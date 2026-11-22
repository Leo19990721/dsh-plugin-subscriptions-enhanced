import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply as applyGoogle } from '../lib/agy-local-plugin.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

const GOOGLE = { provider: 'antigravity', model: 'gemini-3-flash' };
const nativeTools = ['list_agents', 'send_message', 'subagent', 'wait_agent'];
const text = value => ({ type: 'text', text: value });
const contentText = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const users = events => events.filter(event => event.type === 'user/message' && event.data.source.kind !== 'runtime-context').map(event => event.data);
const end = (h, id) => h.events(id).findLast(event => event.type === 'turn/end')?.data.reason;
const prompts = h => h.acpCalls.filter(call => call.method === 'session/prompt');

async function fixture(t, { acpPrompt, nativeSubagents, ordinaryStream, ...options }) {
  const opened = new Set(), bindings = new Map();
  const failures = [], started = [], ended = [];
  const h = await createTurnHost(t, {
    ...options, releasedReader: true, desktopRequests: true,
    withWorkingDirectory: true, withCompaction: true, withRetry: true,
    nativeSubagents, ordinaryStream,
    acpPrompt(turn) {
      // Fake ACP only emits protocol notifications from this callback. MCP still
      // crosses the real per-ACP HTTP listener with its in-memory capability.
      Promise.resolve().then(() => acpPrompt?.(turn)).catch(error => {
        failures.push(error);
        turn.error(-32603, 'synthetic ACP test assertion failed');
      });
    },
    async mountSubscription({ scope, root, makeSession }) {
      applyGoogle(scope, { agentsFile: join(root, 'unused-rules.md'), dataDir: join(root, 'agy-data'), mcp: [] }, () => ({
        async open(signal, { cwd, officialId, mcpServers, onPermission } = {}) {
          const session = makeSession({ signal, cwd, mcpServers, onPermission });
          try { await session.open(officialId); }
          catch (error) { await session.close(); throw error; }
          const close = async () => { try { await session.close(); } finally { opened.delete(close); } };
          opened.add(close);
          return { id: session.id, get options() { return session.options; }, get capabilities() { return session.capabilities; },
            prepare: session.prepare, runTurn: session.runTurn, close };
        },
        readBinding: id => bindings.get(id),
        async writeBinding(id, row) { bindings.set(id, row); },
        async dispose() { await Promise.all([...opened].map(close => close())); },
      }));
    },
  });
  h.ctx.on('subagent/start', event => started.push(event), { global: true });
  h.ctx.on('subagent/end', event => ended.push(event), { global: true });
  function checkAcp() { if (failures.length) throw failures[0]; }
  async function settled(root) {
    const agent = h.agent(root);
    do { await agent.whenIdle(); } while (await h.ctx.subagents.waitForTreeWork(agent));
    checkAcp();
  }
  function bridge(turn) {
    const server = turn.mcpServers?.[0];
    assert.ok(server, 'active synthetic ACP received the real DSH bridge');
    assert.equal(new URL(server.url).hostname, '127.0.0.1');
    return async (method, params) => {
      const response = await fetch(server.url, { method: 'POST', signal: t.signal,
        headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
  }
  async function cleanup() {
    await h.dispose();
    assert.equal(opened.size, 0);
    const sessions = h.acpCalls.filter(call => call.method === 'session/close').map(call => call.params.sessionId);
    assert.ok(sessions.length > 1, 'catalog and chat were both closed');
    assert.ok(sessions.every(id => h.acpExits.includes(id)), 'all fake ACP transports were reaped');
  }
  return Object.assign(h, { started, ended, bridge, settled, cleanup });
}

async function call(rpc, name, args = {}) {
  const reply = await rpc('tools/call', { name, arguments: args });
  assert.equal(reply.result?.isError, false, JSON.stringify(reply));
  return contentText(reply.result.content);
}

async function listed(rpc) {
  const { result } = await rpc('tools/list');
  assert.ok(Array.isArray(result?.tools));
  return result.tools.map(tool => tool.name).sort();
}

async function* answer(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: text(value) };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function* nativeCall(name, args) {
  const id = randomUUID(), json = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

test('Gemini calls native subagent tools and receives the child relay and settled notice', { timeout: 12_000 }, async t => {
  const released = Promise.withResolvers();
  let id, childCalled = false, savedBridge, waited = false;
  t.after(() => released.resolve());
  const h = await fixture(t, {
    nativeSubagents: { spawn: { agentOptions: ORDINARY_SELECTION } },
    async *ordinaryStream(request) {
      assert.notEqual(request.sessionId, id, 'no fallback ordinary response for the owner');
      assert.ok(request.messages.some(message => message.role === 'user' && contentText(message.content).includes('native child assignment')));
      if (!childCalled) {
        childCalled = true;
        await released.promise;
        yield* nativeCall('send_message', { agent: 'lead', message: 'ordinary child relay' });
      } else yield* answer('ordinary child closing output');
    },
    async acpPrompt(turn) {
      const input = contentText(turn.params.prompt);
      if (!savedBridge) {
        assert.match(input, /Gemini owner request/);
        const rpc = savedBridge = h.bridge(turn);
        assert.deepEqual(await listed(rpc), nativeTools);
        const unavailable = await rpc('tools/call', { name: 'interrupt_agent', arguments: { agent: 'lead' } });
        assert.equal(unavailable.error?.code, -32602);
        assert.match(await call(rpc, 'list_agents'), /lead/);
        assert.match(await call(rpc, 'subagent', { name: 'worker', description: 'Run native fixture', prompt: 'native child assignment' }), /started subagent worker/);
        assert.match(await call(rpc, 'list_agents'), /worker/);
        const wait = call(rpc, 'wait_agent', { timeout_ms: 10_000 });
        released.resolve();
        assert.deepEqual(JSON.parse(await wait), { timedOut: false });
        waited = true;
        turn.update('Gemini dispatched native worker');
        turn.reply();
      } else {
        turn.update('Gemini received native response');
        turn.reply();
      }
    },
  });
  id = await h.create();
  ok(await h.select(id, GOOGLE));
  const requestId = randomUUID();
  ok(await h.prompt(id, 'Gemini owner request', { requestId }));
  try { await h.settled(id); }
  finally { released.resolve(); }
  assert.equal(waited, true, 'native wait wakes on agent relay without cancelling the active ACP step');
  assert.equal(h.acpCalls.filter(call => call.method === 'session/cancel').length, 0);
  assert.equal(h.started.length, 1);
  const [child] = h.started;
  assert.equal(child.parentSessionId, id);
  assert.equal(h.agent(child.id), undefined, 'native manager disposed the settled child');
  assert.deepEqual(h.ended.map(({ id, stopReason }) => ({ id, stopReason })), [{ id: child.id, stopReason: 'completed' }]);
  const owner = users(h.events(id));
  assert.deepEqual(owner[0].source, { kind: 'user', rpcId: requestId });
  assert.deepEqual(owner.filter(row => row.source.kind !== 'user').map(row => [row.source.kind, row.source.senderSessionId]), [
    ['agent-message', child.id], ['subagent-settled', child.id],
  ]);
  const delivered = prompts(h).map(call => contentText(call.params.prompt));
  assert.equal(delivered.filter(input => input.includes('ordinary child relay')).length, 1);
  assert.equal(delivered.filter(input => /Background subagent worker finished/.test(input)).length, 1);
  assert.equal(end(h, id).kind, 'completed');
  assert.equal((await savedBridge('tools/call', { name: 'list_agents' })).error?.code, -32602, 'inactive ACP capability cannot call tools');
  await h.cleanup();
  await assert.rejects(savedBridge('tools/list'), TypeError);
});

test('native ordinary parent can spawn, message, and resume a Gemini child', { timeout: 12_000 }, async t => {
  let id, delegated = false, continued = false;
  const h = await fixture(t, {
    nativeSubagents: { spawn: { agentOptions: GOOGLE } },
    async *ordinaryStream(request) {
      assert.equal(request.sessionId, id);
      const latestOwner = request.messages.findLast(message => message.role === 'user' && message.source.kind === 'user' && message.source.rpcId);
      if (!delegated) {
        delegated = true;
        assert.ok(request.tools.some(tool => tool.name === 'subagent'));
        yield* nativeCall('subagent', { name: 'gemworker', description: 'Run Gemini fixture', prompt: 'trusted native child prompt' });
      } else if (!continued && contentText(latestOwner?.content ?? []).includes('Continue the same native child')) {
        continued = true;
        yield* nativeCall('send_message', { agent: 'gemworker', message: 'continue this Gemini child' });
      } else yield* answer('Ordinary parent reviewed output');
    },
    async acpPrompt(turn) {
      const input = contentText(turn.params.prompt);
      const followup = input.includes('continue this Gemini child');
      assert.match(input, followup ? /Agent lead sent a message/ : /trusted native child prompt/);
      const rpc = h.bridge(turn);
      assert.deepEqual(await listed(rpc), nativeTools);
      assert.match(await call(rpc, 'list_agents'), /gemworker/);
      assert.match(await call(rpc, 'send_message', { agent: 'lead', message: followup ? 'Gemini child continued' : 'Gemini child relay' }), /message delivered to agent lead/);
      turn.update('Gemini child closing output');
      turn.reply();
    },
  });
  id = await h.create();
  ok(await h.prompt(id, 'Local owner authorizes native delegation'));
  await h.settled(id);
  assert.equal(h.started.length, 1, JSON.stringify(h.events(id).filter(row => ['tool/result', 'turn/end'].includes(row.type)), null, 2));
  const [child] = h.started;
  assert.equal(prompts(h).length, 1, 'only the Gemini child made an ACP inference request');
  assert.equal(h.started[0].parentSessionId, id);
  assert.deepEqual(h.ended.map(({ id, stopReason }) => ({ id, stopReason })), [{ id: child.id, stopReason: 'completed' }]);
  assert.equal(h.agent(child.id), undefined);
  const reader = await h.ctx.sessionPersistence.open(child.id, 'read');
  try {
    assert.equal(reader.header.origin, 'subagent');
    assert.equal(reader.header.parentSession, id);
    const persisted = await reader.read();
    assert.deepEqual(users(persisted.events)[0].source, { kind: 'user' }, 'native manager child prompt lacks an owner principal or RPC ID');
  } finally { await reader.close(); }
  const parent = users(h.events(id));
  assert.ok(parent.some(row => row.source.kind === 'agent-message' && row.source.senderSessionId === child.id && contentText(row.content).includes('Gemini child relay')));
  assert.ok(parent.some(row => row.source.kind === 'subagent-settled' && row.source.senderSessionId === child.id && row.source.stopReason === 'completed'));

  ok(await h.prompt(id, 'Continue the same native child'));
  await h.settled(id);
  assert.equal(continued, true);
  assert.equal(h.started.length, 2, 'a native message resumes the settled child');
  assert.equal(h.started[1].id, child.id, 'cold resume preserves the durable DSH child identity');
  assert.notEqual(h.started[1].runId, child.runId);
  assert.equal(prompts(h).length, 2, 'exactly one ACP prompt for each child activation');
  assert.equal(prompts(h)[1].params.sessionId, prompts(h)[0].params.sessionId, 'cold resume loads the same ACP conversation');
  assert.equal(h.ended[1].stopReason, 'completed');
  assert.equal(h.agent(child.id), undefined);
  assert.ok(users(h.events(id)).some(row => row.source.kind === 'agent-message' && row.source.senderSessionId === child.id && contentText(row.content).includes('Gemini child continued')));
  await h.cleanup();
});

test('native local Google refuses automation, a granted nonowner, and an owner without browser ingress', { timeout: 12_000 }, async t => {
  const apis = {};
  const h = await fixture(t, { nativeSubagents: {}, apis, acpPrompt() { assert.fail('unauthorized input reached ACP'); } });
  const id = await h.create();
  ok(await h.select(id, GOOGLE));
  apis.guestSessionId = id;
  const guest = randomUUID(), api = randomUUID(), direct = randomUUID();
  const request = (requestId, value) => ({ request: { sessionId: id, mode: 'queue', requestId, content: [text(value)] } });
  await h.invoke('session', 'prompt', request(guest, 'guest via valid per-session grant'), 'guest');
  await h.idle(id);
  assert.deepEqual(users(h.events(id)).at(-1)?.source, { kind: 'user', rpcId: guest, principal: { kind: 'fixture-guest' } });
  ok(await h.prompt(id, 'process-token HTTP owner is not an interactive browser', { requestId: api, who: 'owner' }));
  await h.idle(id);
  assert.deepEqual(users(h.events(id)).at(-1)?.source, { kind: 'user', rpcId: api });
  await h.invoke('session', 'prompt', request(direct, 'owner with in-process access but no HTTP witness'), 'browser');
  await h.idle(id);
  assert.deepEqual(users(h.events(id)).at(-1)?.source, { kind: 'user', rpcId: direct });
  // Native schedule dispatch calls agent.followup(createUserMessage(...)) with this exact attribution.
  h.agent(id).followup(createUserMessage({ content: [text('synthetic schedule')], source: { kind: 'schedule' } }));
  await h.settled(id);
  assert.deepEqual(users(h.events(id)).at(-1)?.source, { kind: 'schedule' });
  assert.equal(prompts(h).length, 0);
  assert.deepEqual(h.started, []);
});
