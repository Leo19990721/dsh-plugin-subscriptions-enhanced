import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { retireAntigravityHost, retireAntigravityClient } from '../scripts/retire-antigravity.mjs';
import { patchModelsSettings } from '../scripts/models-settings-patch.mjs';

const require = createRequire(import.meta.url);
const root = process.env.SUBSCRIPTIONS_UPSTREAM_DIR ?? dirname(require.resolve('dsh-plugin-subscriptions/package.json'));
const sha = text => createHash('sha256').update(text).digest('hex');
const [upstreamHost, upstreamClient] = await Promise.all(['index.js', 'client.js'].map(file => readFile(join(root, 'lib', file), 'utf8')));
assert.equal(sha(upstreamHost), 'b5d71b623f9155d206587ca77fe7b9458427cb881b92dc91b24a958587eea7b4');
assert.equal(sha(upstreamClient), '4bc997d564f8ec7ad6434a760df94bb2d32b73889153c9f0fc3524c96a5c961b');
const host = retireAntigravityHost(upstreamHost);
const client = retireAntigravityClient(upstreamClient);
const supported = ['codex', 'claude', 'grok', 'copilot'];
const endpoints = /cloudcode-pa|cloudaicompanion|googleusercontent\.com|oauth2\.googleapis\.com|accounts\.google\.com|loadCodeAssist|onboardUser|retrieveUserQuotaSummary|streamGenerateContent|\bgenerateContent\b/i;

function region(source, name) {
  const marker = `//#region ${name}\n`;
  const start = source.indexOf(marker);
  const end = source.indexOf('\n//#endregion', start);
  assert.ok(start !== -1 && end > start, `find ${name}`);
  return source.slice(start + marker.length, end);
}

test('removes retired Host code while keeping other provider adapters and tools byte identical', () => {
  assert.doesNotMatch(host, endpoints);
  assert.doesNotMatch(host, /AntigravityAdapter|exchangeAntigravityCode|refreshAntigravity|(?:antigravity|gemini-prompt)\.js|antigravityConfig|thoughtSignature/);
  assert.deepEqual(host.split('\n').filter(line => /antigravity/i.test(line)).map(line => line.trim()), [
    'const ARCHIVED_PROVIDER = "antigravity";',
    '(members) => members[0]?.provider === "antigravity" ? [] : members.filter((member) => member.provider !== "antigravity"));',
    '(ids) => ids.filter((id) => id !== "antigravity")).default(PROVIDER_IDS),',
  ]);
  for (const provider of supported) assert.equal(region(host, `src/providers/${provider}.ts`), region(upstreamHost, `src/providers/${provider}.ts`));
  for (const tool of ['image-generate', 'video-generate', 'x-search']) assert.equal(region(host, `src/tools/${tool}.ts`), region(upstreamHost, `src/tools/${tool}.ts`));
  assert.equal(region(host, 'src/http.ts'), region(upstreamHost, 'src/http.ts'));
  assert.match(host, /id: "gemini-2\.5-pro",\n\s+name: "Gemini 2\.5 Pro"/);
});

test('fails on missing, duplicated or edited seams and unexpected old code', () => {
  assert.throws(() => retireAntigravityHost(upstreamHost.replace('//#region src/providers/antigravity-oauth-client.ts\n', '')), /unexpected seam \(src\/providers\/antigravity-oauth-client\.ts\)/);
  assert.throws(() => retireAntigravityHost(upstreamHost.replace('//#region src/providers/antigravity.ts\n', '//#region src/providers/antigravity.ts\n// changed\n')), /unexpected seam \(src\/providers\/antigravity\.ts\)/);
  assert.throws(() => retireAntigravityHost(`${upstreamHost}\n// loadCodeAssist\n`), /old provider code still present/);
  assert.throws(() => retireAntigravityClient(upstreamClient.replace('//#region src/client/AntigravityQuotaSummary.tsx\n', ('//#region src/client/AntigravityQuotaSummary.tsx\n').repeat(2))), /unexpected seam \(src\/client\/AntigravityQuotaSummary\.tsx\)/);
  assert.throws(() => retireAntigravityClient(upstreamClient.replace('id: "antigravity",', 'id: "typo",')), /unexpected seam \(account selection\)/);
});

function clientSelections(source) {
  const end = 'return module.exports; } });';
  assert.equal(source.split(end).length, 2);
  const code = source.replace(end, 'module.exports = { PROVIDERS, retainSubscriptionSelection };\n' + end);
  let module;
  new Script(code).runInNewContext({ window: { __ModuleLoader__: { load(descriptor) {
    assert.equal(module, undefined);
    module = descriptor;
  } } } }, { timeout: 1000 });
  return module.factory(id => {
    assert.ok(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'].includes(id));
    return { forwardRef: render => render, useAnchoredPosition() {}, useDismissOnOutsidePointer() {} };
  });
}

test('retired accounts disappear from the stock Client and the enhanced Models footer', async () => {
  // Reproduce the existing Models enhancement in memory before retirement.
  const replaceOnce = (source, before, after) => {
    assert.equal(source.split(before).length, 2, before);
    return source.replace(before, () => after);
  };
  const badge = await readFile(new URL('../src/badge-compat.js', import.meta.url), 'utf8');
  const settings = (await readFile(new URL('../src/models-settings-ui.js', import.meta.url), 'utf8')).replace(/^export (?=function )/gm, '');
  const enhanced = patchModelsSettings(upstreamClient
    .replace('(0, __deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)', 'enhancedAnchoredPosition')
    .replace('(0, __deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)', 'enhancedDismissOutside'), replaceOnce)
    .replace('return module.exports; } });', `${badge}\n${settings}\nreturn module.exports; } });`);
  const enhancedClient = retireAntigravityClient(enhanced);
  assert.match(enhancedClient, /registerEnhancedModelsSettings\(ctx, connection, t, SubscriptionsSection\);/);
  assert.match(enhancedClient, /id: ['"]subscriptions-enhanced-accounts['"]/);
  for (const code of [client, enhancedClient]) {
    assert.doesNotMatch(code, /antigravity|usageGeminiModels|usageArgon|usageBadgeModelCount/i);
    assert.doesNotMatch(code, endpoints);
    assert.match(code, /Object\.keys\(statusResp\.providers\)\.filter\(\(id\) => Object\.hasOwn\(PROVIDER_NAMES, id\)\)/);
    assert.match(code, /id: "codex-speed"/);
    assert.match(code, /id: "subscription-usage"/);
    const { PROVIDERS, retainSubscriptionSelection } = clientSelections(code);
    assert.deepEqual(Array.from(PROVIDERS, row => row.id), supported);
    const codex = { provider: 'codex', model: 'gpt-fixture' };
    assert.equal(retainSubscriptionSelection(undefined, codex), codex);
    assert.equal(retainSubscriptionSelection(codex, { provider: 'antigravity', model: 'gemini-fixture' }), codex);
  }
});

// Mount the actual candidate with the desktop LLM and schema runtime when
// available. A closed in-memory filesystem backs the Host, so even an
// unexpected path cannot touch an installed profile, a token, or the disk.
const installedSkip = process.versions.electron && process.env.DSH_INSTALL_DIR && process.env.DSH_PROFILE_DIR
  ? false : 'requires DSH desktop in Node mode with scripts/runtime-hook.mjs';

test('desktop Config, auth RPC and Codex refresh keep legacy JSON opaque', { skip: installedSkip }, async t => {
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');
  const auth = 'fixture://plugins/subscriptions/auth.json';
  const oldAuth = 'fixture://plugins/router/auth.json';
  const prefs = 'fixture://plugins/subscriptions/provider-settings.json';
  const defaults = 'fixture://plugins/subscriptions/model-defaults.json';
  const cache = 'fixture://plugins/subscriptions/models.json';
  const account = 'codex-fixture';
  const model = 'gpt-fixture';
  // A deliberately unmigrated/invalid entry: preserving it cannot rely on
  // today's token validation, account shape, default key or project ID.
  const archived = {
    default: 'absent-fixture',
    accounts: { old: { accessToken: 'retired-fixture', refreshToken: 'retired-fixture-refresh', expiresAt: 1 }, malformed: null },
    extension: { array: [null, 0, '', { '非 ASCII': '保留' }] },
  };
  const archivedPrefs = { accounts: { old: { alias: 'keep fixture' } }, future: true };
  const archivedRevision = { provider: 'antigravity', at: 'old format fixture', tools: { untouched: true } };
  const archivedDefaults = { 'fixture-old-model': { legacyFormat: true } };
  const raw = {
    antigravity: archived,
    codex: { default: account, accounts: {
      [account]: { accountId: account, accessToken: 'expired-fixture', refreshToken: 'codex-fixture-refresh', expiresAt: 1, planType: 'plus' },
      'codex-next': { accountId: 'codex-next', accessToken: 'next-fixture', refreshToken: 'next-refresh-fixture', expiresAt: 9e12 },
    } },
  };
  const files = new Map([
    [auth, JSON.stringify(raw)],
    [prefs, JSON.stringify({ providers: { antigravity: archivedPrefs }, toolHistory: [archivedRevision] })],
    [defaults, JSON.stringify({ antigravity: archivedDefaults })],
    [cache, JSON.stringify({ antigravity: { legacy: true }, accounts: { antigravity: { old: true } } })],
  ]);
  const pathChecks = /^(?:fixture:\/\/plugins\/subscriptions\/(?:auth|provider-settings|model-defaults|models|proxy|model-speeds)\.json(?:\..*)?|fixture:\/\/plugins\/router\/auth\.json)$/;
  const checked = path => { assert.ok(pathChecks.test(path), `unexpected test filesystem path ${path}`); return path; };
  const readSync = path => {
    if (!files.has(checked(path))) throw Object.assign(new Error('fixture file not found'), { code: 'ENOENT' });
    return files.get(path);
  };
  const writes = [];
  const unexpected = what => { assert.fail(`unexpected fixture operation ${what}`); };
  const fixtureIO = {
    readFileSync: readSync,
    readFile: async path => readSync(path),
    mkdir: async () => {},
    writeFile: async (path, content) => { files.set(checked(path), String(content)); },
    chmod: async path => { checked(path); },
    rename: async (source, dest) => { files.set(checked(dest), readSync(source)); files.delete(source); writes.push(dest); },
    rm: async path => { files.delete(checked(path)); },
    dshHomePath: (...segments) => checked(`fixture://${segments.join('/')}`),
    unexpected,
  };
  const calls = [];
  const network = async (input, init) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.href === 'https://auth.openai.com/oauth/token') {
      assert.equal(init.method, 'POST');
      assert.equal(JSON.parse(init.body).refresh_token, 'codex-fixture-refresh');
      return Response.json({ access_token: 'renewed-fixture', expires_in: 3600 });
    }
    assert.equal(url.hostname, 'chatgpt.com', `unexpected synthetic endpoint: ${url.hostname}`);
    assert.equal(init.headers.authorization, 'Bearer renewed-fixture');
    assert.equal(init.headers['chatgpt-account-id'], account);
    switch (url.pathname) {
      case '/backend-api/codex/responses': {
        const body = JSON.parse(init.body);
        assert.equal(body.model, model);
        assert.equal(body.instructions, 'Fixture system prompt');
        return new Response([
          { type: 'response.output_text.delta', item_id: 'fixture-item', delta: 'Fixture reply' },
          { type: 'response.completed' },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      case '/backend-api/wham/usage':
        return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } });
      case '/backend-api/wham/rate-limit-reset-credits':
        return Response.json({ credits: [] });
      default: return unexpected(url.pathname);
    }
  };
  t.mock.method(globalThis, 'fetch', network);

  const fixtureKey = Symbol('retire-antigravity test filesystem');
  // Import the generated module and replace only side-effect boundaries. No
  // real files or login listener can be reached, including on a failed test.
  globalThis[fixtureKey] = fixtureIO;
  const exportsOf = names => `const io = globalThis[Object.getOwnPropertySymbols(globalThis).find(key => key.description === 'retire-antigravity test filesystem')];\n${names}`;
  const stubs = new Map([
    ['node:fs/promises', exportsOf('export const { chmod, mkdir, readFile, rename, rm, writeFile } = io;')],
    ['node:fs', exportsOf('export const { readFileSync } = io; export const chmodSync = io.unexpected, existsSync = io.unexpected, mkdirSync = io.unexpected, writeFileSync = io.unexpected;')],
    ['node:http', exportsOf('export const createServer = io.unexpected;')],
    ['node:child_process', exportsOf('export const execFileSync = io.unexpected;')],
    ['undici', exportsOf('export const ProxyAgent = io.unexpected, fetch = io.unexpected;')],
    ['@deepseek-ai/dsh-home-paths', exportsOf('export const { dshHomePath } = io;')],
  ]);
  const anchoredImports = new Map();
  for (const id of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-tools']) anchoredImports.set(id, import.meta.resolve(id));
  const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
  const candidateUrl = moduleUrl(host);
  const hooks = registerHooks({ resolve(id, context, next) {
    if (context.parentURL !== candidateUrl) return next(id, context);
    const url = stubs.has(id) ? moduleUrl(stubs.get(id)) : anchoredImports.get(id);
    return url ? { url, shortCircuit: true } : next(id, context);
  } });
  let subscriptions;
  try { subscriptions = await import(candidateUrl); }
  finally { hooks.deregister(); delete globalThis[fixtureKey]; }

  const validate = config => subscriptions.Config['~standard'].validate(config);
  assert.deepEqual(validate({}).value.providers, supported);
  const checkedConfig = validate({
    providers: ['antigravity', 'codex'],
    models: { codex: [{ id: model, inputModalities: ['text'] }], antigravity: [{ id: 'fixture-old-model' }] },
    antigravity: { clientSecret: 'retired-fixture-secret' },
    codexClientVersion: '0.153.4', pool: { enabled: false },
  });
  assert.equal(checkedConfig.issues, undefined);
  assert.deepEqual(checkedConfig.value.providers, ['codex']);
  assert.equal(checkedConfig.value.antigravity, undefined);
  assert.equal(checkedConfig.value.models.antigravity, undefined);
  assert.deepEqual(validate({ providers: ['antigravity'] }).value.providers, []);
  assert.ok(validate({ providers: ['unsupported-fixture'] }).issues);
  for (const group of ['families', 'tiers']) {
    const retired = { provider: 'antigravity', model: 'fixture-old-model' };
    const gpt = { provider: 'codex', model, account };
    const active = { provider: 'claude', model: 'fixture-active' };
    const updated = validate({ pool: { [group]: { old: [retired], oldMixed: [retired, gpt], current: [gpt, retired, active] } } });
    assert.equal(updated.issues, undefined);
    assert.deepEqual(updated.value.pool[group], { old: [], oldMixed: [], current: [gpt, active] });
    assert.ok(validate({ pool: { [group]: { unknown: [{ provider: 'unknown-fixture', model }] } } }).issues);
  }

  const ctx = new Context();
  const routes = new Map();
  const base = ctx.plugin({ apply(scope) {
    new LlmRuntime(scope);
    Object.assign(new Service(scope, 'connection', true), { fetch: { register(route) {
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    } } });
  } });
  t.after(async () => { await base.dispose(); assert.equal(routes.size, 0); });
  async function ready(fiber) {
    while (fiber.inertia) await fiber.inertia;
    if (fiber.state === 3) throw fiber._error;
    assert.equal(fiber.state, 2);
  }
  await ready(base);
  const plugin = ctx.plugin(subscriptions, checkedConfig.value);
  t.after(() => plugin.dispose());
  await ready(plugin);
  assert.deepEqual(ctx.llm.listProviders().map(row => row.id), ['codex']);
  assert.deepEqual((await ctx.llm.listModels('codex')).map(row => row.id), [model]);
  async function rpc(endpoint, payload = {}) {
    const method = `subscriptions-auth.${endpoint}`;
    const route = routes.get(`/api/${method}`);
    assert.ok(route, `${method} registered`);
    const response = await route.fetch(new Request(`https://fixture.invalid${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method, payload }),
    }));
    return (await response.json()).result;
  }
  async function ok(endpoint, payload) {
    const result = await rpc(endpoint, payload);
    assert.equal(result.ok, true, `${endpoint}: ${result.error?.message}`);
    return result.value;
  }
  const stored = path => JSON.parse(readSync(path));
  assert.deepEqual(Object.keys((await ok('status')).providers), supported);
  assert.deepEqual((await ok('status')).providers.codex.accounts.map(({ key }) => key), [account, 'codex-next']);
  for (const endpoint of ['login', 'manual', 'cancel', 'logout', 'setDefault', 'usage', 'providerSettings', 'setProviderSettings', 'setModelDefault']) {
    const response = await rpc(endpoint, { provider: 'antigravity', account: 'old', model: 'fixture-old-model', input: 'fixture-code', force: true });
    assert.equal(response.ok, false, endpoint);
    assert.equal(response.error.code, 'bad-request', endpoint);
  }
  assert.deepEqual(writes, [], 'basic account reads and rejected calls do not save');
  assert.deepEqual(calls, [], 'retired account operations do not contact any service');

  const chunks = [];
  for await (const chunk of ctx.llm.stream({ provider: 'codex', model, system: 'Fixture system prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture question' }] }],
  })) chunks.push(chunk);
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['Fixture reply']);
  assert.deepEqual(chunks.at(-1)?.reason, { kind: 'stop' });
  assert.equal(stored(auth).codex.accounts[account].accessToken, 'renewed-fixture');
  assert.deepEqual(stored(auth).antigravity, archived);
  assert.deepEqual((await ok('usage', { provider: 'codex', account })).windows, [{ kind: 'session', durationMs: 18_000_000, usedPercent: 12 }]);
  assert.deepEqual(calls, ['/oauth/token', '/backend-api/codex/responses', '/backend-api/wham/usage', '/backend-api/wham/rate-limit-reset-credits']);

  await ok('setProviderSettings', { provider: 'codex', settings: { displayName: 'Synthetic Codex', tools: { web_search: false } } });
  await ok('setModelDefault', { provider: 'codex', model, effort: 'high' });
  await ok('setDefault', { provider: 'codex', account: 'codex-next' });
  await ok('logout', { provider: 'codex', account });
  assert.deepEqual(stored(prefs).providers.antigravity, archivedPrefs);
  assert.deepEqual(stored(prefs).toolHistory.filter(row => row.provider === 'antigravity'), [archivedRevision]);
  assert.equal(stored(prefs).providers.codex.displayName, 'Synthetic Codex');
  assert.deepEqual(stored(defaults), { antigravity: archivedDefaults, codex: { [model]: 'high' } });
  assert.deepEqual(stored(auth).antigravity, archived);
  assert.equal(stored(auth).codex.default, 'codex-next');
  assert.deepEqual(Object.keys(stored(auth).codex.accounts), ['codex-next']);
  assert.deepEqual(stored(cache), { antigravity: { legacy: true }, accounts: { antigravity: { old: true } } });

  // Exercise the pre-existing fallback migration using only fake files.
  files.set(oldAuth, files.get(auth));
  files.delete(auth);
  assert.equal((await ok('status')).providers.codex.accounts[0].key, 'codex-next');
  assert.deepEqual(stored(auth).antigravity, archived);
  assert.equal(files.has(oldAuth), false);
  files.set(auth, '{invalid fixture JSON');
  assert.match((await ok('status')).providers.codex.detail, /not valid JSON/);
});
