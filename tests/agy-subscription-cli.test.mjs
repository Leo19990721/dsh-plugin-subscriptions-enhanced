import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AgyAcpErrorCode as C } from '../src/agy-acp-client.js';
import { AgyLaunchError } from '../src/agy-launch.js';
import { configureAgyTurn } from '../src/agy-turn-options.js';

// Only this module instance substitutes Windows hash verification and child
// process creation. The real ACP framing, turn wrapper, child env, and disk
// policy are exercised. The production factory has no injection options.
const runtime = new URL('../src/agy-subscription-cli.js?in-memory-acp', import.meta.url).href;
const launch = new URL('../src/agy-launch.js', import.meta.url).href;
const transport = new URL('../src/agy-acp-client.js', import.meta.url).href;
const imports = `import { synthetic } from ${JSON.stringify(import.meta.url)};`;
const mockModule = source => `data:text/javascript,${encodeURIComponent(`${imports}\n${source}`)}`;
const mocked = new Map([
  ['./agy-launch.js', mockModule(`
    export * from ${JSON.stringify(launch)};
    export function verifiedAgyExecutable(...args) { return synthetic.verify(...args); }
  `)],
  ['./agy-acp-client.js', mockModule(`
    import { AgyAcpClient as Client } from ${JSON.stringify(transport)};
    export * from ${JSON.stringify(transport)};
    export class AgyAcpClient extends Client {
      constructor(options) { super({ ...options, spawnFactory: synthetic.spawn }); }
    }
  `)],
]);
export const synthetic = { verify() { assert.fail('Unexpected verification'); }, spawn() { assert.fail('Unexpected spawn'); } };
let createMockCli;
test.before(async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === runtime && mocked.has(specifier)) return next(mocked.get(specifier), context);
      return next(specifier, context);
    },
  });
  try { ({ createAgySubscriptionCli: createMockCli } = await import(runtime)); }
  finally { hooks.deregister(); }
});
const { createAgySubscriptionCli } = await import('../src/agy-subscription-cli.js');

const SESSION = 'fixture-session';
const VERSION = '1.5.12';
const INFO = { name: 'Antigravity ACP Server', version: VERSION };
const MODEL = { id: 'model-picker', name: '合成模型', category: 'model', type: 'select',
  currentValue: 'fixture-model', options: [{ value: 'fixture-model', name: '合成模型' }] };
const EFFORT = { id: 'thought-picker', name: '合成思考', category: 'thought_level', type: 'select',
  currentValue: 'fixture-default', options: [{ value: 'fixture-default', name: '合成默认档' }] };
const settingsPath = env => path.join(env.HOME, '.gemini', 'antigravity-cli', 'settings.json');
const code = (expected, phase, reason, details) => error => {
  assert.equal(error.code, expected);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /SYNTHETIC_PRIVATE/);
  if (phase !== undefined) {
    assert.equal(error.message, `Antigravity runtime: ${expected}`);
    const diagnostic = { phase, reason, ...details };
    assert.deepEqual(error.diagnostic, diagnostic);
    assert.equal(Object.isFrozen(error.diagnostic), true);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: expected, diagnostic });
  }
  return true;
};
const unsafe = (phase, reason, details) => code('unsafe-storage', phase, reason, details);
const cleanup = reason => code('cleanup-unconfirmed', 'cleanup', reason);

class Child extends EventEmitter {
  stdin = new EventEmitter();
  stdout = new PassThrough();
  stderr = new PassThrough();
  messages = [];
  kills = [];

  constructor(options, { onRequest, onExit, ignoreStop = false } = {}) {
    super();
    this.options = options;
    this.stdin.write = (bytes, done) => {
      const message = JSON.parse(bytes.toString('utf8'));
      this.messages.push(message);
      queueMicrotask(() => {
        const fallback = () => {
          if (message.method === 'initialize') {
            return this.reply(message, { protocolVersion: 1, agentInfo: INFO,
              agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
              authMethods: [{ id: 'oauth-personal', title: 'SYNTHETIC_PRIVATE_OAUTH' }] });
          }
          if (message.method === 'session/new') return this.reply(message, { sessionId: SESSION, configOptions: [MODEL, EFFORT] });
          if (message.method === 'session/close') return this.reply(message, {});
          if (message.method === undefined && typeof message.id === 'string') return; // Peer reply.
          assert.fail(`Unexpected synthetic wire message ${message.method}`);
        };
        if (onRequest) onRequest(message, this, fallback);
        else fallback();
      });
      done();
      return true;
    };
    const exit = (code, signal) => {
      if (ignoreStop) return false;
      queueMicrotask(() => { onExit?.(); this.emit('exit', code, signal); });
      return true;
    };
    this.stdin.end = () => { exit(0, null); };
    this.stdin.destroy = () => {};
    this.unref = () => {};
    this.kill = signal => { this.kills.push(signal); return exit(null, signal); };
  }

  send(data) { this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...data })}\n`); }
  reply(message, result) { this.send({ id: message.id, result }); }
}

async function fixture(t, behavior, { verification, proxy, useReal = false } = {}) {
  const parent = await mkdtemp(path.join(await realpath(tmpdir()), 'agy-subscription-test-'));
  const root = path.join(parent, 'runtime');
  const executable = path.join(parent, 'binary', 'agy.exe');
  let verified = 0;
  const children = [];
  const factory = useReal ? createAgySubscriptionCli : createMockCli;
  const system = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR ?? path.parse(parent).root;
  // Child env tests use only dummy secrets. No actual secret value is read.
  t.mock.method(synthetic, 'verify', async file => {
    verified++;
    assert.equal(file, executable);
    if (verification) await verification();
    return file;
  });
  t.mock.method(synthetic, 'spawn', (file, argv, options) => {
    const child = new Child(options, behavior);
    Object.assign(child, { file, argv });
    children.push(child);
    return child;
  });
  const priorSystem = process.env.SYSTEMROOT;
  process.env.SYSTEMROOT = system;
  const priorDummy = process.env.DSH_AGY_TEST_SENTINEL;
  process.env.DSH_AGY_TEST_SENTINEL = 'SYNTHETIC_PRIVATE_TEST';
  const cli = factory({ root, executable, loopbackProxy: proxy });
  t.after(async () => {
    try { await cli.dispose(); }
    catch (error) { assert.equal(error.code, 'cleanup-unconfirmed'); }
    finally {
      if (priorDummy === undefined) delete process.env.DSH_AGY_TEST_SENTINEL;
      else process.env.DSH_AGY_TEST_SENTINEL = priorDummy;
      if (priorSystem === undefined) delete process.env.SYSTEMROOT;
      else process.env.SYSTEMROOT = priorSystem;
      await rm(parent, { recursive: true, force: true });
    }
  });
  return { root, parent, executable, system, cli, children, verified: () => verified };
}

const methods = child => child.messages.filter(message => message.method !== undefined).map(message => message.method);
const gone = target => assert.rejects(lstat(target), { code: 'ENOENT' });

test('ordinary import and factory are inert without an official installation', async t => {
  const f = await fixture(t, undefined, { useReal: true });
  assert.deepEqual(f.cli.blockedPaths, [f.root, path.dirname(f.executable)]);
  assert.equal(f.cli.login, undefined);
  const turn = await f.cli.makeSession();
  assert.equal(turn.id, undefined);
  assert.equal(turn.options, undefined);
  await gone(f.root);
  await turn.close();
  await assert.rejects(f.cli.probe(), code(process.platform === 'win32' && process.arch === 'x64' ? 'missing-cli' : 'unsupported-cli'));
  await gone(f.root);
  assert.equal(f.verified(), 0);
  assert.deepEqual(f.children, []);
});

test('explicit probe performs only initialize, new and close in a verified starting-empty runtime', async t => {
  let inspected, stopped = false;
  const proxy = 'http://127.0.0.1:54321';
  const f = await fixture(t, { onExit() { stopped = true; }, onRequest(message, child, fallback) {
    if (message.method !== 'initialize') return fallback();
    const { cwd, env, shell, windowsHide, stdio } = child.options;
    inspected = Promise.all([readdir(cwd), readFile(settingsPath(env), 'utf8')]).then(([items, settings]) => {
      assert.deepEqual(items, []);
      assert.deepEqual(JSON.parse(settings), { agentMode: '', toolPermission: 'strict',
        allowNonWorkspaceAccess: false, enableTerminalSandbox: true, useG1Credits: false,
        permissions: { allow: [], ask: [], deny: ['read_file(*)', 'write_file(*)', 'command(*)',
          'read_url(*)', 'execute_url(*)', 'mcp(*)'] } });
      const run = path.dirname(cwd);
      assert.equal(path.dirname(run), path.join(f.root, 'active'));
      const systemDir = path.join(f.system, 'System32');
      const drive = path.parse(env.HOME).root.slice(0, 2);
      assert.deepEqual(env, {
        SYSTEMROOT: f.system, WINDIR: f.system, COMSPEC: path.join(systemDir, 'cmd.exe'),
        PATH: [systemDir, f.system].join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD',
        PROCESSOR_ARCHITECTURE: 'AMD64', HOME: path.join(run, 'home'), USERPROFILE: path.join(run, 'home'),
        HOMEDRIVE: drive, HOMEPATH: path.join(run, 'home').slice(drive.length),
        LOCALAPPDATA: path.join(run, 'local'), APPDATA: path.join(run, 'roaming'),
        TEMP: path.join(run, 'scratch'), TMP: path.join(run, 'scratch'),
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1',
        AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      });
      assert.equal(shell, false);
      assert.equal(windowsHide, true);
      assert.deepEqual(stdio, ['pipe', 'pipe', 'pipe']);
      fallback();
    });
    void inspected.catch(() => child.emit('exit', 1, null));
  } }, { proxy });
  const snapshot = await f.cli.probe().finally(() => inspected);
  assert.equal(stopped, true);
  assert.equal(f.verified(), 1);
  const [child] = f.children;
  assert.equal(child.file, f.executable);
  assert.deepEqual(child.argv, ['--mode=default', 'acp', '--sandbox', '--disable-telemetry']);
  assert.deepEqual(methods(child), ['initialize', 'session/new', 'session/close']);
  assert.deepEqual(child.messages[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(child.messages[1].params, { cwd: child.options.cwd, mcpServers: [] });
  assert.deepEqual(child.messages[2].params, { sessionId: SESSION });
  assert.equal(await configureAgyTurn({ sessionId: SESSION, options: snapshot, selection: { model: 'fixture-model' },
    send() { assert.fail('A current selection should need no setter'); },
  }), snapshot);
  assert.deepEqual(snapshot, { model: { id: MODEL.id, currentValue: MODEL.currentValue, options: MODEL.options },
    thoughtLevel: { id: EFFORT.id, currentValue: EFFORT.currentValue, options: EFFORT.options } });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
});

test('does not prompt when auth is missing, version is wrong or catalog is unusable', async t => {
  let which = 'auth';
  const f = await fixture(t, { onRequest(message, child, fallback) {
    if (message.method === 'initialize' && which === 'version') {
      child.reply(message, { protocolVersion: 1, agentInfo: { ...INFO, version: '1.5.13' } });
    } else if (message.method === 'session/new' && which === 'auth') {
      child.send({ id: message.id, error: { code: C.AUTH_REQUIRED, message: 'SYNTHETIC_PRIVATE_ACCOUNT' } });
    } else if (message.method === 'session/new' && which === 'catalog') {
      child.reply(message, { sessionId: SESSION, configOptions: [{ ...MODEL, currentValue: 'wrong' }] });
    } else fallback();
  } });
  await assert.rejects(f.cli.probe(), code(C.AUTH_REQUIRED));
  assert.deepEqual(methods(f.children.at(-1)), ['initialize', 'session/new']);
  which = 'version';
  await assert.rejects(f.cli.probe(), code('cli-version-mismatch'));
  assert.deepEqual(methods(f.children.at(-1)), ['initialize']);
  which = 'catalog';
  await assert.rejects(f.cli.probe(), code('catalog-unavailable'));
  assert.deepEqual(methods(f.children.at(-1)), ['initialize', 'session/new']);
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
});

test('fresh one-shot turns never take a workspace path, load history, or grant ACP permissions', async t => {
  const f = await fixture(t, { onRequest(message, child, fallback) {
    if (message.method !== 'session/prompt') return fallback();
    child.send({ id: 'permission', method: 'session/request_permission', params: { sessionId: SESSION,
      options: [{ optionId: 'allow', kind: 'allow_once' }] } });
    child.send({ id: 'filesystem', method: 'fs/read_text_file', params: { path: 'synthetic.txt' } });
    child.send({ id: 'terminal', method: 'terminal/create', params: { command: 'synthetic' } });
    child.send({ method: 'session/update', params: { sessionId: SESSION, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '合成响应' },
    } } });
    child.reply(message, { stopReason: 'end_turn', discarded: 'SYNTHETIC_PRIVATE' });
  } });
  await assert.rejects(f.cli.makeSession({ cwd: f.parent }), code('invalid-options'));
  const session = await f.cli.makeSession();
  await gone(f.root);
  await assert.rejects(session.open(SESSION), code('invalid-session'));
  await assert.rejects(f.cli.makeSession(), code('cli-busy'));
  assert.equal(f.verified(), 0);
  await session.open();
  assert.equal(session.id, SESSION);
  const firstChild = f.children[0];
  assert.equal(firstChild.options.env.HTTP_PROXY, undefined);
  assert.equal(firstChild.options.env.HTTPS_PROXY, undefined);
  await session.prepare({ model: MODEL.currentValue });
  const delta = [], marks = [];
  assert.deepEqual(await session.runTurn('合成请求', { onDelta: value => delta.push(value),
    beforeDispatch() { marks.push('guard'); }, onDispatch() { marks.push('dispatch'); },
  }), { status: 'completed', stopReason: 'end_turn' });
  await assert.rejects(session.prepare({ model: MODEL.currentValue }), code('turn-unavailable'));
  await assert.rejects(session.runTurn('不会发送', { onDelta() {} }), code('turn-unavailable'));
  assert.deepEqual(delta, ['合成响应']);
  assert.deepEqual(marks, ['guard', 'dispatch']);
  const replies = firstChild.messages.filter(message => message.method === undefined);
  assert.deepEqual(Object.fromEntries(replies.map(({ id, result, error }) => [id, result ?? error?.code])), {
    permission: { outcome: { outcome: 'cancelled' } }, filesystem: -32601, terminal: -32601,
  });
  assert.equal(session.close(), session.close());
  await session.close();
  await gone(firstChild.options.cwd);
  await f.cli.probe();
  assert.notEqual(f.children.at(-1).options.cwd, firstChild.options.cwd);
  assert.notEqual(f.children.at(-1).options.env.HOME, firstChild.options.env.HOME);
  assert.deepEqual(methods(firstChild), ['initialize', 'session/new', 'session/prompt', 'session/close']);
});

test('rejects unowned roots, links, a Git ancestor and existing lock before spawning', async t => {
  const f = await fixture(t);
  const other = path.join(f.parent, 'elsewhere');
  await mkdir(other);
  await writeFile(path.join(other, 'unrelated'), 'unchanged');
  await assert.rejects(createMockCli({ root: 'SYNTHETIC_PRIVATE_ROOT', executable: f.executable }).probe(), unsafe('initial', 'root-policy'));
  await symlink(other, f.root, 'junction');
  await assert.rejects(f.cli.probe(), unsafe('initial', 'storage-identity'));
  assert.deepEqual(await readdir(other), ['unrelated']);
  await rm(f.root);
  await mkdir(f.root);
  const existing = path.join(f.root, 'unowned');
  await writeFile(existing, 'unchanged');
  await assert.rejects(f.cli.probe(), unsafe('initial', 'root-ownership'));
  assert.deepEqual(await readdir(f.root), ['unowned']);
  await rm(existing);
  const git = path.join(f.parent, '.git');
  await writeFile(git, 'gitdir: fixture');
  await assert.rejects(f.cli.probe(), unsafe('initial', 'workspace-discovery'));
  await rm(git);
  await writeFile(path.join(f.root, '.subscriptions-agy-v1'), 'dsh-subscriptions-agy-runtime/1\n');
  await mkdir(path.join(f.root, 'active'));
  await assert.rejects(f.cli.probe(), code('cli-busy'));
  assert.deepEqual(f.children, []);
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1', 'active']);
});

test('verifies policy after initialize and before catalog or prompt', async t => {
  let rewrite;
  const f = await fixture(t, { onRequest(message, child, fallback) {
    if (message.method === 'initialize' && rewrite) {
      const changes = rewrite;
      rewrite = undefined;
      void changes(child.options.env).then(fallback, () => child.emit('exit', 1, null));
    } else fallback();
  } });
  rewrite = async env => {
    const file = settingsPath(env);
    const json = JSON.parse(await readFile(file, 'utf8'));
    delete json.allowNonWorkspaceAccess;
    delete json.useG1Credits;
    delete json.permissions.allow;
    await writeFile(file, JSON.stringify(json));
  };
  await f.cli.probe(); // Documented default elision.
  const editSettings = change => async env => {
    const file = settingsPath(env);
    const settings = await readFile(file, 'utf8');
    await writeFile(file, change(settings));
  };
  const editJson = change => editSettings(settings => {
    const json = JSON.parse(settings);
    change(json);
    return JSON.stringify(json);
  });
  for (const [reason, change] of [
    ['settings-permissions', editJson(json => json.permissions.allow.push('command(SYNTHETIC_PRIVATE)'))],
    ['settings-normalization', editSettings(settings => settings.replace('"toolPermission":"strict"',
      '"toolPermission":"SYNTHETIC_PRIVATE","toolPermission":"strict"'))],
    ['settings-missing', env => rm(settingsPath(env))],
    ['settings-read', env => rm(settingsPath(env)).then(() => mkdir(settingsPath(env)))],
    ['settings-parse', env => writeFile(settingsPath(env), 'SYNTHETIC_PRIVATE invalid JSON')],
    ['settings-shape', editJson(json => { json.SYNTHETIC_PRIVATE = 'unknown setting'; })],
    ['settings-mode', editJson(json => { json.allowNonWorkspaceAccess = true; })],
  ]) {
    rewrite = change;
    await assert.rejects(f.cli.probe(), unsafe('after-initialize', reason));
    assert.deepEqual(methods(f.children.at(-1)), ['initialize']);
    assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
  }
  const turn = await f.cli.makeSession({ signal: new AbortController().signal });
  await turn.open();
  await turn.prepare({ model: MODEL.currentValue });
  const child = f.children.at(-1);
  await writeFile(path.join(child.options.cwd, 'AGENTS.md'), 'synthetic');
  await assert.rejects(turn.runTurn('should not be written', { onDelta() {} }), unsafe('before-prompt', 'work-changed'));
  assert.deepEqual(methods(child), ['initialize', 'session/new', 'session/close']);
  await gone(child.options.cwd);
});

test('session/new policy diagnostic survives cleanup with no prompt or retry', async t => {
  const f = await fixture(t, { onRequest(message, child, fallback) {
    if (message.method !== 'session/new') return fallback();
    void writeFile(path.join(child.options.cwd, 'SYNTHETIC_PRIVATE_FILENAME'), 'synthetic').then(fallback,
      () => child.emit('exit', 1, null));
  } });
  await assert.rejects(f.cli.probe(), unsafe('after-session-new', 'work-changed'));
  assert.equal(f.children.length, 1);
  assert.deepEqual(methods(f.children[0]), ['initialize', 'session/new']);
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
});

test('discovery diagnostics distinguish empty directories from contents, files and links without admitting any', async t => {
  let createSlot;
  const f = await fixture(t, { onRequest(message, child, fallback) {
    if (message.method !== 'session/new') return fallback();
    void createSlot(path.join(child.options.env.HOME, '.gemini')).then(fallback, () => child.emit('exit', 1, null));
  } });
  const outside = path.join(f.parent, 'SYNTHETIC_PRIVATE_TARGET');
  await mkdir(outside);
  await writeFile(path.join(outside, 'SYNTHETIC_PRIVATE_ENTRY'), 'fixture');
  const cases = [
    ['gemini-config', 'empty-directory', gemini => mkdir(path.join(gemini, 'config'))],
    ['gemini-config', 'nonempty-directory', async gemini => {
      const config = path.join(gemini, 'config');
      await mkdir(config);
      await writeFile(path.join(config, 'SYNTHETIC_PRIVATE_FILENAME'), 'SYNTHETIC_PRIVATE_TEXT');
    }],
    ['cli-mcp', 'file', gemini => writeFile(path.join(gemini, 'antigravity-cli', 'mcp_config.json'), 'SYNTHETIC_PRIVATE_TEXT')],
    ['gemini-config', 'link', gemini => symlink(outside, path.join(gemini, 'config'), 'junction')],
  ];
  for (const [leaf, kind, create] of cases) {
    createSlot = create;
    await assert.rejects(f.cli.probe(), unsafe('after-session-new', 'unexpected-config', { leaf, kind }));
    assert.deepEqual(methods(f.children.at(-1)), ['initialize', 'session/new']);
    assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
  }
  assert.equal(f.children.length, cases.length);
  assert.deepEqual(await readdir(outside), ['SYNTHETIC_PRIVATE_ENTRY']);
});

test('workspace identity replacement fails separately from contents and storage cleanup', async t => {
  const f = await fixture(t);
  const turn = await f.cli.makeSession();
  await turn.open();
  const child = f.children[0];
  await rename(child.options.cwd, path.join(path.dirname(child.options.cwd), 'SYNTHETIC_PRIVATE_ORIGINAL'));
  await mkdir(child.options.cwd);
  await assert.rejects(turn.runTurn('should not be written', { onDelta() {} }), unsafe('before-prompt', 'work-identity'));
  assert.deepEqual(methods(child), ['initialize', 'session/new', 'session/close']);
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
});

test('cancellation or disposal drains an in-flight setup and clears the lease', async t => {
  let request = Promise.withResolvers();
  const f = await fixture(t, { onRequest(message, child, fallback) {
    if (message.method === 'session/new') request.resolve();
    else fallback();
  } });
  const controller = new AbortController();
  const stopped = f.cli.probe(controller.signal);
  await request.promise;
  controller.abort(new Error('SYNTHETIC_PRIVATE_REASON'));
  await assert.rejects(stopped, code('cancelled'));
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
  assert.deepEqual(methods(f.children[0]), ['initialize', 'session/new']);
  request = Promise.withResolvers();
  const next = f.cli.probe();
  await request.promise;
  const close = f.cli.dispose();
  assert.equal(f.cli.dispose(), close);
  await assert.rejects(next, code('closed'));
  await close;
  await assert.rejects(f.cli.makeSession(), code('closed'));
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
});

test('disposal before the ACP write cancels the attempt; abort during a turn sends one Stop', async t => {
  const request = Promise.withResolvers();
  let mode = 'before', pending;
  const f = await fixture(t, { onRequest(message, child, fallback) {
    if (mode === 'during' && message.method === 'session/prompt') {
      pending = message;
      request.resolve();
    } else if (mode === 'during' && message.method === 'session/cancel') {
      assert.deepEqual(message.params, { sessionId: SESSION });
      child.reply(pending, { stopReason: 'cancelled' });
    } else fallback();
  } });
  const pre = await f.cli.makeSession();
  await pre.open();
  await pre.prepare({ model: MODEL.currentValue });
  await assert.rejects(pre.runTurn('not sent', { onDelta() {}, beforeDispatch() { void pre.close(); } }), code('turn-unconfirmed'));
  await pre.close();
  assert.deepEqual(methods(f.children[0]), ['initialize', 'session/new']);

  mode = 'during';
  const controller = new AbortController();
  const current = await f.cli.makeSession({ signal: controller.signal });
  await current.open();
  await current.prepare({ model: MODEL.currentValue });
  const execution = current.runTurn('synthetic', { onDelta() {} });
  await request.promise;
  controller.abort('SYNTHETIC_PRIVATE_REASON');
  assert.deepEqual(await execution, { status: 'interrupted', stopReason: 'cancelled' });
  await current.close();
  assert.deepEqual(methods(f.children[1]), ['initialize', 'session/new', 'session/prompt', 'session/cancel', 'session/close']);
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
});

test('failed trust or closed admission never launches or mutates a profile', async t => {
  let error = new AgyLaunchError('unverified-cli');
  const f = await fixture(t, undefined, { verification() { if (error) throw error; }, proxy: 'http://user@127.0.0.1:1234' });
  await assert.rejects(f.cli.probe(), code('unverified-cli'));
  await gone(f.root);
  await assert.rejects(f.cli.probe(AbortSignal.abort(new Error('SYNTHETIC_PRIVATE_REASON'))), code('cancelled'));
  assert.equal(f.verified(), 1);
  error = undefined;
  await assert.rejects(f.cli.probe(), code('invalid-proxy'));
  assert.deepEqual(await readdir(f.root), ['.subscriptions-agy-v1']);
  assert.deepEqual(f.children, []);
});

test('changed cleanup identity reports a fixed reason and preserves the replacement', async t => {
  const f = await fixture(t);
  const turn = await f.cli.makeSession();
  await turn.open();
  const run = path.dirname(f.children[0].options.cwd);
  const original = path.join(path.dirname(run), 'SYNTHETIC_PRIVATE_ORIGINAL');
  await rename(run, original);
  await mkdir(run);
  await assert.rejects(turn.close(), cleanup('storage-identity'));
  assert.equal((await lstat(run)).isDirectory(), true);
  assert.equal((await lstat(original)).isDirectory(), true);
  await assert.rejects(f.cli.dispose(), cleanup('storage-identity'));
});

test('unconfirmed direct-child reap leaves scratch intact and fences future launches', async t => {
  const f = await fixture(t, { ignoreStop: true });
  await assert.rejects(f.cli.probe(), cleanup('process-unconfirmed'));
  assert.deepEqual(f.children[0].kills, ['SIGTERM', 'SIGKILL']);
  assert.equal((await lstat(f.children[0].options.cwd)).isDirectory(), true);
  await assert.rejects(f.cli.makeSession(), cleanup('process-unconfirmed'));
  await assert.rejects(f.cli.dispose(), cleanup('process-unconfirmed'));
  const replacement = createMockCli({ root: f.root, executable: f.executable });
  await assert.rejects(replacement.probe(), code('cli-busy'));
  await replacement.dispose();
  assert.equal(f.children.length, 1);
});
