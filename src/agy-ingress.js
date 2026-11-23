import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';

export const AGY_METHOD = 'subscriptions-enhanced-gemini';
export const AGY_API = `/api/${AGY_METHOD}`;
export const AGY_LOOPBACK = /^(?:::1|(?:::ffff:)?127(?:\.\d{1,3}){3})$/iu;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MAX_BODY = 4 * 1024;
const invalid = () => new Error('Invalid Antigravity request.');

export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

// Desktop forwards authenticated dsh-app requests without Sec-Fetch-Site.
export function isAgyBrowserRequest(ctx, req, exactPeer = false, presentationOnly = false) {
  if (!AGY_LOOPBACK.test(ctx.webServer.host ?? '') || !AGY_LOOPBACK.test(req.socket?.remoteAddress ?? '')
    || (!presentationOnly && ctx.connection.allowsRemoteAuthorities !== false)
    || ![undefined, 'same-origin', 'none'].includes(req.headers?.['sec-fetch-site'])) return false;
  const { peer } = ctx.connection.admit(req);
  return Boolean(peer?.id && !peer.signal.aborted && peer.principal.kind === 'owner'
    && (exactPeer ? peer === ctx.connection.browserPeer : peer.id === ctx.connection.browserPeer?.id));
}

export function installAgyWitness(ctx, { nativeActions = false, exactPeer = true, localCarrier = false } = {}) {
  const storage = new AsyncLocalStorage();
  const paths = new Map([[AGY_API, 'bridge']]);
  if (nativeActions) {
    paths.set('/api/session/prompt', 'prompt');
    paths.set('/api/session/updateQueue', 'editQueue');
    if (localCarrier) paths.set('/api/subagents/prompt', 'prompt');
    paths.set('/api/session/cancel', 'cancel');
  }
  async function run(action, next) {
    const witness = { action, active: true, used: false };
    try { return await storage.run(witness, next); }
    finally { witness.active = false; }
  }
  const disposeHttp = ctx.on('connection/request', (req, _res, next) => {
    const action = req.method === 'POST' ? paths.get(req.url) : undefined;
    if (action === undefined) return next();
    if (isAgyBrowserRequest(ctx, req, exactPeer)) return run(action, next);
    if (action === 'bridge' && isAgyBrowserRequest(ctx, req, exactPeer, true)) return run('presentation', next);
    return next();
  });
  const disposeLocal = nativeActions && localCarrier ? ctx.on('session-hosts/local-call', ({ request, peer, endpoint, signal }, next) => {
    const action = paths.get(`/api/${endpoint}`);
    if (!['prompt', 'editQueue'].includes(action) || request.method !== 'POST' || signal.aborted
      || peer !== ctx.connection.browserPeer || !isAgyBrowserRequest(ctx, request, true)) return next();
    return run(action, next);
  }, { global: true }) : undefined;
  return {
    isLocalSubmission() {
      const witness = storage.getStore();
      return witness?.active === true && (witness.action === 'prompt' || witness.action === 'editQueue');
    },
    take(action) {
      const witness = storage.getStore();
      if (!witness?.active || witness.action !== action || witness.used) return false;
      witness.used = true;
      return true;
    },
    dispose() { disposeLocal?.(); disposeHttp(); },
  };
}

export async function readAgyEnvelope(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    || Number(request.headers.get('content-length')) > MAX_BODY || !request.body) throw invalid();
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((bytes += value.byteLength) > MAX_BODY) throw invalid();
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  if (!exactKeys(decoded, ['type', 'rpcId', 'method', 'payload']) || decoded.type !== 'client-request'
    || typeof decoded.rpcId !== 'string' || !UUID.test(decoded.rpcId) || decoded.method !== AGY_METHOD) throw invalid();
  return decoded;
}
