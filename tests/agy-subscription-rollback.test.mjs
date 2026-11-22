import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

// The exact route shared by the candidate and the legacy adapter. Keep this
// test independent of either implementation, including their model registries.
const GOOGLE = { provider: 'antigravity', model: 'gemini-3.1-pro-high' };
const stock = { releasedReader: true, desktopRequests: true };
const options = { timeout: 20_000 };
const text = text => ({ type: 'text', text });
const savedInput = value => createUserMessage({ content: [text(value)], source: { kind: 'user', rpcId: randomUUID() } });
const ok = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};

async function reopenSaved(t, { pending = true } = {}) {
  assert.equal(SESSION_FORMAT_VERSION, 4);
  const seed = await createTurnHost(t, stock);
  const id = SessionId(`synthetic-google-rollback-${randomUUID()}`);
  const earlier = savedInput('Synthetic earlier ordinary question');
  const answer = createAssistantMessage({ content: [text('Synthetic earlier ordinary answer')], source: ORDINARY_SELECTION });
  const parked = pending ? savedInput('合成谷歌订阅待发正文\n第二行') : undefined;
  const step = { turn: 1, step: 1 };
  const records = [
    ['turn/start', { turn: 1 }],
    ['step/start', step],
    ['user/message', earlier, 'append'],
    ['request/header', { header: { config: ORDINARY_SELECTION }, reason: 'initial' }],
    ['assistant/message', { ...step, message: answer, stream: [] }, 'append'],
    ['step/end', step],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ['model/selection', GOOGLE],
  ];
  if (parked) records.push(['agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [parked] }]);

  // Write the durable state left at the crash point. No live Session or Agent
  // is created in the writer Host, so its disposal cannot clear the inbox.
  const writer = await seed.ctx.sessionPersistence.create({ version: 4, id, createdAt: 1000, isSeeded: false, cwd: seed.cwd, agentPreset: 'fixture' });
  try {
    await writer.append(records.map(([type, data, surfaceOp], seq) => ({ seq, time: 1001 + seq, type, data, ...(surfaceOp ? { surfaceOp } : {}) })));
  } finally { await writer.close(); }
  assert.equal(seed.agent(id), undefined);
  assert.equal(seed.ctx.sessions.get(id), undefined);
  await seed.dispose();

  const h = await createTurnHost(t, { ...stock, root: seed.root });
  assert.equal(h.agent(id), undefined);
  assert.equal(h.ctx.sessions.get(id), undefined);
  assert.deepEqual(h.ctx.llm.listProviders().map(provider => provider.id), [ORDINARY_SELECTION.provider]);
  const { agent, error } = await h.ctx.sessionController.resolveAgent(id);
  assert.ok(agent, error?.message);
  assert.equal(agent.session.header.id, id);
  assert.equal(agent.session.header.version, 4);
  assert.deepEqual(agent.model.current(), GOOGLE);
  assert.deepEqual(agent.inbox.nextTurn, parked ? [parked] : []);
  assert.equal(agent.status, 'idle');
  assert.deepEqual(h.ordinaryCalls, []);
  return { h, id, agent, history: [earlier, answer], parked };
}

function restoreFakeLegacy(h) {
  const calls = [];
  class FakeLegacy extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: GOOGLE.model, name: 'Synthetic legacy Antigravity' }]; }
    async *stream(request) {
      calls.push(request);
      const reply = 'Synthetic legacy Antigravity reply';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'block-end', index: 0, block: text(reply) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  h.ctx.llm.registerAdapter([GOOGLE.provider], new FakeLegacy());
  return calls;
}

function conversation(call, id, selection) {
  const { sessionId, provider, model, purpose, messages } = call;
  assert.deepEqual({ sessionId, provider, model }, { sessionId: id, ...selection });
  assert.equal(purpose, undefined);
  return messages.filter(message => message.role === 'assistant' || message.source.kind === 'user');
}

async function wake(h, id, agent, value) {
  assert.deepEqual(ok(await h.prompt(id, value)), { accepted: true });
  await h.idle(id);
  assert.equal(h.agent(id), agent);
  assert.equal(agent.inbox.hasPending, false);
  assert.deepEqual(h.acpCalls, []);
  assert.deepEqual(h.events(id).findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' });
}

test('stock rc.5 binds the saved Google selection to the restored legacy adapter and sends history plus the parked prompt', options, async t => {
  const { h, id, agent, history, parked } = await reopenSaved(t);
  const calls = restoreFakeLegacy(h);
  await wake(h, id, agent, 'Synthetic wake after legacy restoration');

  assert.deepEqual(h.selects, [], 'the saved route binds without a fresh model selection');
  assert.deepEqual(h.ordinaryCalls, []);
  assert.equal(calls.length, 2, 'the parked prompt runs before the new wake prompt');
  assert.deepEqual(conversation(calls[0], id, GOOGLE), [...history, parked]);
});

test('stock rc.5 sends the parked Google prompt to ordinary after the user selects ordinary and wakes', options, async t => {
  const { h, id, agent, history, parked } = await reopenSaved(t);
  assert.deepEqual(ok(await h.select(id, ORDINARY_SELECTION)), { selected: ORDINARY_SELECTION });
  assert.deepEqual(agent.inbox.nextTurn, [parked], 'changing the selection keeps the same queued input');
  assert.deepEqual(h.ordinaryCalls, [], 'selecting ordinary does not wake the inbox');
  await wake(h, id, agent, 'Synthetic ordinary wake');

  assert.equal(h.ordinaryCalls.length, 2);
  assert.deepEqual(conversation(h.ordinaryCalls[0], id, ORDINARY_SELECTION), [...history, parked]);
});

test('stock rc.5 retains the saved Google route even with an empty inbox and sends history on the first new prompt', options, async t => {
  const { h, id, agent, history } = await reopenSaved(t, { pending: false });
  assert.equal((await h.select(id, GOOGLE)).error?.code, 'session/model-unavailable');
  const calls = restoreFakeLegacy(h);
  const draft = 'Synthetic first prompt after clean rollback';
  await wake(h, id, agent, draft);

  assert.deepEqual(h.selects, []);
  assert.deepEqual(h.ordinaryCalls, []);
  assert.equal(calls.length, 1);
  const messages = conversation(calls[0], id, GOOGLE);
  assert.deepEqual(messages.slice(0, -1), history);
  assert.equal(messages.at(-1).role, 'user');
  assert.deepEqual(messages.at(-1).content, [text(draft)]);
});
