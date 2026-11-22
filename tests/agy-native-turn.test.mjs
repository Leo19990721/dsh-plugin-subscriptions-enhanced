import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AGY_SELECTION, ORDINARY_SELECTION, createTurnHost } from './fixtures/agy-turn-host.mjs';

const ok = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const finished = (h, id) => h.events(id).filter(event => event.type === 'turn/end');
const texts = (h, id) => h.events(id).flatMap(event => {
  const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined;
  return message ? [message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')] : [];
});
const prompts = h => h.acpCalls.filter(call => call.method === 'session/prompt');
const parseHistory = text => JSON.parse(text.slice(text.indexOf('\n') + 1)).flatMap(row => row.content.map(part => part.text));

function deferred(signal) {
  const latch = Promise.withResolvers();
  return { resolve: latch.resolve, get: () => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void latch.promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); });
  }) };
}

// No browser app or CLI process: feed requests through the installed dispatcher,
// use the exact native descriptors/loop and inspect actual disk-backed Sessions.
test('ordinary DSH and Antigravity take successive turns in one native Session', { timeout: 30_000 }, async t => {
  const h = await createTurnHost(t);
  const id = await h.create();
  const session = h.agent(id).session;
  const catalog = ok(await h.catalog(id));
  assert.deepEqual(catalog.default, ORDINARY_SELECTION);
  const group = catalog.groups.find(group => group.id === AGY_SELECTION.provider);
  assert.deepEqual(group.models.map(row => row.id), ['fixture-pro', 'fixture-fast']);
  assert.deepEqual(group.models[0].reasoning.efforts.map(row => row.id), ['fixture-low', 'fixture-high']);
  assert.equal(group.models[0].reasoning.defaultEffort, 'fixture-low');
  assert.equal(group.models[1].reasoning, undefined);
  assert.ok(!catalog.routableProviders.includes(AGY_SELECTION.provider));
  assert.deepEqual(h.ctx.llm.listProviders().map(provider => provider.id), [ORDINARY_SELECTION.provider]);

  assert.deepEqual(ok(await h.prompt(id, '原生第一轮 alphaonly')), { accepted: true });
  await h.idle(id);
  assert.deepEqual(ok(await h.select(id)), { selected: AGY_SELECTION });
  assert.equal(h.acpCalls.length, 0, 'a selection alone does not open an official conversation');
  assert.deepEqual(ok(await h.prompt(id, '接上文第二轮 betaonly')), { accepted: true });
  await h.idle(id);
  assert.deepEqual(finished(h, id).map(row => row.data.reason), [{ kind: 'completed' }, { kind: 'completed' }]);
  assert.equal(h.agent(id).session, session);
  const binding = h.ledger.read(id);
  assert.equal(binding.throughSeq, finished(h, id).at(-1).seq);
  assert.equal(binding.pending, null);
  assert.notEqual(binding.officialId, id);
  assert.ok(Object.isFrozen(binding));
  await assert.rejects(h.ledger.write(id, { ...binding, prompt: 'must never be in the ledger' }), { name: 'ZodError' });
  assert.equal(h.ledger.read(id), binding);
  assert.equal(h.records.filter(row => row.key === id).length, 3);
  assert.deepEqual(h.acpCalls.map(row => row.method), ['initialize', 'session/new', 'session/set_config_option', 'session/prompt', 'session/close']);
  const first = prompts(h)[0].params;
  assert.equal(first.sessionId, binding.officialId);
  assert.deepEqual(parseHistory(first.prompt[0].text), ['原生第一轮 alphaonly', '合成 DSH 回复 1']);
  assert.equal(first.prompt[1].text, '接上文第二轮 betaonly');
  assert.doesNotMatch(JSON.stringify(first), /Synthetic private DSH system text|rpcId|reasoningEffort/);

  assert.deepEqual(ok(await h.select(id, ORDINARY_SELECTION)), { selected: ORDINARY_SELECTION });
  assert.deepEqual(ok(await h.prompt(id, '切回原生第三轮 gammaonly')), { accepted: true });
  await h.idle(id);
  assert.equal(h.ordinaryCalls.length, 2);
  assert.ok(h.ordinaryCalls[1].messages.some(message => message.role === 'assistant' && message.content[0].text === '合成 Antigravity 回复'));
  assert.equal(prompts(h).length, 1);
  assert.deepEqual(ok(await h.select(id)), { selected: AGY_SELECTION });
  assert.deepEqual(ok(await h.prompt(id, '再次切换第四轮 deltaonly')), { accepted: true });
  await h.idle(id);
  assert.deepEqual(h.acpCalls.filter(call => call.method === 'session/load').map(call => call.params.sessionId), [binding.officialId]);
  const second = prompts(h)[1].params;
  assert.equal(second.sessionId, binding.officialId);
  assert.deepEqual(parseHistory(second.prompt[0].text), ['切回原生第三轮 gammaonly', '合成 DSH 回复 2']);
  assert.equal(second.prompt[1].text, '再次切换第四轮 deltaonly');
  assert.deepEqual(h.selects, [], 'ACP and exit are local selections and cannot change the default');
  assert.deepEqual(h.workspace.sessionIds, [id]);
  const rows = ok(await h.post('session', 'list', { _request: {} })).items;
  assert.deepEqual(rows.map(row => row.sessionId), [id]);
  assert.deepEqual(texts(h, id), [
    '原生第一轮 alphaonly', '合成 DSH 回复 1', '接上文第二轮 betaonly', '合成 Antigravity 回复',
    '切回原生第三轮 gammaonly', '合成 DSH 回复 2', '再次切换第四轮 deltaonly', '合成 Antigravity 回复',
  ]);
  assert.equal(finished(h, id).length, 4);
  await h.ctx.sessionPersistence.flush();
  const stored = await h.ctx.sessionPersistence.stat(id);
  const log = await readFile(stored.location.path, 'utf8');
  assert.match(log, /alphaonly/);
  assert.match(log, /deltaonly/);
  assert.doesNotMatch(log, /earlier conversation history|synthetic history from CLI|official-[\da-f-]{36}/);
});

test('the declared native default effort restores the official setting on a loaded session', { timeout: 20_000 }, async t => {
  const h = await createTurnHost(t);
  const id = await h.create();
  ok(await h.select(id));
  ok(await h.prompt(id, '使用较高的思考档位'));
  await h.idle(id);
  const { officialId } = h.ledger.read(id);
  const nativeDefault = { provider: AGY_SELECTION.provider, model: AGY_SELECTION.model };
  assert.deepEqual(ok(await h.select(id, nativeDefault)), { selected: nativeDefault });
  assert.deepEqual(h.agent(id).model.current(), nativeDefault);
  ok(await h.prompt(id, '回到默认档位'));
  await h.idle(id);
  assert.deepEqual(h.acpCalls.filter(call => call.method === 'session/set_config_option').map(call => call.params), [
    { sessionId: officialId, configId: 'fixture-effort-selector', value: 'fixture-high' },
    { sessionId: officialId, configId: 'fixture-effort-selector', value: 'fixture-low' },
  ]);
  const alternate = { provider: AGY_SELECTION.provider, model: 'fixture-fast' };
  ok(await h.select(id, alternate));
  ok(await h.prompt(id, '切到另一个实际公布的模型'));
  await h.idle(id);
  assert.deepEqual(h.acpCalls.filter(call => call.method === 'session/set_config_option').at(-1).params,
    { sessionId: officialId, configId: 'fixture-model-selector', value: 'fixture-fast' });
  assert.deepEqual(finished(h, id).map(row => row.data.reason.kind), ['completed', 'completed', 'completed']);
  assert.equal(prompts(h).length, 3);
  assert.deepEqual(h.selects, []);
});

test('switching during an ordinary tool step leaves its continuation on DSH', { timeout: 20_000 }, async t => {
  const toolStarted = deferred(t.signal), releaseTool = deferred(t.signal);
  const h = await createTurnHost(t, { async toolStep(execution) {
    toolStarted.resolve(execution);
    await releaseTool.get();
  } });
  const id = await h.create();
  try {
    ok(await h.prompt(id, '在工具执行期间切换'));
    await toolStarted.get();
    ok(await h.select(id));
    ok(await h.prompt(id, '工具完成后走 Antigravity'));
    assert.equal(h.ordinaryCalls.length, 1);
    assert.deepEqual(h.acpCalls, []);
  } finally { releaseTool.resolve(); }
  await h.idle(id);
  assert.equal(h.ordinaryCalls.length, 2);
  assert.ok(h.ordinaryCalls[1].messages.some(message => message.role === 'tool'
    && message.content[0].text === 'synthetic private tool result'));
  assert.deepEqual(finished(h, id).map(row => row.data.reason), [{ kind: 'completed' }, { kind: 'completed' }]);
  const [{ params }] = prompts(h);
  assert.deepEqual(parseHistory(params.prompt[0].text), ['在工具执行期间切换', '合成 DSH 回复 2']);
  assert.doesNotMatch(JSON.stringify(params), /synthetic private tool result|fixture_counter/);
  assert.equal(params.prompt[1].text, '工具完成后走 Antigravity');
});

test('native follow and Stop keep late ACP text, preserve the next DSH item, and reopen cold', { timeout: 30_000 }, async t => {
  const start = deferred(t.signal), stopped = deferred(t.signal);
  const h = await createTurnHost(t, {
    acpPrompt(turn) { turn.update('正在回复'); start.resolve(turn); },
    apis: { onCancel: id => stopped.resolve(id) },
  });
  const id = await h.create();
  ok(await h.select(id));
  const feed = await h.follow(id);
  const { value: snap } = await feed.next();
  assert.equal(snap.type, 'snapshot');
  assert.equal(snap.header.id, id);
  try {
    ok(await h.prompt(id, '合成停止验证'));
    const turn = await start.get();
    assert.equal(h.agent(id).status, 'running');
    const pending = h.ledger.read(id);
    assert.deepEqual(pending.pending, { turn: 1 });
    // Switching takes effect on the next turn. The original CLI owns Stop.
    ok(await h.select(id, ORDINARY_SELECTION));
    ok(await h.prompt(id, '保留在原生队列'));
    const itemId = h.agent(id).inbox.nextTurn[0].id;
    const refused = await h.post('session', 'updateQueue', { request: { sessionId: id, itemId, action: { kind: 'steer' } } });
    assert.equal(refused.error?.code, 'session/steer-unavailable', JSON.stringify(refused));
    assert.deepEqual(h.agent(id).inbox.nextTurn.map(item => item.id), [itemId]);
    assert.equal((await h.cancel(id, 'api')).ok, false);
    assert.deepEqual(ok(await h.cancel(id)), { accepted: true });
    assert.equal(await stopped.get(), turn.sessionId);
    assert.deepEqual(h.acpCalls.at(-1), { method: 'session/cancel', params: { sessionId: turn.sessionId }, hasId: false });
    turn.update('；停止后到达的尾片');
    assert.equal(h.agent(id).status, 'running');
    turn.reply('cancelled');
    await h.idle(id);
    const deltas = [];
    let reply;
    for (;;) {
      const { value, done } = await feed.next();
      assert.equal(done, false);
      if (value.type === 'assistant-stream' && value.frame.chunk?.type === 'text-delta') deltas.push(value.frame.chunk.text);
      if (value.type === 'event' && value.event.type === 'assistant/message') reply = value.event;
      if (value.type === 'event' && value.event.type === 'turn/end') break;
    }
    assert.deepEqual(deltas, ['正在回复', '；停止后到达的尾片']);
    assert.equal(reply.data.interrupted, true);
    assert.deepEqual(finished(h, id)[0].data.reason, { kind: 'aborted', reason: { kind: 'user' } });
    assert.deepEqual(h.agent(id).inbox.nextTurn.map(item => item.id), [itemId]);
    assert.equal(h.ordinaryCalls.length, 0);
    assert.equal(h.ledger.read(id).stopReason, 'cancelled');
    assert.equal(h.ledger.read(id).throughSeq, finished(h, id)[0].seq);
    // Disposing the ordinary agent clears its parked inbox, as stock does.
  } finally { await feed.return(); }
  const committed = h.ledger.read(id);
  await h.dispose();
  const cold = await createTurnHost(t, { root: h.root });
  assert.equal(cold.agent(id), undefined);
  assert.deepEqual(cold.ledger.read(id), committed);
  ok(await cold.select(id));
  assert.deepEqual(texts(cold, id), ['合成停止验证', '正在回复；停止后到达的尾片']);
  ok(await cold.prompt(id, '冷重开下一轮'));
  await cold.idle(id);
  assert.deepEqual(cold.acpCalls.filter(call => call.method === 'session/load').map(call => call.params.sessionId), [committed.officialId]);
  assert.deepEqual(prompts(cold)[0].params.prompt, [{ type: 'text', text: '冷重开下一轮' }]);
  assert.equal(cold.ledger.read(id).throughSeq, finished(cold, id).at(-1).seq);
  assert.deepEqual(ok(await cold.post('workspace', 'pinSession', { request: { sessionId: id } })), { pinnedSessionIds: [id] });
  const hits = ok(await cold.post('session', 'search', { request: { query: '冷重开下一轮' } }));
  assert.equal(hits.items[0].sessionId, id);
  assert.deepEqual(ok(await cold.post('workspace', 'archiveSession', { request: { sessionId: id } })), { archivedSessionIds: [id] });
  assert.deepEqual(ok(await cold.post('workspace', 'unarchiveSession', { request: { sessionId: id } })), { archivedSessionIds: [] });
});

test('stock rc.5 reads V4 external queue records and uses its current ordinary selection when next woken', { timeout: 20_000 }, async t => {
  const [{ createUserMessage }, { SESSION_FORMAT_VERSION, SessionId }] = await Promise.all([
    import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-session'),
  ]);
  // Same durable events as a selected external route with an unclaimed prompt.
  // No ACP runtime is mounted and neither adapter nor request resolves outside this fixture.
  const h = await createTurnHost(t, { releasedReader: true });
  const id = SessionId('synthetic-v4-before-rollback');
  const selected = { provider: 'turn:antigravity', model: 'synthetic-pro' };
  const queued = createUserMessage({ content: [{ type: 'text', text: 'synthetic-external-queued-marker' }], source: { kind: 'user' } });
  assert.equal(SESSION_FORMAT_VERSION, 4, 'This characterization is for the released V4 reader');
  const writer = await h.ctx.sessionPersistence.create({ version: 4, id, createdAt: 1000, isSeeded: false, cwd: h.cwd, agentPreset: 'fixture' });
  try {
    await writer.append([
      { seq: 0, time: 1001, type: 'model/selection', data: selected },
      { seq: 1, time: 1002, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [queued] } },
    ]);
  } finally { await writer.close(); }
  const { agent } = await h.ctx.agents.resume({ resumeSessionId: id, agentOptions: ORDINARY_SELECTION });
  assert.deepEqual(agent.model.current(), selected);
  assert.deepEqual(agent.inbox.nextTurn.map(item => item.id), [queued.id]);
  assert.deepEqual(h.ordinaryCalls, []);
  assert.equal(h.ledger, undefined);

  assert.deepEqual(ok(await h.select(id, ORDINARY_SELECTION)), { selected: ORDINARY_SELECTION });
  assert.deepEqual(agent.inbox.nextTurn.map(item => item.id), [queued.id], 'old selectModel does not clear, park or reauthorize the queued item');
  assert.deepEqual(ok(await h.prompt(id, 'synthetic-ordinary-wakeup')), { accepted: true });
  await h.idle(id);
  assert.equal(h.agent(id), agent);
  assert.deepEqual(agent.inbox.nextTurn, []);
  assert.deepEqual(h.acpCalls, []);
  assert.ok(h.ordinaryCalls.length > 0);
  const first = h.ordinaryCalls[0];
  assert.equal(first.provider, ORDINARY_SELECTION.provider);
  assert.equal(first.model, ORDINARY_SELECTION.model);
  assert.ok(first.messages.some(message => message.role === 'user' && message.content[0]?.text === 'synthetic-external-queued-marker'),
    'the old reader delivered the previously parked text to the ordinary adapter');
});
