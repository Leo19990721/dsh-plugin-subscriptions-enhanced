import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { exactKeys, isAgyBrowserRequest } from './agy-ingress.js';

const MAX_BODY = 512 * 1024;
const MAX_TEXT = 64 * 1024;
const PATHS = new Map([['/api/session/prompt', 'prompt'], ['/api/session/updateQueue', 'updateQueue']]);
const sameRoute = (left, right) => left?.provider === right?.provider && left?.model === right?.model
  && left?.reasoningEffort === right?.reasoningEffort;
const matchesPrompt = (request, message) => typeof request.requestId === 'string' && message.source?.kind === 'user'
  && message.source.rpcId === request.requestId && isDeepStrictEqual(request.content, message.content);

export function agySubscriptionText(content) {
  if (!Array.isArray(content) || content.length !== 1 || !exactKeys(content[0], ['type', 'text'])
    || content[0].type !== 'text' || typeof content[0].text !== 'string') return;
  const { text } = content[0];
  if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT || text.includes('dsh-session:') || /^\s*\//u.test(text)) return;
  return text;
}

function decode(chunks, size, method) {
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size)));
  if (!exactKeys(body, ['type', 'rpcId', 'method', 'payload']) || body.type !== 'client-request'
    || typeof body.rpcId !== 'string' || body.method !== `session/${method}` || !exactKeys(body.payload, ['args'])
    || !exactKeys(body.payload.args, ['request'])) return;
  return body.payload.args.request;
}

/** Observe the stock rc.5 buffered HTTP body without owning its auth, validation or response. */
export function observeAgySubscriptionRequests(ctx) {
  const storage = new AsyncLocalStorage();
  const off = ctx.on('connection/request', async (req, _res, next) => {
    const method = req.method === 'POST' ? PATHS.get(req.url) : undefined;
    if (!method || typeof req[Symbol.asyncIterator] !== 'function'
      || req.headers?.['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
      || Number(req.headers?.['content-length']) > MAX_BODY) return next();
    const { peer } = ctx.connection.admit(req);
    if (!peer || peer.signal.aborted) return next();
    const browser = isAgyBrowserRequest(ctx, req, true);
    // Other authenticated carriers can classify a queue action but cannot grant send authority.
    if (!browser && method !== 'updateQueue') return next();
    const original = req[Symbol.asyncIterator];
    const own = Object.getOwnPropertyDescriptor(req, Symbol.asyncIterator);
    const witness = { peer, browser, method, request: undefined, agent: undefined, route: undefined, active: true, used: false };
    let attached;
    async function* observe() {
      let size = 0;
      const parts = [];
      for await (const chunk of { [Symbol.asyncIterator]: () => original.call(this) }) {
        if (size <= MAX_BODY && Buffer.isBuffer(chunk)) {
          size += chunk.byteLength;
          if (size <= MAX_BODY) parts.push(Buffer.from(chunk));
          else parts.length = 0;
        } else { size = MAX_BODY + 1; parts.length = 0; }
        yield chunk;
      }
      if (size > 0 && size <= MAX_BODY && witness.active && !attached) {
        attached = true;
        try {
          witness.request = decode(parts, size, method);
          if (method === 'prompt' && typeof witness.request?.sessionId === 'string') {
            witness.agent = ctx.agents.get(witness.request.sessionId);
            const route = witness.agent?.model.current();
            witness.route = route && Object.freeze({ ...route });
          }
        } catch (_error) { /* The stock parser owns malformed requests; grant no evidence. */ }
      }
    }
    try { Object.defineProperty(req, Symbol.asyncIterator, { configurable: true, value: observe }); }
    catch (_error) { return next(); }
    try { return await storage.run(witness, next); }
    finally {
      witness.active = false;
      witness.request = undefined;
      witness.agent = undefined;
      witness.route = undefined;
      if (req[Symbol.asyncIterator] === observe) {
        if (own) Object.defineProperty(req, Symbol.asyncIterator, own);
        else delete req[Symbol.asyncIterator];
      }
    }
  });
  return Object.freeze({
    off,
    isQueueSteer(session, message) {
      const evidence = storage.getStore();
      const req = evidence?.request;
      return evidence?.active && evidence.method === 'updateQueue' && req?.sessionId === session.id
        && req.itemId === message.id && req.action?.kind === 'steer';
    },
    changedPromptRoute(agent, selection, message, provider) {
      const evidence = storage.getStore();
      return evidence?.active && evidence.method === 'prompt' && evidence.request?.sessionId === agent.id
        && (evidence.route?.provider === provider || selection?.provider === provider)
        && evidence.request.requestId === message.source?.rpcId && (evidence.agent !== agent || !sameRoute(evidence.route, selection));
    },
    take({ agent, selection, inserted, previous, target }) {
      const evidence = storage.getStore();
      const request = evidence?.request;
      if (!evidence?.active || !evidence.browser || evidence.used || !request || request.sessionId !== agent.id || evidence.peer.signal.aborted
        || evidence.peer !== ctx.connection.browserPeer || ctx.connection.allowsRemoteAuthorities !== false
        || inserted.source?.kind !== 'user' || inserted.source.principal !== undefined) return;
      if (previous === undefined) {
        if (evidence.method !== 'prompt' || request.mode !== 'queue' || target !== 'next-turn' || evidence.agent !== agent
          || !sameRoute(evidence.route, selection) || !matchesPrompt(request, inserted)) return;
      } else if (evidence.method !== 'updateQueue' || target !== 'next-turn' || request.action?.kind !== 'edit'
        || request.itemId !== previous.id || inserted.id !== previous.id || !isDeepStrictEqual(previous.source, inserted.source)
        || !isDeepStrictEqual(request.action.content, inserted.content)) return;
      const text = agySubscriptionText(previous === undefined ? request.content : request.action.content);
      if (text === undefined) return;
      evidence.used = true;
      return Object.freeze({ peer: evidence.peer, text });
    },
  });
}
