import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AgyAcpErrorCode } from './agy-acp-client.js';
import { AgySessionError } from './agy-session.js';
import { assertAgyNativeSupport, publishAgyAgent } from './agy-native-agent.js';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';

export const name = 'subscriptions-enhanced-gemini-acp';
export const inject = ['connection', 'webServer', 'workspaceRegistry'];
export const AGY_API = '/api/subscriptions-enhanced-gemini';
const NATIVE_ID = /^agy-native-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_BODY = 4 * 1024;
const LOOPS = /^(?:\:\:1|(?:\:\:ffff:)?127(?:\.\d{1,3}){3})$/i;
const ACTIONS = new Set(['status', 'read', 'list', 'open', 'answer', 'close']);
const MESSAGES = new Set([
  'host-required', 'preview-only', 'local-only', 'invalid', 'unavailable', 'busy', 'no-workspace', 'workspace-changed',
  'auth-required', 'history-unavailable', 'history-too-large', 'permission-unavailable', 'turn-unconfirmed', 'cleanup-unconfirmed',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => new AgySessionError(code);
const noCache = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

// The browser Peer differs from local API, scheduled, remote and in-process callers.
// Desktop forwards authenticated dsh-app requests without Sec-Fetch-Site.
export function isAgyBrowserRequest(ctx, req) {
  if (!LOOPS.test(ctx.webServer.host ?? '') || !LOOPS.test(req.socket?.remoteAddress ?? '')
    || ctx.connection.allowsRemoteAuthorities !== false
    || ![undefined, 'same-origin', 'none'].includes(req.headers?.['sec-fetch-site'])) return false;
  const { peer } = ctx.connection.admit(req);
  return Boolean(peer?.id && !peer.signal.aborted && peer.principal.kind === 'owner' && peer.id === ctx.connection.browserPeer?.id);
}

export function installAgyWitness(ctx, nativeActions = false) {
  const storage = new AsyncLocalStorage();
  const paths = new Map([[AGY_API, 'bridge']]);
  if (nativeActions) {
    paths.set('/api/session/prompt', 'prompt');
    paths.set('/api/session/cancel', 'cancel');
  }
  const off = ctx.on('connection/request', async (req, _res, next) => {
    const action = req.method === 'POST' ? paths.get(req.url) : undefined;
    if (!action || typeof action !== 'string' || !isAgyBrowserRequest(ctx, req)) return next();
    const witness = { action, active: true, used: false };
    try { return await storage.run(witness, next); }
    finally { witness.active = false; }
  });
  return {
    take(action) {
      const witness = storage.getStore();
      if (!witness?.active || witness.action !== action || witness.used) return false;
      witness.used = true;
      return true;
    },
    dispose: off,
  };
}

function matches(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function agyInput(payload) {
  if (!object(payload) || !ACTIONS.has(payload.action)) throw fail('invalid');
  const { action } = payload;
  if (action === 'status' && matches(payload, ['action'])) return { action };
  if ((action === 'read' || action === 'close') && matches(payload, ['action', 'sessionId'])
    && typeof payload.sessionId === 'string' && NATIVE_ID.test(payload.sessionId)) {
    return { action, sessionId: payload.sessionId };
  }
  if (action === 'answer' && matches(payload, ['action', 'sessionId', 'nonce', 'allow']) && typeof payload.sessionId === 'string'
    && NATIVE_ID.test(payload.sessionId) && typeof payload.nonce === 'string' && UUID.test(payload.nonce) && typeof payload.allow === 'boolean') {
    return { action, sessionId: payload.sessionId, nonce: payload.nonce, allow: payload.allow };
  }
  if (action === 'list' || action === 'open') {
    const hasTicket = action === 'open' && Object.hasOwn(payload, 'ticket');
    if (matches(payload, hasTicket ? ['action', 'workspaceId', 'ticket'] : ['action', 'workspaceId'])
      && typeof payload.workspaceId === 'string' && UUID.test(payload.workspaceId)
      && (!hasTicket || typeof payload.ticket === 'string' && UUID.test(payload.ticket))) {
      return { action, workspaceId: payload.workspaceId, ...(hasTicket ? { ticket: payload.ticket } : {}) };
    }
  }
  throw fail('invalid');
}

function publicCode(error) {
  if (error?.code === AgyAcpErrorCode.AUTH_REQUIRED) return 'auth-required';
  return error instanceof AgySessionError && MESSAGES.has(error.code) ? error.code : 'unavailable';
}

async function readEnvelope(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    || Number(request.headers.get('content-length')) > MAX_BODY || !request.body) throw fail('invalid');
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((bytes += value.byteLength) > MAX_BODY) throw fail('invalid');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  if (!matches(decoded, ['type', 'rpcId', 'method', 'payload']) || decoded.type !== 'client-request'
    || typeof decoded.rpcId !== 'string' || !UUID.test(decoded.rpcId) || decoded.method !== 'subscriptions-enhanced-gemini') throw fail('invalid');
  return decoded;
}

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function workspacePath(ctx, id) {
  const found = ctx.workspaceRegistry.get(id);
  if (!isLocalAgyPath(found?.path)) throw fail('no-workspace');
  try {
    const cwd = await realpath(found.path);
    if (!sameAgyPath(cwd, found.path) || sameAgyPath(cwd, path.parse(cwd).root) || !(await lstat(cwd)).isDirectory()) {
      throw fail('no-workspace');
    }
    const profile = ctx.get('profileContext');
    for (const blocked of [profile?.dir, profile?.home, process.env.DSH_HOME, process.env.USERPROFILE, process.env.DSH_INSTALL_DIR]) {
      if (isLocalAgyPath(blocked) && (contains(cwd, blocked) || contains(blocked, cwd))) throw fail('no-workspace');
    }
    return cwd;
  } catch { throw fail('no-workspace'); }
}

/** Off-line fixtures supply makeSession; the production plugin does not expose a way to inject it. */
export function mountAgyHost(ctx, { makeSession, verify = assertAgyNativeSupport, publish = publishAgyAgent, verifyWorkspace = workspacePath } = {}) {
  const gate = installAgyWitness(ctx, Boolean(makeSession));
  const lifetime = new AbortController();
  let active;
  let operation;
  let tickets;
  let unreaped;

  async function closeSession(session) {
    try { await session.close(); }
    catch {
      unreaped = session;
      throw fail('cleanup-unconfirmed');
    }
  }

  async function availability() {
    if (!LOOPS.test(ctx.webServer.host ?? '') || ctx.connection.allowsRemoteAuthorities !== false) return 'local-only';
    if (ctx.get('sessionProjectionCache', false) !== undefined || ctx.root?.get('sessionProjectionCache', false) !== undefined) return 'host-required';
    if (unreaped) return 'cleanup-unconfirmed';
    if (!makeSession) return 'preview-only';
    try { await verify(ctx); }
    catch { return 'host-required'; }
    return undefined;
  }

  async function release(entry) {
    if (!entry) return;
    entry.retiring = true;
    try { await entry.handle.dispose(); }
    finally { await closeSession(entry.session); }
    if (active === entry) active = undefined;
  }

  async function run(args, signal) {
    signal.throwIfAborted();
    const unavailable = await availability();
    signal.throwIfAborted();
    // Another operation may have attempted cleanup while native support was
    // being checked. A stale readiness result never permits another process.
    const reason = unreaped ? 'cleanup-unconfirmed' : unavailable;
    if (args.action === 'status') {
      if (reason) return { available: false, reason };
      const workspaces = ctx.workspaceRegistry.list().slice(0, 40)
        .filter(item => UUID.test(item.id) && isLocalAgyPath(item.path))
        .map(item => ({ id: item.id, title: typeof item.title === 'string' ? item.title.slice(0, 160) : 'Workspace' }));
      return { available: true, workspaces };
    }
    if (reason) throw fail(reason);
    if (args.action === 'read' || args.action === 'answer') {
      if (!active || active.retiring || args.sessionId !== active.handle.agent.id) throw fail('unavailable');
      if (args.action === 'read') return active.session.read();
      active.session.decide(args.nonce, args.allow);
      return { accepted: true };
    }
    if (operation) throw fail('busy');
    operation = (async () => {
      const { action, workspaceId, ticket } = args;
      if (action === 'close') {
        if (!active || args.sessionId !== active.handle.agent.id) throw fail('unavailable');
        await release(active);
        return { accepted: true };
      }
      if (active?.handle.agent.status === 'running') throw fail('busy');
      const cwd = await verifyWorkspace(ctx, workspaceId);
      signal.throwIfAborted();
      // A native Send may have succeeded while workspace validation yielded.
      if (active?.handle.agent.status === 'running') throw fail('busy');
      let officialId;
      if (ticket !== undefined) {
        if (tickets?.workspaceId !== workspaceId || tickets.expires < Date.now() || !sameAgyPath(cwd, tickets.cwd)) throw fail('invalid');
        officialId = tickets.values.get(ticket);
        if (officialId === undefined) throw fail('invalid');
        if (active?.session.usable && active.session.id === officialId && sameAgyPath(active.cwd, cwd)) {
          return { sessionId: active.handle.agent.id };
        }
      }
      // No two jobs use the same official session in parallel. Changing a
      // workspace closes only this plugin's idle process, never a DSH Agent.
      if (action === 'open' && active) await release(active);
      signal.throwIfAborted();
      if (unreaped) throw fail('cleanup-unconfirmed');
      const session = await makeSession({ cwd });
      let handedOff = false;
      let handle;
      const onAbort = () => { void closeSession(session).catch(() => {}); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        signal.throwIfAborted();
        if (action === 'list') {
          const rows = (await session.list()).filter(item => isLocalAgyPath(item.cwd) && sameAgyPath(item.cwd, cwd));
          signal.throwIfAborted();
          tickets = { workspaceId, cwd, expires: Date.now() + 10 * 60_000, values: new Map() };
          return { threads: rows.map(item => {
            const key = randomUUID();
            tickets.values.set(key, item.id);
            return { ticket: key, title: item.title };
          }) };
        }
        const opened = await session.open(officialId);
        signal.throwIfAborted();
        const id = `agy-native-${randomUUID()}`;
        handle = await publish(ctx, {
          id, cwd, title: 'Gemini · Antigravity', history: opened.history,
          authorizePrompt: data => active?.session === session && !active.retiring && !lifetime.signal.aborted
            && data.sessionId === id && session.usable && gate.take('prompt'),
          authorizeCancel: data => active?.session === session && !active.retiring && !lifetime.signal.aborted
            && data.sessionId === id && gate.take('cancel'),
          async runTurn(text, feed) {
            const current = await verifyWorkspace(ctx, workspaceId);
            if (!sameAgyPath(cwd, current)) throw fail('workspace-changed');
            if (feed.signal.aborted) return { status: 'interrupted' };
            return session.runTurn(text, feed);
          },
        });
        signal.throwIfAborted();
        active = { cwd, handle, session };
        handedOff = true;
        return { sessionId: id };
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (!handedOff) {
          try { await handle?.dispose(); }
          finally { await closeSession(session); }
        }
      }
    })();
    try { return await operation; }
    finally { operation = undefined; }
  }

  ctx.connection.fetch.register({ path: AGY_API, methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    if (!gate.take('bridge') || lifetime.signal.aborted) return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
    let body;
    try { body = await readEnvelope(request); }
    catch { return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    let reply;
    try { reply = { ok: true, value: await run(agyInput(body.payload), signal) }; }
    catch (error) {
      const code = publicCode(error);
      reply = { ok: false, error: { code: `agy/${code}`, message: 'Gemini ACP request did not complete.', details: {} } };
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: reply }), { headers: noCache });
  } });

  ctx.effect(() => async () => {
    lifetime.abort();
    await gate.dispose();
    if (operation) await operation.catch(() => {});
    await release(active);
  }, 'Gemini ACP: owned local session');
}

// rc.5 has no public way to opt an individual native session out of the
// ordinary projection cache (including its first user message). Until this
// and native attachment/remote-session fences are available and exercised, the
// shipped branch registers status only. It cannot spawn a real agent.
export function apply(ctx) { mountAgyHost(ctx); }
