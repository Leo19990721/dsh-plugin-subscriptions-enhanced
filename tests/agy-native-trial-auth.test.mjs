import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createTrialAuthentication, trialAuthRoute } from '../scripts/agy-native-trial.auth.mjs';

const method = 'oauth-personal';
const privateDetail = 'SYNTHETIC_PRIVATE_DETAIL';
const offered = { authMethods: [{ id: 'another-method' }, { id: method, description: privateDetail }] };
const problem = code => Object.assign(new Error(privateDetail), { code, data: privateDetail });
const signedOut = canLogin => ({ status: 'signed-out', canLogin });
const errorView = (error, canLogin) => ({ status: 'error', canLogin, error });
const probe = ['make', 'initialize', 'close'];
const signing = ['make', 'initialize', ['authenticate', method]];

// Only these in-memory clients exist. Record attempts before running the hook so a caught
// exception cannot hide an unexpected action. nextTurn drains their already-settled promises.
function fixture(plans, onConnect) {
  const calls = [], settings = [];
  let index = 0;
  const auth = createTrialAuthentication({
    makeClient(options) {
      calls.push('make');
      settings.push(options);
      const plan = plans[index++];
      assert.ok(plan, 'unexpected client creation');
      return {
        start() { calls.push('initialize'); return plan.start ? plan.start() : offered; },
        authenticate(...args) { calls.push(['authenticate', ...args]); return plan.authenticate?.(); },
        close() { calls.push('close'); return plan.close?.(); },
        request(name) { calls.push(['request', name]); },
        notify(name) { calls.push(['notify', name]); },
        logout() { calls.push('logout'); },
      };
    },
    connect(signal) { calls.push('connect'); return onConnect?.(signal); },
  });
  return { auth, calls, settings };
}

test('inspect only initializes and closes one probe; polling, idle cancel and an early login do nothing', async () => {
  const initializing = Promise.withResolvers();
  const { auth, calls } = fixture([{ start: () => initializing.promise }]);
  assert.deepEqual(auth.snapshot(), signedOut(false));
  assert.deepEqual(auth.login(), signedOut(false));
  assert.deepEqual(await auth.cancel(), signedOut(false));
  assert.deepEqual(calls, []);

  const first = auth.inspect();
  const duplicate = auth.inspect();
  await nextTurn();
  assert.deepEqual(auth.login(), signedOut(false));
  assert.deepEqual(calls, ['make', 'initialize']);
  initializing.resolve(offered);
  assert.deepEqual(await first, signedOut(true));
  await duplicate;
  assert.deepEqual(auth.snapshot(), signedOut(true));
  assert.deepEqual(await auth.cancel(), signedOut(true));
  await auth.dispose();
  assert.deepEqual(calls, probe);
});

test('oauth-personal must be advertised exactly once on the current client, including after a successful probe', async () => {
  for (const [label, result] of [
    ['absent', {}], ['another method', { authMethods: [{ id: 'other' }] }],
    ['wrong case', { authMethods: [{ id: 'OAuth-Personal' }] }],
    ['duplicate', { authMethods: [{ id: method }, { id: method }] }],
  ]) {
    for (const afterProbe of [false, true]) {
      const denied = { start: () => result };
      const { auth, calls } = fixture(afterProbe ? [{}, denied] : [denied]);
      await auth.inspect();
      if (afterProbe) { auth.login(); await nextTurn(); }
      const reason = `${label} on ${afterProbe ? 'login' : 'inspection'}`;
      assert.deepEqual(auth.snapshot(), errorView('auth-unavailable', false), reason);
      assert.deepEqual(auth.login(), auth.snapshot(), reason);
      await nextTurn();
      await auth.dispose();
      assert.deepEqual(calls, afterProbe ? [...probe, ...probe] : probe, reason);
    }
  }
});

test('explicit login waits for authentication, confirmed close and catalog connection, ignoring duplicate starts', async () => {
  const approval = Promise.withResolvers(), closed = Promise.withResolvers(), catalog = Promise.withResolvers();
  let connectionSignal;
  const { auth, calls, settings } = fixture([{}, { authenticate: () => approval.promise, close: () => closed.promise }], signal => {
    connectionSignal = signal;
    return catalog.promise;
  });
  await auth.inspect();
  const pending = auth.login();
  assert.equal(pending.status, 'signing-in');
  assert.deepEqual(auth.login(), pending);
  await nextTurn();
  assert.deepEqual(calls, [...probe, ...signing]);
  assert.deepEqual(settings, [{ allowAuthentication: false }, { allowAuthentication: true }]);
  assert.deepEqual(auth.snapshot(), pending);
  approval.resolve({ ignored: privateDetail });
  await nextTurn();
  assert.deepEqual(calls, [...probe, ...signing, 'close']);
  assert.deepEqual(auth.login(), pending);
  closed.resolve();
  await nextTurn();
  const expected = [...probe, ...signing, 'close', 'connect'];
  assert.deepEqual(calls, expected);
  assert.equal(connectionSignal.aborted, false);
  assert.deepEqual(auth.snapshot(), pending, 'catalog is still connecting');
  catalog.resolve({ ignored: privateDetail });
  await nextTurn();
  const connected = auth.snapshot();
  assert.equal(connected.status, 'connected');
  assert.deepEqual(Object.keys(connected).sort(), ['canLogin', 'status']);
  assert.deepEqual(auth.login(), connected);
  assert.deepEqual(await auth.cancel(), connected);
  await auth.dispose();
  assert.deepEqual(calls, expected);
});

test('failures expose only allowlisted codes; only an explicit retry starts a fresh login', async () => {
  for (const [stage, code, expected] of [
    ['authenticate', 'TIMEOUT', 'TIMEOUT'], ['authenticate', privateDetail, 'unavailable'],
    ['connect', 'catalog-unavailable', 'catalog-unavailable'],
  ]) {
    const fail = () => { throw problem(code); };
    let attempts = 0;
    const { auth, calls } = fixture([{}, stage === 'authenticate' ? { authenticate: fail } : {}, {}], () => {
      if (++attempts === 1 && stage === 'connect') fail();
    });
    await auth.inspect();
    auth.login();
    await nextTurn();
    const failed = [...probe, ...signing, 'close', ...(stage === 'connect' ? ['connect'] : [])];
    assert.deepEqual(auth.snapshot(), errorView(expected, true));
    assert.deepEqual(await auth.cancel(), errorView(expected, true));
    assert.deepEqual(calls, failed);
    assert.equal(Object.hasOwn(auth.login(), 'error'), false, 'a new explicit attempt clears the old error');
    await nextTurn();
    assert.equal(auth.snapshot().status, 'connected');
    await auth.dispose();
    assert.deepEqual(calls, [...failed, ...signing, 'close', 'connect']);
  }
});

test('cancel closes the active login, ignores a late authentication success and permits an explicit retry', async () => {
  const approval = Promise.withResolvers();
  const { auth, calls } = fixture([{}, { authenticate: () => approval.promise }, {}]);
  await auth.inspect();
  auth.login();
  await nextTurn();
  const cancelling = auth.cancel();
  await nextTurn();
  assert.deepEqual(calls, [...probe, ...signing, 'close']);
  approval.resolve();
  assert.deepEqual(await cancelling, signedOut(true));
  assert.ok(!calls.includes('connect'));
  const beforeRetry = [...calls];
  assert.deepEqual(await auth.cancel(), signedOut(true));
  assert.deepEqual(calls, beforeRetry);
  auth.login();
  await nextTurn();
  assert.equal(auth.snapshot().status, 'connected');
  await auth.dispose();
  assert.deepEqual(calls.slice(beforeRetry.length), [...signing, 'close', 'connect']);
});

test('cancel aborts the catalog connection, suppresses late success, but preserves an unconfirmed cleanup', async () => {
  for (const clean of [true, false]) {
    const catalog = Promise.withResolvers();
    let signal;
    const { auth, calls } = fixture([{}, {}], incoming => { signal = incoming; return catalog.promise; });
    await auth.inspect();
    auth.login();
    await nextTurn();
    assert.equal(signal.aborted, false);
    const cancelling = auth.cancel();
    assert.equal(signal.aborted, true);
    if (clean) {
      catalog.resolve();
      assert.deepEqual(await cancelling, signedOut(true));
      await auth.dispose();
    } else {
      catalog.reject(problem('cleanup-unconfirmed'));
      assert.deepEqual(await cancelling, errorView('cleanup-unconfirmed', false));
      assert.deepEqual(auth.login(), auth.snapshot());
      await assert.rejects(auth.dispose(), { code: 'cleanup-unconfirmed' });
    }
    assert.deepEqual(calls, [...probe, ...signing, 'close', 'connect']);
  }
});

test('dispose reaps a client acquired after shutdown started; no later action can create another', async () => {
  const acquisition = Promise.withResolvers();
  const calls = [];
  const auth = createTrialAuthentication({
    makeClient() { calls.push('make'); return acquisition.promise; }, connect() { calls.push('connect'); },
  });
  const inspection = auth.inspect();
  let finished = false;
  const disposal = auth.dispose().then(() => { finished = true; });
  await nextTurn();
  assert.equal(finished, false);
  acquisition.resolve({ start() { calls.push('initialize'); return offered; }, close() { calls.push('close'); } });
  await Promise.all([inspection, disposal]);
  assert.deepEqual(auth.snapshot(), signedOut(false));
  await auth.inspect();
  auth.login();
  await auth.cancel();
  await auth.dispose();
  assert.deepEqual(calls, ['make', 'close']);
});

test('an unconfirmed close disables further work and dispose reports only the local cleanup code', async () => {
  for (const stage of ['inspect', 'login', 'catalog']) {
    const badClose = { close() { throw problem(privateDetail); } };
    const { auth, calls } = fixture(stage === 'inspect' ? [badClose] : [{}, stage === 'login' ? badClose : {}], () => {
      if (stage === 'catalog') throw problem('cleanup-unconfirmed');
    });
    await auth.inspect();
    if (stage !== 'inspect') { auth.login(); await nextTurn(); }
    const failed = errorView('cleanup-unconfirmed', false);
    assert.deepEqual(auth.snapshot(), failed, stage);
    assert.equal(calls.includes('connect'), stage === 'catalog', stage);
    const beforeRetry = [...calls];
    assert.deepEqual(auth.login(), failed);
    assert.deepEqual(await auth.cancel(), failed);
    assert.deepEqual(await auth.inspect(), failed);
    assert.deepEqual(calls, beforeRetry, stage);
    await assert.rejects(auth.dispose(), error => {
      assert.equal(error.code, 'cleanup-unconfirmed');
      assert.ok(!`${error.message} ${JSON.stringify(error)}`.includes(privateDetail));
      assert.equal(error.cause, undefined);
      return true;
    });
    if (stage !== 'catalog') assert.ok(calls.slice(beforeRetry.length).includes('close'), 'retry cleanup of the owned client');
  }
});

test('a failed close during cancellation takes precedence over a late authentication result', async () => {
  const approval = Promise.withResolvers();
  const { auth, calls } = fixture([{}, {
    authenticate: () => approval.promise,
    close() { approval.resolve(); throw problem(privateDetail); },
  }]);
  await auth.inspect();
  auth.login();
  await nextTurn();
  assert.deepEqual(await auth.cancel(), errorView('cleanup-unconfirmed', false));
  assert.ok(!calls.includes('connect'));
  await assert.rejects(auth.dispose(), { code: 'cleanup-unconfirmed' });
});

const routePath = '/__agy_trial_auth';
const loginBody = '{"action":"login"}';
const views = { snapshot: errorView('TIMEOUT', true), login: { status: 'signing-in', canLogin: true }, cancel: signedOut(true) };

// IncomingMessage-shaped stream and ServerResponse recorder; never bind a port or contact a browser.
function webFixture(overrides = {}) {
  const calls = [];
  const controller = new AbortController();
  const browserPeer = { id: 'fixture-browser', principal: { kind: 'owner' }, signal: controller.signal };
  const admissions = new WeakMap();
  const ctx = {
    webServer: { host: '127.0.0.1', port: 47431 },
    connection: { browserPeer, allowsRemoteAuthorities: false, admit: req => admissions.get(req) },
  };
  const auth = Object.fromEntries(['snapshot', 'login', 'cancel', 'inspect', 'dispose'].map(name => [name, (...args) => {
    calls.push([name, ...args]);
    if (overrides[name]) return overrides[name]();
    return name === 'cancel' ? Promise.resolve(views[name]) : views[name];
  }]));
  const route = trialAuthRoute(ctx, auth);

  async function send({ method = 'POST', url = routePath, headers = {}, remoteAddress = '127.0.0.1',
    peer = browserPeer, body = loginBody, chunks = [body] } = {}) {
    async function* bytes() {
      for await (const part of chunks) { yield Buffer.from(part); await nextTurn(); }
    }
    const authority = `127.0.0.1:${ctx.webServer.port}`;
    const req = Object.assign(Readable.from(bytes(), { objectMode: false }), {
      method, url, socket: { remoteAddress },
      headers: { host: authority, origin: `http://${authority}`, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', ...headers },
    });
    admissions.set(req, peer === null ? { rejection: 401 } : { peer });
    let code, replyHeaders, text;
    const res = {
      writeHead(status, fields) {
        assert.equal(code, undefined, 'only one HTTP reply');
        code = status;
        replyHeaders = new Headers(fields);
        return this;
      },
      end(data) { assert.equal(text, undefined); text = Buffer.from(data).toString('utf8'); },
    };
    await route.handler(req, res);
    assert.equal(replyHeaders.get('cache-control'), 'no-store');
    assert.equal(replyHeaders.get('x-content-type-options'), 'nosniff');
    assert.match(replyHeaders.get('content-type'), /^application\/json\b/iu);
    return { code, body: JSON.parse(text) };
  }
  return { route, send, calls, ctx, controller, browserPeer };
}

test('the exact same-origin browser route dispatches just the requested action and returns its plain snapshot', async () => {
  const f = webFixture();
  assert.equal(f.route.kind, 'exact');
  assert.equal(f.route.path, routePath);
  f.ctx.webServer.port = 48079; // The bound port may only be known after the route was created.
  for (const [name, options] of [
    ['snapshot', { body: ' \r\n{\t"act\\u0069on" : "st\\u0061tus" }\n' }],
    ['login', { chunks: ['{"act', 'ion":', '"login"}'], headers: { 'content-type': 'application/json; charset=utf-8' } }],
    ['snapshot', { body: '{"action":"status"}' }],
    ['cancel', { body: '{"action":"cancel"}', remoteAddress: '::ffff:127.0.0.1' }],
  ]) {
    const before = f.calls.length;
    assert.deepEqual(await f.send(options), { code: 200, body: views[name] });
    assert.deepEqual(f.calls.slice(before), [[name]]);
  }
});

test('wrong route, method, listener, socket, headers or browser peer never reaches the authentication object', async () => {
  const f = webFixture();
  for (const [label, code, options] of [
    ['query', 404, { url: `${routePath}?view=status` }], ['trailing slash', 404, { url: `${routePath}/` }],
    ['GET', 405, { method: 'GET' }], ['OPTIONS', 405, { method: 'OPTIONS' }],
    ['non-loopback socket', 403, { remoteAddress: '192.0.2.14' }],
    ['missing origin', 403, { headers: { origin: undefined } }],
    ['wrong origin', 403, { headers: { origin: 'https://other.invalid' } }],
    ['missing host', 403, { headers: { host: undefined } }],
    ['wrong host with correct origin', 403, { headers: { host: 'localhost:47431' } }],
    ['matching host and origin on a different port', 403, { headers: { host: '127.0.0.1:47432', origin: 'http://127.0.0.1:47432' } }],
    ...[undefined, 'same-site', 'cross-site', 'none'].map(site => [`fetch site ${site}`, 403, { headers: { 'sec-fetch-site': site } }]),
    ['not admitted', 403, { peer: null }], ['copied browser id and principal', 403, { peer: { ...f.browserPeer } }],
    ['missing content type', 415, { headers: { 'content-type': undefined } }],
    ['text body', 415, { headers: { 'content-type': 'text/plain' } }],
    ['wrong charset', 415, { headers: { 'content-type': 'application/json; charset=utf-16' } }],
  ]) {
    assert.deepEqual(await f.send(options), { code, body: {} }, label);
    assert.deepEqual(f.calls, [], label);
  }
  for (const change of [
    x => { x.ctx.webServer.host = '0.0.0.0'; }, x => { x.ctx.connection.allowsRemoteAuthorities = true; },
    x => { x.browserPeer.principal.kind = 'remote'; }, x => x.controller.abort(),
  ]) {
    const restricted = webFixture();
    change(restricted);
    assert.deepEqual(await restricted.send(), { code: 403, body: {} });
    assert.deepEqual(restricted.calls, []);
  }
});

test('malformed JSON and all shapes except one supported action are rejected without effects', async () => {
  const f = webFixture();
  for (const body of ['', '{', '{}', 'null', '"login"', '[{"action":"login"}]', '{"action":null}',
    '{"action":{}}', '{"action":"logout"}', '{"Action":"login"}', '{"action":"LOGIN"}',
    `{"action":"login","detail":"${privateDetail}"}`, '{"action":"status","action":"login"}',
    '{"action":"login","act\\u0069on":"login"}', '{"action":"login"}{}', Buffer.from([0xc3, 0x28])]) {
    assert.deepEqual(await f.send({ body }), { code: 400, body: {} }, String(body));
    assert.deepEqual(f.calls, []);
  }
});

test('the 128-byte limit checks both declared length and streamed bytes before dispatch', async () => {
  const f = webFixture();
  const full = loginBody.padEnd(128, ' ');
  for (const [label, options] of [
    ['oversized declaration', { headers: { 'content-length': '129' } }],
    ['invalid declaration', { headers: { 'content-length': 'invalid' } }],
    ['oversized stream without declaration', { chunks: [full.slice(0, 63), full.slice(63), ' '] }],
  ]) {
    assert.deepEqual(await f.send(options), { code: 413, body: {} }, label);
    assert.deepEqual(f.calls, [], label);
  }
  assert.deepEqual(await f.send({ chunks: [full.slice(0, 63), full.slice(63)], headers: { 'content-length': '128' } }),
    { code: 200, body: views.login });
  assert.deepEqual(f.calls, [['login']]);
});

test('browser authorization is still required after the streamed request body arrives', async () => {
  for (const revoke of [f => f.controller.abort(), f => { f.ctx.connection.browserPeer = { ...f.browserPeer }; }]) {
    const f = webFixture();
    async function* interrupted() {
      yield '{"action":';
      revoke(f);
      yield '"login"}';
    }
    assert.deepEqual(await f.send({ chunks: interrupted() }), { code: 403, body: {} });
    assert.deepEqual(f.calls, []);
  }
});

test('route errors never return exception messages, arbitrary codes or provider data', async () => {
  const f = webFixture({ cancel: async () => { throw problem(privateDetail); } });
  assert.deepEqual(await f.send({ body: '{"action":"cancel"}' }),
    { code: 503, body: errorView('unavailable', false) });
  assert.deepEqual(f.calls, [['cancel']]);
});
