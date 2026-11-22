import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { apply as applyAgyPlugin } from '../lib/agy-local-plugin.js';

const textBlock = text => ({ type: 'text', text });

test('Upgrade 1 (installed): agy-local-plugin mounts on loopback even with remote authorities with remote authorities enabled', async () => {
  const registered = [];
  const ctx = {
    webServer: { host: '127.0.0.1' },
    connection: {
      allowsRemoteAuthorities: true,
      admit: () => ({ rejection: 401 }),
      fetch: { register() {} },
    },
    llm: { registerAdapter(providers, adapter) { registered.push({ providers, adapter }); return () => {}; } },
    agents: {
      get: () => undefined,
      turnBoundaryOf: () => ({ openTurnStartSeq: 0, lastStepStartSeq: 0, lastTurn: 1 }),
    },
    logger: { warn() {} },
    get: () => undefined,
    on: () => () => {},
    effect: fn => fn(),
  };
  applyAgyPlugin(ctx, {});
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].providers, ['antigravity']);

  const nonLoopback = [];
  applyAgyPlugin({
    ...ctx,
    webServer: { host: '0.0.0.0' },
    llm: { registerAdapter(providers, adapter) { nonLoopback.push({ providers, adapter }); return () => {}; } },
  }, {});
  assert.equal(nonLoopback.length, 0);
});

test('Upgrade 3 (installed): built Host discovers Codex ultrafast, sends service_tier="ultrafast", and exposes /speed for Desktop & DSH Go', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'subscriptions-ultrafast-')));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  const commands = new Map();
  const sentBodies = [];
  const ctx = new Context();
  let base, plugin;
  try {
    const account = 'uf-fixture-acct';
    const auth = join(home, 'plugins', 'subscriptions', 'auth.json');
    await mkdir(dirname(auth), { recursive: true });
    await writeFile(auth, JSON.stringify({ codex: { default: account, accounts: {
      [account]: { accountId: account, accessToken: 'fixture-valid-token', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, planType: 'pro' },
    } } }));

    // Seed a pre-upgrade models.json WITHOUT ultrafastTier to confirm automatic SWR refresh!
    const modelsCache = join(home, 'plugins', 'subscriptions', 'models.json');
    await writeFile(modelsCache, JSON.stringify({
      codex: {
        at: Date.now(),
        models: [{ id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol', fastTier: true }],
      },
    }));

    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const path = new URL(input).pathname;
      if (path === '/backend-api/codex/models') {
        return Response.json({
          models: [
            {
              slug: 'gpt-6.2-sol',
              display_name: 'GPT-6.2-Sol',
              visibility: 'list',
              priority: 0,
              service_tiers: [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }],
              additional_speed_tiers: ['fast', 'ultrafast'],
            },
            {
              slug: 'gpt-6.1-sol',
              display_name: 'GPT-6.1-Sol',
              visibility: 'list',
              priority: 1,
              service_tiers: [{ id: 'priority', name: 'Fast' }],
              additional_speed_tiers: ['fast'],
            },
          ],
        });
      }
      if (path === '/backend-api/codex/responses') {
        sentBodies.push(JSON.parse(init.body));
        const events = [
          { type: 'response.output_text.delta', item_id: 'msg-1', delta: 'Ultrafast OK' },
          { type: 'response.completed' },
        ];
        return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    base = ctx.plugin({ apply(scope) {
      new LlmRuntime(scope);
      Object.assign(new Service(scope, 'connection', true), { fetch: {
        register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
      } });
      Object.assign(new Service(scope, 'commands', true), {
        register(def) { commands.set(def.name, def); return () => commands.delete(def.name); },
      });
    } });
    while (base.inertia) await base.inertia;
    const subscriptions = await import('../lib/index.js');
    plugin = ctx.plugin(subscriptions, {
      providers: ['codex'], codexClientVersion: '0.153.4', pool: { enabled: false },
    });
    while (plugin.inertia) await plugin.inertia;

    async function rpc(endpoint, payload) {
      const method = `subscriptions-auth.${endpoint}`;
      const route = routes.get(`/api/${method}`);
      const response = await route.fetch(new Request(`https://fixture.invalid${route.path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method, payload }),
      }));
      const envelope = await response.json();
      assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error));
      return envelope.result.value;
    }

    // 1. Catalog automatically refreshed pre-upgrade cache and discovered ultrafast on gpt-6.2-sol
    const speedInitial = await rpc('speed', { sessionId: 'sess-uf', model: 'gpt-6.2-sol' });
    assert.deepEqual(speedInitial.fastModels, ['gpt-6.2-sol', 'gpt-6.1-sol']);
    assert.deepEqual(speedInitial.ultrafastModels, ['gpt-6.2-sol']);
    assert.equal(speedInitial.tier, 'standard');

    // 2. Host-side /speed command works for mobile DSH Go & Desktop!
    const speedCmd = commands.get('speed');
    assert.ok(speedCmd, 'Host /speed command registered');
    const mockAgent = (model) => ({
      id: 'sess-uf',
      model: { current: () => ({ provider: 'codex', model }) },
    });

    // Switch via Chinese alias "/speed 超快"
    const resSet = await speedCmd.handler({ agent: mockAgent('gpt-6.2-sol'), rawInput: ' 超快' });
    assert.equal(resSet.kind, 'success');
    assert.match(resSet.text, /超快/);

    // Reject ultrafast on fast-only model gpt-6.1-sol
    const resBad = await speedCmd.handler({ agent: mockAgent('gpt-6.1-sol'), rawInput: 'ultrafast' });
    assert.equal(resBad.kind, 'error');
    assert.match(resBad.text, /不支持 ultrafast/);

    // 3. Stream request on gpt-6.2-sol actually sends service_tier: "ultrafast"
    const chunks = [];
    for await (const chunk of ctx.llm.stream({
      provider: 'codex', model: 'gpt-6.2-sol', sessionId: 'sess-uf', system: 'sys',
      messages: [{ role: 'user', content: [textBlock('hello ultrafast')] }],
    })) chunks.push(chunk);
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0].service_tier, 'ultrafast');

    // Persisted in model-speeds.json
    const persisted = JSON.parse(await readFile(join(home, 'plugins', 'subscriptions', 'model-speeds.json'), 'utf8'));
    assert.equal(persisted['gpt-6.2-sol'], 'ultrafast');
  } finally {
    await plugin?.dispose();
    await base?.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
