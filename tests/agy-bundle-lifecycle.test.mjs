import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const VERSION = '0.2.2-rc.5';
const PREFIX = 'dsh-agy-lifecycle-';
const BASELINE = 'dsh-synthetic-lifecycle-baseline';
const STOCK_ID = 'ui-model-selection';
const STOCK_MODULE = '@deepseek-ai/dsh-client-ui-model-selection';
const REPLACEMENT_ID = 'ui-synthetic-lifecycle-replacement';
const OTHER = 'dsh-synthetic-lifecycle-model-selection';
const BROKEN = 'dsh-synthetic-lifecycle-broken';
// Cordis 4.1.0 erases its exported const enum at build time.
const ACTIVE = 2;
let hasFixture = false;

const text = value => `${JSON.stringify(value, null, 2)}\n`;
const readText = path => readFile(path, 'utf8');
const clientStub = name => `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: () => ({ apply() {} }) });\n`;

async function verifiedInstallation() {
  const install = process.env.DSH_INSTALL_DIR;
  assert.ok(process.versions.electron && process.execArgv.includes('--expose-internals'),
    'Run this test in the installed Desktop Electron Node mode with --expose-internals.');
  assert.ok(install && isAbsolute(install), 'Set DSH_INSTALL_DIR to the installed DSH runtime or CLI package.');
  const require = createRequire(join(install, 'package.json'));
  const installAnchor = require.resolve('@deepseek-ai/dsh/package.json');
  const root = /^(.*)[\\/]app\.asar[\\/]/i.exec(installAnchor)?.[1];
  assert.ok(root, 'This fixture must load the installed Desktop ASAR.');
  const cli = JSON.parse(await readText(installAnchor));
  assert.equal(cli.name, '@deepseek-ai/dsh');
  assert.equal(cli.version, VERSION);
  const pnpm = await realpath(join(root, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [appBoot, modules, manager] = await Promise.all([
    load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-client-modules'), load('@deepseek-ai/dsh-plugin-manager'),
  ]);
  return { installAnchor, pnpm, appBoot,
    ClientModuleRegistry: modules.ClientModuleRegistry, PluginManager: manager.PluginManager };
}

// Drive the shipped Plugin Manager, HMR, Loader and ClientModuleRegistry. Only
// the source bundles and Profile are synthetic. No server or product Profile is mounted.
export async function createLifecycleFixture(t, {
  baselineRows = [], profilePatches = [], homePatches = [], prepare,
} = {}) {
  const runtime = await verifiedInstallation();
  const tmp = await realpath(tmpdir());
  assert.equal(hasFixture, false, 'Fixture changes the home only in this test process; use it serially.');
  hasFixture = true;
  let root;
  try { root = await mkdtemp(join(tmp, PREFIX)); }
  catch (error) { hasFixture = false; throw error; }
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'synthetic');
  const savedEnv = new Map();
  let ctx;
  t.after(async () => {
    try { await ctx?.fiber.dispose(); }
    finally {
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      hasFixture = false;
      assert.equal(dirname(root), tmp);
      assert.ok(basename(root).startsWith(PREFIX));
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const [name, value] of Object.entries({
    DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents-home'), DSH_PROFILE_DIR: profileDir,
  })) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }

  const { appBoot, installAnchor, pnpm, ClientModuleRegistry, PluginManager } = runtime;
  const { boot, createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages, readProfilePatches } = appBoot;
  initProfile(profileDir, []);
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const homePatchPath = join(home, 'cordis.patch.yml');
  const configPath = join(profileDir, 'cordis.yml');
  const manifestPath = join(profileDir, 'package.json');
  const rootRows = [{ insert: [
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: { fallbackRegistries: [], idleTimeoutMs: 15_000 } },
    { id: 'hmr', name: '@deepseek-ai/dsh-hmr', config: { root: [], awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 50 } } },
    { id: 'client-modules', name: '@deepseek-ai/dsh-client-modules' },
  ] }];
  await Promise.all([writeFile(configPath, '[]\n'), writeFile(patchPath, text(rootRows)), writeFile(homePatchPath, '[]\n')]);

  const emptyNpmrc = join(root, 'empty.npmrc');
  const denyNetwork = join(root, 'deny-network.mjs');
  await Promise.all([writeFile(emptyNpmrc, ''), writeFile(denyNetwork, `
import net from 'node:net';
const deny = () => { throw new Error('Network is forbidden in the synthetic lifecycle test'); };
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
`)]);
  const packageManager = {
    command: process.execPath,
    args: ['--expose-internals', '--import', pathToFileURL(denyNetwork).href, pnpm],
    env: {
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', CI: 'true', COREPACK_ENABLE_NETWORK: '0',
      HOME: home, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: home,
      APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
      PNPM_HOME: join(home, 'pnpm'), TMP: root, TEMP: root, TMPDIR: root,
      npm_config_offline: 'true', npm_config_userconfig: emptyNpmrc, npm_config_globalconfig: emptyNpmrc,
      npm_config_store_dir: join(root, 'store'), npm_config_cache: join(root, 'npm-cache'),
      npm_config_update_notifier: 'false', npm_config_manage_package_manager_versions: 'false',
      npm_config_ignore_scripts: 'true', npm_config_ignore_pnpmfile: 'true', npm_config_audit: 'false',
    },
  };

  async function writeBundle(name, { patches = [], host, client = false } = {}) {
    assert.match(name, /^dsh-synthetic-lifecycle-[a-z-]+$/);
    const dir = join(root, name);
    await mkdir(dir, { recursive: false });
    const manifest = {
      name, version: '1.0.0', private: true, type: 'module',
      exports: { '.': './host.mjs', './package.json': './package.json', ...(client ? { './client': './client.js' } : {}) },
      dsh: { bundle: { patch: './cordis.patch.yml' }, ...(client ? { client: { platform: 'web', inject: [] } } : {}) },
    };
    await Promise.all([
      writeFile(join(dir, 'package.json'), text(manifest)),
      writeFile(join(dir, 'cordis.patch.yml'), text(patches)),
      writeFile(join(dir, 'host.mjs'), host ?? 'export function apply() {}\n'),
      ...(client ? [writeFile(join(dir, 'client.js'), typeof client === 'string' ? client : clientStub(name))] : []),
    ]);
    return dir;
  }

  const profile = loadProfileDirectory('synthetic lifecycle', profileDir, installAnchor);
  const profileContext = { name: 'synthetic', packageManager, dir: profileDir, patchPath, installAnchor,
    cwd: root, home, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined };
  const ready = new Set();
  const resolution = await createRuntimeResolution({ installAnchor, profile, home });
  ctx = await boot('synthetic lifecycle', configPath, readProfilePatches('synthetic lifecycle', profileContext, profile), async host => {
    host.provide('profileContext', profileContext);
    host.provide('appReady', { onReady(listener) { ready.add(listener); return () => ready.delete(listener); } });
    await host.plugin(PluginPackages, { resolution });
    await prepare?.(host, { root, home, profileDir, installAnchor });
  });
  for (const listener of ready) listener();
  ready.clear();
  const manager = ctx.get('pluginManager');
  assert.ok(manager instanceof PluginManager);
  assert.ok(ctx.get('clientModules') instanceof ClientModuleRegistry);
  assert.ok(ctx.get('hmr'));
  assert.equal(ctx.get('webServer'), undefined);
  assert.equal(ctx.get('agents'), undefined);

  if (baselineRows.length) {
    const baseBundle = await writeBundle(BASELINE, { patches: [{ insert: baselineRows }] });
    assertApplied(await manager.installBundle(baseBundle), true);
  }
  await ctx.hmr.runExclusive(async () => {
    await Promise.all([
      writeFile(patchPath, text([...rootRows, ...profilePatches])),
      writeFile(homePatchPath, text(homePatches)),
    ]);
    assert.equal((await ctx.hmr.reconcileProfile()).restartReason, undefined);
  });

  return {
    ctx, manager, root, home, profileDir, patchPath, homePatchPath, installAnchor, writeBundle,
    readManifest: async () => JSON.parse(await readText(manifestPath)),
    entry: id => [...ctx.loader.entries()].find(entry => entry.options.id === id),
    graphIds: () => ctx.get('clientModules').graph().entries.map(entry => entry.id),
    active: entry => entry?.fiber?.state === ACTIVE,
  };
}

function assertApplied(result, changed) {
  assert.equal(result.application, 'applied', JSON.stringify(result));
  if (changed !== undefined) assert.equal(result.changed, changed, JSON.stringify(result));
}

const modelLayers = {
  baselineRows: [{ id: STOCK_ID, name: STOCK_MODULE, config: { fixture: 'stock' } }],
  profilePatches: [{ id: STOCK_ID, name: STOCK_MODULE, config: { fixture: 'synthetic-user-profile' } }],
  homePatches: [{ id: STOCK_ID, name: STOCK_MODULE, config: { fixture: 'synthetic-user-home', keep: true } }],
};

function replacementPatch(name) {
  return [
    { id: STOCK_ID, name: STOCK_MODULE, disabled: true },
    { insert: [{ id: REPLACEMENT_ID, name }] },
  ];
}

function assertStock(f) {
  const stock = f.entry(STOCK_ID);
  assert.equal(stock.options.name, STOCK_MODULE);
  assert.deepEqual(stock.options.config, modelLayers.homePatches[0].config);
  assert.equal(stock.disabled, false);
  assert.ok(f.active(stock));
  assert.ok(f.graphIds().includes(STOCK_MODULE));
}

export function registerBundleLifecycleTests() {
  test('a normal bundle swaps the stock Client row and restores it on disable and removal', { timeout: 90_000 }, async t => {
    const f = await createLifecycleFixture(t, modelLayers);
    assertStock(f);
    const originalGraph = f.graphIds();
    const originalProfile = await readText(f.patchPath);
    const originalHome = await readText(f.homePatchPath);
    const normal = await f.writeBundle(OTHER, { patches: replacementPatch(OTHER), client: true });

    const result = await f.manager.installBundle(normal);
    assertApplied(result, true);
    assert.equal(result.bundle, OTHER);
    assert.equal(result.packageResult.exitCode, 0);
    const active = async () => {
      assert.equal(f.entry(STOCK_ID).disabled, true);
      assert.equal(f.active(f.entry(STOCK_ID)), false);
      assert.equal(f.entry(REPLACEMENT_ID).options.name, OTHER);
      assert.ok(f.active(f.entry(REPLACEMENT_ID)));
      assert.ok(!f.graphIds().includes(STOCK_MODULE));
      assert.ok(f.graphIds().includes(OTHER));
      const client = f.ctx.clientModules.clientPath(OTHER);
      assert.equal(typeof client, 'string');
      const withinFixture = relative(f.root, client);
      assert.ok(withinFixture && !isAbsolute(withinFixture) && !withinFixture.startsWith('..'));
      const row = f.ctx.clientModules.graph().entries.find(row => row.id === OTHER);
      const response = await f.ctx.clientModules.fetchBundle(new Request(new URL(row.url, 'http://fixture.invalid/')));
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes(clientStub(OTHER).trim()));
    };
    await active();
    assert.deepEqual((await f.readManifest()).dsh.profile.bundles, [BASELINE, OTHER]);

    assertApplied(await f.manager.setBundleEnabled(OTHER, false), true);
    assertStock(f);
    assert.deepEqual(f.graphIds(), originalGraph);
    assert.equal(f.entry(REPLACEMENT_ID), undefined);
    const disabled = await f.readManifest();
    assert.deepEqual(disabled.dsh.profile.bundles, [BASELINE]);
    assert.ok(Object.hasOwn(disabled.dependencies, OTHER));

    assertApplied(await f.manager.setBundleEnabled(OTHER, true), true);
    await active();
    const removed = await f.manager.removeBundle(OTHER);
    assertApplied(removed, true);
    assert.equal(removed.packageResult.exitCode, 0);
    assertStock(f);
    assert.equal(f.entry(REPLACEMENT_ID), undefined);
    assert.deepEqual(f.graphIds(), originalGraph);
    const after = await f.readManifest();
    assert.deepEqual(after.dsh.profile.bundles, [BASELINE]);
    assert.ok(!Object.hasOwn(after.dependencies ?? {}, OTHER));
    assert.ok(!(await f.manager.listBundles()).some(bundle => bundle.name === OTHER));
    assert.equal(f.ctx.pluginPackages.resolution.entries.some(item => item.name === OTHER), false);
    assert.equal(await readText(f.patchPath), originalProfile);
    assert.equal(await readText(f.homePatchPath), originalHome);
  });

  test('a bundle startup failure can leave the saved selection and stock Client row displaced', { timeout: 90_000 }, async t => {
    const f = await createLifecycleFixture(t, modelLayers);
    assertStock(f);
    const originalGraph = f.graphIds();
    const originalProfile = await readText(f.patchPath);
    const originalHome = await readText(f.homePatchPath);
    const failing = await f.writeBundle(BROKEN, {
      patches: replacementPatch(BROKEN),
      host: 'export function apply() { throw new Error("deliberate synthetic lifecycle startup failure"); }\n',
    });
    const fresh = await f.manager.installBundle(failing, { enabled: false });
    assertApplied(fresh, true);
    assert.equal(fresh.packageResult.exitCode, 0);
    assertStock(f);

    const refused = await f.manager.setBundleEnabled(BROKEN, true);
    assert.equal(refused.application, 'failed', JSON.stringify(refused));
    assert.equal(refused.changed, true);
    assert.match(refused.error.diagnostic, /deliberate synthetic lifecycle startup failure/);
    const selected = await f.readManifest();
    assert.deepEqual(selected.dsh.profile.bundles, [BASELINE, BROKEN]);
    assert.equal(f.entry(STOCK_ID).disabled, true);
    assert.equal(f.active(f.entry(STOCK_ID)), false);
    assert.equal(f.entry(REPLACEMENT_ID).options.name, BROKEN);
    assert.equal(f.active(f.entry(REPLACEMENT_ID)), false);
    assert.ok(!f.graphIds().includes(STOCK_MODULE));
    assert.ok(!f.graphIds().includes(BROKEN));

    assertApplied(await f.manager.removeBundle(BROKEN), true);
    assertStock(f);
    assert.deepEqual(f.graphIds(), originalGraph);
    assert.equal(await readText(f.patchPath), originalProfile);
    assert.equal(await readText(f.homePatchPath), originalHome);
  });
}

if (import.meta.main) registerBundleLifecycleTests();
