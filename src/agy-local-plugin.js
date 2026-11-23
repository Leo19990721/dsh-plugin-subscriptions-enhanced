import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { AGY_API, AGY_LOOPBACK, exactKeys, installAgyWitness, readAgyEnvelope } from './agy-ingress.js';
import { GOOGLE, mountLocalGoogle } from './agy-local-host.js';
import { createLocalAgy } from './agy-local-runtime.js';
import { installAgyLineage } from './agy-local-lineage.js';

export const name = 'subscriptions-enhanced-google-local';
export const inject = ['llm', 'agents', 'connection', 'webServer', 'tools'];
const headers = { 'cache-control': 'no-store' };


export function apply(ctx, config = {}, makeRuntime = createLocalAgy) {
  const enabled = AGY_LOOPBACK.test(ctx.webServer.host ?? '');
  const witness = installAgyWitness(ctx, { nativeActions: true, localCarrier: true });
  let google, cardsUntil = 0;
  // The desktop browser advertises presentation support only. The capability
  // cannot authorize a prompt, change a tool set or read any session data.
  let appendDisplayRecord;
  const loadDisplayRecord = enabled
    ? import('@deepseek-ai/dsh-session').then(({ appendPluginRecord }) => {
      if (typeof appendPluginRecord === 'function') appendDisplayRecord = appendPluginRecord;
      return appendDisplayRecord;
    }).catch(() => undefined)
    : Promise.resolve(undefined);
  if (enabled) {
    const home = resolveDshHome();
    const authorize = installAgyLineage(ctx, witness.isLocalSubmission, (agent, message) => google?.matchesBackground(agent, message));
    google = mountLocalGoogle(ctx, { ...config, toolCards: () => cardsUntil > Date.now() ? appendDisplayRecord : undefined }, makeRuntime({ ...config,
      dataDir: config.dataDir || join(process.env.DSH_PROFILE_DIR || home, 'plugin-data', 'subscriptions-enhanced', 'agy'),
      agentsFile: config.agentsFile ?? join(home, 'AGENTS.md'),
    }), authorize);
  }
  ctx.connection.fetch.register({ path: AGY_API, methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    const privileged = witness.take('bridge');
    if ((!privileged && !witness.take('presentation')) || request.signal.aborted) return new Response(null, { status: 403, headers });
    let input;
    try { input = await readAgyEnvelope(request); }
    catch { return new Response(null, { status: 400, headers }); }
    const { rpcId, payload } = input;
    if (!exactKeys(payload, ['action']) || !['status', 'inspect', 'login', 'logout', 'quota', 'tool-cards-v1'].includes(payload.action)) return new Response(null, { status: 400, headers });
    const { action } = payload;
    if (action === 'tool-cards-v1') {
      const writer = appendDisplayRecord ?? await loadDisplayRecord;
      if (writer) cardsUntil = Date.now() + 90_000;
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { enabled: Boolean(writer) } } }, { headers });
    }
    if (!privileged) return new Response(null, { status: 403, headers });
    if (!google) {
      if (action !== 'status' && action !== 'inspect') {
        return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'AGY_UNAVAILABLE', message: '本机 Google Antigravity 接入不可用。' } } }, { headers });
      }
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { status: 'unavailable', modelCount: 0 } } }, { headers });
    }
    try {
      let value;
      switch (action) {
        case 'quota': value = await google.fetchQuota(request.signal); break;
        case 'login': value = await google.login(request.signal); break;
        case 'logout': value = await google.logout(request.signal); break;
        default: value = await google.inspect(action === 'inspect');
      }
      return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, { headers });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'AGY_AUTH_FAILED';
      const message = error instanceof Error && error.message ? error.message : 'Google Antigravity 操作未完成。';
      return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code, message } } }, { headers });
    }
  } });
}
