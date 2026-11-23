import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AGY_API, AGY_METHOD } from '../lib/agy-ingress.js';
import { apply } from '../lib/agy-local-plugin.js';
import { agyMcpTools } from '../lib/agy-local-mcp.js';

test('Remote bridge only exposes tools in the current session tool set', () => {
  const agent = {}, toolSet = {};
  const knowledge = { name: 'mcp__knowledge__knowledge_search' };
  const remote = { name: 'remote_workspaces' };
  let available = [knowledge];
  const ctx = { tools: { definitions(current, resolved) {
    assert.equal(current, agent);
    assert.equal(resolved, toolSet);
    return available;
  }, executable(name, current, resolved) {
    assert.equal(current, agent);
    assert.equal(resolved, toolSet);
    return available.find(tool => tool.name === name && !tool.disabled);
  } } };
  assert.equal(agyMcpTools(ctx, agent, toolSet, ['remote']).size, 0);
  const custom = { name: 'mcp__my-server__read' };
  available = [knowledge, remote, custom, { name: 'pwsh' }];
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet).keys()], [knowledge.name, remote.name, custom.name]);
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet, ['my-server']).keys()], [custom.name]);
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet, ['remote'])], [[remote.name, remote]]);
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet, ['knowledge'])], [[knowledge.name, knowledge]]);
  assert.equal(agyMcpTools(ctx, agent, toolSet, []).size, 0);

  // Subscription media/search tools (image_generate + read_image for references, video_generate, x_search)
  const imageGen = { name: 'image_generate' }, readImg = { name: 'read_image' }, videoGen = { name: 'video_generate' }, xSearch = { name: 'x_search' };
  available = [knowledge, readImg, videoGen, xSearch, { name: 'pwsh' }];
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet).keys()], [knowledge.name, videoGen.name, xSearch.name]);
  available = [knowledge, imageGen, readImg, videoGen, xSearch, { name: 'pwsh' }];
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet).keys()], [knowledge.name, imageGen.name, readImg.name, videoGen.name, xSearch.name]);
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet, ['*']).keys()], [knowledge.name, imageGen.name, readImg.name, videoGen.name, xSearch.name]);
  assert.equal(agyMcpTools(ctx, agent, toolSet, []).size, 0);
});

test('quota RPC queries only for a live exact loopback browser witness', async () => {
  const browserPeer = { id: 'browser', principal: { kind: 'owner' }, signal: new AbortController().signal };
  let route, ingress, fail = false;
  const queries = [];
  const quota = { windows: [{ group: 'Gemini', label: 'Weekly', remainingPercent: 63, resetAt: '2026-11-28T15:02:14Z' }],
    credits: { remaining: 0 }, fetchedAt: '2026-11-22T00:00:00Z' };
  const ctx = {
    webServer: { host: '127.0.0.1' },
    connection: {
      browserPeer, allowsRemoteAuthorities: false,
      admit: req => ({ peer: req.peer }),
      fetch: { register(value) { route = value; } },
    },
    llm: { registerAdapter: () => () => {} },
    effect: fn => fn(),
    on(event, handler) { if (event === 'connection/request') ingress = handler; return () => {}; },
  };
  apply(ctx, {}, () => ({
    open: () => assert.fail('quota must not open ACP'),
    async fetchQuota(signal) {
      queries.push(signal);
      if (fail) throw new Error('private query details');
      return quota;
    },
  }));
  assert.equal(route.path, AGY_API);
  const rpcId = randomUUID();
  const request = ({ peer = browserPeer, address = '127.0.0.1', site = 'same-origin', witness = true,
    signal, payload = { action: 'quota' } } = {}) => {
    const headers = { 'content-type': 'application/json', 'sec-fetch-site': site };
    const raw = { method: 'POST', url: AGY_API, socket: { remoteAddress: address }, headers, peer };
    const call = () => route.fetch(new Request(`http://127.0.0.1${AGY_API}`, {
      method: 'POST', headers, signal, body: JSON.stringify({ type: 'client-request', rpcId, method: AGY_METHOD, payload }),
    }));
    return witness ? ingress(raw, null, call) : call();
  };
  assert.equal((await request({ peer: { ...browserPeer } })).status, 403, 'same ID is not the same peer');
  assert.equal((await request({ address: '10.1.1.1' })).status, 403);
  assert.equal((await request({ site: 'cross-site' })).status, 403);
  assert.equal((await request({ witness: false })).status, 403);
  assert.equal((await request({ signal: AbortSignal.abort() })).status, 403);
  ctx.connection.allowsRemoteAuthorities = true;
  assert.equal((await request()).status, 403);
  ctx.connection.allowsRemoteAuthorities = false;
  assert.equal((await request({ payload: { action: 'quota', executable: 'not-allowed' } })).status, 400);
  assert.equal((await request({ payload: { action: 'open-terminal' } })).status, 400);
  assert.equal(queries.length, 0);

  const ok = await request();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { type: 'server-response', rpcId, result: { ok: true, value: quota } });
  assert.equal(queries.length, 1);
  assert.ok(queries[0] instanceof AbortSignal);

  fail = true;
  const reply = await (await request()).json();
  assert.equal(reply.rpcId, rpcId);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, 'AGY_QUOTA_FAILED');
  assert.doesNotMatch(JSON.stringify(reply), /private query details/);
});
