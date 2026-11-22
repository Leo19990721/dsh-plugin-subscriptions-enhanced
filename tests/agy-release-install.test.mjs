import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLifecycleFixture } from './agy-bundle-lifecycle.test.mjs';

const NAME = 'dsh-subscriptions-enhanced';
const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const LEGACY = 'dsh-plugin-subscriptions-enhanced';
const LEGACY_VERSION = '0.2.8';
const LEGACY_SHA256 = '9cbadd96d82e69e7711d2ba713644a4f276602d8621b83833447d1db8a13bf15';
const UPSTREAM = 'dsh-plugin-subscriptions';
const STOCK = '@deepseek-ai/dsh-client-ui-model-selection';
const STOCK_ID = 'ui-model-selection';
const OLD_ID = 'llm-subscriptions';
const NEW_ID = 'llm-subscriptions-enhanced';
const METHOD = 'subscriptions-enhanced-gemini';
const SUBSCRIPTION_STATUS = 'subscriptions-auth.status';
const account = 'synthetic-account';
const model = 'gpt-synthetic-release';
const provider = 'codex';
const fakeToken = 'synthetic-not-a-credential';
const config = {
  providers: [provider], models: { codex: [{ id: model, inputModalities: ['text'] }] },
  codexClientVersion: '0.153.4', pool: { enabled: false },
};
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inside(root, path) {
  const child = relative(root, path);
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

async function repoDependency(name, version) {
  const require = createRequire(new URL('../package.json', import.meta.url));
  const nodeModules = await realpath(fileURLToPath(new URL('../node_modules', import.meta.url)));
  const manifest = await realpath(require.resolve(`${name}/package.json`));
  assert.ok(inside(nodeModules, manifest), `${name} must come from this repository's pinned dependencies`);
  assert.deepEqual(await readJson(manifest).then(({ name, version }) => [name, version]), [name, version]);
  return dirname(manifest);
}

async function preparePackages(f) {
  const deps = join(f.root, 'offline-deps');
  await mkdir(deps);
  const undici = join(deps, 'undici');
  const upstream = join(deps, UPSTREAM);
  await Promise.all([
    cp(await repoDependency('undici', '7.30.2'), undici, { recursive: true, force: false, errorOnExist: true }),
    cp(await repoDependency(UPSTREAM, '0.9.13'), upstream, { recursive: true, force: false, errorOnExist: true }),
  ]);
  const workspace = join(f.profileDir, 'pnpm-workspace.yaml');
  const before = await readFile(workspace, 'utf8');
  assert.match(before, /^autoInstallPeers: false$/m);
  assert.doesNotMatch(before, /^overrides:/m);
  const local = JSON.stringify(`file:${relative(f.profileDir, undici).split(sep).join('/')}`);
  // The installed manager still runs its own pnpm, with the fixture's isolated
  // store and network guard. Its only third-party dependency is local here.
  await writeFile(workspace, `${before.trimEnd()}\noverrides:\n  "undici@7.30.2": ${local}\n  "${UPSTREAM}>undici": ${local}\n`);
  return upstream;
}

async function attachCarrier(f, HostConnectionService) {
  const origin = 'http://127.0.0.1:1'; // Address metadata only; no listening socket.
  const desktopHeaders = { host: new URL(origin).host, 'content-type': 'application/json' };
  const browserHeaders = { ...desktopHeaders, origin, 'sec-fetch-site': 'same-origin' };
  const users = new WeakMap();
  let otherOwner;
  const carrier = f.ctx.plugin({ name: 'in-process release carrier', apply(scope) {
    scope.provide('webServer', { host: '127.0.0.1', protocol: 'http:', register: () => () => {} });
    scope.provide('agents', { get: () => undefined });
    scope.provide('tools', {});
    scope.provide('agentPresets', { async register(definition) {
      assert.equal(definition.id, 'writing');
      return () => {};
    } });
    new HostConnectionService(scope, [], {
      isAuthenticated: req => users.get(req) === 'browser',
      authenticateApi: req => users.get(req) === 'other-owner' ? otherOwner : undefined,
      authorizeConnect(_req, _res, _secure, publishPeer) { otherOwner = publishPeer('none'); },
    });
  } });
  await carrier.inertia;
  assert.ok(f.active({ fiber: carrier }));
  const connection = f.ctx.connection;
  connection.authorizeConnect({ url: '/connect', headers: browserHeaders }, {});
  assert.ok(otherOwner);
  assert.notEqual(otherOwner, connection.browserPeer.id);
  const shared = connection.createSharedFetchHandler('/api');

  return async function post(payload, { who = 'browser', witness = true, method = 'POST', desktop = false, endpoint = METHOD } = {}) {
    const headers = desktop ? desktopHeaders : browserHeaders;
    const url = `/api/${endpoint}`;
    const req = { url, method, headers, socket: { remoteAddress: '127.0.0.1' } };
    users.set(req, who);
    const { peer } = connection.admit(req);
    assert.equal(peer?.id, who === 'browser' ? connection.browserPeer.id : otherOwner);
    const rpcId = randomUUID();
    const body = method === 'POST' ? JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }) : undefined;
    const fetch = () => shared.fetch(new Request(origin + url, { method, headers, body }), peer);
    const response = witness ? await f.ctx.waterfall('connection/request', req, {}, fetch) : await fetch();
    return { response, rpcId };
  };
}

function applied(result) {
  assert.equal(result.application, 'applied', JSON.stringify(result));
  assert.equal(result.changed, true);
  return result;
}

function denyExternalIo(t) {
  let blocked = 0;
  const deny = () => { blocked++; throw new Error('External I/O is forbidden in the release fixture'); };
  t.mock.method(net.Socket.prototype, 'connect', deny);
  t.mock.method(net.Server.prototype, 'listen', deny);
  let codexCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input) !== 'https://chatgpt.com/backend-api/codex/responses') return deny();
    assert.equal(init.method, 'POST');
    assert.ok(new Headers(init.headers).get('authorization') === `Bearer ${fakeToken}`);
    assert.equal(new Headers(init.headers).get('chatgpt-account-id'), account);
    const body = JSON.parse(init.body);
    assert.equal(body.model, model);
    assert.equal(body.instructions, 'Synthetic release smoke');
    assert.equal(body.stream, true);
    codexCalls++;
    const events = [
      { type: 'response.output_text.delta', item_id: 'synthetic-message', delta: 'Synthetic subscription reply' },
      { type: 'response.completed' },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return { blocked: () => blocked, codexCalls: () => codexCalls };
}

// Run in its own signed Desktop Electron Node process, without the project's
// alternate loader hook. RELEASE_TGZ is the absolute path to a packed candidate.
test('the release archive preserves stock Client behavior and restores the upstream subscription', { timeout: 90_000 }, async t => {
  const input = process.env.RELEASE_TGZ;
  assert.ok(input && isAbsolute(input) && /\.tgz$/i.test(input), 'Set RELEASE_TGZ to an absolute local .tgz path');
  const archive = await realpath(input);
  assert.ok((await stat(archive)).isFile());
  const packedHash = sha256(await readFile(archive));
  if (process.env.RELEASE_SHA256) assert.equal(packedHash, process.env.RELEASE_SHA256.toLowerCase());
  t.diagnostic(`candidate SHA-256: ${packedHash}`);

  let HostConnectionService;
  const io = denyExternalIo(t);
  const f = await createLifecycleFixture(t, {
    baselineRows: [{ id: STOCK_ID, name: STOCK, config: { marker: 'shipped model selection' } }],
    profilePatches: [{ id: STOCK_ID, name: STOCK, config: { marker: 'user profile model selection' } }],
    homePatches: [{ id: STOCK_ID, name: STOCK, config: { marker: 'user home model selection' } }],
    async prepare(ctx, { root, home, installAnchor }) {
      const require = createRequire(installAnchor);
      const load = name => import(pathToFileURL(require.resolve(name)).href);
      const [{ LlmRuntime }, carrier] = await Promise.all([load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-client-connection')]);
      HostConnectionService = carrier.HostConnectionService;
      const saved = new Map();
      for (const [key, value] of Object.entries({
        HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(root, 'no-claude'),
        APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      })) {
        saved.set(key, process.env[key]);
        process.env[key] = value;
      }
      t.after(() => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      await ctx.plugin(LlmRuntime);
    },
  });
  const post = await attachCarrier(f, HostConnectionService);
  const upstreamSource = await preparePackages(f);
  const auth = join(f.home, 'plugins', 'subscriptions', 'auth.json');
  await mkdir(dirname(auth), { recursive: true });
  await writeFile(auth, json({ codex: { default: account, accounts: {
    [account]: { accountId: account, accessToken: fakeToken, refreshToken: 'synthetic-refresh-not-a-credential',
      expiresAt: 4_102_444_800_000, planType: 'plus' },
  } } }), { flag: 'wx' });
  const patch = await readJson(f.patchPath);
  // Both enhanced bundle names use this same Loader id. Keep the user patch
  // independent of which package currently supplies that row.
  patch.push({ id: OLD_ID, name: UPSTREAM, config }, { id: NEW_ID, config });
  await writeFile(f.patchPath, json(patch));
  const userFiles = await Promise.all([f.patchPath, f.homePatchPath, auth].map(async path => [path, await readFile(path)]));
  const assertUserFiles = async () => {
    for (const [path, bytes] of userFiles) assert.ok((await readFile(path)).equals(bytes), 'a fixture user file was changed');
  };

  const original = applied(await f.manager.installBundle(`file:${upstreamSource}`, { expected: { name: UPSTREAM, version: '0.9.13' } }));
  assert.equal(original.packageResult.exitCode, 0);
  const baseline = await f.readManifest();
  const modelEntry = f.entry(STOCK_ID);
  const modelFiber = modelEntry?.fiber;
  const modelClient = f.ctx.clientModules.clientPath(STOCK);
  const modelRevision = f.ctx.clientModules.graph().entries.find(row => row.id === STOCK)?.rev;
  const originalGraph = f.graphIds().sort();
  assert.ok(originalGraph.includes(STOCK) && originalGraph.includes(UPSTREAM));
  assert.ok(modelClient && modelRevision && modelFiber);

  function assertModelPicker() {
    const current = f.entry(STOCK_ID);
    assert.ok(f.active(current));
    assert.equal(current.options.name, STOCK);
    assert.equal(current.fiber, modelFiber);
    assert.equal(current.disabled, false);
    assert.deepEqual(current.options.config, { marker: 'user home model selection' });
    assert.equal(f.ctx.clientModules.clientPath(STOCK), modelClient);
    assert.deepEqual(f.ctx.clientModules.graph().entries.filter(row => row.id === STOCK).map(row => row.rev), [modelRevision]);
  }

  async function assertOrdinarySubscription({ stream = true, google = false } = {}) {
    assert.deepEqual(f.ctx.llm.listProviders().map(row => row.id).sort(), google ? ['antigravity', provider] : [provider]);
    assert.deepEqual((await f.ctx.llm.listModels(provider)).map(row => row.id), [model]);
    const { response, rpcId } = await post({}, { desktop: true, endpoint: SUBSCRIPTION_STATUS });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.rpcId, rpcId);
    assert.equal(receipt.result.ok, true);
    assert.deepEqual(receipt.result.value.providers.codex.accounts.map(({ key }) => key), [account]);
    if (!stream) return;
    const before = io.codexCalls();
    const result = [];
    for await (const chunk of f.ctx.llm.stream({ provider, model, system: 'Synthetic release smoke',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }],
    })) result.push(chunk);
    assert.deepEqual(result.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['Synthetic subscription reply']);
    assert.deepEqual(result.at(-1)?.reason, { kind: 'stop' });
    assert.equal(io.codexCalls(), before + 1);
  }

  async function assertRestored({ stream = true } = {}) {
    assertModelPicker();
    const old = f.entry(OLD_ID);
    assert.equal(old.options.name, UPSTREAM);
    assert.equal(old.disabled, false);
    assert.ok(f.active(old));
    assert.deepEqual(old.options.config, config);
    assert.equal(f.entry(NEW_ID), undefined);
    assert.deepEqual(f.graphIds().sort(), originalGraph);
    assert.deepEqual((await f.readManifest()).dsh.profile.bundles, baseline.dsh.profile.bundles);
    assert.equal((await post({ action: 'status' })).response.status, 404);
    await assertOrdinarySubscription({ stream });
    await assertUserFiles();
  }

  async function assertEnabled({ stream = true } = {}) {
    assertModelPicker();
    assert.equal(f.entry(OLD_ID).disabled, true);
    assert.equal(f.active(f.entry(OLD_ID)), false);
    assert.deepEqual(f.entry(OLD_ID).options.config, config);
    assert.ok(f.active(f.entry(NEW_ID)));
    assert.deepEqual(f.graphIds().sort(), [...originalGraph.filter(name => name !== UPSTREAM), NAME].sort());
    assert.deepEqual((await f.readManifest()).dsh.profile.bundles, [...baseline.dsh.profile.bundles, NAME]);
    for (const desktop of [false, true]) {
      const { response, rpcId } = await post({ action: 'status' }, { desktop });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { type: 'server-response', rpcId, result: { ok: true, value: { status: 'missing-cli', modelCount: 0 } } });
    }
    await assertOrdinarySubscription({ stream, google: true });
    await assertUserFiles();
  }

  await assertRestored();
  const release = applied(await f.manager.installBundle(archive, { expected: { name: NAME, version: VERSION } }));
  assert.equal(release.packageResult.exitCode, 0);
  assert.equal(release.bundle, NAME);
  assert.equal(release.version, VERSION);
  const packageDir = await realpath(join(f.profileDir, 'node_modules', NAME));
  assert.ok(inside(f.profileDir, packageDir));
  assert.deepEqual((await readJson(join(packageDir, 'package.json'))).dependencies, { undici: '7.30.2' });
  const installedUndici = await realpath(createRequire(join(packageDir, 'package.json')).resolve('undici/package.json'));
  assert.ok(inside(f.root, installedUndici));
  assert.equal((await readJson(installedUndici)).version, '7.30.2');
  assert.match(await readFile(join(packageDir, 'lib', 'index.js'), 'utf8'), /from ["']\.\/agy-local-plugin\.js["']/);
  assert.ok((await stat(join(packageDir, 'lib', 'agy-local-runtime.js'))).isFile());
  const client = f.ctx.clientModules.clientPath(NAME);
  assert.ok(client && inside(packageDir, client));
  const copy = await readFile(client, 'utf8');
  assert.match(copy, /原来的聊天模型菜单中选择 Google Antigravity/);
  assert.match(copy, /Gemini model under Google Antigravity in the usual chat model menu/);
  await assertEnabled();
  assert.equal((await post({ action: 'inspect' })).response.status, 200);
  for (const action of ['login', 'open', 'list', 'prompt', 'answer', 'cancel', 'close']) {
    const rejected = (await post({ action })).response;
    assert.equal(rejected.status, 400, action);
    assert.equal(await rejected.text(), '');
  }
  assert.equal((await post({ action: 'status', extra: true })).response.status, 400);
  assert.equal((await post({ action: 'status' }, { who: 'other-owner' })).response.status, 403);
  assert.equal((await post({ action: 'status' }, { witness: false })).response.status, 403);
  assert.equal((await post({ action: 'status' }, { method: 'GET' })).response.status, 404);

  applied(await f.manager.setBundleEnabled(NAME, false));
  assert.ok(Object.hasOwn((await f.readManifest()).dependencies, NAME));
  await assertRestored();
  applied(await f.manager.setBundleEnabled(NAME, true));
  await assertEnabled();
  const removed = applied(await f.manager.removeBundle(NAME));
  assert.equal(removed.packageResult.exitCode, 0);
  assert.deepEqual((await f.readManifest()).dependencies, baseline.dependencies);
  assert.ok(!(await f.manager.listBundles()).some(row => row.name === NAME));
  await assertRestored();
  assert.equal(io.codexCalls(), 5);

  // The older name uses the same entry and preset IDs. Stage the new archive
  // disabled so both tarballs are installed, but only the old one supplies rows.
  if (process.env.RELEASE_LEGACY_TGZ) {
    const input = process.env.RELEASE_LEGACY_TGZ;
    assert.ok(isAbsolute(input) && /\.tgz$/i.test(input), 'Set RELEASE_LEGACY_TGZ to the absolute 0.2.8 archive path');
    const legacyArchive = await realpath(input);
    assert.notEqual(legacyArchive, archive);
    assert.ok((await stat(legacyArchive)).isFile());
    assert.equal(sha256(await readFile(legacyArchive)), LEGACY_SHA256);
    const legacy = applied(await f.manager.installBundle(legacyArchive, { expected: { name: LEGACY, version: LEGACY_VERSION } }));
    assert.equal(legacy.packageResult.exitCode, 0);
    const legacyGraph = f.graphIds().sort();
    assert.deepEqual(legacyGraph, [...originalGraph.filter(name => name !== UPSTREAM), LEGACY].sort());
    const legacyFiber = f.entry(NEW_ID).fiber;
    assert.equal(f.entry(NEW_ID).options.name, LEGACY);
    assert.ok(f.active(f.entry(NEW_ID)));
    assert.deepEqual(f.entry(NEW_ID).options.config, config);
    assert.equal(f.entry(OLD_ID).disabled, true);
    assertModelPicker();
    await assertOrdinarySubscription({ stream: false });
    await assertUserFiles();

    const staged = applied(await f.manager.installBundle(archive, { enabled: false, expected: { name: NAME, version: VERSION } }));
    assert.equal(staged.packageResult.exitCode, 0);
    const stagedManifest = await f.readManifest();
    assert.deepEqual(stagedManifest.dsh.profile.bundles, [...baseline.dsh.profile.bundles, LEGACY]);
    assert.ok(Object.hasOwn(stagedManifest.dependencies, LEGACY) && Object.hasOwn(stagedManifest.dependencies, NAME));
    assert.equal(f.entry(NEW_ID).fiber, legacyFiber);
    assert.ok(f.active(f.entry(NEW_ID)));
    assert.deepEqual(f.graphIds().sort(), legacyGraph);
    assert.equal((await post({ action: 'status' })).response.status, 404);
    await assertOrdinarySubscription({ stream: false });
    await assertUserFiles();

    const replaced = applied(await f.manager.removeBundle(LEGACY));
    assert.equal(replaced.packageResult.exitCode, 0);
    assert.ok(!Object.hasOwn((await f.readManifest()).dependencies, LEGACY));
    await assertRestored({ stream: false });
    applied(await f.manager.setBundleEnabled(NAME, true));
    assert.equal(f.entry(NEW_ID).options.name, NAME);
    await assertEnabled({ stream: false });
    applied(await f.manager.removeBundle(NAME));
    await assertRestored({ stream: false });
    assert.equal(sha256(await readFile(legacyArchive)), LEGACY_SHA256);
    assert.equal(io.codexCalls(), 5, 'renamed-bundle staging does not issue model requests');
    t.diagnostic(`legacy ${LEGACY_VERSION}: new name staged disabled, old name removed, then new name enabled`);
  }

  assert.equal(io.blocked(), 0, 'nothing should even attempt external I/O');
  assert.equal(sha256(await readFile(archive)), packedHash, 'the release archive was modified');
});
