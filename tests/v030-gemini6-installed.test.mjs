import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { agyGptBridgeTools } from '../src/agy-local-gpt-bridge.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';
import { openAgyMcp } from '../lib/agy-local-mcp.js';
import { apply as applyAgyPlugin } from '../lib/agy-local-plugin.js';

const textBlock = text => ({ type: 'text', text });

test('Upgrade 1 (installed): agy-local-plugin mounts on loopback even with remote authorities and admits owner user messages without HTTP witness', async () => {
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

test('Upgrade 4 (installed): openAgyMcp serves built-in parallel GPT bridge tools over Streamable HTTP MCP', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mcp-http-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const parentAgent = {
    id: 'session-parent-mcp',
    session: { header: { id: 'session-parent-mcp', cwd: root } },
    model: { current: () => ({ provider: 'antigravity', model: 'gemini-3-flash' }) },
  };
  const controller = {
    async list() {
      return { items: [{ sessionId: parentAgent.id, cwd: root, running: true, updatedAt: 100, projections: { values: { title: 'Main' } } }] };
    },
    async create() { return { sessionId: 'session-child-1' }; },
    async selectModel({ provider, model }) { return { selected: { provider, model } }; },
    async rename({ title }) { return { title, seq: 1 }; },
    async prompt() { return { accepted: true }; },
    async wait() { return { reason: 'idle', state: { cursor: 2, active: true, running: false, queue: [], pendingInput: [] }, output: { records: [], truncated: false } }; },
    async state() { return { cursor: 1, active: true, running: false, queue: [], pendingInput: [] }; },
    async events() { return { cursor: 1, hasMore: false, records: [] }; },
    async cancel() { return { accepted: true }; },
  };
  const services = new Map([
    ['sessionController', controller],
    ['llm', { listProviders: () => [{ id: 'codex' }], listModels: async () => [{ id: 'gpt-6.2-sol' }] }],
  ]);
  const ctx = { get: name => services.get(name) };
  const builtinTools = agyGptBridgeTools(ctx);
  const bridge = await openAgyMcp(ctx);
  t.after(() => bridge.close());

  const { url, headers } = bridge.servers[0];
  const auth = { authorization: headers[0].value, 'content-type': 'application/json' };
  const callRpc = async (method, params = {}) => {
    const res = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(res.status, 200);
    return res.json();
  };

  let canCall = false;
  bridge.setTurn({ agent: parentAgent, tools: new Map(), builtinTools, signal: new AbortController().signal, canCall: () => canCall });
  const listResp = await callRpc('tools/list');
  assert.deepEqual(listResp.result.tools.map(x => x.name).sort(), [
    'dsh_delegate_gpt', 'dsh_gpt_list', 'dsh_gpt_status', 'dsh_gpt_stop', 'dsh_gpt_wait',
  ]);
  const denied = await callRpc('tools/call', { name: 'dsh_gpt_list', arguments: {} });
  assert.equal(denied.error.code, -32602);

  canCall = true;
  const okList = await callRpc('tools/call', { name: 'dsh_gpt_list', arguments: {} });
  assert.equal(okList.result.isError, false);
  const parsed = JSON.parse(okList.result.content[0].text);
  assert.equal(parsed.sessions[0].sessionId, parentAgent.id);

  const blockedGoogle = await callRpc('tools/call', { name: 'dsh_delegate_gpt', arguments: { prompt: 'x', provider: 'antigravity' } });
  assert.equal(blockedGoogle.result.isError, true);
  assert.match(blockedGoogle.result.content[0].text, /Google Antigravity is forbidden/);
});

test('Parallel GPT placement (installed) records the workspace cwd and membership in real DSH sessions', async t => {
  const h = await createTurnHost(t, { releasedReader: true });
  const home = join(h.root, 'synthetic-home');
  await mkdir(home);
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previousHome = process.env[homeVar];
  process.env[homeVar] = home;
  try {
    const parent = h.agent(await h.create());
    const registry = h.ctx.workspaceRegistry;
    const delegate = agyGptBridgeTools(h.ctx).get('dsh_delegate_gpt');
    // Only the fixture Codex adapter can receive the synthetic prompt.
    const start = args => delegate.execute({ ...ORDINARY_SELECTION, prompt: 'Synthetic delegation', title: '[GPT] Build（GPT）', wait: true, ...args }, { agent: parent }, t.signal);
    const explicit = await start({ cwd: `${h.cwd}/.` });
    assert.equal(explicit.title, 'Build（GPT）');
    assert.equal(explicit.reason, 'idle');
    assert.equal(h.agent(explicit.sessionId).session.header.cwd, h.workspace.path);
    assert.ok(h.workspace.sessionIds.includes(explicit.sessionId));

    const nested = join(h.cwd, 'unregistered');
    await mkdir(nested);
    const grouped = await start({ cwd: nested });
    const defaultPath = join(home, '.dsh', 'workspaces', 'GPT');
    const gpt = await registry.resolveByPath(defaultPath);
    assert.equal(gpt.title, 'GPT');
    assert.equal(grouped.title, 'Build');
    assert.equal(grouped.reason, 'idle');
    assert.equal(h.agent(grouped.sessionId).session.header.cwd, gpt.path);
    assert.equal((await h.ctx.sessionController.projections({ sessionId: grouped.sessionId }, t.signal)).values.title, 'Build');
    assert.deepEqual(gpt.sessionIds, [grouped.sessionId]);
    assert.equal(await registry.resolveByPath(nested), undefined, 'unmatched cwd is not registered itself');
    assert.ok(!h.workspace.sessionIds.includes(grouped.sessionId));

    const continued = await delegate.execute({ sessionId: grouped.sessionId, prompt: 'Synthetic follow-up', title: 'Do not rename', cwd: h.cwd, wait: true }, { agent: parent }, t.signal);
    assert.equal(continued.sessionId, grouped.sessionId);
    assert.equal(continued.reason, 'idle');
    assert.deepEqual(gpt.sessionIds, [grouped.sessionId]);
    assert.equal((await h.ctx.sessionController.projections({ sessionId: grouped.sessionId }, t.signal)).values.title, 'Build');
    assert.deepEqual(h.selects, [], 'no default model preference was changed');
    assert.deepEqual(h.ordinaryCalls.map(call => call.sessionId), [explicit.sessionId, grouped.sessionId, grouped.sessionId]);
  } finally {
    if (previousHome === undefined) delete process.env[homeVar];
    else process.env[homeVar] = previousHome;
  }
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
