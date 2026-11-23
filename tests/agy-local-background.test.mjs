import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundEvent, backgroundWave } from '../src/agy-local-background.js';
import { backgroundSummary, localHistory } from '../src/agy-local-context.js';

const text = value => ({ kind: 'text', value });
const usage = { kind: 'usage', value: { used: 9 } };
const tool = (id, status) => ({ kind: 'tool', value: { sessionUpdate: 'tool_call_update', toolCallId: id, status } });

function fixture(options = {}) {
  const timers = new Map(); let next = 0;
  const wave = backgroundWave({ token: 'fixture', activeTools: new Set(['first']), shortMs: 2, longMs: 45, ...options,
    arm(fn, ms) { timers.set(++next, { fn, ms }); return next; }, disarm(id) { timers.delete(id); } });
  const delays = () => [...timers.values()].map(value => value.ms);
  return { wave, timers, delays };
}
test('wire wave waits for every tool, native HTTP call and permission; only a post-answer usage gets a short tail', async () => {
  const { wave, timers, delays } = fixture();
  const decision = Promise.withResolvers();
  wave.push(usage); wave.attach(() => decision.promise); assert.deepEqual(delays(), [45], 'inherited tools do not block');
  wave.push(tool('first', 'completed')); assert.deepEqual(delays(), [45]);
  wave.push(usage); assert.deepEqual(delays(), [45]);
  wave.push(text('answer')); assert.deepEqual(delays(), [45]);
  wave.push(usage); assert.deepEqual(delays(), [2]);
  const stale = [...timers.keys()][0];
  wave.push({ kind: 'thought', value: 'thinking' }); assert.deepEqual(delays(), [45]); assert.ok(!timers.has(stale));
  wave.push(tool('a', 'in_progress')); wave.push(tool('b', 'pending')); wave.push(usage);
  wave.push(tool('b', 'cancelled')); assert.deepEqual(delays(), [45]);
  wave.mcpCount(2); wave.push(tool('a', 'failed')); wave.mcpCount(1); assert.deepEqual(delays(), []);
  const review = wave.permission({ id: 'review' });
  wave.push(text('final')); wave.push(usage); wave.mcpCount(0); assert.deepEqual(delays(), []);
  decision.resolve(true); assert.equal(await review, true); assert.deepEqual(delays(), [2]);
  [...timers.values()][0].fn(); assert.equal(wave.signal.aborted, true); assert.deepEqual(delays(), []);
  assert.equal(wave.chunks.filter(e => e.kind === 'text').length, 2); assert.deepEqual(wave.usage, { used: 9 });
  wave.push(text('stale')); assert.ok(!wave.chunks.some(e => e.value === 'stale'));
});

test('daemon and inherited tools cannot keep a finished generation open; usage heartbeats do not extend its deadline', () => {
  const { wave, timers, delays } = fixture(); wave.attach(); wave.push(tool('first', 'in_progress'));
  assert.deepEqual(delays(), [45]);
  const daemon = tool('service', 'in_progress'); daemon.value.sessionUpdate = 'tool_call'; daemon.value.rawInput = { IsDaemon: true };
  wave.push(daemon); assert.deepEqual(delays(), [45]);
  wave.push(text('service started')); wave.push(usage); assert.deepEqual(delays(), [2]);
  const id = [...timers.keys()][0]; wave.push(usage); wave.push({ ...usage, value: { used: 10 } });
  assert.deepEqual([...timers.keys()], [id]); assert.deepEqual(wave.usage, { used: 10 });
  assert.equal(backgroundEvent({ sessionUpdate: 'usage_update', used: -1 }), undefined);
  wave.mcpCount(1); assert.deepEqual(delays(), []); wave.mcpCount(0); assert.deepEqual(delays(), [2]);
  wave.push({ kind: 'thought', value: 'more' }); assert.deepEqual(delays(), [45]);
  const fallback = [...timers.keys()][0]; wave.push(usage); wave.push(usage);
  assert.deepEqual([...timers.keys()], [fallback]); timers.get(fallback).fn();
  assert.equal(wave.sealed, true); assert.deepEqual(delays(), []);
});

test('wave overflow bounds bytes, events and tools; abandoned permission waiters never execute on later attach', async () => {
  for (const [budget, events] of [[{ maxBytes: 3 }, [text('好好')]], [{ maxEvents: 1 }, [text('a'), text('b')]],
    [{ maxTools: 1 }, [tool('first', 'completed'), tool('second', 'completed')]]]) {
    let reason; const { wave, delays } = fixture({ ...budget, onRetire: value => { reason = value; } });
    const review = wave.permission({}); events.forEach(e => wave.push(e)); assert.equal(reason, 'overflow');
    wave.attach(() => assert.fail('stale permission')); assert.deepEqual((await review).outcome, { outcome: 'cancelled' }); assert.deepEqual(delays(), []);
  }
  let reason; const { wave, timers, delays } = fixture({ claimMs: 15, waitMs: 5, onRetire: value => { reason = value; } });
  const request = wave.permission({}); const wait = [...timers.values()].find(t => t.ms === 5); wait.fn();
  assert.deepEqual((await request).outcome, { outcome: 'cancelled' }); assert.deepEqual(delays(), [15]);
  [...timers.values()][0].fn(); assert.deepEqual(delays(), []); assert.equal(reason, 'unclaimed');
});

test('metadata and malformed output do not qualify; background history keeps only committed assistant text', () => {
  for (const update of [null, { sessionUpdate: 'available_commands_update' }, { sessionUpdate: 'session_info_update' },
    { sessionUpdate: 'tool_call', toolCallId: '' }, { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } }]) {
    assert.equal(backgroundEvent(update), undefined);
  }
  const events = []; const append = (type, data) => events.push({ seq: events.length, type, data, surfaceOp: 'append' });
  const record = (turn, provider, reason) => {
    append('turn/start', { turn });
    append('user/message', { source: { kind: 'tool-jobs', form: 'notice', summary: backgroundSummary }, content: [{ type: 'text', text: 'never a user request' }] });
    append('assistant/message', { turn, message: { source: { provider }, content: [{ type: 'text', text: `answer ${turn}` }] } });
    append('turn/end', { turn, reason: { kind: reason } });
  };
  record(1, 'antigravity', 'completed'); record(2, 'other', 'completed'); record(3, 'antigravity', 'aborted');
  const session = { snapshotEvents: () => events }; const history = localHistory(session, 20, 0);
  assert.match(history, /answer 1/); assert.doesNotMatch(history, /answer [23]|never a user request/);
  assert.equal(localHistory(session, 20, 1), undefined);
});
