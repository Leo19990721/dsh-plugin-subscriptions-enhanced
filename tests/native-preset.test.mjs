import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as connection from '@deepseek-ai/dsh-client-connection/client';
import * as api from '@deepseek-ai/dsh-api-gateway/client';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import presets from '@deepseek-ai/dsh-agent-preset-registry/remote';

// Current-profile integration, using only synthetic Hosts and an isolated Cordis
// tree. The other project's code is imported read-only; no network or live state.
const remoteProject = join(process.env.DSH_PROFILE_DIR, 'node_modules/@local/dsh-unified-sessions');
let remoteRoot;
try { remoteRoot = await realpath(remoteProject); } catch { /* optional profile integration */ }

test('manual native preset selection and plugin RPC coexist across local and remote Hosts', { skip: !remoteRoot && 'Remote workspace plugin is not installed' }, async () => {
  const { FederatedGateway } = await import(pathToFileURL(join(remoteRoot, 'federated-gateway.js')).href);
  const { installSessionCarrier } = await import(pathToFileURL(join(remoteRoot, 'client-carrier.js')).href);
  const descriptor = presets.descriptors.find(row => row.namespace === 'agentPresets' && row.method === 'select');
  assert.ok(descriptor, 'use the installed DSH method descriptor');
  const calls = [], pluginCalls = [];
  const raw = hostId => ({ call: async (endpoint, payload) => {
    calls.push({ hostId, endpoint, payload });
    assert.equal(endpoint, 'agentPresets/select');
    assert.equal(payload.args.agentPreset, 'minimal');
    return { ok: true, value: 'minimal' };
  } });
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const gateway = new FederatedGateway({
    local: () => raw('local'), baseHost: 'local',
    hosts: async () => [{ hostId: 'synthetic-remote', name: 'Synthetic Host', online: true }],
    channels: { retain: async id => ({ ...raw(id), release: async () => {} }) },
    descriptor: endpoint => endpoint === 'agentPresets/select' ? descriptor : undefined,
  });
  const originalRpc = { call: async (channel, endpoint, payload, signal) => {
    if (channel === '/api') {
      if (endpoint === 'subscriptions-auth.status') {
        pluginCalls.push({ endpoint, payload });
        return { ok: true, value: { providers: {} } };
      }
      return raw('local').call(endpoint, payload);
    }
    assert.equal(channel, '/dsh-session-hosts');
    if (endpoint === 'attach') return { ok: true, value: { viewId: 'synthetic-view', baseHost: 'local' } };
    if (endpoint === 'call') {
      // This is the exact rejection that produced ENDPOINT_REQUIRED before.
      assert.match(payload.endpoint, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_$.-]+$/);
      return gateway.call(payload.endpoint, payload.payload, signal, peer);
    }
    return { ok: true };
  } };
  const ctx = new Context();
  let carrier, consumer;
  const setup = ctx.plugin({ apply(scope) {
    connection.installConnection(scope, { interactions: 'none', transport: { rpc: originalRpc } });
    new TypertRegistry(scope);
  } });
  await setup.inertia;
  const gatewayFiber = ctx.plugin(api);
  try {
    await gatewayFiber.inertia;
    assert.equal(gatewayFiber.state, 2, 'native Client Gateway is active');
    await ctx.get('remote').$mount(presets);
    carrier = await installSessionCarrier(ctx);

    let select;
    consumer = ctx.plugin({ inject: ['remote', 'remote.agentPresets'], apply(scope) {
      select = id => scope.remote.agentPresets.select(id, 'minimal');
    } });
    await consumer.inertia;
    assert.equal(typeof select, 'function');
    assert.equal(calls.length, 0, 'registration never auto-selects any mode');
    const remoteId = gateway.identities.encode('synthetic-remote', 'session', 'remote-session');
    for (const id of ['local-session', remoteId]) {
      const result = await select(id);
      assert.equal(result.ok, true);
      assert.equal(result.value, 'minimal');
    }
    assert.deepEqual(calls.map(row => [row.hostId, row.endpoint, row.payload.args.agentId]), [
      ['local', 'agentPresets/select', 'local-session'],
      ['synthetic-remote', 'agentPresets/select', 'remote-session'],
    ]);
    // A mounted native namespace must not swallow unrelated plugin requests on
    // the same real Cordis Connection; both paths must work in one Client.
    const pluginResult = await ctx.get('connection').rpc.call('/api', 'subscriptions-auth.status', {});
    assert.equal(pluginResult.ok, true);
    assert.deepEqual(pluginCalls, [{ endpoint: 'subscriptions-auth.status', payload: {} }]);
    assert.equal(calls.length, 2, 'plugin status never entered either native Host');
  } finally {
    await consumer?.dispose();
    await carrier?.dispose();
    await gatewayFiber.dispose();
    await setup.dispose();
  }
});
