import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { mountLocalGoogle } from '../src/agy-local-host.js';
import * as writing from '../src/writing-host.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

const selection = { provider: 'antigravity', model: 'gemini-3-flash' };
const ok = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const calls = h => h.acpCalls.filter(row => row.method === 'session/prompt');
const end = (h, id) => h.events(id).findLast(e => e.type === 'turn/end')?.data.reason;

async function fixture(t, options) {
  const { bindings = new Map(), opened = [], ...settings } = options;
  const h = await createTurnHost(t, { releasedReader: true, withCompaction: true, withRetry: true, desktopRequests: true,
    ...settings, async mountSubscription({ scope, makeSession }) {
      const sessions = new Set();
      mountLocalGoogle(scope, {}, {
        async open(signal, { cwd, officialId, mode, persona, mcpServers } = {}) {
          opened.push({ officialId, mode, persona });
          if (mode && !settings.localPermissions) assert.equal(mode, 'read-only');
          const session = makeSession({ signal, cwd, mcpServers });
          try { await session.open(officialId); }
          catch (error) { await session.close(); throw error; }
          sessions.add(session);
          return { id: session.id, get options() { return session.options; }, get capabilities() { return session.capabilities; },
            prepare: session.prepare, runTurn: session.runTurn,
            async close() { try { await session.close(); } finally { sessions.delete(session); } } };
        },
        readBinding: id => bindings.get(id),
        async writeBinding(id, row) { bindings.set(id, row); },
        async dispose() { await Promise.all([...sessions].map(session => session.close())); },
      });
    },
  });
  const fiber = h.ctx.plugin(writing, { localGoogle: true });
  await fiber.await();
  assert.equal(fiber.state, 2);
  t.after(() => fiber.dispose());
  return h;
}

test('stock DSH chat switches to Gemini and streams two turns in the same ACP conversation', { timeout: 25_000 }, async t => {
  let first;
  const h = await fixture(t, { acpPrompt(turn) {
    if (!first) {
      first = turn;
      turn.delta({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在检查工作区' } });
      turn.delta({ sessionUpdate: 'tool_call', toolCallId: 'fixture-read', title: 'Read fixture.txt', kind: 'read', status: 'in_progress' });
      turn.update('第一段');
    } else {
      assert.equal(turn.sessionId, first.sessionId);
      turn.update('接着聊。');
      turn.reply();
    }
  } });
  const id = await h.create();
  const session = h.agent(id).session;
  const catalog = ok(await h.post('session', 'modelCatalog', {}));
  const group = catalog.groups.find(row => row.id === selection.provider);
  assert.equal(group.name, 'Google Antigravity');
  assert.ok(group.models.some(row => row.id === selection.model));
  assert.ok(!catalog.groups.some(row => row.id === 'turn:antigravity'));

  ok(await h.prompt(id, '之前在普通模型聊的话'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  assert.equal(h.ordinaryCalls.length, 1);
  assert.deepEqual(ok(await h.select(id, selection)), { selected: selection });
  const feed = await h.follow(id);
  try {
    assert.equal((await feed.next()).value.header.id, id);
    const firstText = '本轮发送给 Gemini';
    assert.deepEqual(ok(await h.prompt(id, firstText)), { accepted: true });
    const live = [];
    for (;;) {
      const { value, done } = await feed.next();
      assert.equal(done, false);
      if (value.type === 'event' && value.event.type === 'turn/end') assert.fail(JSON.stringify(value.event.data.reason));
      if (value.type !== 'assistant-stream') continue;
      if (value.frame.chunk?.type === 'reasoning-delta') live.push(value.frame.chunk.text);
      if (value.frame.chunk?.type === 'text-delta') {
        assert.equal(value.frame.chunk.text, '第一段');
        break;
      }
    }
    assert.deepEqual(live, ['正在检查工作区', '工具执行中：Read fixture.txt\n\n']);
    assert.equal(h.agent(id).status, 'running', 'the first fragment arrives before ACP finishes');
    first.update('，第二段。');
    first.delta({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-read', status: 'completed' });
    first.reply();
    await h.idle(id);
    assert.deepEqual(end(h, id), { kind: 'completed' });
    const secondText = '同一聊天的下一轮';
    ok(await h.prompt(id, secondText));
    await h.idle(id);
    assert.deepEqual(end(h, id), { kind: 'completed' });
    const [firstCall, secondCall] = calls(h).map(row => row.params);
    assert.equal(firstCall.sessionId, first.sessionId);
    assert.match(firstCall.prompt[0].text, /之前在普通模型聊的话.*合成 DSH 回复 1/);
    assert.deepEqual(firstCall.prompt.slice(1), [{ type: 'text', text: firstText }]);
    assert.deepEqual(secondCall, { sessionId: first.sessionId, prompt: [{ type: 'text', text: secondText }] });
    assert.equal(h.acpCalls.filter(row => row.method === 'session/new').length, 2, 'one catalog check and one reusable chat');
    assert.equal(h.agent(id).session, session);
    const replies = h.events(id).filter(e => e.type === 'assistant/message').slice(-2).map(e => e.data.message);
    assert.deepEqual(replies.map(row => row.content.filter(block => block.type === 'text').map(block => block.text).join('')), ['第一段，第二段。', '接着聊。']);
    assert.ok(replies[0].content.some(block => block.type === 'reasoning' && block.text.startsWith('工具已完成')));
    assert.equal(h.events(id).filter(event => event.type === 'tool/call').length, 0, 'ACP tools are never run again by DSH');
    assert.deepEqual(replies.map(row => row.source.provider), ['antigravity', 'antigravity']);
  } finally { await feed.return(); }

  ok(await h.select(id, ORDINARY_SELECTION));
  ok(await h.prompt(id, '切回原来的普通模型'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  assert.equal(h.ordinaryCalls.length, 2);
  assert.equal(calls(h).length, 2);
  ok(await h.select(id, selection));
  ok(await h.prompt(id, '第二次切入 Gemini'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  assert.match(calls(h)[2].params.prompt[0].text, /切回原来的普通模型.*合成 DSH 回复 2/);
  assert.doesNotMatch(calls(h)[2].params.prompt[0].text, /之前在普通模型聊的话|同一聊天的下一轮/);
});

test('a queued GPT result wakes exactly the owner Gemini session with its granted mode and no MCP tools', { timeout: 10_000 }, async t => {
  const first = Promise.withResolvers(), review = Promise.withResolvers(), childRelease = Promise.withResolvers();
  const opened = [];
  t.after(() => childRelease.resolve());
  let acpTurns = 0;
  const mcpMarker = 'synthetic MCP result';
  const h = await fixture(t, { opened, localPermissions: { mode: 'danger-full-access', approval: 'never' },
    localMcpMarker: mcpMarker, ordinaryPrompt: () => childRelease.promise,
    acpPrompt(turn) {
      if (++acpTurns === 1) first.resolve(turn);
      else { turn.update('已验收'); turn.reply(); review.resolve(turn); }
    },
  });
  const id = await h.create();
  ok(await h.select(id, selection));
  ok(await h.prompt(id, '请派一个任务'));
  const main = await Promise.race([first.promise, h.idle(id).then(() => assert.fail(`Parent ended before ACP call: ${JSON.stringify(end(h, id))}`))]);
  const native = h.acpCalls.filter(row => row.method === 'session/new').at(-1).params.mcpServers[0];
  const tool = async (name, args) => {
    const res = await fetch(native.url, { method: 'POST', signal: t.signal, headers: { authorization: native.headers[0].value },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const { result } = await res.json();
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.content[0].text;
  };
  assert.equal(await tool('mcp__knowledge__dsh_integration_marker', {}), mcpMarker);
  const child = JSON.parse(await tool('dsh_delegate_gpt', { prompt: '做一项合成任务', cwd: h.cwd,
    provider: ORDINARY_SELECTION.provider, model: ORDINARY_SELECTION.model }));
  assert.equal(child.notifyParent, true);
  childRelease.resolve();
  await h.idle(child.sessionId);
  for (let i = 0; !h.agent(id).inbox.nextTurn.length && i < 100; i++) await delay(10, undefined, { signal: t.signal });
  const [queued, ...other] = h.agent(id).inbox.nextTurn;
  assert.ok(queued, 'the completion was queued behind the ongoing conversation');
  assert.equal(other.length, 0);
  assert.equal(calls(h).length, 1);
  main.update('已分派'); main.reply();
  await h.idle(id);
  assert.equal(acpTurns, 2, JSON.stringify(end(h, id)));
  const returned = await review.promise;
  assert.match(returned.params.prompt.at(-1).text, /完成回传[\s\S]*合成 DSH 回复 1/);
  assert.deepEqual(opened.filter(row => row.mode).map(row => row.mode), ['full', 'full']);
  assert.deepEqual(h.acpCalls.filter(row => row.method === 'session/load').at(-1).params.mcpServers, [],
    'the review turn has neither delegation tools nor external MCP tools');
  h.agent(id).followup(queued); // a copied message id/source must not grant a second call
  await h.idle(id);
  assert.equal(calls(h).length, 2);
});

test('native model catalog advertises exact ACP efforts; a stored xhigh downgrades before the prompt', async t => {
  const neon = { provider: 'antigravity', model: 'gemini-4-neon' };
  const flash = { provider: 'antigravity', model: 'gemini-3.8-flash' };
  const effortRows = (...values) => values.map(value => ({ value, name: value }));
  const h = await fixture(t, { acpConfig: [
    { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: neon.model,
      options: [{ value: neon.model, name: 'Neon' }, { value: flash.model, name: 'Flash' }] },
    { type: 'select', id: 'effort', category: 'thought_level', name: 'Thinking', currentValue: 'low',
      options: effortRows('low', 'medium', 'high', 'xhigh') },
  ], apis: { onConfig(config, changed) {
    if (changed.category !== 'model') return;
    config[1].currentValue = 'medium';
    config[1].options = changed.currentValue === flash.model ? effortRows('low', 'medium', 'high') : effortRows('low', 'medium', 'high', 'xhigh');
  } } });
  const id = await h.create();
  const catalog = ok(await h.post('session', 'modelCatalog', {})).groups.find(row => row.id === 'antigravity').models;
  assert.deepEqual(catalog.find(row => row.id === neon.model).reasoning,
    { efforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, name: id })), defaultEffort: 'low' });
  assert.deepEqual(catalog.find(row => row.id === flash.model).reasoning,
    { efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })), defaultEffort: 'medium' });
  assert.equal(calls(h).length, 0, 'catalog only sends configuration requests');
  ok(await h.select(id, { ...neon, reasoningEffort: 'xhigh' }));
  ok(await h.prompt(id, 'use the explicit effort'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  h.agent(id).model.select({ ...flash, reasoningEffort: 'xhigh' }); // a stale saved selection
  ok(await h.prompt(id, 'continue on the three-level model'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  const wire = h.acpCalls.filter(row => row.params?.sessionId === calls(h)[0].params.sessionId);
  assert.deepEqual(wire.filter(row => row.method === 'session/set_config_option').map(row => row.params.value), ['xhigh', flash.model, 'high']);
  assert.equal(calls(h).length, 2);
});

test('writing mode passes a Chinese writing persona only to its local Gemini session', async t => {
  const opened = [];
  const h = await fixture(t, { opened });
  const writingId = await h.create({ agentPreset: 'writing' });
  assert.equal(h.agent(writingId).model.current()?.provider, 'antigravity');
  ok(await h.prompt(writingId, '起草一段文字'));
  await h.idle(writingId);
  assert.deepEqual(end(h, writingId), { kind: 'completed' });
  const ordinaryId = await h.create();
  ok(await h.select(ordinaryId, selection));
  ok(await h.prompt(ordinaryId, '用普通模式继续'));
  await h.idle(ordinaryId);
  assert.deepEqual(end(h, ordinaryId), { kind: 'completed' });
  assert.deepEqual(opened.filter(row => row.mode).map(row => row.persona), ['你是一名中文写作助手，帮助用户起草、修改和整理文字材料。', undefined]);
});

test('an invalid saved official ID falls back once and sends recent DSH text to the new conversation', { timeout: 25_000 }, async t => {
  const bindings = new Map();
  const h = await fixture(t, { bindings });
  const id = await h.create();
  ok(await h.select(id, selection));
  ok(await h.prompt(id, '内容应从 DSH 回退'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  const old = bindings.get(id).officialId;
  await h.dispose();
  const reopened = await fixture(t, { root: h.root, bindings, apis: { failLoad: true } });
  ok(await reopened.prompt(id, '重开之后继续'));
  await reopened.idle(id);
  assert.deepEqual(end(reopened, id), { kind: 'completed' });
  assert.deepEqual(reopened.acpCalls.filter(row => row.method === 'session/load').map(row => row.params.sessionId), [old]);
  assert.notEqual(bindings.get(id).officialId, old);
  assert.equal(calls(reopened).length, 1);
  assert.match(calls(reopened)[0].params.prompt[0].text, /内容应从 DSH 回退.*合成 Antigravity 回复/);
  assert.deepEqual(calls(reopened)[0].params.prompt.at(-1), { type: 'text', text: '重开之后继续' });
});
