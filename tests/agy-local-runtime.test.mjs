import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyProxyEnv } from '../src/agy-local-proxy.js';
import { localHistory, localPrompt, prepareLocalHistory } from '../src/agy-local-context.js';
import { agentsSkillsPath, inventoryAgyWorkspace, isAgyReadOnlyRefPath, matchesAgyReadOnlyRef, syncAgySkills, withinAgyWritableRoots } from '../src/agy-local-storage.js';
import { agyProgress } from '../src/agy-local-progress.js';
import { createLocalAgy } from '../src/agy-local-runtime.js';
import { installAgyLineage } from '../src/agy-local-lineage.js';
import { verifiedAgyExecutable } from '../src/agy-launch.js';

const signal = new AbortController().signal;
const text = text => ({ type: 'text', text });

test('validates an ordinary local agy.exe without pinning its contents', {
  skip: (process.platform !== 'win32' || process.arch !== 'x64') && 'Windows x64 executable validation',
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-path-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exe = join(root, 'agy.exe');
  await assert.rejects(verifiedAgyExecutable(exe), { code: 'missing-cli' });
  await assert.rejects(verifiedAgyExecutable('agy.exe'), { code: 'unsupported-cli' });
  const wrong = join(root, 'other.exe');
  await writeFile(wrong, 'fixture');
  await assert.rejects(verifiedAgyExecutable(wrong), { code: 'unsupported-cli' });
  // No process is spawned; Windows performs the executable format check at launch.
  for (const bytes of ['original bytes', 'different and longer upgraded bytes']) {
    await writeFile(exe, bytes);
    assert.equal(await verifiedAgyExecutable(exe), exe);
  }
  const directory = join(root, 'directory', 'agy.exe');
  await mkdir(directory, { recursive: true });
  await assert.rejects(verifiedAgyExecutable(directory), { code: 'unsupported-cli' });
  const linked = join(root, 'linked');
  await symlink(root, linked, 'junction');
  await assert.rejects(verifiedAgyExecutable(join(linked, 'agy.exe')), { code: 'unsupported-cli' });
});

test('proxy auto-detects using environment then OS; direct and explicit trump both', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-proxy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let reads = 0;
  const discover = () => { reads++; return '127.0.0.1:43217'; };
  const parent = { DSH_HOME: root, Https_Proxy: 'unused-in-posix', HTTPS_PROXY: 'http://fixture:3000', HTTP_PROXY: 'http://fixture:3001', NO_PROXY: '.fixture.com' };
  assert.deepEqual(await agyProxyEnv('auto', parent, discover), {
    HTTPS_PROXY: 'http://fixture:3000', HTTP_PROXY: 'http://fixture:3001', NO_PROXY: 'localhost,127.0.0.1,::1,.fixture.com',
  });
  assert.deepEqual(await agyProxyEnv('direct', parent, discover), {});
  assert.deepEqual(await agyProxyEnv('', parent, discover), {});
  assert.equal((await agyProxyEnv('http://fixture:34567', parent, discover)).HTTPS_PROXY, 'http://fixture:34567');
  assert.equal(reads, 0);
  assert.equal((await agyProxyEnv(undefined, { DSH_HOME: root }, discover)).HTTPS_PROXY, 'http://127.0.0.1:43217');
  assert.equal(reads, 1);
  await assert.rejects(agyProxyEnv('file:///not-a-proxy', { DSH_HOME: root }, discover), { code: 'invalid-proxy' });
});

test('automatic Google proxy reads the upstream subscriptions JSON contract and rechecks it on every launch', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-saved-proxy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'plugins', 'subscriptions');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'proxy.json');
  const parent = { DSH_HOME: root, HTTPS_PROXY: 'http://env.invalid:8000', NO_PROXY: '.env.invalid' };
  const os = () => '127.0.0.1:8123';
  const upstream = { enabled: true, url: 'https://fixture.invalid:8443', username: ' spaced user ', password: 'p@ss:word',
    bypass: [' .proxy-bypass.invalid ', '*.child.invalid', 'https://EXACT.invalid:5555/test', '*', '.proxy-bypass.invalid'] };
  await writeFile(file, '\uFEFF' + JSON.stringify(upstream));
  const saved = 'https://spaced%20user:p%40ss%3Aword@fixture.invalid:8443';
  for (const mode of ['auto', undefined]) assert.deepEqual(await agyProxyEnv(mode, parent, os), {
    HTTPS_PROXY: saved, HTTP_PROXY: saved, NO_PROXY: 'localhost,127.0.0.1,::1,.proxy-bypass.invalid,*.child.invalid,exact.invalid',
  });
  assert.deepEqual(await agyProxyEnv('direct', parent, os), {});
  assert.equal((await agyProxyEnv('explicit.invalid:9000', parent, os)).HTTPS_PROXY, 'http://explicit.invalid:9000');
  for (const scheme of ['socks5', 'socks5h']) {
    await writeFile(file, JSON.stringify({ ...upstream, url: `${scheme}://fixture.invalid:1080` }));
    const proxy = `${scheme}://spaced%20user:p%40ss%3Aword@fixture.invalid:1080`;
    assert.deepEqual(await agyProxyEnv('auto', parent, os), { HTTPS_PROXY: proxy, HTTP_PROXY: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1,.proxy-bypass.invalid,*.child.invalid,exact.invalid' });
  }
  for (const text of ['not JSON', 'null', JSON.stringify({ ...upstream, enabled: false }),
    JSON.stringify({ ...upstream, url: 'ftp://unsupported.invalid:1234' })]) {
    await writeFile(file, text);
    assert.equal((await agyProxyEnv('auto', parent, os)).HTTPS_PROXY, 'http://env.invalid:8000');
    assert.equal((await agyProxyEnv('auto', { DSH_HOME: root }, os)).HTTPS_PROXY, 'http://127.0.0.1:8123');
  }
  await writeFile(file, JSON.stringify({ enabled: true, url: 'http://updated.invalid:8888', bypass: [] }));
  assert.equal((await agyProxyEnv('auto', parent, os)).HTTPS_PROXY, 'http://updated.invalid:8888');
});

test('each ACP launch fingerprints the current exact child proxy environment', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-proxy-launch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = join(root, 'home'), proxyDir = join(dshHome, 'plugins', 'subscriptions');
  await mkdir(proxyDir, { recursive: true });
  const saved = join(proxyDir, 'proxy.json');
  const update = (password, bypass = []) => writeFile(saved, JSON.stringify({ enabled: true, url: 'http://proxy.invalid:3128',
    username: 'synthetic', password, bypass }));
  const spawns = [];
  let resolutions = 0;
  const runtime = createLocalAgy({ proxy: 'auto', dataDir: join(root, 'data') }, {
    parentEnv: { DSH_HOME: dshHome, SystemRoot: root, HTTPS_PROXY: 'https://fallback.invalid:8080' },
    verify: () => join(root, 'agy.exe'),
    async resolveProxy(config, env) { resolutions++; return agyProxyEnv(config, env); },
    makeTransport({ env }) {
      spawns.push(env);
      return { start: async () => ({}), close: async () => {}, async request() {
        return { sessionId: randomUUID(), configOptions: [{ type: 'select', name: 'Model', id: 'model', category: 'model',
          currentValue: 'fixture', options: [{ value: 'fixture', name: 'Fixture' }] }] };
      } };
    },
  });
  t.after(() => runtime.dispose());
  await update('fixture1');
  const original = await runtime.proxyFingerprint(signal);
  assert.match(original, /^[a-f0-9]{64}$/u);
  assert.equal(spawns.length, 0);
  await update('fixture2');
  const session = await runtime.open(signal, { id: 'fixture', cwd: root });
  assert.equal(resolutions, 2, 'the launch does not reuse a prior observation or resolve a second time');
  assert.equal(spawns.at(-1).HTTPS_PROXY, 'http://synthetic:fixture2@proxy.invalid:3128');
  assert.notEqual(session.proxyFingerprint, original);
  assert.equal(session.proxyFingerprint, await runtime.proxyFingerprint(signal));
  await session.close();
  await update('fixture2', ['.bypass.invalid']);
  assert.notEqual(await runtime.proxyFingerprint(signal), session.proxyFingerprint, 'bypass-only change invalidates launches');
  await writeFile(saved, '{"enabled":false}');
  const catalog = await runtime.open(signal);
  assert.equal(spawns.at(-1).HTTPS_PROXY, 'https://fallback.invalid:8080');
  assert.equal(catalog.proxyFingerprint, await runtime.proxyFingerprint(signal));
  assert.notEqual(catalog.proxyFingerprint, session.proxyFingerprint);
  await catalog.close();
  await assert.rejects(runtime.proxyFingerprint(AbortSignal.abort()), { name: 'AbortError' });
});

test('quota reads both fixed commands concurrently via the verified CLI', async () => {
  const binary = String.raw`C:\Official Apps & Tools\agy.exe`;
  const parentEnv = { SystemRoot: String.raw`C:\Windows`, USERPROFILE: String.raw`C:\Users\fixture`,
    GOOGLE_OAUTH_TOKEN: 'not-forwarded', https_proxy: 'http://old-proxy.invalid' };
  const calls = [];
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const runtime = createLocalAgy({ executable: binary, proxy: 'auto' }, {
    parentEnv,
    async verify(file) { assert.equal(file, binary); return file; },
    async resolveProxy(config, parent) {
      assert.equal(config, 'auto'); assert.equal(parent, parentEnv);
      return { HTTPS_PROXY: 'http://fixture-proxy.invalid:43217' };
    },
    makeTransport() { assert.fail('quota never opens ACP'); },
    async printQuota(file, args, options) {
      calls.push(args);
      assert.equal(file, binary);
      assert.deepEqual({ ...options, signal: undefined }, { cwd: parentEnv.USERPROFILE, shell: false, windowsHide: true,
        timeout: 20_000, maxBuffer: 128 * 1024, encoding: 'utf8', signal: undefined,
        env: { SYSTEMROOT: parentEnv.SystemRoot, USERPROFILE: parentEnv.USERPROFILE,
          HTTPS_PROXY: 'http://fixture-proxy.invalid:43217', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } });
      if (calls.length === 2) started.resolve();
      await finish.promise;
      return { stdout: args[1] === '/usage' ? 'noise\r\nGemini Models\tWeekly Limit Remaining\t63%\t2026-11-28T15:02:14Z\r\nInvalid\tWeekly\t500%\t2026-11-28T15:02:14Z' : 'Remaining credits\t0\nUpgrade\thttps://antigravity.google/g1-upgrade' };
    },
  });
  const pending = runtime.fetchQuota(signal);
  await Promise.race([pending, started.promise]);
  assert.deepEqual(calls, [['--print', '/usage', '--print-timeout', '15s'], ['--print', '/credits', '--print-timeout', '15s']]);
  finish.resolve();
  const quota = await pending;
  assert.deepEqual(quota.windows, [{ group: 'Gemini Models', label: 'Weekly Limit Remaining', remainingPercent: 63, resetAt: '2026-11-28T15:02:14Z' }]);
  assert.deepEqual(quota.credits, { remaining: 0, upgradeUrl: 'https://antigravity.google/g1-upgrade' });
  assert.ok(Number.isFinite(Date.parse(quota.fetchedAt)));
  await assert.rejects(runtime.fetchQuota(AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(calls.length, 2);
  await runtime.dispose();
});

test('login alone uses host LOCALAPPDATA and retires only both known legacy catalog caches after success', {
  skip: process.platform !== 'win32' && 'Windows browser cache migration',
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-auth-paths-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = join(root, 'dsh-home'), localAppData = join(root, 'user-local');
  const defaultData = home => join(home, 'plugin-data', 'subscriptions-enhanced', 'agy');
  const desktopState = defaultData(join(dshHome, 'profiles', 'desktop'));
  const catalogLocal = state => join(state, 'catalog', 'local');
  const homes = [catalogLocal(defaultData(dshHome)), catalogLocal(desktopState)];
  const customState = join(root, 'custom-state');
  const cacheParts = ['Microsoft', 'Windows', 'Caches'];
  for (const state of [...homes, localAppData, catalogLocal(customState)]) {
    await mkdir(join(state, ...cacheParts), { recursive: true });
    await writeFile(join(state, ...cacheParts, 'fixture.dat'), state);
    await mkdir(join(state, 'agy', 'keyring'), { recursive: true });
    await writeFile(join(state, 'agy', 'keyring', 'keep'), 'synthetic');
  }
  const edgeCacheParts = ['Edge', 'User Data', 'component_crx_cache'];
  await mkdir(join(homes[1], 'Microsoft', ...edgeCacheParts), { recursive: true });
  await writeFile(join(homes[1], 'Microsoft', ...edgeCacheParts, 'fixture.dat'), 'edge cache');
  const parentEnv = { DSH_HOME: dshHome, SystemRoot: 'C:\\Windows', LocalAppData: localAppData,
    USERPROFILE: join(root, 'os-home'), APPDATA: join(root, 'os-roaming'), GOOGLE_OAUTH_TOKEN: 'not-forwarded' };
  const calls = [];
  let loginError = true, closeError = false;
  const deps = { parentEnv, verify: file => {
    assert.equal(file, join(localAppData, 'agy', 'bin', 'agy.exe'));
    return file;
  }, resolveProxy: (_, env) => {
    assert.equal(env, parentEnv);
    return { HTTPS_PROXY: 'http://fixture.invalid:9000' };
  }, makeTransport(options) {
    calls.push(options);
    assert.equal(options.env.GOOGLE_OAUTH_TOKEN, undefined);
    assert.equal(options.env.DSH_HOME, undefined);
    assert.equal(options.env.HTTPS_PROXY, 'http://fixture.invalid:9000');
    assert.equal(options.env.HOME, options.env.USERPROFILE);
    assert.equal(options.env.HOME, join(options.cwd, '..', 'home'));
    assert.equal(options.env.APPDATA, join(options.cwd, '..', 'roaming'));
    assert.equal(options.env.TEMP, join(options.cwd, '..', 'scratch'));
    return {
      start: async () => ({}), async close() { if (closeError) throw new Error('fixture-reap-failed'); }, async logout() {},
      async authenticate(id) { assert.equal(id, 'oauth-personal'); if (loginError) throw new Error('fixture-auth-failed'); },
      async request() { return { sessionId: randomUUID(), configOptions: [{ type: 'select', name: 'Model', id: 'model',
        category: 'model', currentValue: 'gemini-fixture', options: [{ value: 'gemini-fixture', name: 'Fixture' }] }] }; },
    };
  } };
  const runtime = createLocalAgy({ dataDir: desktopState }, deps);
  t.after(() => runtime.dispose());
  await runtime.logout(signal);
  assert.equal(calls.at(-1).env.LOCALAPPDATA, homes[1]);
  await assert.rejects(runtime.authenticate(signal), /fixture-auth-failed/u);
  for (const state of homes) assert.equal(await readFile(join(state, ...cacheParts, 'fixture.dat'), 'utf8'), state);
  loginError = false;
  closeError = true;
  await runtime.authenticate(signal);
  for (const state of homes) assert.equal(await readFile(join(state, ...cacheParts, 'fixture.dat'), 'utf8'), state);
  closeError = false;
  const custom = createLocalAgy({ dataDir: customState }, deps);
  await custom.authenticate(signal);
  await custom.dispose();
  for (const state of homes) assert.equal(await readFile(join(state, ...cacheParts, 'fixture.dat'), 'utf8'), state);
  // Give one legacy candidate a junction instead of a genuine backup target.
  await rename(join(homes[0], 'Microsoft'), join(homes[0], 'Microsoft.fixture'));
  await symlink(join(localAppData, 'Microsoft'), join(homes[0], 'Microsoft'), 'junction');
  const busy = spawn(process.execPath, ['-e', "console.log('busy'); process.stdin.resume()"], {
    cwd: join(homes[1], 'Microsoft'), windowsHide: true,
  });
  const closed = once(busy, 'close');
  try {
    await once(busy.stdout, 'data');
    await runtime.authenticate(signal);
    assert.equal(await readFile(join(homes[1], 'Microsoft', ...edgeCacheParts, 'fixture.dat'), 'utf8'), 'edge cache');
  } finally {
    busy.stdin.end();
    await closed;
  }
  const unfamiliar = join(homes[1], 'Microsoft', 'unfamiliar.fixture');
  await writeFile(unfamiliar, 'preserve the whole directory');
  await runtime.authenticate(signal);
  assert.equal(await readFile(unfamiliar, 'utf8'), 'preserve the whole directory');
  assert.equal(await readFile(join(homes[1], 'Microsoft', ...edgeCacheParts, 'fixture.dat'), 'utf8'), 'edge cache');
  await rm(unfamiliar);
  await runtime.authenticate(signal);
  assert.equal(calls.at(-1).env.LOCALAPPDATA, localAppData);
  assert.equal(calls.at(-1).allowAuthentication, true);
  assert.equal(calls.at(-1).permissionMode, 'sandbox');
  assert.equal((await lstat(join(homes[0], 'Microsoft'))).isSymbolicLink(), true);
  assert.equal((await readdir(homes[0])).some(name => name.startsWith('Microsoft.dsh-retired-')), false);
  await assert.rejects(lstat(join(homes[1], 'Microsoft')), { code: 'ENOENT' });
  const [backup] = (await readdir(homes[1])).filter(name => name.startsWith('Microsoft.dsh-retired-'));
  assert.equal(await readFile(join(homes[1], backup, 'Windows', 'Caches', 'fixture.dat'), 'utf8'), homes[1]);
  assert.equal(await readFile(join(homes[1], backup, ...edgeCacheParts, 'fixture.dat'), 'utf8'), 'edge cache');
  await rm(join(homes[0], 'Microsoft'));
  await rename(join(homes[0], 'Microsoft.fixture'), join(homes[0], 'Microsoft'));
  await runtime.authenticate(signal);
  const [historicalBackup] = (await readdir(homes[0])).filter(name => name.startsWith('Microsoft.dsh-retired-'));
  assert.equal(await readFile(join(homes[0], historicalBackup, 'Windows', 'Caches', 'fixture.dat'), 'utf8'), homes[0]);
  for (const state of [...homes, localAppData, catalogLocal(customState)]) {
    assert.equal(await readFile(join(state, 'agy', 'keyring', 'keep'), 'utf8'), 'synthetic');
  }
  for (const state of [localAppData, catalogLocal(customState)]) {
    assert.equal(await readFile(join(state, ...cacheParts, 'fixture.dat'), 'utf8'), state);
  }
  await (await runtime.open(signal)).close();
  assert.equal(calls.at(-1).env.LOCALAPPDATA, homes[1]);
  assert.equal((await readdir(homes[1])).filter(name => name.startsWith('Microsoft.dsh-retired-')).length, 1);
});

test('real cwd, stable home and official ID survive CLI upgrade and policy changes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'runtime'), agentsFile = join(root, 'AGENTS.md');
  await writeFile(agentsFile, '# Synthetic local rules');
  const parentEnv = { DSH_HOME: join(root, 'dsh-home'), SystemRoot: process.env.SystemRoot ?? root };
  const spawns = [], calls = [];
  const officialId = randomUUID();
  const configOptions = [{ type: 'select', name: 'Model', id: 'model', category: 'model', currentValue: 'gemini-fixture',
    options: [{ value: 'gemini-fixture', name: 'Fixture' }] }];
  const dependencies = {
    parentEnv, verify: () => join(root, 'agy.exe'), resolveProxy: () => ({}),
    makeTransport(options) {
      spawns.push(options);
      return {
        start: async () => ({ agentInfo: { version: spawns.length === 1 ? '1.5.12' : '1.5.13' },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }),
        async request(method, params) {
          calls.push({ method, params });
          return { sessionId: params.sessionId ?? officialId, configOptions };
        }, close: async () => {},
      };
    },
  };
  let runtime = createLocalAgy({ dataDir, agentsFile }, dependencies);
  const id = 'test-session';
  const first = await runtime.open(signal, { id, cwd: root, mode: 'full', persona: '合成写作人设' });
  assert.equal(first.id, officialId);
  assert.equal(first.capabilities.promptCapabilities.image, true);
  const binding = { createdAt: 1, cwd: root, officialId, throughTurn: 2 };
  await runtime.writeBinding(id, binding);
  const home = spawns[0].env.HOME;
  const settings = () => readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8').then(JSON.parse);
  assert.equal(spawns[0].cwd, root);
  assert.equal(spawns[0].permissionMode, 'full');
  assert.deepEqual(await settings(), { useG1Credits: false, agentMode: '', toolPermission: 'always-proceed',
    allowNonWorkspaceAccess: true, enableTerminalSandbox: false });
  const rules = () => readFile(join(home, '.gemini', 'GEMINI.md'), 'utf8');
  await runtime.dispose();
  assert.equal(await rules(), '## Global instructions (AGENTS.md)\n\n# Synthetic local rules\n\n合成写作人设');

  runtime = createLocalAgy({ dataDir, agentsFile }, dependencies);
  assert.deepEqual(await runtime.readBinding(id), binding);
  const reopened = await runtime.open(signal, { id, cwd: root, mode: 'read-only', officialId });
  assert.equal(reopened.id, officialId);
  assert.equal(spawns[1].env.HOME, home);
  assert.equal(spawns[1].permissionMode, 'sandbox');
  assert.equal(await rules(), '## Global instructions (AGENTS.md)\n\n# Synthetic local rules', 'ordinary mode removes persona while preserving global rules');
  const deny = ['command(*)', 'unsandboxed(*)', 'execute_url(*)'];
  const allow = ['mcp(dsh/*)'];
  assert.deepEqual(await settings(), { useG1Credits: false, agentMode: '', toolPermission: 'request-review',
    allowNonWorkspaceAccess: false, enableTerminalSandbox: true, permissions: { deny: [...deny, 'write_file(*)'], allow } });
  assert.deepEqual(calls, [{ method: 'session/new', params: { cwd: root, mcpServers: [] } },
    { method: 'session/load', params: { cwd: root, mcpServers: [], sessionId: officialId } }]);
  await reopened.close();
  await runtime.open(signal, { id, cwd: root, mode: 'workspace-write', officialId });
  assert.equal(spawns[2].permissionMode, 'sandbox');
  assert.deepEqual(await settings(), { useG1Credits: false, agentMode: '', toolPermission: 'request-review',
    allowNonWorkspaceAccess: false, enableTerminalSandbox: true, permissions: { deny, allow, ask: ['write_file(*)'] } });
  await runtime.dispose();
  runtime = createLocalAgy({ dataDir, agentsFile }, dependencies);
  for (const mode of ['read-only', 'workspace-write']) {
    const chat = await runtime.open(signal, { id, cwd: root, mode, officialId, onPermission() {} });
    assert.equal(spawns.at(-1).permissionMode, 'sandbox');
    assert.deepEqual(await settings(), { useG1Credits: false, agentMode: '', toolPermission: 'request-review',
      allowNonWorkspaceAccess: true, enableTerminalSandbox: true, permissions: { deny: mode === 'read-only' ? [...deny, 'write_file(*)'] : deny,
        allow, ask: mode === 'read-only' ? ['read_file(*)'] : ['read_file(*)', 'write_file(*)'] } });
    await chat.close();
  }
  await runtime.dispose();
});

test('private CLI homes copy user DSH skills with resources; refresh updates and removals without following links', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-skills-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = join(root, 'dsh-home'), skills = join(dshHome, 'skills'), source = join(skills, 'bundle');
  const outside = join(root, 'external');
  await mkdir(join(source, 'references'), { recursive: true });
  await mkdir(join(skills, '.system', 'bundled'), { recursive: true });
  await mkdir(join(skills, 'not-a-skill'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(skills, 'linked-skill'), 'junction');
  await symlink(outside, join(source, 'linked-assets'), 'junction');
  await writeFile(join(source, 'SKILL.md'), 'original');
  await writeFile(join(source, 'references', 'remove-me.md'), 'reference');
  await writeFile(join(outside, 'SKILL.md'), 'not ours');
  await writeFile(join(skills, 'flat.md'), 'flat skill');
  await writeFile(join(skills, '.system', 'bundled', 'SKILL.md'), 'bundled');
  const spawns = [];
  const mkdirDep = { parentEnv: { DSH_HOME: dshHome, SystemRoot: process.env.SystemRoot ?? root },
    verify: () => join(root, 'agy.exe'), resolveProxy: () => ({}), makeTransport({ env }) {
      spawns.push(env);
      return { start: async () => ({}), close: async () => {},
        async request() { return { sessionId: randomUUID(), configOptions: [{ type: 'select', name: 'Model', id: 'model',
          category: 'model', currentValue: 'gemini-fixture', options: [{ value: 'gemini-fixture', name: 'Fixture' }] }] }; } };
    } };
  const runtime = createLocalAgy({ dataDir: join(root, 'data') }, mkdirDep);
  const talk = id => runtime.open(signal, { id, cwd: root }).then(session => session.close());
  const dest = ({ HOME }) => join(HOME, '.gemini', 'antigravity-cli', 'skills');
  await (await runtime.open(signal)).close();
  await assert.rejects(lstat(dest(spawns[0])), { code: 'ENOENT' });
  await talk('first');
  const first = dest(spawns[1]);
  assert.equal(await readFile(join(first, 'bundle', 'SKILL.md'), 'utf8'), 'original');
  assert.equal(await readFile(join(first, 'bundle', 'references', 'remove-me.md'), 'utf8'), 'reference');
  assert.equal(await readFile(join(first, 'flat', 'SKILL.md'), 'utf8'), 'flat skill');
  for (const unused of ['.system', 'not-a-skill', 'linked-skill', join('bundle', 'linked-assets')]) {
    await assert.rejects(lstat(join(first, unused)), { code: 'ENOENT' });
  }
  assert.equal((await lstat(join(first, 'bundle'))).isSymbolicLink(), false);
  await writeFile(join(first, 'bundle', 'SKILL.md'), 'changed private copy');
  assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), 'original');
  await writeFile(join(source, 'SKILL.md'), 'updated');
  await rm(join(source, 'references', 'remove-me.md'));
  await rm(join(skills, 'flat.md'));
  await talk('first');
  assert.equal(await readFile(join(first, 'bundle', 'SKILL.md'), 'utf8'), 'updated');
  await assert.rejects(lstat(join(first, 'bundle', 'references', 'remove-me.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(first, 'flat')), { code: 'ENOENT' });
  await talk('second');
  const second = dest(spawns.at(-1));
  assert.notEqual(second, first);
  assert.equal(await readFile(join(second, 'bundle', 'SKILL.md'), 'utf8'), 'updated');
  await rename(skills, join(dshHome, 'skills-removed'));
  await talk('first');
  await assert.rejects(lstat(join(first, 'bundle')), { code: 'ENOENT' });
  await runtime.dispose();
});

test('cwd context merges ordinary local rules and skills, and fingerprints only effective inputs', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), elsewhere = join(root, 'other-project'), outside = join(root, 'outside');
  const dshHome = join(root, 'dsh-home'), global = join(dshHome, 'skills'), dataDir = join(root, 'runtime');
  const localDsh = join(cwd, '.dsh'), local = join(localDsh, 'skills'), localBundle = join(local, 'bundle');
  const globalRules = join(dshHome, 'AGENTS.md'), localRules = join(cwd, 'AGENTS.md');
  for (const dir of [join(localBundle, 'references'), join(localBundle, '.git'), join(global, 'SHARED'), join(outside, 'skills'), elsewhere]) {
    await mkdir(dir, { recursive: true });
  }
  const write = (dir, name, value) => writeFile(join(dir, name), value);
  await writeFile(globalRules, 'global rules');
  await writeFile(localRules, 'local rules');
  await write(root, 'AGENTS.md', 'not a direct cwd file');
  await write(outside, 'SKILL.md', 'outside skill');
  await write(join(outside, 'skills'), 'outside-flat.md', 'outside flat skill');
  await write(outside, 'AGENTS.md', 'outside rules');
  await write(global, 'only-global.md', 'global flat');
  await write(join(global, 'SHARED'), 'SKILL.md', 'shadowed global directory');
  await write(join(global, 'SHARED'), 'asset.txt', 'never merge shadowed resources');
  await write(local, 'shared.md', 'workspace flat shadows a global directory');
  await write(local, 'bundle.md', 'workspace flat loses to workspace directory');
  await write(localBundle, 'SKILL.md', 'workspace directory');
  await write(join(localBundle, '.git'), 'config', 'excluded');
  const resource = join(localBundle, 'references', 'notes.md');
  await writeFile(resource, 'original resource');
  await symlink(outside, join(local, 'linked-skill'), 'junction');
  await symlink(outside, join(localBundle, 'linked-assets'), 'junction');
  await symlink(outside, join(elsewhere, '.dsh'), 'junction');
  const alias = join(root, 'alias');
  await symlink(cwd, alias, 'junction');
  let linkedRules = true;
  try { await symlink(join(outside, 'AGENTS.md'), join(elsewhere, 'AGENTS.md'), 'file'); }
  catch (error) {
    if (error.code !== 'EPERM') throw error;
    linkedRules = false;
    await mkdir(join(elsewhere, 'AGENTS.md'));
  }
  const spawns = [];
  const runtime = createLocalAgy({ dataDir, agentsFile: globalRules }, {
    parentEnv: { DSH_HOME: dshHome, SystemRoot: process.env.SystemRoot ?? root },
    verify: () => join(root, 'agy.exe'), resolveProxy: () => ({}), makeTransport(options) {
      spawns.push(options);
      return { start: async () => ({}), close: async () => {},
        async request() { return { sessionId: randomUUID(), configOptions: [{ type: 'select', name: 'Model', id: 'model',
          category: 'model', currentValue: 'fixture', options: [{ value: 'fixture', name: 'Fixture' }] }] }; } };
    },
  });
  t.after(() => runtime.dispose());
  const open = (dir, id) => runtime.open(signal, { id, cwd: dir, persona: 'preset persona' });
  const output = (...parts) => join(spawns.at(-1).env.HOME, '.gemini', ...parts);
  const rules = () => readFile(output('GEMINI.md'), 'utf8');
  const skills = (...parts) => output('antigravity-cli', 'skills', ...parts);
  const missing = path => assert.rejects(lstat(path), { code: 'ENOENT' });
  const fingerprint = await runtime.workspaceFingerprint(cwd, signal);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(spawns.length, 0);
  await missing(dataDir);
  await write(root, 'AGENTS.md', 'edited outside of direct cwd');
  await write(join(global, 'SHARED'), 'SKILL.md', 'edited shadowed skill');
  await write(join(localBundle, '.git'), 'ignored', 'unpublished metadata');
  await write(outside, 'SKILL.md', 'different linked target');
  assert.equal(await runtime.workspaceFingerprint(cwd), fingerprint);
  await assert.rejects(runtime.workspaceFingerprint(cwd, AbortSignal.abort()), { name: 'AbortError' });
  const catalog = await runtime.open(signal);
  assert.equal(catalog.workspaceFingerprint, undefined);
  assert.equal(await rules(), '');
  await missing(skills());
  await catalog.close();

  const session = await open(cwd, 'workspace');
  assert.equal(session.workspaceFingerprint, fingerprint);
  const globalSection = '## Global instructions (AGENTS.md)';
  const workspaceSection = '## Workspace instructions (AGENTS.md)';
  assert.equal(await rules(), `${globalSection}\n\nglobal rules\n\n${workspaceSection}\n\nlocal rules\n\npreset persona`);
  assert.equal(await readFile(skills('shared', 'SKILL.md'), 'utf8'), 'workspace flat shadows a global directory');
  assert.equal(await readFile(skills('only-global', 'SKILL.md'), 'utf8'), 'global flat');
  assert.equal(await readFile(skills('bundle', 'SKILL.md'), 'utf8'), 'workspace directory');
  assert.equal(await readFile(skills('bundle', 'references', 'notes.md'), 'utf8'), 'original resource');
  for (const path of [skills('shared', 'asset.txt'), skills('linked-skill'), skills('bundle', 'linked-assets'), skills('bundle', '.git')]) {
    await missing(path);
  }
  await session.close();

  await writeFile(resource, 'different resource length');
  const resourceChanged = await runtime.workspaceFingerprint(cwd);
  assert.notEqual(resourceChanged, fingerprint);
  await writeFile(localRules, 'updated local rules');
  const rulesChanged = await runtime.workspaceFingerprint(cwd);
  assert.notEqual(rulesChanged, resourceChanged);
  await writeFile(globalRules, 'updated global rules');
  assert.notEqual(await runtime.workspaceFingerprint(cwd), rulesChanged);
  await rm(join(local, 'shared.md'));
  const revealed = await runtime.workspaceFingerprint(cwd);
  const refreshed = await open(cwd, 'workspace');
  assert.equal(refreshed.workspaceFingerprint, revealed);
  assert.equal(await rules(), `${globalSection}\n\nupdated global rules\n\n${workspaceSection}\n\nupdated local rules\n\npreset persona`);
  assert.equal(await readFile(skills('SHARED', 'SKILL.md'), 'utf8'), 'edited shadowed skill');
  assert.equal(await readFile(skills('bundle', 'references', 'notes.md'), 'utf8'), 'different resource length');
  await refreshed.close();

  for (const dir of [elsewhere, alias]) {
    const unmerged = await open(dir, 'workspace');
    assert.equal(unmerged.workspaceFingerprint, await runtime.workspaceFingerprint(dir));
    assert.equal(await rules(), `${globalSection}\n\nupdated global rules\n\npreset persona`);
    await missing(skills('bundle'));
    await missing(skills('outside-flat'));
    await unmerged.close();
  }
  assert.equal(spawns.at(-1).cwd, cwd, 'the CLI still launches in the canonical cwd');
  await rename(globalRules, join(dshHome, 'AGENTS.fixture'));
  const workspaceOnly = await open(cwd, 'workspace');
  assert.equal(await rules(), `${workspaceSection}\n\nupdated local rules\n\npreset persona`);
  assert.equal(workspaceOnly.workspaceFingerprint, await runtime.workspaceFingerprint(cwd));
  await workspaceOnly.close();
  if (!linkedRules) t.diagnostic('File symlink creation requires Windows privileges; tested a non-ordinary AGENTS directory instead.');
});

test('ACP input keeps long text, verified file links, and image bytes in order', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-attachments-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const long = '中文长文'.repeat(20_000);
  const image = { mediaType: 'image/png', height: 1, width: 1, bytes: 3 };
  const file = { name: '合成.txt', bytes: 3 };
  const filename = join(root, file.name), neighbor = join(root, 'neighbor.txt');
  await writeFile(filename, 'abc');
  await writeFile(neighbor, 'xyz');
  const refs = [];
  let verified = false;
  const attachments = {
    fileHostPath(ref) { assert.equal(ref, file); return filename; },
    async *readFileStream(ref, control) {
      assert.equal(ref, file);
      assert.equal(control, signal);
      yield Buffer.from('abc');
      verified = true;
    },
    async readImage(ref) { assert.equal(ref, image); return { ref, data: Buffer.from('abc') }; },
  };
  const options = { onReadOnlyRef: ref => { assert.ok(verified); refs.push(ref); } };
  const blocks = await localPrompt([text(long), { type: 'file', attachment: file, path: neighbor }, { type: 'image', attachment: image }],
    attachments, signal, options);
  assert.deepEqual(blocks[0], text(long));
  assert.equal(blocks[1].type, 'resource_link');
  assert.match(blocks[1].uri, /^file:\/\//);
  assert.ok(blocks[2].text.includes(JSON.stringify(filename)));
  assert.deepEqual(blocks[3], { type: 'image', mimeType: 'image/png', data: 'YWJj' });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, filename);
  assert.equal(await matchesAgyReadOnlyRef(filename, root, refs[0]), true);
  assert.equal(await matchesAgyReadOnlyRef(file.name, root, refs[0]), true);
  assert.equal(await matchesAgyReadOnlyRef(root, root, refs[0]), false);
  assert.equal(await matchesAgyReadOnlyRef(neighbor, root, refs[0]), false);
  const alias = join(root, 'alias');
  await symlink(root, alias, 'junction');
  assert.equal(await matchesAgyReadOnlyRef(join(alias, file.name), root, refs[0]), false);
  await assert.rejects(localPrompt([{ type: 'file', attachment: file }], { ...attachments,
    fileHostPath: () => join(alias, file.name) }, signal, options), { code: 'attachment-unavailable' });
  await assert.rejects(localPrompt([{ type: 'file', attachment: file }], { ...attachments,
    async *readFileStream() { yield Buffer.from('abc'); throw new Error('fixture integrity failure at EOF'); } }, signal, options),
  { code: 'attachment-unavailable' });
  assert.equal(refs.length, 1, 'never grants a corrupt object or an alias');
  await writeFile(filename, 'changed bytes');
  assert.equal(await matchesAgyReadOnlyRef(filename, root, refs[0]), false);
  assert.equal(isAgyReadOnlyRefPath(filename, root, refs[0]), true, 'replacement still must not be writable via this grant');
  assert.equal(isAgyReadOnlyRefPath(neighbor, root, refs[0]), false);
});

test('history keeps recent user/assistant body only, bounded independently from the current text', () => {
  const events = [];
  const append = (type, data) => events.push({ seq: events.length, surfaceOp: 'append', type, data });
  const turn = (number, user, assistant, result = 'completed') => {
    append('turn/start', { turn: number });
    append('user/message', { source: user ? { kind: 'user' } : { kind: 'schedule' }, content: [text(user ?? 'AUTOMATION')] });
    append('tool/result', { content: [text('INTERNAL TOOL')] });
    append('assistant/message', { turn: number, message: { content: [text(assistant), { type: 'reasoning', text: 'INTERNAL REASONING' }] } });
    append('turn/end', { turn: number, reason: { kind: result } });
  };
  turn(1, 'old user', 'old assistant');
  turn(2, undefined, 'AUTOMATED ANSWER');
  turn(3, 'interrupted user', 'interrupted assistant', 'aborted');
  turn(4, 'middle message', 'new answer');
  turn(5, 'current prompt', 'not in history');
  const result = localHistory({ snapshotEvents: () => events }, 20, 1);
  assert.match(result, /middle message.*new answer/);
  assert.doesNotMatch(result, /old user|AUTOMA|interrupted user|INTERNAL|current prompt/);
});

test('history respects shadowed compaction node IDs and registers only a truncated archive file', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-history-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const append = (type, data, surfaceOp) => {
    const seq = events.length + 1;
    events.push({ seq, type, data, surfaceOp });
    return seq;
  };
  const turn = (number, message, reply) => {
    append('turn/start', { turn: number });
    const user = append('user/message', { source: { kind: 'user' }, content: [text(message)] }, 'append');
    const assistant = append('assistant/message', { turn: number, message: { content: [text(reply), { type: 'reasoning', text: 'PRIVATE THOUGHT' }] } }, 'append');
    append('turn/end', { turn: number, reason: { kind: 'completed' } });
    return [user, assistant];
  };
  const old = turn(1, 'old question', 'old reply');
  const first = append('compaction/summary', { summary: [text('first summary')], shadowedSeqs: old });
  const surviving = turn(2, 'hidden question', 'remaining reply');
  append('compaction/summary', { summary: [text('latest summary')], shadowedRange: { start: first, end: surviving[0] },
    shadowedSeqs: [surviving[0]] });
  const session = { snapshotEvents: () => events };
  const before = () => events.length + 1;
  const archivePath = join(root, 'dsh-history-archive.md'), grants = [];
  const opts = { archivePath, signal, onReadOnlyRef: ref => grants.push(ref) };
  const inline = await prepareLocalHistory(session, before(), 0, opts);
  assert.match(inline, /latest summary.*remaining reply/);
  assert.doesNotMatch(inline, /first summary|old question|old reply|hidden question|PRIVATE THOUGHT|archived at/);
  assert.equal(grants.length, 0);
  await assert.rejects(lstat(archivePath), { code: 'ENOENT' });
  // A single shortened message, even when its turn fits, is still a length truncation.
  const long = 'start of huge reply ' + 'A'.repeat(22_000) + ' middle omitted marker ' + 'B'.repeat(22_000);
  turn(3, 'unabridged question', long);
  const handoff = await prepareLocalHistory(session, before(), 0, opts);
  assert.ok(handoff.includes(JSON.stringify(archivePath)));
  assert.match(handoff, /shortened/);
  assert.doesNotMatch(handoff, /middle omitted marker|old question|PRIVATE THOUGHT/);
  assert.equal(grants.length, 1);
  assert.equal(await matchesAgyReadOnlyRef(archivePath, root, grants[0]), true);
  assert.equal(await matchesAgyReadOnlyRef(root, root, grants[0]), false);
  const archive = await readFile(archivePath, 'utf8');
  assert.match(archive, /latest summary/);
  assert.match(archive, /old question/);
  assert.match(archive, /middle omitted marker/);
  assert.doesNotMatch(archive, /PRIVATE THOUGHT/);
  await assert.rejects(prepareLocalHistory(session, before(), 0, { ...opts, signal: AbortSignal.abort() }), { name: 'AbortError' });
  const linkedDir = join(root, 'link');
  await symlink(root, linkedDir, 'junction');
  const fallback = await prepareLocalHistory(session, before(), 0, { ...opts, archivePath: join(linkedDir, 'unsafe.md') });
  assert.doesNotMatch(fallback, /archived at/);
  await assert.rejects(lstat(join(root, 'unsafe.md')), { code: 'ENOENT' });
  assert.equal(grants.length, 1);
});

test('explicit writable roots cover only real directories and contained output paths', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-writable-roots-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), extra = join(root, 'extra'), outside = join(root, 'external');
  for (const dir of [workspace, extra, outside]) await mkdir(dir);
  const junction = join(extra, 'escape'), extraAlias = join(root, 'extra-alias'), incoming = join(outside, 'workspace-alias');
  await symlink(outside, junction, 'junction');
  await symlink(extra, extraAlias, 'junction');
  await symlink(workspace, incoming, 'junction');
  assert.equal(await withinAgyWritableRoots('new.txt', workspace, workspace), true);
  const output = join(extra, 'nested', 'new.txt');
  assert.equal(await withinAgyWritableRoots(output, workspace, workspace), false);
  assert.equal(await withinAgyWritableRoots(output, workspace, workspace, [extra]), true);
  assert.equal(await withinAgyWritableRoots(join(extra, 'escape', 'new.txt'), workspace, workspace, [extra]), false);
  assert.equal(await withinAgyWritableRoots(join(outside, 'workspace-alias', 'new.txt'), workspace, workspace, [extra]), false);
  assert.equal(await withinAgyWritableRoots(`escape/../new.txt`, extra, workspace, [extra]), false);
  assert.equal(await withinAgyWritableRoots(join(extraAlias, 'new.txt'), workspace, workspace, [extraAlias]), false);
  assert.equal(await withinAgyWritableRoots(output, workspace, workspace, [join(root, 'missing')]), false);
});

test('reasoning and tool progress are display-only with final status and a tool-only receipt', () => {
  const view = agyProgress();
  assert.equal(view.push({ kind: 'thought', value: 'Reasoning' })[1].type, 'reasoning-delta');
  const update = (id, status) => view.push({ kind: 'tool', value: { toolCallId: id, title: 'Read x.txt', status } });
  assert.match(update('1', 'in_progress').at(-1).text, /工具执行中/);
  assert.match(update('1', 'completed').at(-1).text, /工具已完成/);
  update('2', 'failed');
  assert.match(view.close()[0].block.text, /^工具失败/);
  assert.match(view.receipt(), /已完成 1 项，失败 1 项/);
  assert.equal(view.hasAnswer, false);
});

test('non-catalog sessions block AGY built-in async subagent tools via PreToolUse hook and guide to DSH native subagents', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-hooks-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), cwd = join(root, 'work');
  await mkdir(cwd);
  const spawns = [];
  const runtime = createLocalAgy({ dataDir, agentsFile: join(root, 'missing-agents.md') }, {
    parentEnv: { DSH_HOME: root, SystemRoot: process.env.SystemRoot ?? root },
    verify: () => join(root, 'agy.exe'),
    resolveProxy: () => ({}),
    makeTransport(options) {
      spawns.push(options);
      return {
        start: async () => ({}),
        close: async () => {},
        async request() {
          return {
            sessionId: randomUUID(),
            configOptions: [{
              type: 'select', name: 'Model', id: 'model', category: 'model',
              currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
            }],
          };
        },
      };
    },
  });
  t.after(() => runtime.dispose());

  // Catalog session does not write hooks.json
  const catalog = await runtime.open(signal);
  await assert.rejects(lstat(join(spawns[0].env.HOME, '.gemini', 'config', 'hooks.json')), { code: 'ENOENT' });
  await catalog.close();

  // Chat session with nativeSubagents: true
  const s1 = await runtime.open(signal, { id: 'chat-sub', cwd, mode: 'full', nativeSubagents: true });
  const cfg1 = join(spawns[1].env.HOME, '.gemini', 'config');
  const hooks = JSON.parse(await readFile(join(cfg1, 'hooks.json'), 'utf8'));
  const deny1 = JSON.parse(await readFile(join(cfg1, 'dsh-deny-subagent.json'), 'utf8'));
  const geminiMd1 = await readFile(join(spawns[1].env.HOME, '.gemini', 'GEMINI.md'), 'utf8');
  const matcher = new RegExp(hooks['dsh-native-subagents-only'].PreToolUse[0].matcher);
  for (const blocked of ['invoke_subagent', 'define_subagent', 'manage_subagents', 'send_message', 'swarm', 'run_workflow', 'schedule']) {
    assert.equal(matcher.test(blocked), true, `should block ${blocked}`);
  }
  for (const allowed of ['mcp_dsh_subagent', 'mcp_dsh_send_message', 'mcp_dsh_list_agents', 'mcp_dsh_wait_agent', 'read_file', 'run_command']) {
    assert.equal(matcher.test(allowed), false, `should allow ${allowed}`);
  }
  assert.equal(deny1.decision, 'deny');
  assert.match(deny1.reason, /mcp_dsh_subagent/);
  assert.match(geminiMd1, /mcp_dsh_subagent/);
  await s1.close();

  // Chat session with nativeSubagents: false
  const s2 = await runtime.open(signal, { id: 'chat-nosub', cwd, mode: 'full', nativeSubagents: false });
  const cfg2 = join(spawns[2].env.HOME, '.gemini', 'config');
  const deny2 = JSON.parse(await readFile(join(cfg2, 'dsh-deny-subagent.json'), 'utf8'));
  const geminiMd2 = await readFile(join(spawns[2].env.HOME, '.gemini', 'GEMINI.md'), 'utf8');
  assert.equal(deny2.decision, 'deny');
  assert.doesNotMatch(deny2.reason, /mcp_dsh_subagent/);
  assert.doesNotMatch(geminiMd2, /mcp_dsh_subagent/);
  await s2.close();

  // Ephemeral auxiliary session uses a unique isolated dir (not catalog), writes hooks, and deletes itself on close
  const aux1 = await runtime.open(signal, { ephemeral: true });
  const aux2 = await runtime.open(signal, { ephemeral: true });
  const homeAux1 = spawns[3].env.HOME;
  const homeAux2 = spawns[4].env.HOME;
  assert.notEqual(homeAux1, homeAux2);
  assert.notEqual(homeAux1, spawns[0].env.HOME);
  const auxHooks = JSON.parse(await readFile(join(homeAux1, '.gemini', 'config', 'hooks.json'), 'utf8'));
  assert.ok(auxHooks['dsh-native-subagents-only']);
  await aux1.close();
  await aux2.close();
  await assert.rejects(lstat(join(homeAux1, '..')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(homeAux2, '..')), { code: 'ENOENT' });
});

test('installAgyLineage authorizes resumed pre-existing subagents and their callbacks after restart', async () => {
  const listeners = new Map();
  const agentMap = new Map();
  const rootAgent = {
    id: 'root-1', status: 'running',
    session: { header: { origin: undefined } },
    ctx: { get: () => undefined },
  };
  const resumedChild = {
    id: 'child-old', status: 'running',
    session: { header: { origin: 'subagent', parentSession: 'root-1', delegationDepth: 1 } },
    ctx: { get: () => undefined },
  };
  const foreignChild = {
    id: 'child-other-tree', status: 'running',
    session: { header: { origin: 'subagent', parentSession: 'other-root', delegationDepth: 1 } },
    ctx: { get: () => undefined },
  };
  agentMap.set('root-1', rootAgent);
  agentMap.set('child-old', resumedChild);
  agentMap.set('child-other-tree', foreignChild);
  const subagents = {
    rootOf(agent) {
      if (agent === resumedChild) return rootAgent;
      if (agent === foreignChild) return undefined;
      return agent;
    },
  };
  const ctx = {
    get(key) {
      if (key === 'agents') return { get: id => agentMap.get(id) };
      if (key === 'subagents') return subagents;
      return undefined;
    },
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
  };
  const authorize = installAgyLineage(ctx, () => true);

  // Simulate owner prompt authorizing root after restart (no subagent/start was emitted for child-old!)
  const ownerMsg = { id: 'm1', source: { kind: 'user', rpcId: 'rpc-1', principal: { kind: 'owner' } } };
  for (const fn of listeners.get('agent/inbox/inserted') ?? []) fn({ agent: rootAgent, message: ownerMsg });
  for (const fn of listeners.get('agent/pre-step') ?? []) {
    await fn({ agent: rootAgent, messages: [ownerMsg], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [ownerMsg] }));
  }

  // Resumed child receives a relay from root (e.g., send_message after restart)
  const relayToChild = { id: 'm2', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'root-1' } };
  assert.equal(authorize(resumedChild, [relayToChild], { step: 1 }), true);

  // Root receives subagent-settled and agent-message from resumed pre-existing child
  const settledFromOldChild = { id: 'm3', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-old' } };
  const relayFromOldChild = { id: 'm4', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-old' } };
  assert.equal(authorize(rootAgent, [settledFromOldChild], { step: 2 }), true);
  assert.equal(authorize(rootAgent, [relayFromOldChild], { step: 3 }), true);

  // Foreign child from another tree is still strictly rejected!
  const spoofed = { id: 'm5', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-other-tree' } };
  assert.equal(authorize(rootAgent, [spoofed], { step: 4 }), false);
});

test('syncAgySkills follows official agy migration junction to sibling .gemini/config/skills while rejecting outside links', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-skill-migrate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalSkills = join(root, 'dsh-skills'), skillDir = join(globalSkills, 'demo');
  const geminiDir = join(root, 'home', '.gemini');
  const settingsDir = join(geminiDir, 'antigravity-cli');
  const configDir = join(geminiDir, 'config');
  const migratedSkills = join(configDir, 'skills');
  const outside = join(root, 'outside');
  await Promise.all([skillDir, settingsDir, migratedSkills, outside].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(join(skillDir, 'SKILL.md'), '# Demo Skill v1\n');
  await writeFile(join(migratedSkills, '.dsh-skill-mirror'), '');
  // Simulate newer agy.exe leaving a junction at antigravity-cli/skills -> config/skills
  await symlink(migratedSkills, join(settingsDir, 'skills'), 'junction');

  const inv1 = await inventoryAgyWorkspace({ globalSkills, signal });
  await syncAgySkills(inv1, settingsDir, signal);
  assert.equal(await readFile(join(migratedSkills, 'demo', 'SKILL.md'), 'utf8'), '# Demo Skill v1\n');
  assert.equal(await readFile(join(settingsDir, 'skills', 'demo', 'SKILL.md'), 'utf8'), '# Demo Skill v1\n');

  // Update skill and sync again cleanly
  await writeFile(join(skillDir, 'SKILL.md'), '# Demo Skill v2\n');
  const inv2 = await inventoryAgyWorkspace({ globalSkills, signal });
  await syncAgySkills(inv2, settingsDir, signal);
  assert.equal(await readFile(join(migratedSkills, 'demo', 'SKILL.md'), 'utf8'), '# Demo Skill v2\n');

  // A junction pointing outside .gemini/config/skills must still be rejected!
  await rm(join(settingsDir, 'skills'), { recursive: true, force: true });
  await symlink(outside, join(settingsDir, 'skills'), 'junction');
  await assert.rejects(syncAgySkills(inv2, settingsDir, signal), /Unsafe Antigravity skills directory/);
});

test('inventoryAgyWorkspace discovers all DSH skill roots in exact precedence order and handles user/ grouping safely', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-skill-roots-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = join(root, 'user-home');
  const dshHome = join(root, 'dsh-home');
  const cwd = join(root, 'project');
  const userAgents = join(userHome, '.agents', 'skills');
  const userDsh = join(dshHome, 'skills');
  const userDshGrouped = join(userDsh, 'user');
  const projectAgents = join(cwd, '.agents', 'skills');
  const projectDsh = join(cwd, '.dsh', 'skills');

  const put = async (base, name, body) => {
    const dir = join(base, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), body);
  };
  await put(userAgents, 'only-user-agents', 'from ~/.agents/skills');
  await put(userAgents, 'shared', 'tier-1-user-agents');
  await put(userDshGrouped, 'only-grouped', 'from ~/.dsh/skills/user');
  await put(userDshGrouped, 'shared', 'tier-2-user-grouped');
  await put(userDshGrouped, 'grouped-vs-direct', 'tier-2-grouped');
  await put(userDsh, 'grouped-vs-direct', 'tier-3-direct-dsh');
  await put(projectAgents, 'only-project-agents', 'from <cwd>/.agents/skills');
  await put(projectAgents, 'shared', 'tier-4-project-agents');
  await put(projectAgents, 'project-override', 'tier-4-project-agents');
  await put(projectDsh, 'project-override', 'tier-5-project-dsh');

  // Verify agentsSkillsPath isolation and env precedence
  assert.equal(agentsSkillsPath({ DSH_HOME: dshHome }), undefined);
  assert.equal(agentsSkillsPath({ USERPROFILE: userHome }), userAgents);
  assert.equal(agentsSkillsPath({ DSH_AGENTS_HOME: join(root, 'custom-agents'), USERPROFILE: userHome }), join(root, 'custom-agents', 'skills'));

  const spawns = [];
  const runtime = createLocalAgy({ dataDir: join(root, 'data') }, {
    parentEnv: { DSH_HOME: dshHome, USERPROFILE: userHome, SystemRoot: process.env.SystemRoot ?? root },
    verify: () => join(root, 'agy.exe'),
    resolveProxy: () => ({}),
    makeTransport(options) {
      spawns.push(options);
      return {
        start: async () => ({}),
        close: async () => {},
        async request() {
          return {
            sessionId: randomUUID(),
            configOptions: [{
              type: 'select', name: 'Model', id: 'model', category: 'model',
              currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
            }],
          };
        },
      };
    },
  });
  t.after(() => runtime.dispose());

  const session = await runtime.open(signal, { id: 'all-roots', cwd, mode: 'full' });
  const mirrored = (...parts) => join(spawns[0].env.HOME, '.gemini', 'antigravity-cli', 'skills', ...parts);
  assert.equal(await readFile(mirrored('only-user-agents', 'SKILL.md'), 'utf8'), 'from ~/.agents/skills');
  assert.equal(await readFile(mirrored('only-grouped', 'SKILL.md'), 'utf8'), 'from ~/.dsh/skills/user');
  assert.equal(await readFile(mirrored('grouped-vs-direct', 'SKILL.md'), 'utf8'), 'tier-3-direct-dsh');
  assert.equal(await readFile(mirrored('only-project-agents', 'SKILL.md'), 'utf8'), 'from <cwd>/.agents/skills');
  assert.equal(await readFile(mirrored('shared', 'SKILL.md'), 'utf8'), 'tier-4-project-agents');
  assert.equal(await readFile(mirrored('project-override', 'SKILL.md'), 'utf8'), 'tier-5-project-dsh');
  await session.close();

  // Edge case: a genuine skill literally named "user" (having ~/.dsh/skills/user/SKILL.md)
  // must be discovered as "user" and NOT produce a bogus flat skill named "SKILL".
  const literalSkills = join(root, 'literal-skills');
  await put(literalSkills, 'user', 'skill literally named user');
  const invLiteral = await inventoryAgyWorkspace({ globalSkills: literalSkills, signal });
  assert.deepEqual(invLiteral.skills.map(s => s.name), ['user']);
});

test('skill-sync-failed preserves underlying cause and logs diagnostic warning via logger', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-skill-diag-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), cwd = join(root, 'work'), outside = join(root, 'outside');
  await Promise.all([cwd, outside].map(dir => mkdir(dir, { recursive: true })));
  const warnings = [];
  const runtime = createLocalAgy({ dataDir }, {
    parentEnv: { DSH_HOME: join(root, 'dsh-home'), SystemRoot: process.env.SystemRoot ?? root },
    verify: () => join(root, 'agy.exe'),
    resolveProxy: () => ({}),
    logger: { warn: message => warnings.push(message) },
    makeTransport() { assert.fail('should fail before launching ACP'); },
  });
  t.after(() => runtime.dispose());

  // Pre-seed an external junction at .gemini/antigravity-cli/skills for session id 'broken-sync'
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update('broken-sync').digest('hex');
  const settingsDir = join(dataDir, key, 'home', '.gemini', 'antigravity-cli');
  await mkdir(settingsDir, { recursive: true });
  await symlink(outside, join(settingsDir, 'skills'), 'junction');

  await assert.rejects(
    runtime.open(signal, { id: 'broken-sync', cwd, mode: 'full' }),
    error => {
      assert.equal(error.code, 'skill-sync-failed');
      assert.match(error.cause?.message ?? '', /Unsafe Antigravity skills directory/);
      return true;
    },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unsafe Antigravity skills directory/);
});
