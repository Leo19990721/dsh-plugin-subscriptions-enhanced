import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgyAcpClient, AgyAcpError, AgyAcpErrorCode as C } from '../src/agy-acp-client.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));
const sessionId = 'synthetic-session';
const argv = ['--mode=default', 'acp', '--sandbox', '--disable-telemetry'];
// Synthetic children never see this test runner's environment or actual profile.
const env = { SYNTHETIC_AGY_TEST: '1' };
const cancelled = { outcome: { outcome: 'cancelled' } };
const fakeInfo = { name: 'Antigravity ACP Server', version: '1.5.12' };
const expected = code => error => {
  assert.ok(error instanceof AgyAcpError);
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(error.data, undefined);
  assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, /SYNTHETIC_PRIVATE/);
  return true;
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function childFor(t, mode, options = {}) {
  const closed = [];
  const exit = deferred();
  let child, invocations = 0, exposedOptions;
  const client = new AgyAcpClient({
    executable: process.execPath, cwd, env, timeoutMs: 4_000, ...options,
    onClosed(error) {
      closed.push(error);
      return options.onClosed?.(error);
    },
    spawnFactory(executable, args, receivedOptions) {
      invocations++;
      exposedOptions = [executable, args, receivedOptions];
      const fixtureOptions = process.versions.electron
        ? { ...receivedOptions, env: { ...receivedOptions.env, ELECTRON_RUN_AS_NODE: '1' } }
        : receivedOptions;
      child = spawn(process.execPath, [fixture, mode], fixtureOptions);
      child.once('exit', (code, signal) => exit.resolve({ code, signal }));
      return child;
    },
  });
  t.after(() => client.close());
  return { client, closed, exit: exit.promise, info: () => ({ invocations, exposedOptions, child }) };
}

class FakeChild extends EventEmitter {
  writes = [];
  kills = [];
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new EventEmitter();
  onWrite;
  ended = false;
  unrefed = false;
  killOn = 'SIGTERM';
  initializeResult = { protocolVersion: 1, agentInfo: fakeInfo };

  constructor() {
    super();
    this.stdin.write = (bytes, done) => {
      assert.ok(Buffer.isBuffer(bytes));
      const value = JSON.parse(bytes.toString('utf8'));
      this.writes.push(value);
      if (value.method === 'initialize') {
        queueMicrotask(() => this.send({ id: value.id, result: this.initializeResult }));
        done();
      } else {
        this.onWrite?.(value, done);
      }
      // False return with a callback models pipe backpressure without a test-wide pause.
      return false;
    };
    this.stdin.end = () => { this.ended = true; };
    this.stdin.destroy = () => {};
  }

  send(value) { this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); }
  kill(signal) {
    this.kills.push(signal);
    if (signal === this.killOn) queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
  unref() { this.unrefed = true; }
}

function authenticationChild(authMethods = [{ id: 'oauth-personal' }]) {
  const child = new FakeChild();
  child.initializeResult.authMethods = authMethods;
  child.onWrite = (_, done) => done();
  child.stdin.end = () => {
    child.ended = true;
    queueMicrotask(() => child.emit('exit', 0, null));
  };
  return child;
}

function mockClock(t) {
  let now = performance.now();
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return ms => { now += ms; t.mock.timers.tick(ms); };
}

function mockClient(t, child, options = {}) {
  const client = new AgyAcpClient({ executable: process.execPath, cwd, env, timeoutMs: 4_000,
    spawnFactory: () => child, ...options });
  t.after(async () => { try { await client.close(); } catch (error) { expected(C.CLOSE_TIMEOUT)(error); } });
  return client;
}

test('the local ACP handshake advertises VS Code without changing client capabilities', async t => {
  const child = authenticationChild();
  const client = mockClient(t, child);
  await client.start();
  assert.equal(child.writes[0].method, 'initialize');
  assert.deepEqual(child.writes[0].params, {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'vscode', title: 'VS Code', version: '1.0.0' },
  });
});

test('spawns one fixed command and streams split UTF-8, CRLF and coalesced frames in order', async t => {
  const updates = [];
  const { client, closed, exit, info } = childFor(t, 'normal', { onUpdate: params => { updates.push(params.update.content.text); } });
  await assert.rejects(client.request('test/ping'), expected(C.NOT_READY));
  const start = client.start();
  assert.equal(client.start(), start);
  assert.deepEqual(await start, { protocolVersion: 1, agentInfo: fakeInfo,
    agentCapabilities: { loadSession: true }, authMethods: [] });
  assert.equal(client.start(), start);
  assert.equal(info().invocations, 1);
  assert.deepEqual(info().exposedOptions, [process.execPath, argv,
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }]);
  const text = '汉字\n和 emoji 🚀';
  const response = await client.request('test/duplex', { text });
  assert.deepEqual(response, { echo: text });
  assert.deepEqual(updates, [text, '🚀二']);
  const close = client.close();
  assert.equal(client.close(), close);
  await close;
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.deepEqual(closed, [undefined]);
  await assert.rejects(client.start(), expected(C.CLOSED));
  await assert.rejects(client.request('test/ping'), expected(C.CLOSED));
  await assert.rejects(client.notify('test/mark', {}), expected(C.CLOSED));
});

test('request correlation is type safe and outbound notifications preserve submission order', async t => {
  const { client } = childFor(t, 'normal');
  await client.start();
  const a = client.notify('test/mark', { tag: '第一个' });
  const b = client.notify('test/mark', { tag: '第二个' });
  const receipt = client.request('test/order');
  await Promise.all([a, b]);
  assert.deepEqual(await receipt, ['第一个', '第二个']);
  const resolved = [];
  const first = client.request('test/first').then(value => { resolved.push(value); });
  const second = client.request('test/second').then(value => { resolved.push(value); });
  await Promise.all([first, second]);
  assert.deepEqual(resolved, ['second', 'first']);
});

test('beforeWrite runs once in the write callback stack after backpressure and does not alter ordinary frames', async t => {
  const child = new FakeChild();
  const order = [];
  let release;
  child.onWrite = (frame, done) => {
    if (frame.method === 'test/block') { release = done; return; }
    order.push(frame.method);
    if (frame.id !== undefined) child.send({ id: frame.id, result: { ok: true } });
    done();
  };
  const client = mockClient(t, child);
  await client.start();
  const blocking = client.notify('test/block', {});
  const guarded = client.request('test/guarded', {}, { beforeWrite(...args) {
    assert.deepEqual(args, []);
    assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'test/block']);
    order.push('beforeWrite');
  }, onResponse() { order.push('onResponse'); } });
  const ordinary = client.request('test/ordinary');
  const notice = client.notify('test/notify', {});
  assert.deepEqual(order, []);
  release();
  assert.deepEqual(order, ['beforeWrite', 'test/guarded', 'onResponse', 'test/ordinary', 'test/notify']);
  assert.deepEqual(await Promise.all([blocking, guarded, ordinary, notice]), [undefined, { ok: true }, { ok: true }, undefined]);
});

test('beforeWrite rejects throws, Promises and thenables without sending or leaking callback data', async t => {
  for (const [name, beforeWrite] of [
    ['throws', () => { throw new Error('SYNTHETIC_PRIVATE_CALLBACK'); }],
    ['async', async () => { await nextTick(); throw new Error('SYNTHETIC_PRIVATE_ASYNC'); }],
    ['thenable', () => ({ then() { assert.fail('a guard thenable must not be executed'); } })],
    ['throwing then getter', () => ({ get then() { throw new Error('SYNTHETIC_PRIVATE_THENABLE'); } })],
  ]) await t.test(name, async t => {
    const child = new FakeChild();
    let release;
    child.onWrite = (_, done) => { release = done; };
    const closed = [];
    const client = mockClient(t, child, { onClosed: error => closed.push(error) });
    await client.start();
    const blocking = client.notify('test/block', {});
    let calls = 0;
    const guarded = assert.rejects(client.request('session/prompt', { sessionId }, { beforeWrite() {
      calls++;
      return beforeWrite();
    }, onResponse() { assert.fail('no response can match this unsent frame'); } }), expected(C.BEFORE_WRITE_FAILED));
    const ordinary = assert.rejects(client.notify('test/following', {}), expected(C.BEFORE_WRITE_FAILED));
    assert.equal(calls, 0);
    release();
    await Promise.all([blocking, guarded, ordinary]);
    await client.close();
    await nextTick();
    assert.equal(calls, 1);
    assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'test/block']);
    assert.deepEqual(child.kills, ['SIGTERM']);
    assert.equal(closed.length, 1);
    expected(C.BEFORE_WRITE_FAILED)(closed[0]);
  });
});

test('beforeWrite cannot start a guarded frame during close, including a close from inside the guard', async t => {
  for (const reentrant of [false, true]) await t.test(reentrant ? 'reentrant close' : 'queued close', async t => {
    const child = new FakeChild();
    let release, closing;
    child.onWrite = (frame, done) => { if (frame.method === 'test/block') release = done; else done(); };
    child.stdin.end = () => { queueMicrotask(() => child.emit('exit', 0, null)); };
    const client = mockClient(t, child);
    await client.start();
    const blocking = client.notify('test/block', {});
    let calls = 0;
    const guarded = assert.rejects(client.request('session/prompt', { sessionId }, { beforeWrite() {
      calls++;
      closing = client.close();
    } }), expected(C.CLOSED));
    const notice = client.notify('test/following', {});
    if (!reentrant) closing = client.close();
    release();
    await Promise.all([blocking, guarded, notice, closing]);
    assert.equal(calls, reentrant ? 1 : 0);
    assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'test/block', 'test/following']);
    assert.deepEqual(child.kills, []);
  });
});

test('onResponse observes only the matched response before later coalesced frames or promise handlers', async t => {
  const child = new FakeChild();
  child.onWrite = (_, done) => done();
  const events = [];
  const client = mockClient(t, child, { onUpdate: ({ text }) => { events.push(text); } });
  await client.start();
  const pending = client.request('session/prompt', { sessionId }, { onResponse(...args) {
    assert.deepEqual(args, []);
    events.push('response');
  } }).then(value => { events.push('resolved'); return value; });
  const sent = child.writes.at(-1);
  assert.deepEqual(sent, { jsonrpc: '2.0', id: sent.id, method: 'session/prompt', params: { sessionId } });
  const update = text => ({ method: 'session/update', params: { text } });
  const terminal = { id: sent.id, result: { stopReason: 'end_turn' } };
  child.stdout.write(Buffer.from([
    { ...terminal, id: String(sent.id) }, update('before'), terminal, update('after'), terminal,
  ].map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame })).join('\n') + '\n'));
  assert.deepEqual(events, ['before', 'response', 'after']);
  assert.deepEqual(await pending, { stopReason: 'end_turn' });
  assert.deepEqual(events, ['before', 'response', 'after', 'resolved']);

  const rejected = assert.rejects(client.request('test/rpc-error', {}, { onResponse(...args) {
    assert.deepEqual(args, []);
    events.push('error-response');
  } }), expected(C.RPC_ERROR));
  child.send({ id: child.writes.at(-1).id, error: { code: -32602, message: 'SYNTHETIC_PRIVATE_REMOTE', data: { private: true } } });
  assert.equal(events.at(-1), 'error-response');
  await rejected;
});

test('onResponse is not called for malformed replies or replies to requests still queued for writing', async t => {
  for (const name of ['malformed', 'not yet written']) await t.test(name, async t => {
    const child = new FakeChild();
    child.onWrite = (_, done) => { if (name === 'malformed') done(); };
    const client = mockClient(t, child);
    await client.start();
    const blocker = name === 'not yet written' ? assert.rejects(client.notify('test/block', {}), expected(C.PROTOCOL)) : undefined;
    let callbacks = 0;
    const pending = assert.rejects(client.request('test/respond', {}, { onResponse() { callbacks++; } }), expected(C.PROTOCOL));
    const id = name === 'not yet written' ? child.writes[0].id + 1 : child.writes.at(-1).id;
    child.send(name === 'malformed' ? { id, result: {}, error: { code: -32602, message: 'SYNTHETIC_PRIVATE_MALFORMED' } } : { id, result: {} });
    await Promise.all([blocker, pending]);
    assert.equal(callbacks, 0);
    assert.equal(child.writes.some(frame => frame.method === 'test/respond'), name === 'malformed');
  });
});

test('onResponse failures fence all pending requests without leaking callback errors', async t => {
  for (const [name, handler] of [
    ['throws', () => { throw new Error('SYNTHETIC_PRIVATE_CALLBACK'); }],
    ['async', async () => { throw new Error('SYNTHETIC_PRIVATE_CALLBACK'); }],
  ]) await t.test(name, async t => {
    const child = new FakeChild();
    child.onWrite = (_, done) => done();
    const updates = [];
    const client = mockClient(t, child, { onUpdate(value) { updates.push(value); } });
    await client.start();
    const first = assert.rejects(client.request('test/hang', {}), expected(C.RESPONSE_HANDLER_FAILED));
    const second = assert.rejects(client.request('test/respond', {}, { onResponse: handler }), expected(C.RESPONSE_HANDLER_FAILED));
    child.stdout.write(Buffer.from([
      { id: child.writes.at(-1).id, result: {} }, { method: 'session/update', params: {} },
    ].map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame })).join('\n') + '\n'));
    await Promise.all([first, second]);
    await assert.rejects(client.request('test/again'), expected(C.RESPONSE_HANDLER_FAILED));
    await client.close();
    assert.deepEqual(updates, []);
    assert.deepEqual(child.kills, ['SIGTERM']);
  });
});

test('only permission requests go to the controller; unsupported requests get Method not found', async t => {
  const updates = [];
  const decision = deferred();
  const permission = deferred();
  const { client } = childFor(t, 'permission', {
    onUpdate: params => { updates.push(params.update.content.text); },
    async onPermission(params) { permission.resolve(params); return decision.promise; },
  });
  await client.start();
  const prompt = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'test' }] });
  const params = await permission.promise;
  assert.equal(params.sessionId, sessionId);
  assert.equal(params.toolCall.toolCallId, 'first-tool');
  assert.deepEqual(params.options.map(option => option.kind), ['reject_once', 'allow_once']);
  assert.deepEqual(updates, ['询问']);
  assert.deepEqual(await client.request('test/order'), [1, 'term', 'mcp', 'update-is-a-request']);
  decision.resolve({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
  assert.deepEqual(await prompt, { stopReason: 'end_turn', response: { jsonrpc: '2.0',
    id: 'peer-permission', result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } } });
  assert.deepEqual(updates, ['询问', '继续']);
});

test('permission callbacks fail closed when absent, throwing or returning malformed results', async t => {
  for (const [name, onPermission] of [
    ['absent', undefined],
    ['throws', async () => { throw new Error('SYNTHETIC_PRIVATE_HANDLER'); }],
    ['malformed', async () => ({ outcome: { outcome: 'selected', optionId: 17 } })],
  ]) {
    await t.test(name, async t => {
      const { client } = childFor(t, 'permission', { onPermission });
      await client.start();
      const result = await client.request('session/prompt', { sessionId, prompt: [] });
      assert.deepEqual(result.response.result, cancelled);
    });
  }
});

test('the controller can send cancel and resolve its permission; final updates precede the response', async t => {
  const updates = [];
  const decision = deferred();
  const permission = deferred();
  const { client } = childFor(t, 'cancel', {
    onUpdate: params => { updates.push(params.update.content.text); },
    async onPermission(params) { permission.resolve(params); return decision.promise; },
  });
  await client.start();
  const prompt = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'test' }] });
  await permission.promise;
  await client.notify('session/cancel', { sessionId });
  decision.resolve(cancelled);
  assert.deepEqual(await prompt, { stopReason: 'cancelled' });
  assert.deepEqual(updates, ['开始', '停止后的最后一段']);
});

test('RPC errors redact message and data; auth-required remains recognizable without signing in', async t => {
  const { client, closed } = childFor(t, 'normal');
  await client.start();
  assert.equal(C.AUTH_REQUIRED, -32000);
  await assert.rejects(client.request('session/new', { cwd, mcpServers: [] }), expected(C.AUTH_REQUIRED));
  await assert.rejects(client.request('test/rpc-error'), expected(C.RPC_ERROR));
  assert.deepEqual(await client.request('test/ping'), { alive: true });
  assert.deepEqual(closed, []);
});

test('invalid local calls never send auth/MCP methods or leak an exception from serialization', async t => {
  const child = new FakeChild();
  child.onWrite = (_, done) => done();
  const client = mockClient(t, child);
  await client.start();
  await assert.rejects(client.request('initialize', {}), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.request('authenticate', {}), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.notify('logout', {}), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.request('session/new', { cwd, mcpServers: [{}] }), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.request('session/new', { toJSON: () => ({ cwd, mcpServers: [{}] }) }), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.notify('test/other', 'not structured'), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.request('test/hang', {}, { timeoutMs: 0 }), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.request('test/hang', {}, { onResponse: true }), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.request('test/hang', {}, { beforeWrite: true }), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.request('test/hang', {}, { get beforeWrite() {
    throw new Error('SYNTHETIC_PRIVATE_GUARD_GETTER');
  } }), expected(C.INVALID_ARGUMENT));
  await assert.rejects(client.notify('test/other', { toJSON() { throw new Error('SYNTHETIC_PRIVATE_INPUT'); } }), expected(C.INVALID_ARGUMENT));
  assert.deepEqual(child.writes.map(({ method }) => method), ['initialize']);
  await client.notify('session/cancel', { sessionId });
});

test('authentication needs explicit boolean opt-in and public request/notify always reject auth methods', async t => {
  for (const allowAuthentication of [undefined, false, true]) await t.test(String(allowAuthentication), async t => {
    const child = authenticationChild();
    const options = allowAuthentication === undefined ? {} : { allowAuthentication };
    const client = mockClient(t, child, options);
    await client.start();
    if (allowAuthentication !== true) {
      await assert.rejects(client.authenticate('oauth-personal'), expected(C.INVALID_ARGUMENT));
    }
    for (const method of ['authenticate', 'logout']) {
      await assert.rejects(client.request(method, { methodId: 'oauth-personal' }), expected(C.INVALID_ARGUMENT));
      await assert.rejects(client.notify(method, { methodId: 'oauth-personal' }), expected(C.INVALID_ARGUMENT));
    }
    assert.deepEqual(child.writes.map(frame => frame.method), ['initialize']);
  });
  for (const allowAuthentication of [1, 'true', null, {}, []]) {
    assert.throws(() => new AgyAcpClient({ executable: process.execPath, cwd, env, allowAuthentication }), expected(C.INVALID_ARGUMENT));
  }
});

test('only an advertised personal method may authenticate after initialize, and its response is always void', async t => {
  const child = authenticationChild([
    { id: 'oauth-personal', name: 'SYNTHETIC_PRIVATE_AUTH_NAME', description: 'SYNTHETIC_PRIVATE_AUTH_DATA',
      _meta: { secret: 'SYNTHETIC_PRIVATE_AUTH_METADATA' } },
    ...['oauth-business', 'gemini-api-key', 'agent-platform', 'terminal-login'].map(id => ({ id })),
  ]);
  const client = mockClient(t, child, { allowAuthentication: true });
  await assert.rejects(client.authenticate('oauth-personal'), expected(C.NOT_READY));
  const starting = client.start();
  await assert.rejects(client.authenticate('oauth-personal'), expected(C.NOT_READY));
  const initialized = await starting;
  assert.deepEqual(initialized.authMethods, ['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform', 'terminal-login'].map(id => ({ id })));
  assert.doesNotMatch(JSON.stringify(initialized), /SYNTHETIC_PRIVATE/);
  for (const methodId of [undefined, null, 0, {}, ['oauth-personal'], 'oauth-business', 'gemini-api-key', 'agent-platform', 'terminal-login',
    'oauth-personal ', 'OAUTH-PERSONAL', { toString() { throw new Error('SYNTHETIC_PRIVATE_METHOD'); } }]) {
    await assert.rejects(client.authenticate(methodId), expected(C.INVALID_ARGUMENT));
  }
  assert.deepEqual(child.writes.map(frame => frame.method), ['initialize']);
  const authentication = client.authenticate('oauth-personal');
  await nextTick();
  const sent = child.writes.at(-1);
  assert.deepEqual(sent, { jsonrpc: '2.0', id: 1, method: 'authenticate', params: { methodId: 'oauth-personal' } });
  child.send({ id: sent.id, result: { then: 'SYNTHETIC_PRIVATE_AUTH_RESULT', data: { secret: 'SYNTHETIC_PRIVATE_TOKEN' } } });
  assert.equal(await authentication, undefined);
  await client.close();
  assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'authenticate']);
  await assert.rejects(client.authenticate('oauth-personal'), expected(C.CLOSED));
});

test('missing advertisements cannot be forged through cached initialize data or unsolicited replies', async t => {
  for (const [name, authMethods] of [['absent', undefined], ['empty', []], ['different methods', [{ id: 'oauth-business' }]]]) {
    await t.test(name, async t => {
      const child = authenticationChild(authMethods);
      if (name === 'absent') delete child.initializeResult.authMethods;
      const client = mockClient(t, child, { allowAuthentication: true });
      const initialized = await client.start();
      if (initialized.authMethods?.length) initialized.authMethods[0].id = 'oauth-personal';
      else initialized.authMethods = [{ id: 'oauth-personal' }];
      assert.equal(await client.start(), initialized);
      child.send({ id: child.writes[0].id, result: { ...child.initializeResult, authMethods: [{ id: 'oauth-personal' }] } });
      await assert.rejects(client.authenticate('oauth-personal'), expected(C.INVALID_ARGUMENT));
      assert.deepEqual(child.writes.map(frame => frame.method), ['initialize']);
    });
  }
  await t.test('real advertisement survives mutation of the returned array', async t => {
    const child = authenticationChild();
    const client = mockClient(t, child, { allowAuthentication: true });
    const initialized = await client.start();
    initialized.authMethods[0].id = 'oauth-business';
    initialized.authMethods.length = 0;
    const authentication = client.authenticate('oauth-personal');
    await nextTick();
    child.send({ id: child.writes.at(-1).id, result: null });
    assert.equal(await authentication, undefined);
  });
});

test('invalid auth method advertisements fail initialization without publishing remote metadata', async t => {
  for (const [name, authMethods] of [
    ['null list', null], ['object list', {}], ['null entry', [null]], ['array entry', [[]]], ['string entry', ['oauth-personal']],
    ['missing id', [{ name: 'SYNTHETIC_PRIVATE_METHOD' }]], ['non-string id', [{ id: 7 }]], ['blank id', [{ id: '  ' }]],
    ['duplicate id', [{ id: 'oauth-personal' }, { id: 'oauth-personal' }]],
  ]) await t.test(name, async t => {
    const child = authenticationChild(authMethods);
    const client = mockClient(t, child, { allowAuthentication: true });
    await assert.rejects(client.start(), expected(C.PROTOCOL));
    await assert.rejects(client.authenticate('oauth-personal'), expected(C.PROTOCOL));
    await client.close();
    assert.deepEqual(child.writes.map(frame => frame.method), ['initialize']);
  });
});

test('concurrent and reentrant authentication calls share exactly one operation without retry', async t => {
  const child = authenticationChild();
  let reentrant;
  const client = mockClient(t, child, { allowAuthentication: true });
  child.onWrite = (frame, done) => {
    if (frame.method === 'authenticate') reentrant = client.authenticate('oauth-personal');
    done();
  };
  await client.start();
  const first = client.authenticate('oauth-personal');
  assert.equal(client.authenticate('oauth-personal'), first);
  await nextTick();
  assert.equal(reentrant, first);
  assert.equal(client.authenticate('oauth-personal'), first);
  await assert.rejects(client.authenticate('oauth-business'), expected(C.INVALID_ARGUMENT));
  assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'authenticate']);
  child.send({ id: child.writes.at(-1).id, result: { secret: 'SYNTHETIC_PRIVATE_AUTH_SUCCESS' } });
  assert.deepEqual(await Promise.all([first, reentrant]), [undefined, undefined]);
  await nextTick();
  assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'authenticate']);
});

test('authentication errors keep recognizable codes but never remote messages, data, stderr or automatic retries', async t => {
  for (const code of [-32602, C.AUTH_REQUIRED]) await t.test(String(code), async t => {
    const child = authenticationChild();
    const closed = [];
    const client = mockClient(t, child, { allowAuthentication: true, onClosed: error => closed.push(error) });
    await client.start();
    const authentication = assert.rejects(client.authenticate('oauth-personal'), expected(code === C.AUTH_REQUIRED ? C.AUTH_REQUIRED : C.RPC_ERROR));
    await nextTick();
    child.stderr.write('SYNTHETIC_PRIVATE_LOGIN_STDERR');
    child.send({ id: child.writes.at(-1).id, error: { code, message: 'SYNTHETIC_PRIVATE_LOGIN_ERROR',
      data: { secret: 'SYNTHETIC_PRIVATE_LOGIN_DATA', authUrl: 'https://SYNTHETIC_PRIVATE.example/' } } });
    await authentication;
    await nextTick();
    assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'authenticate']);
    assert.deepEqual(closed, []);
    await client.close();
    assert.deepEqual(closed, [undefined]);
  });
});

test('close cancels scheduled, queued and in-flight authentication without starting a queued login', async t => {
  for (const stage of ['scheduled', 'queued', 'in-flight']) await t.test(stage, async t => {
    const child = authenticationChild();
    let release;
    child.onWrite = (frame, done) => { if (frame.method === 'test/block') release = done; else done(); };
    const client = mockClient(t, child, { allowAuthentication: true });
    await client.start();
    const blocking = stage === 'queued' ? client.notify('test/block', {}) : undefined;
    const authentication = assert.rejects(client.authenticate('oauth-personal'), expected(C.CLOSED));
    if (stage !== 'scheduled') await nextTick();
    const closing = client.close();
    if (stage === 'queued') release();
    if (stage === 'in-flight') child.send({ id: child.writes.at(-1).id, result: { secret: 'SYNTHETIC_PRIVATE_LATE_LOGIN' } });
    await Promise.all([blocking, authentication, closing]);
    assert.deepEqual(child.writes.map(frame => frame.method), stage === 'queued' ? ['initialize', 'test/block']
      : stage === 'in-flight' ? ['initialize', 'authenticate'] : ['initialize']);
    assert.equal(child.ended, true);
    assert.deepEqual(child.kills, []);
    await assert.rejects(client.authenticate('oauth-personal'), expected(C.CLOSED));
  });
});

test('close reaps authentication even when its write callback and the first termination signal never complete', async t => {
  const child = authenticationChild();
  child.onWrite = () => {};
  child.killOn = 'SIGKILL';
  const client = mockClient(t, child, { allowAuthentication: true });
  await client.start();
  const advance = mockClock(t);
  const authentication = assert.rejects(client.authenticate('oauth-personal'), expected(C.CLOSED));
  await nextTick();
  const closing = client.close();
  await authentication;
  await nextTick();
  advance(250);
  await nextTick();
  assert.deepEqual(child.kills, ['SIGTERM']);
  advance(250);
  await closing;
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'authenticate']);
  assert.equal(child.unrefed, false);
});

test('authentication has a ten-minute response deadline independent of the ordinary write timeout', async t => {
  const child = authenticationChild();
  const closed = [];
  const client = mockClient(t, child, { timeoutMs: 20_000, allowAuthentication: true, onClosed: error => closed.push(error) });
  await client.start();
  const advance = mockClock(t);
  let settled = false;
  const authentication = client.authenticate('oauth-personal');
  const rejected = assert.rejects(authentication, expected(C.TIMEOUT)).then(() => { settled = true; });
  await nextTick();
  advance(20_001);
  await nextTick();
  assert.equal(settled, false);
  assert.equal(client.authenticate('oauth-personal'), authentication);
  advance(579_998);
  await nextTick();
  assert.equal(settled, false);
  advance(1);
  await rejected;
  child.send({ id: child.writes.at(-1).id, result: { secret: 'SYNTHETIC_PRIVATE_EXPIRED_LOGIN' } });
  await client.close();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'authenticate']);
  assert.equal(closed.length, 1);
  expected(C.TIMEOUT)(closed[0]);
  await assert.rejects(client.authenticate('oauth-personal'), expected(C.TIMEOUT));
});

test('a stuck authentication stdin write still uses the original twenty-second write deadline', async t => {
  const child = authenticationChild();
  child.onWrite = () => {};
  const client = mockClient(t, child, { timeoutMs: 20_000, allowAuthentication: true });
  await client.start();
  const advance = mockClock(t);
  const authentication = assert.rejects(client.authenticate('oauth-personal'), expected(C.TIMEOUT));
  await nextTick();
  advance(19_999);
  assert.deepEqual(child.kills, []);
  advance(1);
  await authentication;
  await client.close();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.deepEqual(child.writes.map(frame => frame.method), ['initialize', 'authenticate']);
});

test('initialization fails closed on wrong descriptor, missing fields, auth error, exit or timeout', async t => {
  for (const [mode, code] of [
    ['wrong-version', C.UNSUPPORTED_PROTOCOL], ['wrong-name', C.PROTOCOL], ['missing-version', C.PROTOCOL],
    ['initialize-auth', C.AUTH_REQUIRED], ['exit-before-initialize', C.PROCESS_EXIT], ['initialize-timeout', C.TIMEOUT],
  ]) {
    await t.test(mode, async t => {
      const { client, closed, exit } = childFor(t, mode, mode === 'initialize-timeout' ? { timeoutMs: 160 } : {});
      await assert.rejects(client.start(), expected(code));
      await client.close();
      await exit;
      assert.equal(closed.length, 1);
      expected(code)(closed[0]);
      await assert.rejects(client.start(), expected(code));
    });
  }
});

test('invalid launch inputs, synchronous spawn exceptions and emitted spawn errors stay sanitized', async t => {
  assert.throws(() => new AgyAcpClient({ executable: 'agy.exe', cwd, env }), expected(C.INVALID_ARGUMENT));
  assert.throws(() => new AgyAcpClient({ executable: process.execPath, cwd: 'relative', env }), expected(C.INVALID_ARGUMENT));
  assert.throws(() => new AgyAcpClient({ executable: process.execPath, cwd }), expected(C.INVALID_ARGUMENT));
  const first = new AgyAcpClient({ executable: process.execPath, cwd, env,
    spawnFactory() { throw new Error('SYNTHETIC_PRIVATE_EXECUTABLE_PATH'); } });
  await assert.rejects(first.start(), expected(C.SPAWN_FAILED));
  await first.close();
  const child = new FakeChild();
  child.stdin.write = () => false;
  const second = mockClient(t, child);
  const rejected = assert.rejects(second.start(), expected(C.SPAWN_FAILED));
  await nextTick();
  child.emit('error', new Error('SYNTHETIC_PRIVATE_ASYNC_SPAWN'));
  await rejected;
  await second.close();
});

test('a request deadline fences all pending responses, callbacks and subsequent writes', async t => {
  const child = new FakeChild();
  const permission = deferred();
  const decision = deferred();
  const updates = [];
  const closed = [];
  child.onWrite = (value, done) => {
    done();
    if (value.method === 'session/prompt') child.send({ id: 'peer', method: 'session/request_permission', params: { sessionId } });
  };
  const client = mockClient(t, child, { onUpdate: params => { updates.push(params); },
    onPermission() { permission.resolve(); return decision.promise; }, onClosed: error => { closed.push(error); } });
  await client.start();
  const one = assert.rejects(client.request('session/prompt', { sessionId }, { timeoutMs: 50 }), expected(C.TIMEOUT));
  const two = assert.rejects(client.request('test/hang', {}), expected(C.TIMEOUT));
  await permission.promise;
  await Promise.all([one, two]);
  const writes = child.writes.length;
  child.send({ method: 'session/update', params: { ignored: true } });
  child.send({ id: 1, result: { stopReason: 'end_turn' } });
  decision.resolve({ outcome: { outcome: 'selected', optionId: 'late' } });
  await client.close();
  await nextTick();
  assert.equal(child.writes.length, writes);
  assert.deepEqual(updates, []);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(closed.length, 1);
  expected(C.TIMEOUT)(closed[0]);
  await assert.rejects(client.notify('session/cancel', { sessionId }), expected(C.TIMEOUT));
});

test('a slow synchronous update cannot let a coalesced response bypass its deadline', async t => {
  const child = new FakeChild();
  child.onWrite = (_, done) => done();
  let updates = 0;
  const client = mockClient(t, child, { onUpdate() {
    updates++;
    const until = performance.now() + 50;
    while (performance.now() < until) { /* advance the monotonic clock without servicing timers */ }
  } });
  await client.start();
  const waiting = assert.rejects(client.request('test/hang', {}, { timeoutMs: 25 }), expected(C.TIMEOUT));
  const update = { jsonrpc: '2.0', method: 'session/update', params: {} };
  const response = { jsonrpc: '2.0', id: child.writes.at(-1).id, result: {} };
  child.stdout.write(Buffer.from([update, response, update].map(JSON.stringify).join('\n') + '\n'));
  await waiting;
  assert.equal(updates, 1);
});

test('mid-connection exit, malformed framing and oversize fail without exposing process output', async t => {
  for (const [method, code] of [
    ['test/exit', C.PROCESS_EXIT], ['test/invalid-json', C.PROTOCOL],
    ['test/invalid-utf8', C.PROTOCOL], ['test/invalid-response', C.PROTOCOL], ['test/oversize', C.FRAME_TOO_LARGE],
  ]) {
    await t.test(method, async t => {
      const updates = [];
      const { client, closed, exit } = childFor(t, 'normal', { onUpdate: params => { updates.push(params); } });
      await client.start();
      await Promise.all([assert.rejects(client.request('test/hang'), expected(code)),
        assert.rejects(client.request(method), expected(code))]);
      await client.close();
      await exit;
      assert.deepEqual(updates, []);
      assert.equal(closed.length, 1);
      expected(code)(closed[0]);
    });
  }
});

test('stdout EOF with a partial frame fences pending work before process exit', async t => {
  const child = new FakeChild();
  child.onWrite = (_, done) => done();
  const client = mockClient(t, child);
  await client.start();
  const waiting = assert.rejects(client.request('test/hang'), expected(C.PROTOCOL));
  child.stdout.end(Buffer.from('{"jsonrpc":"2.0","incomplete":"SYNTHETIC_PRIVATE_TRUNCATED_FRAME'));
  await waiting;
  await client.close();
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('an oversized outbound frame is rejected before writing and fences pending work', async t => {
  const child = new FakeChild();
  child.onWrite = (_, done) => done();
  const client = mockClient(t, child);
  await client.start();
  const waiting = assert.rejects(client.request('test/hang'), expected(C.FRAME_TOO_LARGE));
  await assert.rejects(client.notify('test/large', { text: '汉'.repeat(1_400_000) }), expected(C.FRAME_TOO_LARGE));
  await waiting;
  assert.deepEqual(child.writes.map(({ method }) => method), ['initialize', 'test/hang']);
});

test('synchronous update hook exceptions or async returns fence the connection without unhandled rejection', async t => {
  for (const [name, onUpdate] of [
    ['throws', () => { throw new Error('SYNTHETIC_PRIVATE_UPDATE'); }],
    ['returns promise', async () => { throw new Error('SYNTHETIC_PRIVATE_UPDATE'); }],
  ]) {
    await t.test(name, async t => {
      const { client, closed } = childFor(t, 'normal', { onUpdate });
      await client.start();
      await assert.rejects(client.request('test/duplex', { text: '汉' }), expected(C.UPDATE_HANDLER_FAILED));
      await client.close();
      expected(C.UPDATE_HANDLER_FAILED)(closed[0]);
    });
  }
});

test('write callbacks govern order and graceful close drains accepted writes before stdin EOF', async t => {
  const child = new FakeChild();
  const flushes = [];
  const closed = [];
  child.onWrite = (_, done) => { flushes.push(done); };
  child.stdin.end = () => {
    child.ended = true;
    queueMicrotask(() => child.emit('exit', 0, null));
  };
  const client = mockClient(t, child, { onClosed: error => { closed.push(error); } });
  await client.start();
  const first = client.notify('test/mark', { tag: 'A' });
  const second = client.notify('test/mark', { tag: 'B' });
  assert.equal(flushes.length, 1);
  const closing = client.close();
  assert.equal(child.ended, false);
  flushes.shift()();
  assert.equal(flushes.length, 1);
  assert.equal(child.ended, false);
  flushes.shift()();
  await Promise.all([first, second, closing]);
  assert.equal(child.ended, true);
  assert.deepEqual(child.kills, []);
  assert.deepEqual(child.writes.slice(1).map(({ params }) => params.tag), ['A', 'B']);
  assert.deepEqual(closed, [undefined]);
});

test('write errors reject a stuck write and prevent its following queued write', async t => {
  const child = new FakeChild();
  const flushes = [];
  child.onWrite = (_, done) => { flushes.push(done); };
  const client = mockClient(t, child);
  await client.start();
  const a = assert.rejects(client.notify('test/mark', { tag: 'A' }), expected(C.IO));
  const b = assert.rejects(client.notify('test/mark', { tag: 'B' }), expected(C.IO));
  assert.equal(flushes.length, 1);
  flushes.shift()(new Error('SYNTHETIC_PRIVATE_EPIPE'));
  await Promise.all([a, b]);
  await client.close();
  assert.deepEqual(child.writes.slice(1).map(({ params }) => params.tag), ['A']);
});

test('pending peer requests are bounded, and shutdown does not await an unfinished permission', async t => {
  const child = new FakeChild();
  const decisions = deferred();
  let count = 0;
  child.onWrite = (_, done) => done();
  const client = mockClient(t, child, { onPermission: () => { count++; return decisions.promise; } });
  await client.start();
  const failure = assert.rejects(client.request('test/hang'), expected(C.LIMIT_EXCEEDED));
  for (let id = 0; id < 33; id++) child.send({ id: `peer-${id}`, method: 'session/request_permission', params: { sessionId } });
  await failure;
  assert.equal(count, 32);
  await client.close();
  decisions.resolve(cancelled);
  await nextTick();
  assert.deepEqual(child.writes.map(({ method }) => method), ['initialize', 'test/hang']);
});

test('close reaps a stubborn real synthetic child, escalates if required, and reports an unconfirmed reap', async t => {
  await t.test('real process is reaped', async t => {
    const { client, closed, exit } = childFor(t, 'stubborn');
    await client.start();
    await client.close();
    const { code, signal } = await exit;
    assert.ok(code !== 0 || signal);
    assert.deepEqual(closed, [undefined]);
  });
  await t.test('synthetic hard termination', async t => {
    const child = new FakeChild();
    child.killOn = 'SIGKILL';
    const client = mockClient(t, child);
    await client.start();
    await client.close();
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.unrefed, false);
  });
  await t.test('unconfirmed exit', async t => {
    const child = new FakeChild();
    const closed = [];
    child.killOn = null;
    const client = mockClient(t, child, { onClosed: error => { closed.push(error); } });
    await client.start();
    await assert.rejects(client.close(), expected(C.CLOSE_TIMEOUT));
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.unrefed, true);
    expected(C.CLOSE_TIMEOUT)(closed[0]);
  });
});
