import { spawn } from 'node:child_process';
import { isAbsolute, parse } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { isPromise } from 'node:util/types';

export const AgyAcpErrorCode = Object.freeze({
  AUTH_REQUIRED: -32000,
  RPC_ERROR: 'RPC_ERROR',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_READY: 'NOT_READY',
  CLOSED: 'CLOSED',
  SPAWN_FAILED: 'SPAWN_FAILED',
  IO: 'IO',
  PROCESS_EXIT: 'PROCESS_EXIT',
  PROTOCOL: 'PROTOCOL',
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  TIMEOUT: 'TIMEOUT',
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  UPDATE_HANDLER_FAILED: 'UPDATE_HANDLER_FAILED',
  RESPONSE_HANDLER_FAILED: 'RESPONSE_HANDLER_FAILED',
  BEFORE_WRITE_FAILED: 'BEFORE_WRITE_FAILED',
  CLOSE_TIMEOUT: 'CLOSE_TIMEOUT',
});

const C = AgyAcpErrorCode;
const messages = Object.freeze({
  [C.AUTH_REQUIRED]: 'Antigravity authentication required.',
  [C.RPC_ERROR]: 'Antigravity rejected the ACP request.',
  [C.INVALID_ARGUMENT]: 'Invalid ACP client argument.',
  [C.NOT_READY]: 'The ACP connection has not been initialized.',
  [C.CLOSED]: 'The ACP connection is closed.',
  [C.SPAWN_FAILED]: 'Could not start the Antigravity ACP process.',
  [C.IO]: 'The Antigravity ACP pipe failed.',
  [C.PROCESS_EXIT]: 'The Antigravity ACP process disconnected.',
  [C.PROTOCOL]: 'Invalid message from the Antigravity ACP process.',
  [C.UNSUPPORTED_PROTOCOL]: 'The Antigravity ACP process did not negotiate ACP v1.',
  [C.TIMEOUT]: 'The Antigravity ACP operation timed out.',
  [C.FRAME_TOO_LARGE]: 'An ACP message exceeds the byte limit.',
  [C.LIMIT_EXCEEDED]: 'The ACP connection exceeded its pending work limit.',
  [C.UPDATE_HANDLER_FAILED]: 'The ACP update handler did not complete synchronously.',
  [C.RESPONSE_HANDLER_FAILED]: 'The ACP response handler did not complete synchronously.',
  [C.BEFORE_WRITE_FAILED]: 'The ACP write guard rejected the outbound message.',
  [C.CLOSE_TIMEOUT]: 'The Antigravity ACP process could not be confirmed stopped in time.',
});

/** Locally chosen codes/messages only. Remote errors, paths and stderr are never attached. */
export class AgyAcpError extends Error {
  constructor(code) {
    if ((typeof code !== 'number' && typeof code !== 'string') || !Object.hasOwn(messages, code)) {
      code = C.RPC_ERROR;
    }
    super(messages[code]);
    this.name = 'AgyAcpError';
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const AUTHENTICATION_TIMEOUT_MS = 10 * 60_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024; // UTF-8 bytes before the LF.
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 128;
const MAX_PEER_REQUESTS = 32;
const DRAIN_MS = 250;
const EOF_GRACE_MS = 250;
const TERM_GRACE_MS = 250;
const KILL_WAIT_MS = 500;
const EMPTY = Buffer.alloc(0);
const METHOD_NOT_FOUND = Object.freeze({ code: -32601, message: 'Method not found' });
const CANCELLED = Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) });
const noop = () => {};

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const absolute = value => typeof value === 'string' && !value.includes('\0')
  && isAbsolute(value) && (process.platform !== 'win32' || parse(value).root.length > 1);
const validTimeout = value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const validId = value => value === null || typeof value === 'string' || Number.isSafeInteger(value);

function expireAt(deadline, expire) {
  return setTimeout(expire, Math.max(1, Math.ceil(deadline - performance.now())));
}

function validateInitialize(result) {
  if (!record(result) || !Number.isSafeInteger(result.protocolVersion)) throw new AgyAcpError(C.PROTOCOL);
  if (result.protocolVersion !== 1) throw new AgyAcpError(C.UNSUPPORTED_PROTOCOL);
  // Google documents this server name. The CLI version is descriptor metadata,
  // not a compatibility check; the ACP protocol version above is what matters.
  const info = result.agentInfo;
  if (!record(info) || info.name !== 'Antigravity ACP Server' || !nonempty(info.version)
    || (info.title != null && typeof info.title !== 'string')
    || (result.agentCapabilities !== undefined && !record(result.agentCapabilities))
    || (result.authMethods !== undefined && !Array.isArray(result.authMethods))) {
    throw new AgyAcpError(C.PROTOCOL);
  }
  if (result.authMethods === undefined) return { ...result };
  const ids = new Set();
  const authMethods = result.authMethods.map(method => {
    if (!record(method) || !nonempty(method.id) || ids.has(method.id)) throw new AgyAcpError(C.PROTOCOL);
    ids.add(method.id);
    // Only method IDs are needed. Never retain or publish remote auth metadata.
    return { id: method.id };
  });
  return { ...result, authMethods };
}

function checkMethod(method) {
  if (!nonempty(method) || method === 'initialize' || method === 'authenticate' || method === 'logout') {
    throw new AgyAcpError(C.INVALID_ARGUMENT);
  }
}

function checkParams(message, line, allowMcpServers) {
  if (message.params === undefined) return;
  // Check the wire representation, including any transformation by toJSON().
  const { params } = JSON.parse(line);
  if (!record(params) && !Array.isArray(params)) throw new AgyAcpError(C.INVALID_ARGUMENT);
  if (message.method.startsWith('session/') && Object.hasOwn(params, 'mcpServers')
    && (!Array.isArray(params.mcpServers) || (!allowMcpServers && params.mcpServers.length !== 0))) {
    throw new AgyAcpError(C.INVALID_ARGUMENT);
  }
}

async function waitBounded(signal, ms) {
  let timer;
  try {
    return await Promise.race([signal.then(() => true), new Promise(resolve => {
      timer = setTimeout(resolve, ms, false);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Single-use ACP v1 stdio transport. Host owns executable trust, env and session policy. */
export class AgyAcpClient {
  #executable;
  #cwd;
  #env;
  #spawn;
  #timeoutMs;
  #allowAuthentication;
  #allowMcpServers;
  #permissionMode;
  #maxFrameBytes;
  #authMethodIds = new Set();
  #canLogout = false;
  #authenticationPromise;
  #logoutPromise;
  #onUpdate;
  #onPermission;
  #onClosed;

  #state = 'idle';
  #fault;
  #startPromise;
  #closePromise;
  #child;
  #exited = false;
  #resolveExit;
  #exit = new Promise(resolve => { this.#resolveExit = resolve; });

  #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  #partial = EMPTY;
  #partialBytes = 0;
  #nextId = 0;
  #pending = new Map();
  #requestDeadline = Infinity;
  #peerIds = new Map();
  #writes = [];
  #writeBytes = 0;
  #activeWrite;
  #writeTimer;
  #resolveDrain;

  constructor(options) {
    try {
      const { executable, cwd, env, spawnFactory = spawn, timeoutMs = DEFAULT_TIMEOUT_MS,
        allowAuthentication = false, allowMcpServers = false, permissionMode = 'sandbox', maxFrameBytes = MAX_FRAME_BYTES,
        onUpdate, onPermission, onClosed } = options;
      if (!absolute(executable) || !absolute(cwd) || !record(env) || typeof spawnFactory !== 'function'
        || !validTimeout(timeoutMs) || typeof allowAuthentication !== 'boolean' || typeof allowMcpServers !== 'boolean'
        || !['sandbox', 'review', 'full'].includes(permissionMode) || !Number.isSafeInteger(maxFrameBytes)
        || maxFrameBytes < MAX_FRAME_BYTES || maxFrameBytes > 16 * 1024 * 1024
        || [onUpdate, onPermission, onClosed].some(fn => fn !== undefined && typeof fn !== 'function')) {
        throw new AgyAcpError(C.INVALID_ARGUMENT);
      }
      this.#executable = executable;
      this.#cwd = cwd;
      this.#env = { ...env }; // Explicit Host-supplied environment; no process.env fallback.
      this.#spawn = spawnFactory;
      this.#timeoutMs = timeoutMs;
      this.#allowAuthentication = allowAuthentication;
      this.#allowMcpServers = allowMcpServers;
      this.#permissionMode = permissionMode;
      this.#maxFrameBytes = maxFrameBytes;
      this.#onUpdate = onUpdate;
      this.#onPermission = onPermission;
      this.#onClosed = onClosed;
    } catch {
      throw new AgyAcpError(C.INVALID_ARGUMENT);
    }
  }

  /** Launch and negotiate once. Returns initialize with authMethods reduced to { id }. */
  start() {
    if (this.#state === 'starting' || this.#state === 'ready') return this.#startPromise;
    if (this.#state !== 'idle') return Promise.reject(this.#unavailable());
    this.#state = 'starting';
    this.#startPromise = Promise.resolve().then(() => {
      if (this.#state !== 'starting') throw this.#unavailable();
      try {
        this.#open();
      } catch {
        this.#fail(new AgyAcpError(C.SPAWN_FAILED));
        throw this.#unavailable();
      }
      if (this.#state !== 'starting') throw this.#unavailable();
      return this.#sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'vscode', title: 'VS Code', version: '1.0.0' },
      }, this.#timeoutMs, true);
    });
    return this.#startPromise;
  }

  /**
   * Explicit Host opt-in only: agy opens its own Google browser sign-in.
   * The initialized agent must advertise this exact personal method.
   * Coalesce a double click, never retry, and never expose the response payload.
   */
  authenticate(methodId) {
    if (this.#state !== 'ready') return Promise.reject(this.#unavailable());
    if (!this.#allowAuthentication || methodId !== 'oauth-personal' || !this.#authMethodIds.has(methodId)) {
      return Promise.reject(new AgyAcpError(C.INVALID_ARGUMENT));
    }
    if (this.#authenticationPromise) return this.#authenticationPromise;
    // Reserve the single operation before any synchronous/reentrant pipe callback.
    const operation = Promise.resolve().then(() => {
      if (this.#state !== 'ready') throw this.#unavailable();
      return this.#sendRequest('authenticate', { methodId }, AUTHENTICATION_TIMEOUT_MS, false,
        undefined, noop, undefined, true);
    });
    const authentication = operation.then(() => undefined).finally(() => {
      if (this.#authenticationPromise === authentication) this.#authenticationPromise = undefined;
    });
    this.#authenticationPromise = authentication;
    return authentication;
  }

  /**
   * Explicit Host opt-in only: ask official agy to clear its own auth session via ACP logout.
   * Coalesce double clicks, never retry, and never expose the response payload.
   */
  logout() {
    if (this.#state !== 'ready') return Promise.reject(this.#unavailable());
    if (!this.#allowAuthentication || !this.#canLogout) {
      return Promise.reject(new AgyAcpError(C.INVALID_ARGUMENT));
    }
    if (this.#logoutPromise) return this.#logoutPromise;
    const operation = Promise.resolve().then(() => {
      if (this.#state !== 'ready') throw this.#unavailable();
      return this.#sendRequest('logout', {}, this.#timeoutMs, false,
        undefined, noop, undefined, true);
    });
    const req = operation.then(() => undefined).finally(() => {
      if (this.#logoutPromise === req) this.#logoutPromise = undefined;
    });
    this.#logoutPromise = req;
    return req;
  }

  /**
   * Send a JSON-RPC request after start. A timeout fences the connection.
   * beforeWrite() is an optional synchronous guard run only when this frame
   * reaches stdin. A throw or thenable prevents the write and fences the pipe.
   * onWriteStarted() marks the write attempt synchronously after the last
   * guard and deadline check. It must only record local state; it cannot
   * cancel or start other work. onResponse() marks a matched response before
   * the next frame is dispatched. These callbacks receive no wire data.
   */
  async request(method, params, options = {}) {
    if (this.#state !== 'ready') throw this.#unavailable();
    checkMethod(method);
    let timeoutMs, onResponse, beforeWrite, onWriteStarted;
    try { ({ timeoutMs = this.#timeoutMs, onResponse, beforeWrite, onWriteStarted } = options); }
    catch { throw new AgyAcpError(C.INVALID_ARGUMENT); }
    if (!validTimeout(timeoutMs) || [onResponse, beforeWrite, onWriteStarted].some(fn => fn !== undefined && typeof fn !== 'function')) {
      throw new AgyAcpError(C.INVALID_ARGUMENT);
    }
    return this.#sendRequest(method, params, timeoutMs, false, onResponse, beforeWrite, onWriteStarted);
  }

  /** Queue a notification and resolve after its bytes have been written in order. */
  async notify(method, params) {
    if (this.#state !== 'ready') throw this.#unavailable();
    checkMethod(method);
    const bytes = this.#frame({ jsonrpc: '2.0', method, params }, true);
    if (this.#state !== 'ready') throw this.#unavailable();
    await this.#queue(bytes);
  }

  /** Fence callbacks, drain accepted writes briefly, close stdin, and reap the child. */
  close() {
    if (!this.#closePromise) {
      this.#state = 'draining';
      this.#fenceReads(new AgyAcpError(C.CLOSED));
      this.#beginShutdown();
    }
    return this.#closePromise;
  }

  #unavailable() {
    return this.#fault ?? new AgyAcpError(this.#state === 'idle' || this.#state === 'starting'
      ? C.NOT_READY : C.CLOSED);
  }

  #open() {
    const flag = { sandbox: '--sandbox', full: '--dangerously-skip-permissions' }[this.#permissionMode];
    const child = this.#spawn(this.#executable, ['--mode=default', 'acp', ...(flag ? [flag] : []), '--disable-telemetry'], {
      cwd: this.#cwd, env: this.#env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    this.#child = child;
    child.on('error', () => this.#fail(new AgyAcpError(this.#state === 'starting' ? C.SPAWN_FAILED : C.IO)));
    child.once('exit', () => this.#onExit());
    child.once('close', () => this.#onExit());
    const pipeError = () => this.#fail(new AgyAcpError(C.IO));
    child.stdin.on('error', pipeError);
    child.stdout.on('error', pipeError);
    child.stderr.on('error', pipeError);
    child.stdout.once('end', () => this.#onStdoutEnd());
    child.stdout.once('close', () => this.#onStdoutEnd());
    child.stderr.resume(); // Drain without decoding, retaining, logging or forwarding anything.
    child.stdout.on('data', chunk => this.#receive(chunk));
  }

  #onExit() {
    if (this.#exited) return;
    this.#exited = true;
    this.#resolveExit();
    if (this.#reading() || (this.#state === 'draining' && this.#writes.length)) {
      this.#fail(new AgyAcpError(C.PROCESS_EXIT));
    }
  }

  #onStdoutEnd() {
    if (this.#reading()) this.#fail(new AgyAcpError(this.#partialBytes ? C.PROTOCOL : C.PROCESS_EXIT));
  }

  #reading() { return this.#state === 'starting' || this.#state === 'ready'; }

  #frame(message, checkPublicParams = false) {
    let line;
    try {
      line = JSON.stringify(message);
      if (typeof line !== 'string') throw new AgyAcpError(C.INVALID_ARGUMENT);
    } catch {
      throw new AgyAcpError(C.INVALID_ARGUMENT);
    }
    if (Buffer.byteLength(line) > this.#maxFrameBytes) {
      const error = new AgyAcpError(C.FRAME_TOO_LARGE);
      this.#fail(error);
      throw error;
    }
    if (checkPublicParams) checkParams(message, line, this.#allowMcpServers);
    return Buffer.from(`${line}\n`);
  }

  #sendRequest(method, params, timeoutMs, initializing, onResponse, beforeWrite, onWriteStarted, authenticating = false) {
    if (this.#pending.size >= MAX_PENDING || !Number.isSafeInteger(this.#nextId)) {
      const error = new AgyAcpError(C.LIMIT_EXCEEDED);
      this.#fail(error);
      throw error;
    }
    const id = this.#nextId++;
    const bytes = this.#frame({ jsonrpc: '2.0', id, method, params }, !initializing);
    if (this.#state !== (initializing ? 'starting' : 'ready')) throw this.#unavailable();
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      const timer = expireAt(deadline, () => this.#fail(new AgyAcpError(C.TIMEOUT)));
      const pending = { resolve, reject, initializing, authenticating, deadline, timer, onResponse, sent: false };
      this.#pending.set(id, pending);
      this.#requestDeadline = Math.min(this.#requestDeadline, deadline);
      try {
        // I/O errors fence this connection and reject every pending request.
        void this.#queue(bytes, () => {
          onWriteStarted?.();
          pending.sent = true;
        }, beforeWrite).catch(noop);
      } catch (error) {
        this.#forget(id, pending);
        reject(error);
      }
    });
  }

  #forget(id, pending) {
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (pending.deadline === this.#requestDeadline) {
      this.#requestDeadline = Infinity;
      for (const other of this.#pending.values()) this.#requestDeadline = Math.min(this.#requestDeadline, other.deadline);
    }
  }

  #deadlinePassed() {
    if (performance.now() < Math.min(this.#requestDeadline, this.#activeWrite?.deadline ?? Infinity)) return false;
    this.#fail(new AgyAcpError(C.TIMEOUT));
    return true;
  }

  #queue(bytes, onWrite, beforeWrite) {
    if (!this.#reading() || this.#deadlinePassed()) throw this.#unavailable();
    if (this.#writes.length >= MAX_PENDING || this.#writeBytes + bytes.length > Math.max(MAX_WRITE_BYTES, 2 * this.#maxFrameBytes)) {
      const error = new AgyAcpError(C.LIMIT_EXCEEDED);
      this.#fail(error);
      throw error;
    }
    const written = new Promise((resolve, reject) => this.#writes.push({ bytes, onWrite, beforeWrite, resolve, reject }));
    this.#writeBytes += bytes.length;
    this.#pump();
    return written;
  }

  #pump() {
    if (this.#activeWrite || !this.#writes.length || (!this.#reading() && this.#state !== 'draining')
      || this.#deadlinePassed()) return;
    const entry = this.#activeWrite = this.#writes[0];
    entry.deadline = performance.now() + this.#timeoutMs;
    this.#writeTimer = expireAt(entry.deadline, () => this.#fail(new AgyAcpError(C.TIMEOUT)));
    const { beforeWrite } = entry;
    entry.beforeWrite = undefined;
    if (beforeWrite) {
      // Drain ordinary writes on close but never start a queued guarded write.
      if (this.#reading()) {
        try {
          const result = beforeWrite();
          if (isPromise(result)) {
            // Observe even an async rejection without attaching its value to diagnostics.
            void Promise.prototype.then.call(result, undefined, noop);
            return this.#fail(new AgyAcpError(C.BEFORE_WRITE_FAILED));
          }
          if (typeof result?.then === 'function') return this.#fail(new AgyAcpError(C.BEFORE_WRITE_FAILED));
        } catch {
          return this.#fail(new AgyAcpError(C.BEFORE_WRITE_FAILED));
        }
      }
      // A guard can synchronously close/fail the connection or consume the deadline.
      if (this.#activeWrite !== entry || this.#deadlinePassed()) return;
      if (!this.#reading()) return this.#finishWrite(entry, this.#unavailable());
    }
    try {
      entry.onWrite?.();
      this.#child.stdin.write(entry.bytes, error => {
        if (this.#activeWrite !== entry || this.#deadlinePassed()) return;
        if (error) return this.#fail(new AgyAcpError(C.IO));
        this.#finishWrite(entry);
      });
    } catch {
      this.#fail(new AgyAcpError(C.IO));
    }
  }

  #finishWrite(entry, error) {
    clearTimeout(this.#writeTimer);
    this.#activeWrite = undefined;
    this.#writeBytes -= entry.bytes.length;
    this.#writes.shift();
    if (error) entry.reject(error);
    else entry.resolve();
    if (this.#writes.length) this.#pump();
    else this.#resolveDrain?.();
  }

  #receive(chunk) {
    if (!this.#reading()) return;
    if (!Buffer.isBuffer(chunk)) return this.#fail(new AgyAcpError(C.PROTOCOL));
    for (let offset = 0; offset < chunk.length && this.#reading();) {
      const lf = chunk.indexOf(0x0a, offset);
      const end = lf === -1 ? chunk.length : lf;
      const size = this.#partialBytes + end - offset;
      if (size > this.#maxFrameBytes) return this.#fail(new AgyAcpError(C.FRAME_TOO_LARGE));
      let bytes = chunk.subarray(offset, end);
      if (lf === -1 || this.#partialBytes !== 0) {
        // Grow geometrically: fragmented data is copied in linear total time.
        if (this.#partial.length < size) {
          const next = Buffer.allocUnsafe(Math.min(this.#maxFrameBytes, Math.max(4096, size, this.#partial.length * 2)));
          this.#partial.copy(next, 0, 0, this.#partialBytes);
          this.#partial = next;
        }
        bytes.copy(this.#partial, this.#partialBytes);
        this.#partialBytes = size;
        if (lf === -1) return;
        bytes = this.#partial.subarray(0, size);
        this.#partialBytes = 0;
        if (this.#partial.length > 64 * 1024) this.#partial = EMPTY;
      }
      let message;
      try { message = JSON.parse(this.#decoder.decode(bytes)); }
      catch { return this.#fail(new AgyAcpError(C.PROTOCOL)); }
      this.#dispatch(message);
      offset = end + 1;
    }
  }

  #dispatch(message) {
    if (this.#deadlinePassed()) return;
    if (!record(message) || message.jsonrpc !== '2.0') return this.#fail(new AgyAcpError(C.PROTOCOL));
    const hasId = Object.hasOwn(message, 'id');
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasId && !validId(message.id)) return this.#fail(new AgyAcpError(C.PROTOCOL));
    if (Object.hasOwn(message, 'method')) {
      if (typeof message.method !== 'string' || hasResult || hasError) {
        return this.#fail(new AgyAcpError(C.PROTOCOL));
      }
      if (hasId) this.#peerRequest(message);
      else if (message.method === 'session/update' && this.#state === 'ready') this.#update(message.params);
      return;
    }
    if (!hasId || hasResult === hasError
      || (hasError && (!record(message.error) || !Number.isSafeInteger(message.error.code)
        || typeof message.error.message !== 'string'))) {
      return this.#fail(new AgyAcpError(C.PROTOCOL));
    }
    const pending = this.#pending.get(message.id);
    if (!pending || pending.responding) return;
    if (!pending.sent) return this.#fail(new AgyAcpError(C.PROTOCOL));
    const error = hasError ? new AgyAcpError(message.error.code === C.AUTH_REQUIRED ? C.AUTH_REQUIRED : C.RPC_ERROR) : undefined;
    let result;
    if (pending.initializing) {
      if (error) return this.#fail(error);
      try { result = validateInitialize(message.result); }
      catch (invalid) { return this.#fail(invalid); }
      // Keep authorization detached from the cached initialize value exposed by start().
      this.#authMethodIds = new Set(result.authMethods?.map(method => method.id));
      this.#canLogout = Boolean(result.agentCapabilities?.auth?.logout);
      this.#state = 'ready';
    } else if (!pending.authenticating) result = message.result;
    const { onResponse } = pending;
    // Keep this request pending while the handler runs, so a failure can still
    // reject it on the connection fence. Re-entrant responses cannot settle it.
    if (onResponse) {
      pending.responding = true;
      try {
        const result = onResponse();
        if (typeof result?.then === 'function') {
          void Promise.resolve(result).catch(noop);
          return this.#fail(new AgyAcpError(C.RESPONSE_HANDLER_FAILED));
        }
      } catch {
        return this.#fail(new AgyAcpError(C.RESPONSE_HANDLER_FAILED));
      }
    }
    if (this.#pending.get(message.id) !== pending) return;
    this.#forget(message.id, pending);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  #update(params) {
    if (!record(params)) return this.#fail(new AgyAcpError(C.PROTOCOL));
    try {
      const result = this.#onUpdate?.(params);
      if (typeof result?.then === 'function') {
        void Promise.resolve(result).catch(noop);
        this.#fail(new AgyAcpError(C.UPDATE_HANDLER_FAILED));
      }
    } catch {
      this.#fail(new AgyAcpError(C.UPDATE_HANDLER_FAILED));
    }
  }

  #peerRequest({ id, method, params }) {
    if (this.#peerIds.has(id)) return this.#fail(new AgyAcpError(C.PROTOCOL));
    if (this.#peerIds.size >= MAX_PEER_REQUESTS) return this.#fail(new AgyAcpError(C.LIMIT_EXCEEDED));
    const token = {};
    this.#peerIds.set(id, token);
    if (method !== 'session/request_permission') {
      this.#peerReply(id, token, { error: METHOD_NOT_FOUND });
    } else if (this.#state === 'ready' && this.#onPermission && record(params)) {
      void this.#permission(id, token, params);
    } else {
      this.#peerReply(id, token, { result: CANCELLED });
    }
  }

  async #permission(id, token, params) {
    let result = CANCELLED;
    try {
      const decision = (await this.#onPermission(params))?.outcome;
      if (decision?.outcome === 'selected') {
        const optionId = decision.optionId;
        // The controller validates the option, session and user's decision.
        if (nonempty(optionId)) result = { outcome: { outcome: 'selected', optionId } };
      }
    } catch {
      // No decision, an exception or an unusable return value fails closed.
    }
    this.#peerReply(id, token, { result });
  }

  #peerReply(id, token, payload) {
    if (!this.#reading() || this.#peerIds.get(id) !== token) return;
    try {
      const bytes = this.#frame({ jsonrpc: '2.0', id, ...payload });
      void this.#queue(bytes, () => { this.#peerIds.delete(id); }).catch(noop);
    } catch {
      this.#fail(new AgyAcpError(C.IO));
    }
  }

  #fenceReads(error) {
    this.#partial = EMPTY;
    this.#partialBytes = 0;
    this.#peerIds.clear();
    this.#authMethodIds.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#requestDeadline = Infinity;
  }

  #discardWrites(error) {
    clearTimeout(this.#writeTimer);
    this.#activeWrite = undefined;
    for (const entry of this.#writes) entry.reject(error);
    this.#writes.length = 0;
    this.#writeBytes = 0;
    this.#resolveDrain?.();
  }

  #fail(error) {
    if (this.#state === 'stopping' || this.#state === 'closed') return;
    this.#fault = error;
    this.#state = 'stopping';
    this.#fenceReads(error);
    this.#discardWrites(error);
    this.#beginShutdown();
  }

  #beginShutdown() {
    this.#closePromise ??= Promise.resolve().then(() => this.#shutdown());
    // Automatic shutdown can start without an explicit caller of close().
    void this.#closePromise.catch(noop);
  }

  async #shutdown() {
    const child = this.#child;
    let reapError;
    try {
      if (child && this.#state === 'draining' && this.#writes.length) {
        const drained = await waitBounded(new Promise(resolve => { this.#resolveDrain = resolve; }), DRAIN_MS);
        this.#resolveDrain = undefined;
        if (!drained) this.#fail(new AgyAcpError(C.TIMEOUT));
      }
      if (child && !this.#exited && this.#state === 'draining') {
        try { child.stdin.end(); }
        catch { this.#fail(new AgyAcpError(C.IO)); }
        if (this.#state === 'draining') await waitBounded(this.#exit, EOF_GRACE_MS);
      }
      if (child && !this.#exited) {
        try { child.stdin?.destroy(); } catch { /* proceed to terminate */ }
        try { child.kill('SIGTERM'); } catch { /* allow hard termination below */ }
        if (!(await waitBounded(this.#exit, TERM_GRACE_MS))) {
          try { child.kill('SIGKILL'); } catch { /* checked by the final reap wait */ }
          if (!(await waitBounded(this.#exit, KILL_WAIT_MS))) reapError = new AgyAcpError(C.CLOSE_TIMEOUT);
        }
      }
    } finally {
      this.#state = 'closed';
      this.#fault ??= reapError;
      this.#child = undefined;
      this.#env = undefined;
      this.#startPromise = undefined;
      this.#onUpdate = undefined;
      this.#onPermission = undefined;
      if (child) {
        for (const pipe of ['stdin', 'stdout', 'stderr']) {
          try { child[pipe]?.destroy(); } catch { /* no raw pipe errors */ }
        }
        if (!this.#exited) {
          try { child.unref(); } catch { /* no raw process errors */ }
        }
      }
      const closed = this.#onClosed;
      this.#onClosed = undefined;
      try { void Promise.resolve(closed?.(this.#fault)).catch(noop); }
      catch { /* no raw callback errors */ }
    }
    if (reapError) throw reapError;
  }
}
