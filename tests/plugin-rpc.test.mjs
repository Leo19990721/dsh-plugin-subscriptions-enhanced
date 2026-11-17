import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';

let remoteRoot;
try { remoteRoot = await realpath(join(process.env.DSH_PROFILE_DIR, 'node_modules/@local/dsh-unified-sessions')); } catch { /* optional profile integration */ }
const browser = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = browser.indexOf('const SUBSCRIPTIONS_AUTH_CHANNEL =');
const end = browser.indexOf('\n//#endregion', start);
assert.ok(start > 0 && end > start, 'locate the original subscription RPC implementation');
const context = vm.createContext({ failUsage() {}, publishUsage() {}, retainUsageAccounts() {} });
vm.runInContext(browser.slice(start, end) + '\nthis.callAuth = callSubscriptionsAuth;', context);

for (const [method, payload, value] of [
  ['status', {}, { providers: { antigravity: { accounts: [{ key: 'synthetic-account' }] } } }],
  ['usage', { provider: 'antigravity', account: 'synthetic-account' }, { remaining: 72 }],
  ['providerSettings', { provider: 'antigravity' }, { provider: 'antigravity', modelPreferences: [] }],
]) {
  test(`subscription ${method} keeps its original API route with Remote enabled`, { skip: !remoteRoot && 'Remote plugin not installed', timeout: 5000 }, async () => {
    const { installSessionCarrier } = await import(pathToFileURL(join(remoteRoot, 'client-carrier.js')).href);
    const { registerFederatedRoute } = await import(pathToFileURL(join(remoteRoot, 'federated-route.js')).href);
    const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
    let route;
    const disposers = [], received = [];
    registerFederatedRoute({
      connection: { admit: request => request.headers['x-test-owner'] === 'synthetic-owner' ? { peer } : { rejection: 401 } },
      webServer: { register(value) { route = value; return () => {}; } },
      effect(factory) { const result = factory(); if (typeof result === 'function') disposers.push(result); else for (const dispose of result) disposers.push(dispose); },
    }, {
      baseHost: () => 'local', hosts: async () => [], descriptor: () => undefined,
      local: () => ({ call: () => { throw new Error('Plugin requests must not enter native Gateway'); } }),
      channels: { retain: () => { throw new Error('Plugin settings must not reach another Host'); } },
    });
    const endpoint = `subscriptions-auth.${method}`;
    const server = createServer(async (request, response) => {
      try {
        if (request.url === `/api/${endpoint}`) {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          received.push(message);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }));
        } else await route.handler(request, response);
      } catch (error) { response.destroy(error); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/`;
    const send = (url, init) => fetch(new URL(url, base), { ...init, headers: { ...init.headers, 'x-test-owner': 'synthetic-owner' } });
    const rpc = { call: async (channel, method, payload, signal) => {
      const response = await send(channel.slice(1) + '/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId: 'synthetic-rpc', method, payload }),
      });
      return (await response.json()).result;
    } };
    let carrier;
    try {
      carrier = await installSessionCarrier({
        connection: { rpc },
        // No native definitions are mounted for these plugin-owned requests.
        // Match the installed registry interface instead of bypassing routing.
        typert: { remotes: { get: () => undefined, list: () => [] } },
      }, { fetch: send });
      const result = await context.callAuth(rpc, method, payload);
      assert.equal(received.length, 1, 'the request reached the plugin-owned route exactly once');
      assert.equal(received[0].method, endpoint);
      assert.deepEqual(received[0].payload, payload, 'do not add native args or rewrite plugin data');
      for (const key of Object.keys(value)) assert.deepEqual(JSON.parse(JSON.stringify(result[key])), value[key]);
    } finally {
      await carrier?.dispose();
      for (const dispose of disposers.reverse()) await dispose();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
