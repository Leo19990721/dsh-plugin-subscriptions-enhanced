import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { composeEntries, evaluatePluginCompatibility, getDshRuntimeVersion, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import LlmRuntime from '@deepseek-ai/dsh-llm';

test('DSH accepts this release across the intended 0.2.x range without a version exemption', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(evaluatePluginCompatibility(manifest), undefined, `runs on DSH ${getDshRuntimeVersion()}`);
  const { engines: _engines, ...withPeerRequirements } = manifest;
  for (const version of ['0.2.2-rc.3', '0.2.2-rc.5', '0.2.2', '0.2.3-rc.1']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version);
    assert.equal(evaluatePluginCompatibility(withPeerRequirements, {}, version), undefined, version);
  }
  for (const version of ['0.2.2-rc.2', '0.3.0-rc.1', '0.3.0']) {
    const rejection = evaluatePluginCompatibility(manifest, {}, version);
    assert.equal(rejection?.requirements['engines.dsh'], manifest.engines.dsh, version);
    assert.equal(rejection.exempted, false);
  }
});

test('installed Models settings exposes the subscription footer after its add-provider control', async () => {
  const dir = join(process.env.DSH_INSTALL_DIR, '../dsh-client-ui-settings-models/src/client');
  const [registration, section] = await Promise.all(['index.ts', 'ModelsSection.tsx'].map(file => readFile(join(dir, file), 'utf8')));
  assert.match(registration, /'settings\.models\.footer':\s*\{\s*kind: 'list',\s*scope: 'root'\s*\}/);
  const add = section.indexOf("{t('add')}");
  assert.ok(add >= 0, 'native Add control still exists');
  assert.ok(section.indexOf("renderSlot('settings.models.footer', {})") > add, 'subscription footer follows the native control');
});

test('installed DSH composes Enhanced alone or as a replacement for the earlier stock row', () => {
  const patch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url));
  const enhanced = loadOverlayPatches('subscriptions-fixture', patch);
  const stock = [{ insert: [{ id: 'llm-subscriptions', name: 'dsh-plugin-subscriptions' }] }];
  const warnings = [];
  const alone = composeEntries([enhanced], warning => warnings.push(warning));
  assert.deepEqual(alone.map(({ id }) => id), ['llm-subscriptions-enhanced', 'preset-writing']);
  assert.ok(warnings.every(warning => warning === 'patch: entry "llm-subscriptions" not found'));
  const replaced = composeEntries([stock, enhanced], warning => assert.fail(warning));
  assert.equal(replaced.find(row => row.id === 'llm-subscriptions').disabled, true);
  assert.deepEqual(replaced.filter(row => !row.disabled).map(({ id }) => id), alone.map(({ id }) => id));
});

// Mount the shipped plugin on the real DSH LLM registry. The only data and
// responses are synthetic; no browser, live account, or provider network I/O.
test('bundled GPT keeps the original account, RPC and native LLM stream', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'subscriptions-fixture-')));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  const ctx = new Context();
  let base, plugin;
  try {
    const provider = 'codex';
    const model = 'gpt-fixture';
    const account = 'workspace-fixture';
    const auth = join(home, 'plugins', 'subscriptions', 'auth.json');
    await mkdir(dirname(auth), { recursive: true });
    await writeFile(auth, JSON.stringify({ codex: { default: account, accounts: {
      [account]: { accountId: account, accessToken: 'fixture-expired', refreshToken: 'fixture-refresh', expiresAt: 1, planType: 'plus' },
    } } }));

    const calls = [];
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const path = new URL(input).pathname;
      calls.push(path);
      switch (path) {
        case '/oauth/token':
          assert.equal(init.method, 'POST');
          assert.equal(JSON.parse(init.body).refresh_token, 'fixture-refresh');
          return Response.json({ access_token: 'fixture-renewed', expires_in: 3600 });
        case '/backend-api/codex/responses': {
          const request = JSON.parse(init.body);
          assert.equal(init.headers.authorization, 'Bearer fixture-renewed');
          assert.equal(init.headers['chatgpt-account-id'], account);
          assert.equal(request.model, model);
          assert.equal(request.instructions, 'Synthetic DSH system prompt.');
          assert.equal(request.stream, true);
          const events = [
            { type: 'response.output_text.delta', item_id: 'message-fixture', delta: 'Fixture reply' },
            { type: 'response.completed' },
          ];
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        case '/backend-api/wham/usage':
          return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } });
        case '/backend-api/wham/rate-limit-reset-credits':
          return Response.json({ credits: [] });
        default:
          throw new Error(`Unexpected fixture fetch: ${path}`);
      }
    });

    base = ctx.plugin({ apply(scope) {
      new LlmRuntime(scope);
      Object.assign(new Service(scope, 'connection', true), { fetch: {
        register(route) {
          assert.equal(routes.has(route.path), false);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      } });
    } });
    while (base.inertia) await base.inertia;
    if (base.state === 3) throw base._error;
    assert.equal(base.state, 2);
    const subscriptions = await import('../lib/index.js');
    assert.deepEqual(subscriptions.Config['~standard'].validate({}).value.providers,
      ['codex', 'claude', 'grok', 'copilot', 'antigravity']);
    // The status RPC also checks versions for enabled providers; keep it from
    // invoking a local Claude CLI outside this fixture.
    plugin = ctx.plugin(subscriptions, {
      providers: [provider], models: { codex: [{ id: model, inputModalities: ['text'] }] },
      codexClientVersion: '0.153.4', pool: { enabled: false },
    });
    while (plugin.inertia) await plugin.inertia;
    if (plugin.state === 3) throw plugin._error;
    assert.equal(plugin.state, 2);
    assert.deepEqual(ctx.llm.listProviders().map(item => item.id), [provider]);
    assert.deepEqual((await ctx.llm.listModels(provider)).map(item => item.id), [model]);

    async function rpc(endpoint, payload) {
      const method = `subscriptions-auth.${endpoint}`;
      const route = routes.get(`/api/${method}`);
      assert.ok(route, `${method} registered`);
      const response = await route.fetch(new Request(`https://fixture.invalid${route.path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method, payload }),
      }));
      const envelope = await response.json();
      assert.equal(envelope.rpcId, endpoint);
      assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error));
      return envelope.result.value;
    }
    const status = (await rpc('status', {})).providers.codex;
    assert.deepEqual(status.accounts.map(({ key, isDefault, plan }) => ({ key, isDefault, plan })), [{ key: account, isDefault: true, plan: 'plus' }]);
    assert.deepEqual(calls, [], 'viewing the stored account and fixed model does not refresh');
    const chunks = [];
    for await (const chunk of ctx.llm.stream({ provider, model, system: 'Synthetic DSH system prompt.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture question' }] }],
    })) chunks.push(chunk);
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['Fixture reply']);
    assert.deepEqual(chunks.at(-1)?.reason, { kind: 'stop' });
    assert.equal(JSON.parse(await readFile(auth, 'utf8')).codex.accounts[account].accessToken, 'fixture-renewed');
    assert.deepEqual((await rpc('usage', { provider, account })).windows, [{ kind: 'session', durationMs: 18000000, usedPercent: 12 }]);
    assert.deepEqual(calls, ['/oauth/token', '/backend-api/codex/responses', '/backend-api/wham/usage', '/backend-api/wham/rate-limit-reset-credits']);
  } finally {
    await plugin?.dispose();
    await base?.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
  assert.equal(routes.size, 0);
});
