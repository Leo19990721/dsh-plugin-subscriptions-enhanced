import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AGY_SELECTION, ORDINARY_SELECTION, createTurnHost } from './fixtures/agy-turn-host.mjs';

// Loaded by the installed-runtime branch of scripts/test.mjs. The Host uses
// temporary stores, a synthetic HTTP carrier and an in-memory ACP transport.
const installed = (name, run) => test(name, { timeout: 30_000 }, run);
const accepted = { accepted: true };
const text = value => ({ type: 'text', text: value });
const calls = (h, method) => h.acpCalls.filter(call => call.method === method);
const turnEnds = (h, id) => h.events(id).filter(event => event.type === 'turn/end');
const userMessages = (h, id) => h.events(id).filter(event => event.type === 'user/message').map(event => event.data);

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function denied(result, code, message) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
  if (message) assert.match(result.error.message, message);
}

function stillUnsent(h, id, events) {
  assert.deepEqual(h.events(id), events, 'rejection must not append a Session event');
  assert.deepEqual(h.agent(id).inbox.nextTurn, []);
  assert.deepEqual(h.agent(id).inbox.nextStep, []);
  assert.deepEqual(h.acpCalls, []);
  assert.equal(h.ledger.read(id), undefined);
}

async function waitFor(t, promise) {
  t.signal.throwIfAborted();
  let abort;
  const deadline = new Promise((_resolve, reject) => {
    abort = () => reject(t.signal.reason);
    t.signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, deadline]); }
  finally { t.signal.removeEventListener('abort', abort); }
}

installed('only the addressed live ordinary conversation gets ACP in its model catalog', async t => {
  const h = await createTurnHost(t);
  const id = await h.create();
  const before = h.events(id);
  const plain = ok(await h.post('session', 'modelCatalog')); // Exact native subagent Settings call.
  assert.deepEqual(plain.routableProviders, [ORDINARY_SELECTION.provider]);
  assert.deepEqual(plain.groups.map(group => group.id), [ORDINARY_SELECTION.provider]);
  const scoped = ok(await h.catalog(id));
  assert.deepEqual(scoped, { ...plain, groups: [...plain.groups, scoped.groups.at(-1)] });
  assert.equal(scoped.groups.at(-1).id, AGY_SELECTION.provider);
  assert.deepEqual(await h.ctx.sessionController.modelCatalog(), plain, 'Host-only callers use the ordinary directory');
  const missing = `missing-${randomUUID()}`;
  assert.deepEqual(ok(await h.catalog(missing)), plain);
  assert.equal(h.agent(missing), undefined, 'listing must never open or resume an unknown Session');

  for (const request of [null, {}, { audience: 'subagent', sessionId: id }, { audience: 'conversation', sessionId: '' },
    { audience: 'conversation', sessionId: id, provider: AGY_SELECTION.provider }]) {
    const result = await h.post('session', 'modelCatalog', { request });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error.code, /^gateway\//);
  }
  assert.deepEqual(h.events(id), before);
  await assert.rejects(h.ctx.llm.resolveCallConfig(AGY_SELECTION), { code: 'NO_ADAPTER' });
  assert.deepEqual(h.selects, []);
  assert.deepEqual(h.acpCalls, []);

  ok(await h.select(id));
  assert.deepEqual(ok(await h.post('session', 'modelCatalog')), plain, 'an ACP selection must not update the settings catalog');
  ok(await h.post('workspace', 'archiveSession', { request: { sessionId: id } }));
  assert.deepEqual(ok(await h.catalog(id)), plain);
  assert.deepEqual(h.ctx.agentDefaultModel.currentSelection(), ORDINARY_SELECTION);
});

installed('only an authenticated browser request can select, prompt and Stop an ACP turn', async t => {
  const entered = Promise.withResolvers(), cancelled = Promise.withResolvers();
  const h = await createTurnHost(t, {
    acpPrompt(turn) { turn.update('合成 ACP 前文'); entered.resolve(turn); },
    apis: { onCancel: id => cancelled.resolve(id) },
  });
  const id = await h.create();
  const hasAgy = catalog => catalog.groups.some(group => group.id === AGY_SELECTION.provider);
  const browserCatalog = ok(await h.catalog(id));
  const apiCatalog = ok(await h.catalog(id, 'api'));
  assert.equal(hasAgy(browserCatalog), true);
  assert.equal(hasAgy(apiCatalog), false);
  assert.deepEqual(apiCatalog.default, ORDINARY_SELECTION);

  const beforeSelect = h.events(id);
  const selection = { request: { sessionId: id, ...AGY_SELECTION } };
  denied(await h.select(id, AGY_SELECTION, 'api'), 'session/model-unavailable');
  for (const peer of ['owner', 'browser']) {
    assert.deepEqual(await h.invoke('session', 'modelCatalog', { request: { audience: 'conversation', sessionId: id } }, peer), apiCatalog);
    await assert.rejects(h.invoke('session', 'selectModel', selection, peer), { code: 'session/model-unavailable' });
  }
  stillUnsent(h, id, beforeSelect);
  assert.deepEqual(h.agent(id).model.current(), ORDINARY_SELECTION);
  assert.deepEqual(ok(await h.select(id)), { selected: AGY_SELECTION });

  const requestId = randomUUID();
  const prompt = '浏览器的合成提问';
  const promptArgs = { request: { sessionId: id, requestId, mode: 'queue', content: [text(prompt)] } };
  const beforePrompt = h.events(id);
  denied(await h.prompt(id, prompt, { requestId, who: 'api' }), 'session/agent-busy');
  for (const peer of ['owner', 'browser']) {
    await assert.rejects(h.invoke('session', 'prompt', promptArgs, peer), { code: 'session/agent-busy' });
  }
  stillUnsent(h, id, beforePrompt);
  assert.deepEqual(ok(await h.prompt(id, prompt, { requestId })), accepted);
  const turn = await waitFor(t, entered.promise);
  try {
    const beforeStop = h.events(id);
    denied(await h.cancel(id, 'api'), 'session/agent-busy');
    for (const peer of ['owner', 'browser']) {
      await assert.rejects(h.invoke('session', 'cancel', { request: { sessionId: id } }, peer), { code: 'session/agent-busy' });
    }
    assert.deepEqual(calls(h, 'session/cancel'), []);
    assert.deepEqual(h.events(id), beforeStop);
    assert.equal(h.agent(id).status, 'running');
    assert.deepEqual(ok(await h.cancel(id)), accepted);
    assert.equal(await waitFor(t, cancelled.promise), turn.sessionId);
  } finally {
    turn.reply('cancelled');
    await h.idle(id);
  }
  assert.deepEqual(calls(h, 'session/prompt'), [{
    method: 'session/prompt', params: { sessionId: turn.sessionId, prompt: [text(prompt)] }, hasId: true,
  }]);
  assert.deepEqual(calls(h, 'session/cancel'), [{
    method: 'session/cancel', params: { sessionId: turn.sessionId }, hasId: false,
  }]);
  assert.deepEqual(turnEnds(h, id).map(event => event.data.reason), [{ kind: 'aborted', reason: { kind: 'user' } }]);
  assert.deepEqual(h.selects, []);
});

installed('direct Agent schedule and tool messages cannot enter an ACP inbox', async t => {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const entered = Promise.withResolvers();
  const h = await createTurnHost(t, { acpPrompt: turn => entered.resolve(turn) });
  const id = await h.create();
  ok(await h.select(id));
  const agent = h.agent(id);
  function rejectDerivedInput() {
    for (const source of [{ kind: 'schedule' }, { kind: 'tool', callId: randomUUID() }]) {
      const message = createUserMessage({ content: [text('合成派生消息')], source });
      for (const method of ['followup', 'steer', 'inject']) {
        assert.throws(() => agent[method](message), { code: 'agy/prompt-unavailable' }, `${source.kind}: ${method}`);
      }
    }
  }
  const before = h.events(id);
  rejectDerivedInput();
  stillUnsent(h, id, before);
  ok(await h.prompt(id, '真正经浏览器提交'));
  const turn = await waitFor(t, entered.promise);
  try {
    const active = h.events(id);
    assert.equal(agent.status, 'running');
    rejectDerivedInput();
    assert.deepEqual(h.events(id), active);
    assert.equal(agent.inbox.hasPending, false);
  } finally {
    turn.reply();
    await h.idle(id);
  }
  assert.equal(calls(h, 'session/prompt').length, 1);
  assert.deepEqual(userMessages(h, id).map(message => message.content), [[text('真正经浏览器提交')]]);
});

installed('native Schedule manual delivery still works on DSH and cannot enqueue for ACP', async t => {
  const [{ ScheduleService }, { TYPERT }] = await Promise.all([
    import('@deepseek-ai/dsh-schedule'), import('@deepseek-ai/dsh-schedule/typert'),
  ]);
  const h = await createTurnHost(t);
  const registrations = h.ctx.plugin({ inject: ['typert'], apply(scope) { scope.typert.register(TYPERT); } });
  let schedule;
  try {
    await registrations.inertia;
    assert.equal(registrations.state, 2);
    schedule = h.ctx.plugin(ScheduleService, {});
    await schedule.inertia;
    assert.equal(schedule.state, 2);
    const id = await h.create();
    ok(await h.select(id));
    const request = {
      title: '合成提醒', prompt: '合成的原生调度消息',
      timing: { kind: 'after', after_seconds: 3600 }, target: { kind: 'session', sessionId: id },
    };
    // Use the fixture Session as the actor so task management emits no separate
    // change notice. Pause before invoking the installed manual delivery route.
    const task = await h.ctx.schedule.create(request, id);
    const paused = await h.ctx.schedule.edit({ id: task.id, action: 'update', patch: { active: false } }, id);
    assert.equal(paused.status, 'paused');
    const run = { request: { id: task.id } };
    const before = h.events(id);
    await assert.rejects(h.invoke('schedule', 'run', run), { code: 'agy/prompt-unavailable' });
    stillUnsent(h, id, before);
    assert.equal((await h.ctx.schedule.view(run.request)).lastDelivery, undefined);

    ok(await h.select(id, ORDINARY_SELECTION));
    const delivered = ok(await h.post('schedule', 'run', run, 'api'));
    assert.equal(delivered.lastDelivery.targetSessionId, id);
    await h.idle(id);
    assert.equal(h.ordinaryCalls.length, 1);
    assert.equal(h.acpCalls.length, 0);
    const reminder = userMessages(h, id).find(message => message.id === delivered.lastDelivery.messageId);
    assert.equal(reminder.source.kind, 'schedule');
    assert.ok(reminder.content.some(part => part.type === 'text' && part.text.includes(request.prompt)));
    assert.equal(turnEnds(h, id).at(-1).data.reason.kind, 'completed');
  } finally {
    try { await schedule?.dispose(); }
    finally { await registrations.dispose(); }
  }
});

installed('archiving an ordinary Session blocks ACP selection and revokes an existing ACP choice for prompts', async t => {
  const h = await createTurnHost(t);
  const id = await h.create();
  const archive = async () => assert.deepEqual(ok(await h.post('workspace', 'archiveSession', { request: { sessionId: id } })), {
    archivedSessionIds: [id],
  });
  const unarchive = async () => assert.deepEqual(ok(await h.post('workspace', 'unarchiveSession', { request: { sessionId: id } })), {
    archivedSessionIds: [],
  });
  await archive();
  const beforeSelect = h.events(id);
  denied(await h.select(id), 'session/model-unavailable');
  stillUnsent(h, id, beforeSelect);
  assert.deepEqual(h.agent(id).model.current(), ORDINARY_SELECTION);

  await unarchive();
  ok(await h.select(id));
  await archive();
  const beforePrompt = h.events(id);
  const requestId = randomUUID();
  denied(await h.prompt(id, '仅取消归档后发送', { requestId }), 'session/agent-busy');
  stillUnsent(h, id, beforePrompt);

  await unarchive();
  assert.deepEqual(ok(await h.prompt(id, '仅取消归档后发送', { requestId })), accepted);
  await h.idle(id);
  assert.equal(calls(h, 'session/prompt').length, 1);
  assert.equal(turnEnds(h, id).at(-1).data.reason.kind, 'completed');
});

installed('ACP rejects non-text content, empty continuation and steering before queue admission', async t => {
  const { LlmError } = await import('@deepseek-ai/dsh-llm');
  const h = await createTurnHost(t, { ordinaryPrompt(_request, count) {
    if (count === 1) throw new LlmError('Synthetic ordinary rate limit', 'RATE_LIMIT');
  } });
  const id = await h.create();
  assert.deepEqual(ok(await h.prompt(id, '普通轮可继续', { who: 'api' })), accepted);
  await h.idle(id);
  const end = turnEnds(h, id).at(-1);
  assert.equal(end.data.reason.error.code, 'RATE_LIMIT');
  const continuation = h.ctx.sessionProjections.snapshot(h.agent(id).session, ['conversationContinuation']);
  assert.equal(continuation.values.conversationContinuation, end.seq);
  ok(await h.select(id));
  const before = h.events(id);
  const requestId = randomUUID();
  const png = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
  const file = { type: 'file', receiptId: randomUUID() };
  for (const content of [[png], [text('混合正文'), file], []]) {
    denied(await h.prompt(id, content, { requestId }), 'session/agent-busy', /text prompt/);
  }
  denied(await h.prompt(id, ' \t'), 'gateway/bad-request');
  denied(await h.prompt(id, '改变当前轮', { mode: 'steer' }), 'session/agent-busy', /text prompt/);
  stillUnsent(h, id, before);

  ok(await h.select(id, ORDINARY_SELECTION));
  assert.deepEqual(ok(await h.prompt(id, [], { requestId, who: 'api' })), accepted);
  await h.idle(id);
  assert.equal(h.ordinaryCalls.length, 2);
  const continued = userMessages(h, id).find(message => message.source.rpcId === requestId);
  assert.equal(continued.source.kind, 'retry');
  assert.deepEqual(continued.content, []);
  assert.equal(turnEnds(h, id).at(-1).data.reason.kind, 'completed');
  assert.equal(h.acpCalls.length, 0);
});

async function reopenPending(t, h, id, pending, { prompt, requestId }) {
  assert.deepEqual(h.ledger.read(id), pending);
  await h.dispose();
  const cold = await createTurnHost(t, { root: h.root });
  assert.equal(cold.agent(id), undefined);
  assert.deepEqual(cold.ledger.read(id), pending);
  // A native duplicate receipt can be acknowledged after restart without
  // rerunning the prompt. Fresh input must still meet the persisted fence.
  assert.deepEqual(ok(await cold.prompt(id, prompt, { requestId })), accepted);
  assert.deepEqual(cold.agent(id).model.current(), AGY_SELECTION);
  const before = cold.events(id);
  denied(await cold.prompt(id, '冷重开后拒绝新请求'), 'session/agent-busy', /unconfirmed/);
  await cold.idle(id);
  assert.deepEqual(cold.events(id), before);
  assert.equal(userMessages(cold, id).filter(message => message.source.rpcId === requestId).length, 1);
  assert.equal(cold.agent(id).inbox.hasPending, false);
  assert.deepEqual(cold.ledger.read(id), pending);
  assert.deepEqual(cold.acpCalls, []);
  assert.deepEqual(cold.ordinaryCalls, []);
  return cold;
}

for (const loss of [
  { name: 'disconnect after Stop without a terminal response', stop: true, finish: turn => turn.disconnect() },
  { name: 'an ACP error response after dispatch', stop: false, finish: turn => turn.error(-32603, 'synthetic provider failure detail') },
]) installed(`${loss.name} retains the pending fence across cold reopen`, async t => {
  const entered = Promise.withResolvers(), cancelled = Promise.withResolvers();
  const preview = '未确认的合成预览';
  const stopTail = '；发出停止后收到的合成尾片';
  let attempt = 0;
  const h = await createTurnHost(t, {
    acpPrompt(turn) {
      if (++attempt === 1) { turn.update('合成已确认回复'); turn.reply(); return; }
      turn.update(preview);
      entered.resolve(turn);
    },
    apis: { onCancel: id => cancelled.resolve(id) },
  });
  const id = await h.create();
  ok(await h.select(id));
  ok(await h.prompt(id, '先建立一个已确认的官方游标'));
  await h.idle(id);
  const confirmed = h.ledger.read(id);
  assert.equal(confirmed.pending, null);
  assert.equal(confirmed.throughSeq, turnEnds(h, id).at(-1).seq);
  assert.equal(confirmed.stopReason, 'end_turn');

  const prompt = '只发一次的合成提问';
  const requestId = randomUUID();
  assert.deepEqual(ok(await h.prompt(id, prompt, { requestId })), accepted);
  const turn = await waitFor(t, entered.promise);
  const pending = { ...confirmed, pending: { turn: 2 } };
  try {
    assert.equal(turn.sessionId, confirmed.officialId);
    assert.deepEqual(h.ledger.read(id), pending);
    if (loss.stop) {
      assert.deepEqual(ok(await h.cancel(id)), accepted);
      assert.equal(await waitFor(t, cancelled.promise), turn.sessionId);
      assert.equal(turnEnds(h, id).length, 1, 'a Stop notification is not a terminal response');
      turn.update(stopTail);
    }
  } finally {
    loss.finish(turn);
    await h.idle(id);
  }
  const end = turnEnds(h, id).at(-1);
  assert.equal(end.data.turn, 2);
  assert.equal(end.data.reason.kind, 'error');
  assert.equal(end.data.reason.error.code, 'AGY_TURN_UNCONFIRMED');
  const events = h.events(id);
  assert.doesNotMatch(JSON.stringify(events), /synthetic provider failure detail/);
  const messages = events.filter(event => event.type === 'assistant/message');
  const attempts = events.filter(event => event.type === 'assistant/attempt');
  assert.deepEqual(messages.map(event => event.data.turn), loss.stop ? [1, 2] : [1]);
  assert.deepEqual(attempts.map(event => event.data.turn), loss.stop ? [] : [2]);
  if (loss.stop) {
    assert.equal(messages[1].data.interrupted, true);
    assert.deepEqual(messages[1].data.message.content, [text(preview + stopTail)]);
  }
  assert.deepEqual(h.ledger.read(id), pending);
  assert.equal(calls(h, 'session/prompt').length, 2);
  assert.equal(calls(h, 'session/cancel').length, Number(loss.stop));
  denied(await h.prompt(id, '热 Session 也拒绝新请求'), 'session/agent-busy', /unconfirmed/);
  assert.equal(calls(h, 'session/prompt').length, 2);
  const cold = await reopenPending(t, h, id, pending, { prompt, requestId });
  assert.deepEqual(turnEnds(cold, id).at(-1).data.reason, end.data.reason);
});

installed('a failed final Session checkpoint keeps the ACP fence without blocking ordinary DSH', async t => {
  const barriers = [];
  const h = await createTurnHost(t, { beforeFlush(session) {
    const end = session.snapshotEvents().findLast(event => event.type === 'turn/end');
    barriers.push(end?.seq);
    return end === undefined;
  } });
  const id = await h.create();
  ok(await h.select(id));
  const prompt = '有官方终态但最终保存屏障失败';
  const requestId = randomUUID();
  assert.deepEqual(ok(await h.prompt(id, prompt, { requestId })), accepted);
  await h.idle(id);
  const [end] = turnEnds(h, id);
  assert.deepEqual(barriers, [undefined, end.seq], 'both pre-send and final durability checks ran');
  assert.equal(end.data.reason.kind, 'completed', 'the synthetic provider sent its official terminal response');
  assert.equal(calls(h, 'session/prompt').length, 1);
  const pending = h.ledger.read(id);
  assert.deepEqual(pending.pending, { turn: end.data.turn });
  assert.equal(pending.throughSeq, -1);
  assert.equal(pending.stopReason, undefined);
  denied(await h.prompt(id, '保存未经确认时不再发送'), 'session/agent-busy', /unconfirmed/);
  assert.equal(calls(h, 'session/prompt').length, 1);

  const cold = await reopenPending(t, h, id, pending, { prompt, requestId });
  assert.deepEqual(ok(await cold.select(id, ORDINARY_SELECTION)), { selected: ORDINARY_SELECTION });
  assert.deepEqual(ok(await cold.prompt(id, '同一 Session 可继续普通轮', { who: 'api' })), accepted);
  await cold.idle(id);
  assert.equal(cold.ordinaryCalls.length, 1);
  assert.deepEqual(cold.acpCalls, []);
  assert.deepEqual(cold.ledger.read(id), pending, 'a regular turn must not erase the ACP fence');
  assert.equal(turnEnds(cold, id).at(-1).data.reason.kind, 'completed');
});

installed('browser Stop after the pending mark but before dispatch clears the unsent fence', async t => {
  const marked = Promise.withResolvers(), release = Promise.withResolvers();
  let firstMark = true;
  const h = await createTurnHost(t, { async afterLedgerWrite(id, row) {
    if (row.pending === null || !firstMark) return;
    firstMark = false;
    marked.resolve({ id, row });
    await release.promise;
  } });
  const id = await h.create();
  ok(await h.select(id));
  try {
    assert.deepEqual(ok(await h.prompt(id, '在 ACP 写出前停止')), accepted);
    const { id: markedId, row } = await waitFor(t, marked.promise);
    assert.equal(markedId, id);
    assert.deepEqual(row.pending, { turn: 1 });
    assert.deepEqual(h.ledger.read(id), row);
    assert.deepEqual(calls(h, 'session/prompt'), []);
    assert.deepEqual(ok(await h.cancel(id)), accepted);
  } finally {
    release.resolve();
    await h.idle(id);
  }
  assert.deepEqual(calls(h, 'session/prompt'), []);
  assert.deepEqual(calls(h, 'session/cancel'), [], 'no notification is needed for a prompt that was never dispatched');
  assert.deepEqual(turnEnds(h, id)[0].data.reason, { kind: 'aborted', reason: { kind: 'user' } });
  const cleared = h.ledger.read(id);
  assert.equal(cleared.pending, null);
  assert.equal(cleared.throughSeq, -1);

  const prompt = '停止后另行提交的合成输入';
  assert.deepEqual(ok(await h.prompt(id, prompt)), accepted);
  await h.idle(id);
  assert.deepEqual(calls(h, 'session/load').map(call => call.params.sessionId), [cleared.officialId]);
  assert.deepEqual(calls(h, 'session/prompt').map(call => call.params.prompt), [[text(prompt)]]);
  const end = turnEnds(h, id).at(-1);
  assert.equal(end.data.reason.kind, 'completed');
  assert.deepEqual(h.ledger.read(id), { ...cleared, throughSeq: end.seq, stopReason: 'end_turn' });
});

installed('confirmed Stop parks edited ACP work until a new browser request drains it in order', async t => {
  const first = Promise.withResolvers(), cancel = Promise.withResolvers(), fourth = Promise.withResolvers();
  let dispatched = 0;
  const h = await createTurnHost(t, {
    acpPrompt(turn) {
      turn.update('合成 ACP 回复');
      switch (++dispatched) {
        case 1: first.resolve(turn); break;
        case 4: fourth.resolve(turn); break;
        default: turn.reply();
      }
    },
    apis: { onCancel: id => cancel.resolve(id) },
  });
  const id = await h.create();
  assert.deepEqual(ok(await h.select(id)), { selected: AGY_SELECTION });
  const agent = h.agent(id);
  const edit = (itemId, value, who) => h.post('session', 'updateQueue', {
    request: { sessionId: id, itemId, action: { kind: 'edit', content: [text(value)] } },
  }, who);
  const original = '待编辑的合成第二条';
  const edited = '编辑后保留的合成第二条';
  const requestId = randomUUID();
  const firstText = '先停止正在执行的合成第一条';
  assert.deepEqual(ok(await h.prompt(id, firstText)), accepted);
  const running = await waitFor(t, first.promise);
  let parked;
  try {
    assert.deepEqual(agent.model.current(), AGY_SELECTION);
    assert.equal(agent.status, 'running');
    assert.deepEqual(ok(await h.prompt(id, original, { requestId })), accepted);
    assert.equal(agent.inbox.nextTurn.length, 1);
    const [item] = agent.inbox.nextTurn;
    assert.equal(item.source.rpcId, requestId);
    assert.deepEqual(item.content, [text(original)]);

    assert.deepEqual(ok(await edit(item.id, edited)), accepted);
    parked = { ...item, content: [text(edited)] };
    assert.deepEqual(agent.inbox.nextTurn, [parked], 'edit preserves the occurrence and request identities');
    const beforeDeniedEdit = h.events(id);
    denied(await edit(item.id, '不应生效的 owner API 修改', 'api'), 'session/agent-busy');
    assert.deepEqual(h.events(id), beforeDeniedEdit);
    assert.deepEqual(agent.inbox.nextTurn, [parked]);
    assert.deepEqual(agent.inbox.nextStep, []);
    assert.equal(calls(h, 'session/prompt').length, 1);
    assert.deepEqual(ok(await h.cancel(id)), accepted);
    assert.equal(await waitFor(t, cancel.promise), running.sessionId);
  } finally {
    running.reply('cancelled');
    await h.idle(id);
  }

  assert.deepEqual(turnEnds(h, id).map(event => event.data.reason), [{ kind: 'aborted', reason: { kind: 'user' } }]);
  assert.deepEqual(agent.inbox.nextTurn, [parked]);
  const stopped = h.ledger.read(id);
  assert.equal(stopped.pending, null);
  assert.equal(stopped.stopReason, 'cancelled');
  const beforeRetry = h.events(id);
  assert.deepEqual(ok(await h.prompt(id, original, { requestId })), accepted);
  denied(await h.select(id, ORDINARY_SELECTION), 'session/model-unavailable');
  await h.idle(id);
  assert.deepEqual(h.events(id), beforeRetry, 'a duplicate receipt must not alter or wake the parked queue');
  assert.deepEqual(agent.inbox.nextTurn, [parked]);
  assert.deepEqual(agent.model.current(), AGY_SELECTION);
  assert.equal(calls(h, 'session/prompt').length, 1);

  const next = '新浏览器提交的合成第三条';
  const nextRequestId = randomUUID();
  assert.deepEqual(ok(await h.prompt(id, next, { requestId: nextRequestId })), accepted);
  await h.idle(id);
  assert.deepEqual(calls(h, 'session/prompt').map(call => call.params), [firstText, edited, next].map(value => ({
    sessionId: stopped.officialId, prompt: [text(value)],
  })));
  assert.deepEqual(userMessages(h, id).slice(1).map(message => [message.source.rpcId, message.content]), [
    [requestId, [text(edited)]], [nextRequestId, [text(next)]],
  ]);
  assert.equal(agent.inbox.hasPending, false);
  assert.deepEqual(turnEnds(h, id).map(event => event.data.reason.kind), ['aborted', 'completed', 'completed']);

  assert.deepEqual(ok(await h.prompt(id, '继续测试移除的合成第四条')), accepted);
  const removing = await waitFor(t, fourth.promise);
  const removedRequestId = randomUUID();
  try {
    assert.deepEqual(ok(await h.prompt(id, '将在原生队列移除的合成消息', { requestId: removedRequestId })), accepted);
    const [item] = agent.inbox.nextTurn;
    assert.equal(item.source.rpcId, removedRequestId);
    assert.deepEqual(ok(await h.post('session', 'updateQueue', {
      request: { sessionId: id, itemId: item.id, action: { kind: 'remove' } },
    })), accepted);
    assert.equal(agent.inbox.hasPending, false);
  } finally {
    removing.reply();
    await h.idle(id);
  }
  assert.equal(calls(h, 'session/prompt').length, 4);
  assert.equal(userMessages(h, id).some(message => message.source.rpcId === removedRequestId), false);
  assert.equal(calls(h, 'session/new').length, 1);
  assert.deepEqual(calls(h, 'session/load').map(call => call.params.sessionId), Array(3).fill(stopped.officialId));
  assert.deepEqual(h.ordinaryCalls, []);
});

installed('a full active ACP queue keeps a slot for the next Send after Stop', async t => {
  const entered = Promise.withResolvers(), cancelled = Promise.withResolvers();
  let initial = true;
  const h = await createTurnHost(t, {
    acpPrompt(turn) {
      if (initial) { initial = false; entered.resolve(turn); }
      else turn.reply();
    },
    apis: { onCancel: sessionId => cancelled.resolve(sessionId) },
  });
  const id = await h.create();
  ok(await h.select(id));
  const initialText = '暂停这一轮';
  ok(await h.prompt(id, initialText));
  const running = await waitFor(t, entered.promise);
  const waiting = Array.from({ length: 7 }, (_, index) => `合成队列 ${index + 1}`);
  let parkedIds;
  try {
    for (const value of waiting) assert.deepEqual(ok(await h.prompt(id, value)), accepted);
    parkedIds = h.agent(id).inbox.nextTurn.map(message => message.id);
    assert.equal(parkedIds.length, waiting.length);
    const before = h.events(id);
    denied(await h.prompt(id, '超出繁忙时的排队容量'), 'session/agent-busy');
    assert.deepEqual(h.events(id), before);
    assert.deepEqual(ok(await h.cancel(id)), accepted);
    assert.equal(await waitFor(t, cancelled.promise), running.sessionId);
  } finally {
    running.reply('cancelled');
    await h.idle(id);
  }
  assert.deepEqual(h.agent(id).inbox.nextTurn.map(message => message.id), parkedIds);
  assert.equal(calls(h, 'session/prompt').length, 1);
  const resumeText = '点击原生发送继续队列';
  assert.deepEqual(ok(await h.prompt(id, resumeText)), accepted);
  await h.idle(id);
  assert.equal(h.agent(id).inbox.hasPending, false);
  assert.deepEqual(calls(h, 'session/prompt').map(call => call.params), [initialText, ...waiting, resumeText].map(value => ({
    sessionId: running.sessionId, prompt: [text(value)],
  })));
});

installed('deleting the Workspace after the pending mark prevents any ACP prompt from dispatching', async t => {
  const marked = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await createTurnHost(t, { async afterLedgerWrite(id, row) {
    if (row.pending === null) return;
    marked.resolve({ id, row });
    await release.promise;
  } });
  const id = await h.create();
  ok(await h.select(id));
  const { workspace } = h;
  let pending;
  try {
    assert.deepEqual(ok(await h.prompt(id, '工作区移除前受理的合成输入')), accepted);
    const { id: markedId, row } = await waitFor(t, marked.promise);
    pending = row;
    assert.equal(markedId, id);
    assert.deepEqual(row.pending, { turn: 1 });
    assert.deepEqual(h.ledger.read(id), row);
    assert.ok(h.ctx.workspaceRegistry.get(workspace.id).sessionIds.includes(id));
    assert.equal(h.agent(id).status, 'running');
    assert.deepEqual(calls(h, 'session/prompt'), []);
    const deleted = await waitFor(t, h.post('workspace', 'delete', { request: { workspaceId: workspace.id } }));
    assert.deepEqual(ok(deleted), { deleted: true });
    assert.equal(h.ctx.workspaceRegistry.get(workspace.id), undefined);
  } finally {
    release.resolve();
    await h.idle(id);
  }

  assert.deepEqual(calls(h, 'session/prompt'), []);
  assert.deepEqual(calls(h, 'session/cancel'), []);
  assert.equal(calls(h, 'session/new').length, 1, 'setup could already have created an empty official session');
  // A denied final write shuts down the transport, so no further ACP command is sent.
  assert.deepEqual(calls(h, 'session/close'), []);
  assert.deepEqual(h.acpExits, [pending.officialId], 'the exact synthetic child has exited before native idle');
  assert.deepEqual(h.ledger.read(id), { ...pending, pending: null });
  assert.equal(pending.throughSeq, -1);
  assert.equal(pending.stopReason, undefined);
  assert.equal(h.events(id).some(event => event.type === 'assistant/message'), false);
  const before = h.events(id);
  denied(await h.prompt(id, '工作区移除后仍拒绝新输入'), 'session/agent-busy');
  assert.deepEqual(h.events(id), before);
  assert.deepEqual(calls(h, 'session/prompt'), []);
});
