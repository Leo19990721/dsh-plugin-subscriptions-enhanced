import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { apply, mountAgyHost } from '../src/agy-host.js';
import { AgyAcpErrorCode } from '../src/agy-acp-client.js';
import { AgySessionError } from '../src/agy-session.js';

const METHOD = 'subscriptions-enhanced-gemini';
const BRIDGE = '/api/subscriptions-enhanced-gemini';
const PROMPT = '/api/session/prompt';
const CANCEL = '/api/session/cancel';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const A = uuid(1), B = uuid(2), RPC_ID = uuid(3);
const OTHER_NATIVE_ID = `agy-native-${uuid(4)}`;
// These paths are labels for the synthetic backend; nothing opens them on disk.
const cwdA = resolve('fixture-private-agy', 'workspace-a');
const cwdB = resolve('fixture-private-agy', 'workspace-b');
const workspaceRows = [{ id: A, path: cwdA, title: 'A' }, { id: B, path: cwdB, title: 'B' }];
const status = { action: 'status' };
const open = (workspaceId = A) => ({ action: 'open', workspaceId });
const list = (workspaceId = A) => ({ action: 'list', workspaceId });
const envelope = (payload, overrides) => JSON.stringify({ type: 'client-request', rpcId: RPC_ID, method: METHOD, payload, ...overrides });

function request(payload, { body = envelope(payload), headers } = {}) {
  return new Request(`http://127.0.0.1:12345${BRIDGE}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half',
  });
}

async function rpcResult(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const { result, ...reply } = await response.json();
  assert.deepEqual(reply, { type: 'server-response', rpcId: RPC_ID });
  return result;
}

async function value(response) {
  const result = await rpcResult(response);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

async function agyError(response, code, label) {
  assert.deepEqual(await rpcResult(response), {
    ok: false, error: { code: `agy/${code}`, message: 'Gemini ACP request did not complete.', details: {} },
  }, label);
}

async function httpError(response, statusCode, label) {
  assert.equal(response.status, statusCode, label);
  assert.equal(response.headers.get('cache-control'), 'no-store', label);
  assert.equal(await response.text(), '', label);
}

const ownerPeer = (id, kind = 'owner', signal = new AbortController().signal) => ({ id, principal: { kind }, signal });

// Capture the Host registrations and dispatch through the real witness, using
// separate in-memory IncomingMessage-shaped metadata and Fetch Request bodies.
function host(t, workspaces = workspaceRows) {
  let route, middleware, disposeEffect, disposing;
  const admitted = new WeakMap();
  const browserPeer = ownerPeer('fixture-browser');
  const authenticated = ownerPeer(browserPeer.id); // Identity is the id, not object equality.
  const calls = { registry: [], prepare: 0, unsubscribe: 0 };
  const sessions = { prepare() { calls.prepare++; throw new Error('Unexpected native preparation'); } };
  const services = new Map([['sessions', sessions]]), rootServices = new Map();
  const ctx = {
    webServer: { host: '127.0.0.1' },
    connection: {
      browserPeer, allowsRemoteAuthorities: false,
      admit(req) { const peer = admitted.get(req); return peer ? { peer } : { rejection: 401 }; },
      fetch: { register(spec) {
        assert.equal(route, undefined);
        assert.equal(spec.path, BRIDGE);
        assert.deepEqual(spec.methods, ['POST']);
        assert.equal(spec.requestBody, 'streaming');
        route = spec;
      } },
    },
    workspaceRegistry: {
      list() { calls.registry.push('list'); return workspaces; },
      get(id) { calls.registry.push(id); return workspaces.find(row => row.id === id); },
    },
    sessions,
    get: name => services.get(name),
    root: { get: name => rootServices.get(name) },
    on(event, listener) {
      assert.equal(event, 'connection/request');
      assert.equal(middleware, undefined);
      middleware = listener;
      return () => { calls.unsubscribe++; middleware = undefined; };
    },
    effect(factory) { disposeEffect = factory(); },
  };
  const dispose = () => disposing ??= Promise.resolve().then(() => disposeEffect?.());
  t.after(dispose);

  function witness(url, next, { peer = authenticated, site = 'same-origin', remoteAddress = '127.0.0.1', method = 'POST' } = {}) {
    const req = { method, url, socket: { remoteAddress }, headers: site === null ? {} : { 'sec-fetch-site': site } };
    admitted.set(req, peer);
    return middleware ? middleware(req, {}, next) : next();
  }

  const deliver = req => route.fetch(req);
  function send(payload, options = {}) {
    const req = request(payload, options);
    const next = () => deliver(req);
    return options.direct ? next() : witness(options.witnessPath ?? BRIDGE, next, options);
  }
  return { ctx, calls, services, rootServices, witness, deliver, send, dispose };
}

function synthetic(t, options = {}) {
  const fixture = host(t, options.workspaces);
  const paths = new Map(workspaceRows.map(row => [row.id, row.path]));
  const backend = { checks: 0, verified: [], made: [], opened: [], published: [], retired: [], closed: [] };
  mountAgyHost(fixture.ctx, {
    verify() { backend.checks++; return options.verify?.(); },
    verifyWorkspace(_ctx, id) {
      backend.verified.push(id);
      return options.verifyWorkspace ? options.verifyWorkspace(id) : paths.get(id);
    },
    makeSession({ cwd }) {
      backend.made.push(cwd);
      return {
        usable: false,
        async list() { return options.list?.(cwd) ?? []; },
        async open(id) {
          backend.opened.push(id);
          const opened = await options.open?.(id);
          this.id = id ?? 'fixture-private-official-new';
          this.usable = true;
          return opened ?? { history: [] };
        },
        read() { return { available: this.usable, permissions: [], tools: [] }; },
        async close() {
          backend.closed.push(cwd);
          await options.close?.();
          this.usable = false;
        },
        runTurn(text, feed) { return options.runTurn?.(text, feed) ?? { status: 'completed' }; },
      };
    },
    async publish(_ctx, input) {
      await options.publish?.(input);
      const agent = { id: input.id, status: 'idle' };
      backend.published.push({ input, agent });
      return { agent, dispose() { backend.retired.push(agent.id); } };
    },
  });
  return { ...fixture, paths, backend };
}

function untouched(fixture) {
  assert.equal(fixture.backend.checks, 0);
  assert.deepEqual(fixture.backend.verified, []);
  assert.deepEqual(fixture.backend.made, []);
  assert.deepEqual(fixture.calls.registry, []);
  assert.equal(fixture.calls.prepare, 0);
}

test('production apply stays preview-only even with launch and publication options', async t => {
  const f = host(t);
  const attempted = [];
  const unexpected = name => () => { attempted.push(name); throw new Error(`Unexpected ${name}`); };
  const config = {
    enabled: true, executable: resolve(cwdA, 'agy.exe'), cwd: cwdA,
    makeSession: unexpected('launch'), verify: unexpected('native support'),
    verifyWorkspace: unexpected('workspace'), publish: unexpected('publish'),
  };
  f.ctx.config = config;
  apply(f.ctx, config);
  assert.deepEqual(await value(await f.send(status)), { available: false, reason: 'preview-only' });
  await agyError(await f.send(open()), 'preview-only');
  await agyError(await f.send(list()), 'preview-only');
  for (const services of [f.services, f.rootServices]) {
    services.set('sessionProjectionCache', {});
    assert.deepEqual(await value(await f.send(status)), { available: false, reason: 'host-required' });
    await agyError(await f.send(open()), 'host-required');
    services.delete('sessionProjectionCache');
  }
  assert.deepEqual(attempted, []);
  assert.equal(f.calls.prepare, 0);
  assert.deepEqual(f.calls.registry, []);
});

test('a shared projection cache blocks even the synthetic backend before workspace lookup', async t => {
  const f = synthetic(t);
  f.rootServices.set('sessionProjectionCache', {});
  assert.deepEqual(await value(await f.send(status)), { available: false, reason: 'host-required' });
  await agyError(await f.send(open()), 'host-required');
  untouched(f);
});

test('the exact POST witness requires the authenticated loopback browser peer', async t => {
  const f = synthetic(t);
  const browserId = f.ctx.connection.browserPeer.id;
  for (const [label, options] of [
    ['unwrapped request', { direct: true }],
    ['unauthenticated request', { peer: null }],
    ['in-process owner', { peer: ownerPeer('fixture-in-process-owner') }],
    ['non-owner with matching id', { peer: ownerPeer(browserId, 'remote') }],
    ['disconnected browser', { peer: ownerPeer(browserId, 'owner', AbortSignal.abort()) }],
    ['non-loopback socket', { remoteAddress: '192.0.2.1' }],
    ['cross-site browser', { site: 'cross-site' }],
    ['same-site is not same-origin', { site: 'same-site' }],
    ['wrong HTTP method', { method: 'GET' }],
    ['nearby route', { witnessPath: `${BRIDGE}/` }],
    ['query suffix', { witnessPath: `${BRIDGE}?extra=1` }],
  ]) await httpError(await f.send(open(), options), 403, label);

  f.ctx.webServer.host = '0.0.0.0';
  await httpError(await f.send(open()), 403, 'non-loopback listener');
  f.ctx.webServer.host = '127.0.0.1';
  f.ctx.connection.allowsRemoteAuthorities = true;
  await httpError(await f.send(open()), 403, 'remote authorities enabled');
  f.ctx.connection.allowsRemoteAuthorities = false;
  f.ctx.connection.browserPeer = undefined;
  await httpError(await f.send(open()), 403, 'no browser peer');
  f.ctx.connection.browserPeer = ownerPeer(browserId);
  untouched(f);

  const expected = { available: true, workspaces: [{ id: A, title: 'A' }, { id: B, title: 'B' }] };
  assert.deepEqual(await value(await f.send(status)), expected);
  assert.deepEqual(await value(await f.send(status, { site: null })), expected, 'Desktop omits Sec-Fetch-Site');
});

test('invalid envelopes and both body size checks reject before the backend', async t => {
  const f = synthetic(t);
  const valid = envelope(open());
  const streamedOverflow = new ReadableStream({ start(controller) {
    const encode = new TextEncoder();
    controller.enqueue(encode.encode(valid));
    controller.enqueue(encode.encode(' '.repeat(4096)));
    controller.close();
  } });
  for (const [label, options] of [
    ['wrong media type', { body: valid, headers: { 'content-type': 'text/plain' } }],
    ['malformed JSON', { body: '{' }],
    ['invalid UTF-8', { body: Uint8Array.of(0xff) }],
    ['wrong envelope type', { body: envelope(open(), { type: 'server-response' }) }],
    ['wrong RPC id', { body: envelope(open(), { rpcId: 'fixture-not-a-uuid' }) }],
    ['wrong RPC method', { body: envelope(open(), { method: 'other-method' }) }],
    ['extra envelope field', { body: envelope(open(), { extra: true }) }],
    ['declared overflow', { body: valid, headers: { 'content-length': '4097' } }],
    ['streamed overflow without Content-Length', { body: streamedOverflow }],
  ]) await httpError(await f.send(open(), options), 400, label);
  untouched(f);
});

test('strict action payloads never reach workspace lookup or native preparation', async t => {
  const f = synthetic(t);
  for (const [label, input] of [
    ['non-object payload', [open()]],
    ['native prompt through the bridge', { action: 'prompt', sessionId: OTHER_NATIVE_ID }],
    ['caller-supplied cwd', { ...open(), cwd: cwdB }],
    ['caller-supplied official id', { ...open(), officialId: 'fixture-private-official' }],
    ['caller-supplied native id', { ...open(), sessionId: OTHER_NATIVE_ID }],
    ['non-UUID workspace', open('arbitrary-workspace')],
    ['oversize workspace id', open(A + '0'.repeat(1024))],
    ['oversize ticket', { ...open(), ticket: B + '0'.repeat(1024) }],
    ['ticket supplied to list', { ...list(), ticket: B }],
    ['non-native session id', { action: 'read', sessionId: A }],
    ['invalid decision nonce', { action: 'answer', sessionId: OTHER_NATIVE_ID, nonce: 'wrong', allow: true }],
    ['non-boolean permission answer', { action: 'answer', sessionId: OTHER_NATIVE_ID, nonce: A, allow: 'true' }],
  ]) await agyError(await f.send(input), 'invalid', label);
  untouched(f);
});

test('witnesses are exact-route, action-specific, one-use and request-scoped', async t => {
  const f = synthetic(t);
  const { sessionId } = await value(await f.send(open()));
  const { authorizePrompt, authorizeCancel } = f.backend.published[0].input;
  const prompt = (id = sessionId) => authorizePrompt({ sessionId: id, text: 'fixture turn' });
  const cancel = (id = sessionId) => authorizeCancel({ sessionId: id, cause: { kind: 'user' } });
  assert.equal(prompt(), false);
  assert.equal(cancel(), false);

  await f.witness(BRIDGE, async () => {
    assert.equal(prompt(), false, 'bridge cannot authorize native Send');
    assert.equal(cancel(), false, 'bridge cannot authorize native Stop');
    await value(await f.deliver(request(status)));
    await httpError(await f.deliver(request(status)), 403, 'bridge witness was consumed');
  });
  for (const [route, authorize, wrongAction] of [[PROMPT, prompt, cancel], [CANCEL, cancel, prompt]]) {
    assert.equal(await f.witness(`${route}/`, authorize), false);
    assert.equal(await f.witness(route, authorize, { peer: ownerPeer('fixture-in-process-owner') }), false);
    await f.witness(route, async () => {
      assert.equal(wrongAction(), false);
      assert.equal(authorize(OTHER_NATIVE_ID), false);
      assert.equal(authorize(), true);
      await Promise.resolve();
      assert.equal(authorize(), false, 'the same request can authorize only one native call');
    });

    const later = Promise.withResolvers();
    let detached;
    await f.witness(route, () => { detached = later.promise.then(() => authorize()); });
    later.resolve();
    assert.equal(await detached, false, 'a detached callback cannot use an unconsumed witness after the request');
    assert.equal(authorize(), false, 'an unwrapped RPC cannot inherit authorization');
  }
});

test('history tickets are opaque and scoped to the current list and verified workspace', async t => {
  const officialId = 'fixture-private-official-a';
  const f = synthetic(t, { list: cwd => [
    { id: officialId, cwd, title: 'Saved thread' },
    { id: 'fixture-private-official-b', cwd: cwdB, title: 'Different workspace' },
  ] });
  async function ticket() {
    const { threads } = await value(await f.send(list()));
    assert.equal(threads.length, 1);
    assert.match(threads[0].ticket, UUID);
    assert.deepEqual(threads, [{ ticket: threads[0].ticket, title: 'Saved thread' }]);
    return threads[0].ticket;
  }
  const old = await ticket();
  assert.deepEqual(f.backend.closed, [cwdA], 'listing closes its unpublished process');
  await agyError(await f.send({ ...open(), ticket: uuid(99) }), 'invalid', 'forged ticket');
  await agyError(await f.send({ ...open(B), ticket: old }), 'invalid', 'different workspace');
  f.paths.set(A, cwdB);
  await agyError(await f.send({ ...open(), ticket: old }), 'invalid', 'workspace id now resolves to a different path');
  f.paths.set(A, cwdA);
  assert.deepEqual(f.backend.made, [cwdA], 'invalid tickets never open a process');

  const newest = await ticket();
  assert.notEqual(newest, old);
  await agyError(await f.send({ ...open(), ticket: old }), 'invalid', 'superseded by a new list');
  assert.deepEqual(f.backend.made, [cwdA, cwdA]);
  const { sessionId } = await value(await f.send({ ...open(), ticket: newest }));
  assert.match(sessionId, /^agy-native-/);
  assert.deepEqual(f.backend.opened, [officialId]);
});

test('workspace switch rechecks whether the previous session started a turn during validation', { timeout: 5000 }, async t => {
  const validating = Promise.withResolvers(), validated = Promise.withResolvers();
  const started = Promise.withResolvers(), terminal = Promise.withResolvers();
  const f = synthetic(t, {
    verifyWorkspace(id) {
      if (id === A) return cwdA;
      assert.equal(id, B);
      validating.resolve();
      return validated.promise;
    },
    runTurn(text) { started.resolve(text); return terminal.promise; },
  });
  const { sessionId } = await value(await f.send(open()));
  const { agent, input } = f.backend.published[0];
  const switching = f.send(open(B));
  let running;
  try {
    await Promise.race([validating.promise, switching.then(() => assert.fail('switch finished before workspace validation'))]);
    assert.equal(agent.status, 'idle');
    running = f.witness(PROMPT, async () => {
      const text = 'a legitimate native user turn';
      assert.equal(input.authorizePrompt({ sessionId, text }), true);
      agent.status = 'running';
      try { return await input.runTurn(text, { signal: new AbortController().signal, onDelta() {} }); }
      finally { agent.status = 'idle'; }
    });
    assert.equal(await Promise.race([started.promise, running.then(() => assert.fail('turn finished before the terminal reply'))]),
      'a legitimate native user turn');
    validated.resolve(cwdB);
    await agyError(await switching, 'busy');
    assert.equal(agent.status, 'running');
    assert.deepEqual(f.backend.retired, []);
    assert.deepEqual(f.backend.closed, []);
    assert.deepEqual(f.backend.made, [cwdA]);
    assert.equal((await value(await f.send({ action: 'read', sessionId }))).available, true);
  } finally {
    validated.resolve(cwdB);
    terminal.resolve({ status: 'completed' });
    await Promise.allSettled([switching, running]);
  }
  assert.deepEqual(await running, { status: 'completed' });
});

for (const first of ['list', 'open']) {
  test(`unconfirmed cleanup of an unpublished ${first} locks out later process creation`, async t => {
    const attempted = [];
    const f = synthetic(t, {
      list(cwd) {
        attempted.push('list');
        return [{ id: 'fixture-private-official', cwd, title: 'Saved thread' }];
      },
      open() { attempted.push('open'); },
      publish() {
        attempted.push('publish');
        throw new Error('fixture-private-publication-diagnostic');
      },
      close() { throw new Error('fixture-private-cleanup-diagnostic'); },
    });
    await agyError(await f.send({ action: first, workspaceId: A }), 'cleanup-unconfirmed');
    assert.deepEqual(attempted, first === 'list' ? ['list'] : ['open', 'publish']);
    assert.deepEqual(f.backend.published, []);
    assert.deepEqual(f.backend.closed, [cwdA]);
    assert.deepEqual(await value(await f.send(status)), { available: false, reason: 'cleanup-unconfirmed' });
    await agyError(await f.send(open()), 'cleanup-unconfirmed');
    await agyError(await f.send(open(B)), 'cleanup-unconfirmed');
    await agyError(await f.send(list(B)), 'cleanup-unconfirmed');
    assert.deepEqual(f.backend.verified, [A]);
    assert.deepEqual(f.backend.made, [cwdA]);
  });
}

test('a readiness check already in flight cannot outrun a failed reap', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers(), resume = Promise.withResolvers();
  let validations = 0;
  const f = synthetic(t, {
    verify() {
      if (++validations === 1) {
        started.resolve();
        return resume.promise;
      }
    },
    close() { throw new Error('synthetic close not confirmed'); },
  });
  const opening = f.send(open(B));
  try {
    await Promise.race([started.promise, opening.then(() => assert.fail('open did not wait for readiness'))]);
    await agyError(await f.send(list()), 'cleanup-unconfirmed');
  } finally { resume.resolve(); }
  await agyError(await opening, 'cleanup-unconfirmed');
  assert.deepEqual(f.backend.made, [cwdA]);
  assert.deepEqual(f.backend.verified, [A]);
  assert.deepEqual(f.backend.published, []);
});

test('explicit Close and host disposal retire the owned sessions and remove the witness', async t => {
  const f = synthetic(t);
  const { sessionId: first } = await value(await f.send(open()));
  await agyError(await f.send({ action: 'close', sessionId: OTHER_NATIVE_ID }), 'unavailable');
  assert.deepEqual(f.backend.retired, []);
  assert.deepEqual(await value(await f.send({ action: 'close', sessionId: first })), { accepted: true });
  await agyError(await f.send({ action: 'read', sessionId: first }), 'unavailable');
  assert.deepEqual(f.backend.retired, [first]);
  assert.deepEqual(f.backend.closed, [cwdA]);

  const { sessionId: second } = await value(await f.send(open(B)));
  await f.dispose();
  assert.deepEqual(f.backend.retired, [first, second]);
  assert.deepEqual(f.backend.closed, [cwdA, cwdB]);
  assert.equal(f.calls.unsubscribe, 1);
  await httpError(await f.send(open()), 403, 'a stale bridge handler cannot run after disposal');
  await f.witness(PROMPT, () => assert.equal(f.backend.published[1].input.authorizePrompt({ sessionId: second }), false));
  assert.deepEqual(f.backend.made, [cwdA, cwdB]);
});

test('status bounds workspace metadata and exposes only ids and display titles', async t => {
  const tooLong = '标题'.repeat(100) + 'fixture-private-title-tail';
  const f = synthetic(t, { workspaces: [
    { id: A, path: cwdA, title: tooLong, extra: 'fixture-private-metadata' },
    { id: B, path: cwdB, title: { value: 'fixture-private-non-string-title' } },
    { id: 'fixture-private-invalid-id', path: cwdA },
    { id: uuid(8), path: 'fixture-private-relative-path' },
    ...Array.from({ length: 42 }, (_, i) => ({ id: uuid(100 + i), path: cwdA, title: `Workspace ${i}` })),
  ] });
  const result = await value(await f.send(status));
  assert.equal(result.available, true);
  assert.ok(result.workspaces.length <= 40);
  assert.deepEqual(result.workspaces.slice(0, 2), [{ id: A, title: tooLong.slice(0, 160) }, { id: B, title: 'Workspace' }]);
  assert.ok(result.workspaces.every(row => UUID.test(row.id) && row.id !== uuid(8)
    && row.title.length <= 160 && Object.keys(row).sort().join(',') === 'id,title'));
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
  assert.deepEqual(f.backend.made, []);
});

test('backend failures return only safe public codes and a generic message', async t => {
  const secret = 'fixture-private-backend-diagnostic';
  let failure;
  const f = synthetic(t, { open() { throw failure; } });
  for (const [error, code] of [
    [Object.assign(new Error(secret), { code: AgyAcpErrorCode.AUTH_REQUIRED }), 'auth-required'],
    [new AgySessionError('history-unavailable'), 'history-unavailable'],
    [Object.assign(new Error(secret), { code: 'history-unavailable' }), 'unavailable'],
    [new AgySessionError(secret), 'unavailable'],
  ]) {
    failure = Object.assign(error, { message: secret, details: { cwd: cwdA, stderr: secret } });
    await agyError(await f.send(open()), code);
  }
  assert.deepEqual(f.backend.published, []);
  assert.equal(f.backend.closed.length, 4);
});
