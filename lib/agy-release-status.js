import { hasAgyNativeTurnHost } from './agy-compatibility.js';
import { AGY_API, exactKeys, installAgyWitness, readAgyEnvelope } from './agy-ingress.js';

export const name = 'subscriptions-enhanced-antigravity-status';
export const inject = ['connection', 'webServer'];

const privateHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const empty = status => new Response(null, { status, headers: privateHeaders });

/** Report availability without provisioning a CLI, binding a Session or mounting a model. */
export function apply(ctx) {
  const gate = installAgyWitness(ctx);
  let stopped = false;
  ctx.effect(() => () => { stopped = true; return gate.dispose(); }, 'Antigravity status lifetime');
  ctx.connection.fetch.register({
    path: AGY_API, methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      if (stopped || request.signal.aborted || !gate.take('bridge')) return empty(403);
      let envelope;
      try { envelope = await readAgyEnvelope(request); }
      catch (_error) { return empty(400); }
      if (stopped || request.signal.aborted) return empty(403);
      const { rpcId, payload } = envelope;
      if (!exactKeys(payload, ['action']) || payload.action !== 'status') return empty(400);
      // Host methods alone do not establish compatible queue teardown or Desktop wiring.
      const reason = hasAgyNativeTurnHost(ctx) ? 'integration-unavailable' : 'native-turn-required';
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { available: false, reason } } }, {
        headers: privateHeaders,
      });
    },
  });
}
