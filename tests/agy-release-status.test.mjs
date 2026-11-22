import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../src/agy-release-status.js';
import { AGY_API, AGY_METHOD } from '../src/agy-ingress.js';

const rpcId = '00000000-0000-4000-8000-000000000001';
const controller = new AbortController();
const owner = { id: 'fixture-browser', signal: controller.signal, principal: { kind: 'owner' } };
const raw = payload => JSON.stringify({ type: 'client-request', method: AGY_METHOD, rpcId, payload });
const makeRequest = (body = raw({ action: 'status' }), headers = {}) => new Request(`http://127.0.0.1:1${AGY_API}`, {
  method: 'POST', body, headers: { 'content-type': 'application/json', ...headers }, duplex: 'half',
});

function fixture(t) {
  let route, middleware, cleanup;
  const reads = [];
  const services = new Map();
  const admitted = new WeakMap();
  const ctx = {
    webServer: { host: '127.0.0.1' },
    connection: {
      allowsRemoteAuthorities: false, browserPeer: owner,
      admit(req) { return { peer: admitted.get(req) }; },
      fetch: { register(spec) {
        assert.deepEqual([spec.path, spec.methods, spec.requestBody], [AGY_API, ['POST'], 'streaming']);
        assert.equal(route, undefined);
        route = spec;
      } },
    },
    get(name) {
      assert.ok(['agentLoop', 'sessionController'].includes(name), `unexpected service read: ${name}`);
      reads.push(name);
      return services.get(name);
    },
    on(name, handler) {
      assert.equal(name, 'connection/request');
      assert.equal(middleware, undefined);
      middleware = handler;
      return () => { middleware = undefined; };
    },
    effect(register) { cleanup = register(); },
  };
  apply(ctx, { autoEnable: true, launch: () => assert.fail('the status plugin cannot launch agy') });
  const close = () => cleanup?.();
  t.after(close);
  function witness(send, { peer = owner, method = 'POST', url = AGY_API, socket = '127.0.0.1', site } = {}) {
    const req = { method, url, socket: { remoteAddress: socket }, headers: site === undefined ? {} : { 'sec-fetch-site': site } };
    if (peer !== null) admitted.set(req, peer);
    return middleware ? middleware(req, {}, send) : send();
  }
  const deliver = request => route.fetch(request ?? makeRequest());
  return { ctx, services, reads, witness, deliver, close, call: (request, meta) => witness(() => deliver(request), meta) };
}

async function status(response, reason) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId, result: { ok: true, value: { available: false, reason } } });
}

const neverRegister = () => assert.fail('compatibility checks may not register a turn or provider');

test('the shipped status keeps agy off if either interface is missing or the build has not been verified', async t => {
  const f = fixture(t);
  assert.deepEqual(f.reads, []);
  await status(await f.call(), 'native-turn-required');
  f.services.set('sessionController', { registerTurnProvider: neverRegister });
  await status(await f.call(), 'native-turn-required');
  f.services.delete('sessionController');
  f.services.set('agentLoop', { registerTurnExecutor: neverRegister });
  await status(await f.call(), 'native-turn-required');
  f.services.set('sessionController', { registerTurnProvider: neverRegister });
  await status(await f.call(), 'integration-unavailable');
});

test('status requires a single authenticated browser ingress even with Desktop headers omitted', async t => {
  const f = fixture(t);
  for (const meta of [
    { peer: null }, { peer: { ...owner } }, { peer: { ...owner, id: 'local-api' } },
    { socket: '192.0.2.1' }, { site: 'cross-site' }, { url: `${AGY_API}?source=fixture` }, { method: 'GET' },
  ]) assert.equal((await f.call(undefined, meta)).status, 403);
  assert.equal((await f.deliver()).status, 403, 'a direct Fetch call grants no authority');
  f.ctx.connection.allowsRemoteAuthorities = true;
  assert.equal((await f.call()).status, 403);
  f.ctx.connection.allowsRemoteAuthorities = false;
  assert.deepEqual(f.reads, []);
  await f.witness(async () => {
    await status(await f.deliver(), 'native-turn-required');
    assert.equal((await f.deliver()).status, 403);
  });
  await status(await f.call(undefined, { socket: '::ffff:127.0.0.1' }), 'native-turn-required');
  f.close();
  assert.equal((await f.call()).status, 403);
});

test('malformed requests and every non-status action fail before reading a service', async t => {
  const f = fixture(t);
  const actions = ['inspect', 'login', 'cancel', 'open', 'list', 'prompt', 'answer', 'close'];
  for (const action of actions) assert.equal((await f.call(makeRequest(raw({ action })))).status, 400, action);
  for (const body of [raw({ action: 'status', path: 'private-fixture-path' }), raw([]), raw(null), '{', raw({ action: 'status' }) + ' '.repeat(4096)]) {
    const response = await f.call(makeRequest(body));
    assert.equal(response.status, 400);
    assert.equal(await response.text(), '');
  }
  assert.equal((await f.call(makeRequest(undefined, { 'content-type': 'text/plain' }))).status, 400);
  assert.equal((await f.call(new Request(`http://127.0.0.1:1${AGY_API}`, { method: 'POST' }))).status, 400);
  assert.deepEqual(f.reads, []);
});
