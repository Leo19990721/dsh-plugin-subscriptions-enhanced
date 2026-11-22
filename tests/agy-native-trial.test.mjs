import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/start-agy-native-trial.ps1', import.meta.url), 'utf8');

test('trial Web can start signed out without a credential acknowledgement or login marker', () => {
  assert.match(source, /ValidateSet\('Prepare','Web','Stop'\)/u);
  assert.match(source, /\$Action = 'Prepare'/u);
  assert.match(source, /if \(\$Action -eq 'Prepare'\)/u);
  assert.doesNotMatch(source, /UseWindowsLogin|login-completed\.json|officialLoginExitedSuccessfully|\$Action -eq 'Login'/u);
  assert.doesNotMatch(source, /'--login'|session\/prompt|exchangeAntigravityCode|antigravityFlow/u);
});

test('trial staging publishes its local Host and Client under one named package', () => {
  // The CLI imports profile rows from the include dir, one level below this scope boundary.
  // Without it, the enclosing source package's self-reference shadows the Web bundle's controller.
  assert.match(source, /\$stageManifest = Join-Path \$stage 'package\.json'/u);
  assert.match(source, /\$scopeManifest = '\{"private":true,"type":"module"\}'/u);
  assert.match(source, /dsh-agy-native-trial/u);
  for (const file of ['agy-native-trial.host.mjs', 'agy-native-trial.auth.mjs', 'agy-native-trial.client.js']) {
    assert.ok(source.includes(file), `the launcher stages ${file}`);
  }
  assert.match(source, /exports/u);
  assert.match(source, /["']\.["']\s*[:=]\s*["']\.\/[^"']+\.mjs["']/u);
  assert.match(source, /["']\.\/client["']\s*[:=]\s*["']\.\/[^"']+\.js["']/u);
});

test('trial launcher validates the local signed CLI without a hash pin and clears inherited credentials', () => {
  assert.match(source, /Test-Path -LiteralPath \$executable -PathType Leaf/u);
  assert.doesNotMatch(source, /Get-FileHash -LiteralPath \$executable/u);
  assert.match(source, /Get-AuthenticodeSignature/u);
  assert.match(source, /\$info\.Environment\.Clear\(\)/u);
  assert.match(source, /\['AGY_CLI_DISABLE_AUTO_UPDATE'\] = 'true'/u);
  assert.match(source, /toolPermission='strict'/u);
  for (const rule of ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'mcp(*)']) {
    assert.ok(source.includes(`'${rule}'`));
  }
  assert.match(source, /\$property\.Value -isnot \[bool\]/u);
  assert.match(source, /\$null -ne \$property/u);
});

test('trial launcher opens native loopback Web only for its own listener and stops its own process', () => {
  assert.match(source, /'--profile','web'/u);
  assert.match(source, /'--host','127\.0\.0\.1','--port','0','--no-open'/u);
  assert.match(source, /\$child\.Id -notin \$listeners\.OwningProcess/u);
  assert.match(source, /\$process\.StartTime\.ToUniversalTime\(\)\.Ticks -ne \$record\.startedTicks/u);
  assert.match(source, /\[IO\.FileShare\]::None/u);
  assert.match(source, /if \(\$OpenBrowser\) \{\s+try \{ Start-Process -FilePath \$ready\.launchUrl/u);
  assert.doesNotMatch(source, /Write-(?:Output|Host).*launchUrl/u);
});

const hostSource = readFileSync(new URL('../scripts/agy-native-trial.host.mjs', import.meta.url), 'utf8');
const hostBody = hostSource.replace(/^import .*;\r?\n/gmu, '').replace(/^export /gmu, '');
const plain = value => JSON.parse(JSON.stringify(value));
const privateError = code => Object.assign(new Error('PRIVATE_REMOTE_DETAIL must never leave this mock'), { code });
const deferred = () => Promise.withResolvers();

// All filesystem, CLI, authentication and Host registrations stay inside this VM harness.
async function runHost(scenario = {}) {
  const root = path.resolve('fixture-trial-host');
  const workspace = path.resolve('fixture-trial-work');
  const executable = path.resolve('fixture-trial-cli', 'agy.exe');
  const cliAreas = Object.fromEntries(['home', 'local', 'roaming', 'scratch'].map(name => [name, path.resolve('fixture-cli', name)]));
  const hooks = {};
  const trace = { root, workspace, executable, cliAreas, hooks, statuses: [], events: [], effects: [], sessions: [],
    created: [], clients: [], registrations: [], routes: [], calls: [], logs: [], exits: [],
    activeProviders: new Set(), activeRoutes: new Set(), activeLedgers: new Set(), activeNative: new Set() };
  let ready;
  let stop;
  let stopExists = scenario.stop === true;
  let timerActive = false;
  let statusWritten = false;
  let authDisposed = false;
  let effectDepth = 0;
  let cleanup;
  const options = { model: { currentValue: 'actual-opaque-model', options: [{ value: 'actual-opaque-model', name: 'Actual Model' }] },
    thoughtLevel: { currentValue: 'actual-default-effort', options: [{ value: 'actual-default-effort', name: 'Actual Effort' }] } };
  trace.options = options;
  class LlmError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }
  const mock = {
    existsSync(file) { assert.equal(file, path.join(root, 'stop')); return stopExists; },
    writeFileSync(file, text, config) {
      assert.equal(file, path.join(root, 'ready.json'));
      assert.equal(config.flag, 'wx');
      if (statusWritten || scenario.writeError) throw privateError('EEXIST');
      statusWritten = true;
      trace.statuses.push(JSON.parse(text));
    },
    path, LlmAdapter: class {}, LlmError, AbortController, AbortSignal,
    AgyAcpClient: class {
      constructor(config) { this.config = config; this.closed = false; trace.clients.push(this); }
      async start() {
        trace.events.push('initialize'); trace.calls.push({ method: 'initialize' });
        return { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] };
      }
      async close() { this.closed = true; trace.events.push('client-close'); }
      async authenticate() { trace.calls.push({ method: 'authenticate' }); throw new Error('Startup must never authenticate'); }
      async request(method) { trace.calls.push({ method }); throw new Error('A raw startup request is not permitted'); }
    },
    AgyAcpErrorCode: { AUTH_REQUIRED: -32000, TIMEOUT: 'TIMEOUT', CLOSED: 'CLOSED' },
    agyWindowsEnv(areas) { assert.equal(areas, cliAreas); return { HOME: cliAreas.home }; },
    isLocalAgyPath: value => typeof value === 'string' && path.isAbsolute(value),
    sameAgyPath: (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase(),
    async verifiedAgyExecutable(file) {
      trace.events.push('verify'); assert.equal(file, executable);
      await hooks.verify?.();
      return file;
    },
    assertAgyNativeTurnHost(ctx) {
      assert.equal(ctx, trace.ctx);
      trace.events.push('native-preflight');
      if (scenario.incompatible) throw privateError('native-turn-required');
    },
    mountAgyNativeTurnHost(ctx, config) {
      trace.events.push('native-mount');
      if (scenario.mountError) throw privateError('UNTRUSTED_MOUNT');
      trace.native = config;
      const native = { dispose() {
        if (trace.activeNative.delete(native)) trace.events.push('native-dispose');
      } };
      trace.activeNative.add(native);
      return native;
    },
    async openAgyTurnLedger(domain) {
      assert.equal(domain, trace.storageDomain);
      trace.events.push('ledger-open');
      await hooks.ledger?.();
      if (scenario.ledgerError) throw privateError('UNTRUSTED_LEDGER');
      const ledger = { close() {
        if (trace.activeLedgers.delete(ledger)) trace.events.push('ledger-close');
      } };
      trace.activeLedgers.add(ledger);
      return ledger;
    },
    createAgyTurnSession(config) {
      trace.events.push('session-construct'); assert.equal(config.cwd, workspace);
      const client = config.makeClient({});
      const session = {
        id: 'actual-official', options: scenario.missingOptions ? undefined : options, closed: false,
        async open(id) {
          assert.equal(id, undefined, 'the catalog probe never resumes an existing official session');
          trace.events.push('probe-open'); trace.calls.push({ method: 'session/new' });
          await hooks.probe?.();
          if (scenario.auth) throw privateError(-32000);
          if (scenario.probeError) throw privateError(scenario.probeError);
        },
        async close() {
          trace.events.push('probe-close');
          if (scenario.closeError) throw privateError('UNTRUSTED_CLOSE');
          await client.close();
          this.closed = true;
        },
        prepare() { trace.events.push('prepare'); throw new Error('Startup cannot configure a turn'); },
        runTurn() { trace.events.push('prompt'); throw new Error('Startup cannot prompt'); },
      };
      trace.sessions.push(session);
      return session;
    },
    createTrialAuthentication(config) {
      trace.events.push('auth-create'); trace.authOptions = config;
      assert.equal(typeof config.makeClient, 'function');
      assert.equal(typeof config.connect, 'function');
      const auth = {
        snapshot: () => ({ status: 'signed-out', canLogin: !authDisposed }),
        async inspect() {
          trace.events.push('auth-inspect');
          const client = await config.makeClient({ allowAuthentication: false });
          try { await client.start(); }
          finally { await client.close(); }
          return auth.snapshot();
        },
        async dispose() { authDisposed = true; trace.events.push('auth-dispose'); },
      };
      trace.auth = auth;
      return auth;
    },
    trialAuthRoute(ctx, auth) {
      trace.events.push('auth-route'); assert.equal(auth, trace.auth);
      const route = { kind: 'exact', path: '/__agy_trial_auth', handler() {} };
      trace.authRoute = route;
      return route;
    },
    process: { env: { DSH_HOME: path.join(root, 'home', '.dsh') } },
    setInterval(callback) { stop = callback; timerActive = true; return 'owned-timer'; },
    clearInterval(timer) { if (timer === 'owned-timer') timerActive = false; trace.events.push(`clear:${timer}`); },
    console: Object.fromEntries(['log', 'error', 'warn', 'info', 'debug'].map(level => [level, (...args) => trace.logs.push({ level, args })])),
  };
  const context = vm.createContext(mock);
  const apply = new vm.Script(`${hostBody}\napply;`, { filename: 'trial.host.mjs' }).runInContext(context);
  trace.storageDomain = {};
  const ctx = {
    webServer: { host: '127.0.0.1', port: 49123, register(route) {
      assert.ok(effectDepth > 0, 'the authentication route is owned by ctx.effect');
      trace.events.push('route-register'); trace.routes.push(route); trace.activeRoutes.add(route);
      return () => { if (trace.activeRoutes.delete(route)) trace.events.push('route-dispose'); };
    } },
    connection: { allowsRemoteAuthorities: false, authenticatedUrl(base) { return `${base}/?launch=synthetic-only`; } },
    effect(effect, label) {
      let release;
      effectDepth++;
      try { release = effect(); }
      finally { effectDepth--; }
      let done;
      const dispose = () => done ??= Promise.resolve().then(() => release?.());
      trace.effects.push({ label, dispose });
      return dispose;
    },
    appExit(code) { trace.events.push(`exit:${code}`); trace.exits.push(code); },
    appReady: { onReady(callback) { ready = callback; return () => { ready = undefined; trace.events.push('ready-dispose'); }; } },
    llm: { registerAdapter(ids, adapter) {
      trace.events.push('idle-register'); trace.registrations.push({ ids: Array.from(ids), adapter });
      for (const id of ids) trace.activeProviders.add(id);
      return () => { for (const id of ids) trace.activeProviders.delete(id); trace.events.push('idle-dispose'); };
    } },
    workspaceRegistry: { async create(cwd) { trace.created.push(cwd); } }, storageDomain: trace.storageDomain,
  };
  trace.ctx = ctx;
  trace.connect = signal => trace.authOptions.connect(signal);
  trace.fireReady = () => ready?.();
  trace.setStop = () => { stopExists = true; };
  trace.tick = () => { if (timerActive) stop?.(); };
  trace.cleanup = () => cleanup ??= (async () => {
    const failures = [];
    for (const effect of trace.effects.toReversed()) {
      try { await effect.dispose(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  })();
  await apply(ctx, { root, workspace, executable, cliAreas });
  if (scenario.ready !== false) trace.fireReady();
  return trace;
}

function noNative(trace) {
  assert.equal(trace.native, undefined);
  assert.equal(trace.activeNative.size, 0);
  assert.equal(trace.activeLedgers.size, 0);
}
function noPrivateOutput(trace, error) {
  const publicValues = { statuses: trace.statuses, logs: trace.logs, ...(error ? { code: error.code, message: error.message } : {}) };
  assert.doesNotMatch(JSON.stringify(publicValues), /PRIVATE_REMOTE_DETAIL|UNTRUSTED_/u);
}
async function connectFailure(trace) {
  let failure;
  try { await trace.connect(new AbortController().signal); }
  catch (error) { failure = error; }
  assert.ok(failure, 'connect reports failure without publishing a provider');
  noPrivateOutput(trace, failure);
  return failure;
}

test('trial host initializes signed out, inspects only, and publishes the local authenticated handoff', async t => {
  const h = await runHost();
  t.after(() => h.cleanup());
  assert.deepEqual(h.calls.map(call => call.method), ['initialize']);
  assert.ok(h.events.indexOf('native-preflight') < h.events.indexOf('auth-create'));
  assert.equal(h.sessions.length, 0);
  assert.equal(h.events.filter(event => event === 'auth-inspect').length, 1);
  assert.deepEqual(h.created, [h.workspace]);
  assert.equal(h.statuses.length, 1);
  assert.deepEqual(h.statuses[0], { status: 'ready', base: 'http://127.0.0.1:49123', launchUrl: 'http://127.0.0.1:49123/?launch=synthetic-only' });
  assert.equal(h.auth.snapshot().status, 'signed-out');
  assert.equal(h.routes.length, 1);
  assert.equal(h.routes[0], h.authRoute, 'the auth route is registered through the owned Host effect');
  assert.equal(h.activeRoutes.size, 1);
  assert.ok(h.clients.every(client => client.closed));
  assert.equal(h.clients[0].config.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(h.clients[0].config.env.HOME, h.cliAreas.home);
  assert.deepEqual(h.registrations[0].ids, ['trial-idle']);
  assert.deepEqual(plain(await h.registrations[0].adapter.listModels('trial-idle')), [{
    provider: 'trial-idle', id: 'select-antigravity', name: '请在模型菜单选择 Antigravity',
  }]);
  const stream = h.registrations[0].adapter.stream();
  await assert.rejects(stream.next(), /请选择|请先/u);
  assert.ok(!h.events.includes('prepare') && !h.events.includes('prompt'));
  noNative(h);
  noPrivateOutput(h);
});

test('an incompatible native Host stops before starting agy, offering login, or opening storage', async t => {
  const h = await runHost({ incompatible: true });
  t.after(() => h.cleanup());
  assert.deepEqual(h.statuses, [{ status: 'unavailable', code: 'native-turn-required' }]);
  assert.deepEqual(h.exits, [0]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.clients, []);
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.registrations, []);
  assert.deepEqual(h.created, []);
  assert.equal(h.auth, undefined);
  assert.ok(!h.events.includes('ledger-open') && !h.events.includes('verify'));
  noNative(h);
  noPrivateOutput(h);
});

test('explicit connect alone probes and closes an empty session before ledger and native registration', async t => {
  const h = await runHost();
  t.after(() => h.cleanup());
  const before = h.events.length;
  await h.connect(new AbortController().signal);
  const events = h.events.slice(before);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].closed, true);
  assert.deepEqual(h.calls.map(call => call.method), ['initialize', 'session/new']);
  assert.ok(events.indexOf('verify') < events.indexOf('session-construct'));
  assert.ok(events.indexOf('probe-open') < events.indexOf('probe-close'));
  assert.ok(events.indexOf('probe-close') < events.indexOf('ledger-open'));
  assert.ok(events.indexOf('ledger-open') < events.indexOf('native-mount'));
  assert.equal(h.native.options, h.options);
  assert.equal(h.native.defaultEffort, h.options.thoughtLevel.currentValue);
  assert.deepEqual(Array.from(h.native.blockedPaths), [...Object.values(h.cliAreas), path.dirname(h.executable)]);
  assert.equal(h.activeLedgers.size, 1);
  assert.equal(h.activeNative.size, 1);
  assert.equal(h.statuses.length, 1, 'connecting never replaces the exclusive startup handoff');
  assert.ok(!events.includes('prepare') && !events.includes('prompt'));
});

test('authentication transport opts in only for the explicit login factory', async t => {
  const h = await runHost();
  t.after(() => h.cleanup());
  assert.equal(h.clients[0].config.allowAuthentication, false);
  const client = await h.authOptions.makeClient({ allowAuthentication: true });
  assert.equal(client.config.allowAuthentication, true);
  assert.equal(client.config.executable, h.executable);
  await client.close();
  await h.connect(new AbortController().signal);
  assert.notEqual(h.clients.at(-1).config.allowAuthentication, true, 'turn transports cannot authenticate');
  assert.deepEqual(h.calls.map(call => call.method), ['initialize', 'session/new']);
});

test('native session factory revalidates the executable path and rejects a different workspace', async t => {
  const h = await runHost();
  t.after(() => h.cleanup());
  await h.connect(new AbortController().signal);
  const verified = h.events.filter(event => event === 'verify').length;
  await assert.rejects(h.native.makeSession({ cwd: path.resolve('unrelated-workspace') }), /workspace-mismatch/u);
  assert.equal(h.events.filter(event => event === 'verify').length, verified);
  const session = await h.native.makeSession({ cwd: h.workspace });
  assert.equal(h.events.filter(event => event === 'verify').length, verified + 1);
  assert.equal(h.clients.at(-1).config.executable, h.executable);
  assert.equal(h.clients.at(-1).config.cwd, h.workspace);
  assert.equal(h.clients.at(-1).config.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  await session.close();
});

for (const phase of ['verify', 'probe', 'ledger']) {
  test(`cancel during ${phase} leaves no native provider or open ledger`, async t => {
    const h = await runHost();
    t.after(() => h.cleanup());
    const controller = new AbortController();
    h.hooks[phase] = async () => { controller.abort(privateError('UNTRUSTED_ABORT_REASON')); };
    const [result] = await Promise.allSettled([h.connect(controller.signal)]);
    assert.equal(result.status, 'rejected');
    noPrivateOutput(h, result.reason);
    noNative(h);
    assert.ok(h.sessions.every(session => session.closed));
    if (phase === 'ledger') assert.ok(h.events.includes('ledger-close'));
    assert.equal(h.statuses.length, 1);
    noPrivateOutput(h);
  });
}

test('cancelling a pending probe actively closes it before the open promise settles', async t => {
  const h = await runHost();
  t.after(() => h.cleanup());
  const entered = deferred(), release = deferred();
  const controller = new AbortController();
  h.hooks.probe = async () => { entered.resolve(); await release.promise; };
  const pending = Promise.allSettled([h.connect(controller.signal)]);
  await entered.promise;
  try {
    controller.abort();
    assert.ok(h.events.includes('probe-close'), 'abort actively begins closing the probe while open is still pending');
    assert.ok(!h.events.includes('ledger-open'));
  } finally { release.resolve(); }
  await pending;
  noNative(h);
  assert.ok(h.sessions.every(session => session.closed));
});

test('connect failures expose local codes without raw remote details or native registrations', async t => {
  for (const scenario of [{ probeError: 'UNTRUSTED_REMOTE_CODE' }, { auth: true }, { missingOptions: true }, { ledgerError: true }]) {
    const h = await runHost(scenario);
    t.after(() => h.cleanup());
    const error = await connectFailure(h);
    assert.ok(['host-unavailable', 'unavailable', 'auth-required', 'catalog-unavailable'].includes(error.code));
    noNative(h);
    assert.ok(h.sessions.every(session => session.closed));
    assert.equal(h.statuses[0].status, 'ready', 'a failed explicit connection keeps the signed-out Web available');
    assert.deepEqual(h.exits, []);
  }
});

test('probe close failure takes precedence over successful discovery, authentication and remote errors', async () => {
  for (const scenario of [{ closeError: true }, { auth: true, closeError: true }, { probeError: 'UNTRUSTED_REMOTE_CODE', closeError: true }]) {
    const h = await runHost(scenario);
    try {
      const error = await connectFailure(h);
      assert.equal(error.code, 'cleanup-unconfirmed');
      assert.ok(!h.events.includes('ledger-open'));
      noNative(h);
    } finally {
      await assert.rejects(h.cleanup(), /cleanup-unconfirmed/u);
    }
  }
});

test('an existing stop marker prevents initialization and a later stop exits once and disposes owned resources', async () => {
  const stopped = await runHost({ stop: true });
  assert.deepEqual(stopped.exits, [0]);
  assert.deepEqual(stopped.calls, []);
  assert.equal(stopped.statuses.length, 0);
  noNative(stopped);
  await stopped.cleanup();

  const h = await runHost();
  await h.connect(new AbortController().signal);
  h.setStop(); h.tick(); h.tick();
  assert.deepEqual(h.exits, [0]);
  await h.cleanup();
  assert.equal(h.activeNative.size, 0);
  assert.equal(h.activeLedgers.size, 0);
  assert.equal(h.activeProviders.size, 0);
  assert.equal(h.activeRoutes.size, 0);
  assert.ok(h.events.includes('auth-dispose'));
  assert.ok(h.events.includes('clear:owned-timer'));
  const count = h.statuses.length;
  h.fireReady(); h.tick();
  assert.equal(h.statuses.length, count);
  assert.deepEqual(h.exits, [0]);
});

test('stopping while ledger acquisition is pending closes the late resource without mounting', async t => {
  const h = await runHost();
  t.after(() => h.cleanup());
  const entered = deferred(), release = deferred();
  h.hooks.ledger = async () => { entered.resolve(); await release.promise; };
  const result = Promise.allSettled([h.connect(new AbortController().signal)]);
  await entered.promise;
  h.setStop(); h.tick();
  release.resolve();
  await result;
  noNative(h);
  assert.ok(h.events.includes('ledger-close'));
  assert.deepEqual(h.exits, [0]);
});
