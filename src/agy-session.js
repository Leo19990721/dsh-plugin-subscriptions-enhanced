import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgyAcpErrorCode } from './agy-acp-client.js';
import { isLocalAgyPath } from './agy-launch.js';
import { AGY_MAX_TOOL_CALLS, AGY_TOOL_BYTES, AGY_TOOL_UPDATES, agyToolSize, summarizeAgyTool } from './agy-local-tool-data.js';

const SESSION_LIMIT = 512;
const MAX_TURN_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 600;
const MAX_TOOLS = AGY_MAX_TOOL_CALLS;
const MAX_PERMISSIONS = 6;
const CANCELLED = Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) });
const STOP_REASONS = new Set(['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal']);
const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanLabel = (value, limit) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, limit) : '';

export const isAgySessionId = value => typeof value === 'string' && value.length > 0 && value.length <= SESSION_LIMIT
  && !/[\p{Cc}\p{Cf}]/u.test(value);

const stopped = () => Object.freeze({ status: 'interrupted' });

export class AgySessionError extends Error {
  constructor(code) {
    super(`Antigravity session: ${code}`);
    this.code = code;
  }
}

/** Official session/load is the authority for history. Text replay is only a presentation copy. */
class ReplayText {
  bytes = 0;
  rows = [];
  push(update) {
    const role = update.sessionUpdate === 'user_message_chunk' ? 'user'
      : update.sessionUpdate === 'agent_message_chunk' ? 'agent' : undefined;
    const { content, messageId } = update;
    if (!role || content?.type !== 'text' || typeof content.text !== 'string' || content.text === '') return;
    this.bytes += Buffer.byteLength(content.text);
    if (this.bytes > MAX_HISTORY_BYTES) throw new AgySessionError('history-too-large');
    const identity = isAgySessionId(messageId) ? messageId : undefined;
    const last = this.rows.at(-1);
    if (last?.role === role && last.id === identity) last.text += content.text;
    else {
      if (this.rows.length >= MAX_HISTORY_MESSAGES) throw new AgySessionError('history-too-large');
      this.rows.push({ role, id: identity, text: content.text });
    }
  }
  turns() {
    const history = [];
    let current;
    for (const row of this.rows) {
      if (row.role === 'user') {
        if (row.text.trim() === '') continue;
        current = { prompt: row.text, status: 'completed' };
        history.push(current);
      } else if (current) current.text = (current.text ?? '') + row.text;
    }
    return history;
  }
}

function choice(options, kind) {
  const found = options.filter(option => record(option) && option.kind === kind);
  if (found.length !== 1 || !isAgySessionId(found[0].optionId)) return;
  const { optionId } = found[0];
  if (options.filter(option => option?.optionId === optionId).length === 1) return optionId;
}

function toolDescription(call) {
  const title = cleanLabel(call.title, 512);
  const kind = cleanLabel(call.kind, 32);
  const paths = Array.isArray(call.locations) ? call.locations.slice(0, 12)
    .map(location => cleanLabel(location?.path, 512)).filter(Boolean) : [];
  // Keep a bounded, literal description for review. Never render agent-provided
  // HTML/links or pass this value to a local command runner.
  let detail;
  try {
    const encoded = record(call.rawInput) && Object.keys(call.rawInput).length > 0
      ? JSON.stringify(call.rawInput, null, 2) : undefined;
    if (typeof encoded === 'string' && encoded.length <= 4096) {
      // Escape invisible formatting and bidi controls to keep the display literal.
      detail = encoded.replace(/\p{Cf}/gu, char => `\\u{${char.codePointAt(0).toString(16)}}`);
      if (detail.length > 4096) detail = undefined;
    }
  } catch { /* an absent description is not approval evidence */ }
  return { title, kind, paths, detail };
}

function reviewableRead(cwd, call, description) {
  // Only the isolated fixture can grant this narrowly described read. CLI
  // execution, edits and any request with opaque input stay deny-only until
  // their official action schema and operating-system boundary are verified.
  const input = call.rawInput;
  if (call.kind !== 'read' || !description.title || !description.detail || !record(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'path')) return false;
  const file = input.path;
  if (!isLocalAgyPath(cwd) || !isLocalAgyPath(file) || file.length > 512 || path.normalize(file) !== file) return false;
  if (call.locations !== undefined && (!Array.isArray(call.locations) || call.locations.length !== 1
    || call.locations[0]?.path !== file)) return false;
  const relative = path.relative(cwd, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** One opened official ACP session. No native model registration, auth RPC, or client tools. */
export class AgySession {
  #client;
  #id;
  #cwd;
  #capabilities;
  #replay;
  #turn;
  #pending = new Map();
  #tools = new Map();
  #closed = false;
  #broken;
  #closing;
  #title = '';
  #timeLimits;
  #mcpServers;
  #captureHistory;
  #onBackgroundUpdate;

  constructor({ cwd, makeClient, timeLimits = {}, mcpServers = [], captureHistory = true, onBackgroundUpdate }) {
    this.#cwd = cwd;
    this.#mcpServers = mcpServers;
    this.#captureHistory = captureHistory;
    this.#onBackgroundUpdate = onBackgroundUpdate;
    this.#timeLimits = { open: 20_000, turn: 20 * 60_000, cancel: 8_000, permission: 120_000, ...timeLimits };
    this.#client = makeClient({
      onUpdate: (params, outside = false) => this.#update(params, outside),
      onPermission: params => this.#permission(params),
      onClosed: () => { this.#closed = true; this.#resolvePermissions(); },
    });
  }

  get id() { return this.#id; }
  get capabilities() { return this.#capabilities; }
  get usable() { return !this.#closed && !this.#broken && !this.#closing && this.#id !== undefined; }

  async initialize() {
    if (this.#closed || this.#closing || this.#broken) throw new AgySessionError('closed');
    this.#capabilities = (await this.#client.start()).agentCapabilities ?? {};
    return this.#capabilities;
  }

  async list() {
    const { sessionCapabilities } = await this.initialize();
    if (!record(sessionCapabilities?.list)) throw new AgySessionError('history-unavailable');
    const result = await this.#client.request('session/list', { cwd: this.#cwd }, { timeoutMs: this.#timeLimits.open });
    if (!Array.isArray(result?.sessions)) throw new AgySessionError('history-unavailable');
    return result.sessions.slice(0, 60).flatMap(item => {
      if (!isAgySessionId(item?.sessionId) || typeof item?.cwd !== 'string') return [];
      return [{ id: item.sessionId, cwd: item.cwd, title: cleanLabel(item.title, 120) }];
    });
  }

  async open(officialId) {
    if (this.#id !== undefined || this.#replay || (officialId !== undefined && !isAgySessionId(officialId))) {
      throw new AgySessionError('invalid-session');
    }
    const capabilities = await this.initialize();
    if (officialId !== undefined && capabilities.loadSession !== true) throw new AgySessionError('history-unavailable');
    this.#replay = officialId === undefined || !this.#captureHistory ? undefined : { id: officialId, text: new ReplayText() };
    const params = { cwd: this.#cwd, mcpServers: this.#mcpServers };
    try {
      const result = officialId === undefined
        ? await this.#client.request('session/new', params, { timeoutMs: this.#timeLimits.open })
        : await this.#client.request('session/load', { ...params, sessionId: officialId }, { timeoutMs: this.#timeLimits.open });
      if (this.#broken) throw this.#broken;
      const id = officialId ?? result?.sessionId;
      if (!isAgySessionId(id) || !record(result) || (result.sessionId !== undefined && result.sessionId !== id)) {
        throw new AgySessionError('invalid-session');
      }
      this.#id = id;
      return { title: this.#title, history: this.#replay?.text.turns() ?? [] };
    } finally { this.#replay = undefined; }
  }

  read() {
    return {
      available: this.usable,
      running: this.#turn !== undefined,
      stopping: Boolean(this.#turn?.cancelled),
      tools: [...this.#tools.values()].slice(-10).map(value => ({ ...value })),
      permissions: [...this.#pending.values()].map(({ nonce, title, kind, paths, detail, canAllow }) => ({
        nonce, title, kind, paths: [...paths], detail, canAllow,
      })),
    };
  }

  decide(nonce, allow) {
    const pending = this.#pending.get(nonce);
    if (!this.usable || !this.#turn || this.#turn.cancelled || !pending || pending.turn !== this.#turn
      || performance.now() >= pending.deadline || (allow && !pending.canAllow)) {
      throw new AgySessionError('permission-unavailable');
    }
    this.#settle(nonce, allow ? pending.choices.allow : pending.choices.reject);
  }

  #settle(nonce, optionId) {
    const pending = this.#pending.get(nonce);
    if (!pending) return;
    this.#pending.delete(nonce);
    clearTimeout(pending.timer);
    pending.resolve(optionId === undefined ? CANCELLED : { outcome: { outcome: 'selected', optionId } });
  }

  #resolvePermissions() { for (const nonce of this.#pending.keys()) this.#settle(nonce); }

  #permission(params) {
    const call = params?.toolCall;
    if (!this.usable || !this.#turn || this.#turn.cancelled || params?.sessionId !== this.#id
      || !record(call) || !isAgySessionId(call.toolCallId)) return CANCELLED;
    // Revoke the old snapshot even when the replacement is malformed or
    // arrives while all approval slots are occupied.
    for (const [key, pending] of this.#pending) if (pending.toolCallId === call.toolCallId) this.#settle(key);
    if (!Array.isArray(params.options) || params.options.length > 16 || this.#pending.size >= MAX_PERMISSIONS) return CANCELLED;
    const allow = choice(params.options, 'allow_once');
    const reject = choice(params.options, 'reject_once');
    const description = toolDescription(call);
    const nonce = randomUUID();
    const { promise, resolve } = Promise.withResolvers();
    const deadline = performance.now() + this.#timeLimits.permission;
    const timer = setTimeout(() => this.#settle(nonce), this.#timeLimits.permission);
    timer.unref?.();
    this.#pending.set(nonce, { nonce, ...description, toolCallId: call.toolCallId, turn: this.#turn,
      canAllow: Boolean(allow && reviewableRead(this.#cwd, call, description)), choices: { allow, reject }, timer, deadline, resolve });
    return promise;
  }

  #update(params, outside) {
    if (this.#closed || this.#broken || !record(params?.update)) return;
    const update = params.update;
    if (this.#replay?.id === params.sessionId) {
      try { this.#replay.text.push(update); }
      catch (error) { this.#broken = error; void this.#client.close().catch(() => {}); }
    }
    if (update.sessionUpdate === 'session_info_update' && (this.#id ?? this.#replay?.id) === params.sessionId) {
      this.#title = cleanLabel(update.title, 120);
    }
    const turn = this.#turn;
    if (this.#id === undefined || this.#id !== params.sessionId) return;
    if (!turn || outside) {
      if (this.usable) this.#onBackgroundUpdate?.(update);
      return;
    }
    if (['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate) && update.content?.type === 'text') {
      const delta = update.content.text;
      if (typeof delta !== 'string' || !delta) return;
      turn.bytes += Buffer.byteLength(delta);
      if (turn.bytes > MAX_TURN_BYTES) {
        this.#broken = new AgySessionError('turn-unconfirmed');
        this.#cancel(turn);
        return;
      }
      if (update.sessionUpdate === 'agent_thought_chunk') turn.onThought?.(delta);
      else turn.onDelta(delta);
    } else if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && isAgySessionId(update.toolCallId)) {
      const id = update.toolCallId;
      // As soon as the agent changes the operation or its lifecycle, its
      // previous approval is stale. Only a fresh server request may ask again.
      if (update.sessionUpdate === 'tool_call' || ['title', 'kind', 'locations', 'rawInput', 'status']
        .some(key => Object.hasOwn(update, key))) {
        for (const [nonce, pending] of this.#pending) if (pending.toolCallId === id) this.#settle(nonce);
      }
      const previous = this.#tools.get(id);
      if (!previous && this.#tools.size >= MAX_TOOLS) return;
      const title = cleanLabel(update.title, 300) || previous?.title;
      const status = TOOL_STATUSES.has(update.status) ? update.status : previous?.status ?? 'pending';
      this.#tools.set(id, { title: title || 'Antigravity', status });
      if (turn.onTool && turn.toolUpdates < AGY_TOOL_UPDATES && turn.toolBytes < AGY_TOOL_BYTES) {
        const preview = summarizeAgyTool(update);
        if (preview && (turn.toolBytes += agyToolSize(preview)) <= AGY_TOOL_BYTES) {
          turn.toolUpdates++;
          turn.onTool({ ...preview, sessionUpdate: update.sessionUpdate });
        }
      }
    } else if (update.sessionUpdate === 'usage_update') {
      const used = Number.isSafeInteger(update.used) && update.used >= 0 ? update.used : undefined;
      const size = Number.isSafeInteger(update.size) && update.size > 0 ? update.size : undefined;
      if (used !== undefined || size !== undefined) turn.onUsage?.({ ...(used !== undefined ? { used } : {}), ...(size !== undefined ? { size } : {}) });
    }
  }

  #cancel(turn) {
    if (turn !== this.#turn || turn.cancelled) return;
    turn.cancelled = true;
    const signal = this.#client.notify('session/cancel', { sessionId: this.#id });
    this.#resolvePermissions();
    // The agent can finish despite the cancellation request. Keep the last
    // official tool status while the user interface shows 'stopping'.
    void signal.catch(() => {
      if (this.#turn === turn) void this.#client.close().catch(() => {});
    });
    turn.cancelTimer = setTimeout(() => {
      if (this.#turn === turn) void this.#client.close().catch(() => {});
    }, this.#timeLimits.cancel);
    turn.cancelTimer.unref?.();
  }

  async runTurn(input, { signal, onDelta, onThought, onTool, onUsage }) {
    if (signal.aborted) return stopped();
    const prompt = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    if (!this.usable || this.#turn || !Array.isArray(prompt) || !prompt.some(block =>
      block?.type === 'text' ? typeof block.text === 'string' && block.text.trim() : block?.type === 'image' || block?.type === 'resource_link' || block?.type === 'resource')) {
      throw new AgySessionError('turn-unavailable');
    }
    const turn = { onDelta, onThought, onTool, onUsage, bytes: 0, toolBytes: 0, toolUpdates: 0, cancelled: false, done: Promise.withResolvers() };
    this.#tools.clear();
    this.#turn = turn;
    const cancel = () => this.#cancel(turn);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) return stopped();
      const result = await this.#client.request('session/prompt', {
        sessionId: this.#id,
        prompt,
      }, { timeoutMs: this.#timeLimits.turn });
      if (this.#broken || !STOP_REASONS.has(result?.stopReason)) throw new AgySessionError('turn-unconfirmed');
      if (result.stopReason === 'cancelled') return stopped();
      return { status: 'completed' };
    } catch (error) {
      this.#broken = new AgySessionError(error?.code === AgyAcpErrorCode.AUTH_REQUIRED ? 'auth-required' : 'turn-unconfirmed');
      throw this.#broken;
    } finally {
      signal.removeEventListener('abort', cancel);
      clearTimeout(turn.cancelTimer);
      this.#resolvePermissions();
      this.#turn = undefined;
      turn.done.resolve();
    }
  }

  close() {
    return this.#closing ??= (async () => {
      if (this.#turn) {
        const turn = this.#turn;
        this.#cancel(turn);
        await turn.done.promise;
      }
      this.#resolvePermissions();
      if (!this.#closed && this.#id && record(this.#capabilities?.sessionCapabilities?.close)) {
        try { await this.#client.request('session/close', { sessionId: this.#id }, { timeoutMs: 2_000 }); }
        catch { /* Process teardown also retires this session. */ }
      }
      await this.#client.close();
    })();
  }
}
