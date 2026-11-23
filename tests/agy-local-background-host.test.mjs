import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply } from '../lib/agy-local-plugin.js';
import { openAgyMcp } from '../lib/agy-local-mcp.js';
import { backgroundSummary, isBackgroundNotice } from '../lib/agy-local-context.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

const model = { provider: 'antigravity', model: 'gemini-3-flash' };
const ok = result => assert.equal(result.ok, true, JSON.stringify(result));
const text = text => ({ type: 'text', text });
const usage = { sessionUpdate: 'usage_update', used: 19 };
const completed = { sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 'command' };
const prompts = h => h.acpCalls.filter(e => e.method === 'session/prompt');
const replies = (h, id) => h.events(id).filter(e => e.type === 'assistant/message').map(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join(''));
const notices = (h, id) => h.events(id).filter(e => e.type === 'user/message' && isBackgroundNotice(e.data));
const rpc = async (server, method, params) => (await fetch(server.url, { method: 'POST', headers: { authorization: server.headers[0].value },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
async function fixture(t, { send, timing, onBinding, ...options } = {}) {
  const sessions = new Set(), bindings = new Map(), turns = [];
  const h = await createTurnHost(t, { releasedReader: true, desktopRequests: true, ...options,
    acpPrompt(turn) { turns.push(turn); if (send) send(turn); else { turn.update('foreground'); turn.reply(); } },
    async mountSubscription({ scope, makeSession }) {
      apply(scope, { mcp: ['*'], backgroundTiming: { shortMs: 12, longMs: 1500, ...timing } }, () => ({
        async open(signal, { cwd, officialId, ...hooks } = {}) {
          const session = makeSession({ signal, cwd, ...hooks }); await session.open(officialId); sessions.add(session);
          return session;
        }, readBinding: id => bindings.get(id), async writeBinding(id, row, signal) { bindings.set(id, row); await onBinding?.(row, signal); },
        async dispose() { await Promise.all([...sessions].map(s => s.close())); },
      }));
    } });
  const id = await h.create(); ok(await h.select(id, model));
  return Object.assign(h, { id, turns, bindings });
}
async function start(h) { ok(await h.prompt(h.id, 'owner')); await h.idle(h.id); return h.turns[0]; }
function gateStep(agent, matches) {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const off = agent.ctx.on('agent/pre-step', async (p, next) => {
    if (matches(p.messages)) { entered.resolve(); await gate.promise; } return next();
  });
  return { entered: entered.promise, release() { gate.resolve(); off(); } };
}

test('native followup drains synchronous post-response frames and repeated waves with no second ACP prompt', { timeout: 12000 }, async t => {
  let first = true;
  const h = await fixture(t, { send(turn) {
    turn.update('foreground'); turn.reply();
    if (first) { first = false; turn.delta(completed); turn.update('early'); turn.delta(usage); }
  } });
  const { id } = h, turn = await start(h);
  assert.deepEqual(replies(h, id), ['foreground', 'early']);
  turn.delta(usage); turn.delta({ sessionUpdate: 'session_info_update', title: 'no wake' });
  assert.equal(h.agent(id).status, 'idle');
  turn.delta({ sessionUpdate: 'agent_thought_chunk', content: text('reflection') }); turn.update('later'); turn.delta(usage);
  await h.idle(id);
  assert.deepEqual(replies(h, id), ['foreground', 'early', 'later']);
  assert.equal(notices(h, id).length, 2); assert.equal(new Set(notices(h, id).map(e => e.data.id)).size, 2);
  assert.ok(notices(h, id).every(e => e.data.content.length === 0), 'native trigger uses summary, not model-facing text');
  assert.equal(prompts(h).length, 1); assert.equal(h.bindings.get(id).throughTurn, 3);
  ok(await h.prompt(id, 'next user')); await h.idle(id);
  assert.deepEqual(prompts(h).at(-1).params.prompt, [text('next user')]);
  h.agent(id).followup(notices(h, id)[0].data); await h.idle(id);
  assert.equal(prompts(h).length, 2, 'replay cannot revive a spent notice');
  assert.equal(h.events(id).findLast(e => e.type === 'turn/end').data.reason.kind, 'error');
  ok(await h.select(id, ORDINARY_SELECTION)); turn.update('wrong provider'); turn.delta(usage);
  assert.equal(h.agent(id).status, 'idle'); assert.equal(h.ordinaryCalls.length, 0);
});

test('a background-admitted Gemini parent can dispatch and resume a real native DSH subagent', { timeout: 12000 }, async t => {
  const childGate = Promise.withResolvers(); t.after(() => childGate.resolve());
  const h = await fixture(t, { nativeSubagents: { spawn: { agentOptions: model } }, send(turn) {
    if (turn.params.prompt.some(block => block.text?.includes('background child assignment'))) {
      void childGate.promise.then(() => { turn.update('child complete'); turn.reply(); });
    } else { turn.update('parent'); turn.reply(); }
  } });
  const { id } = h, turn = await start(h);
  turn.delta(completed);
  const sub = await rpc(turn.mcpServers[0], 'tools/call', { name: 'subagent', arguments: {
    name: 'worker', description: 'Run native fixture', prompt: 'background child assignment',
  } });
  assert.match(JSON.stringify(sub.result), /started subagent worker/);
  turn.update('background delegated'); turn.delta(usage); await h.idle(id);
  childGate.resolve();
  do { await h.idle(id); } while (await h.ctx.subagents.waitForTreeWork(h.agent(id)));
  assert.ok(prompts(h).some(e => e.params.prompt.some(block => block.text === 'background child assignment')));
  assert.ok(prompts(h).some(e => e.params.prompt.some(block => block.text?.includes('child complete'))));
  assert.equal(h.events(id).findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
});

for (const shape of ['mixed', 'owner-first', 'steer']) test(`background collision: ${shape} preserves wire output and sends owner text once`, { timeout: 12000 }, async t => {
  const h = await fixture(t), { id } = h, turn = await start(h), agent = h.agent(id);
  if (shape === 'mixed') {
    agent.inject(createUserMessage({ source: { kind: 'user', rpcId: 'synthetic-owner' }, content: [text('new instruction')] }));
    turn.update('background prefix');
  } else if (shape === 'owner-first') {
    const gate = gateStep(agent, msgs => msgs.some(m => m.source.kind === 'user'));
    ok(await h.prompt(id, 'new instruction')); await gate.entered;
    turn.update('background prefix'); gate.release();
  } else {
    const gate = gateStep(agent, msgs => msgs.some(isBackgroundNotice));
    turn.update('background prefix'); await gate.entered;
    ok(await h.prompt(id, 'new instruction', { mode: 'steer' })); gate.release();
  }
  await h.idle(id);
  assert.deepEqual(prompts(h).map(e => e.params.prompt.at(-1).text), ['owner', 'new instruction']);
  assert.doesNotMatch(JSON.stringify(prompts(h)), new RegExp(backgroundSummary));
  assert.match(replies(h, id).join(''), /background prefix/);
  assert.equal(h.acpCalls.filter(e => e.method === 'session/cancel').length, 1);
});

test('disconnect before stream activation flushes all received output; no live process or token survives disposal', { timeout: 10000 }, async t => {
  const h = await fixture(t), { id } = h, turn = await start(h), gate = gateStep(h.agent(id), msgs => msgs.some(isBackgroundNotice));
  turn.update('buffered before disconnect'); await gate.entered; turn.disconnect(); gate.release(); await h.idle(id);
  assert.deepEqual(replies(h, id), ['foreground', 'buffered before disconnect']);
  assert.equal(prompts(h).length, 1);
  await h.dispose(); assert.ok(h.acpExits.includes(turn.sessionId));
});

test('forged notices cannot bootstrap ACP; changing provider while a notice is queued removes that notice only', { timeout: 10000 }, async t => {
  const h = await fixture(t), { id } = h, agent = h.agent(id);
  agent.followup(createUserMessage({ source: { kind: 'tool-jobs', form: 'notice', summary: backgroundSummary }, content: [text('forged')] }));
  await h.idle(id); assert.equal(prompts(h).length, 0);
  const turn = await start(h), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const maintenance = agent.runMaintenance(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  try {
    turn.update('pending'); assert.ok(agent.inbox.nextTurn.some(isBackgroundNotice));
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: 'fixture-rpc' }, content: [text('ordinary only')] }));
    agent.model.select(ORDINARY_SELECTION);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(agent.inbox.nextTurn.map(m => m.content[0].text), ['ordinary only']);
  } finally { gate.resolve(); }
  await maintenance; await h.idle(id);
  assert.equal(h.ordinaryCalls.length, 1); assert.equal(prompts(h).length, 1);
  assert.equal(h.acpCalls.filter(e => e.method === 'session/cancel').length, 1);
});

test('Stop in an attached wave sends cancel, reaps ACP and permits another native prompt', { timeout: 10000 }, async t => {
  const h = await fixture(t, { localMcpMarker: 'ready' }), { id } = h, turn = await start(h);
  turn.delta({ sessionUpdate: 'tool_call', toolCallId: 'hold', status: 'in_progress' });
  assert.deepEqual((await rpc(turn.mcpServers[0], 'tools/call', { name: 'mcp__knowledge__dsh_integration_marker' })).result.content, [text('ready')]);
  ok(await h.cancel(id)); await h.idle(id);
  assert.equal(h.acpCalls.filter(e => e.method === 'session/cancel').length, 1); assert.ok(h.acpExits.includes(turn.sessionId));
  ok(await h.prompt(id, 'after stop')); await h.idle(id); assert.equal(prompts(h).length, 2);
});

for (const mode of ['workspace-write', 'danger-full-access']) test(`background ${mode} permissions use only the admitted DSH approval context`, { timeout: 10000 }, async t => {
  const answers = [], decisions = [], received = Promise.withResolvers(), decision = Promise.withResolvers();
  const h = await fixture(t, { localMcpMarker: 'ready', localPermissions: { mode, approval: 'ask', request({ reason }) { decisions.push(reason); if (reason === 'early') return 'rejected'; received.resolve(); return decision.promise; } },
    apis: { onPermissionReply(id, value) { answers.push([id, value.outcome]); } } });
  const { id } = h, turn = await start(h), gate = gateStep(h.agent(id), msgs => msgs.some(isBackgroundNotice));
  turn.delta(completed); await gate.entered;
  turn.ask('early', { toolCallId: 'early', kind: 'fetch', title: 'early' });
  const call = rpc(turn.mcpServers[0], 'tools/call', { name: 'mcp__knowledge__dsh_integration_marker' });
  gate.release(); assert.deepEqual((await call).result.content, [text('ready')]);
  turn.ask('review', { toolCallId: 'review', kind: 'fetch', title: 'review' }); await received.promise;
  turn.update('reviewed'); turn.delta(usage); decision.resolve('allowed-once');
  await h.idle(id); assert.deepEqual(decisions, ['early', 'review']);
  assert.deepEqual(answers, [['early', { outcome: 'selected', optionId: 'deny' }], ['review', { outcome: 'selected', optionId: 'allow' }]]);
  assert.deepEqual(replies(h, id), ['foreground', 'reviewed']);
});

for (const decision of ['allowed-once', 'rejected']) test(`permission-first wake waits for native admission: ${decision}`, { timeout: 10000 }, async t => {
  const replied = Promise.withResolvers(); let asks = 0;
  const h = await fixture(t, { localPermissions: { mode: 'workspace-write', approval: 'ask', request() { asks++; return decision; } },
    apis: { onPermissionReply(id, value) { if (id === 'first') replied.resolve(value.outcome); } } });
  const { id } = h, turn = await start(h), gate = gateStep(h.agent(id), msgs => msgs.some(isBackgroundNotice));
  turn.ask('first', { toolCallId: 'first', kind: 'fetch', title: 'permission before tool_call' });
  try { await gate.entered; assert.equal(asks, 0); } finally { gate.release(); }
  assert.deepEqual(await replied.promise, { outcome: 'selected', optionId: decision === 'allowed-once' ? 'allow' : 'deny' });
  turn.update('permission settled'); turn.delta(usage); await h.idle(id);
  assert.equal(asks, 1); assert.equal(notices(h, id).length, 1); assert.equal(prompts(h).length, 1);
});

test('a new ordinary prompt leaves detached ACP work alone on the same route', { timeout: 10000 }, async t => {
  const h = await fixture(t, { send(turn) { turn.delta({ sessionUpdate: 'tool_call', toolCallId: 'service', status: 'in_progress' }); turn.update('ok'); turn.reply(); } });
  const first = await start(h); ok(await h.prompt(h.id, 'next instruction')); await h.idle(h.id);
  assert.equal(h.turns[1].sessionId, first.sessionId); assert.ok(!h.acpExits.includes(first.sessionId));
  assert.equal(h.acpCalls.filter(e => e.method === 'session/cancel').length, 0);
});

test('an empty foreground reply after a preempted answer cannot spend the old answer or tool receipt', { timeout: 10000 }, async t => {
  const h = await fixture(t, { send(turn) { if (turn.params.prompt.at(-1).text === 'owner') turn.update('initial'); turn.reply(); } });
  const turn = await start(h), { id } = h;
  h.agent(id).inject(createUserMessage({ source: { kind: 'user', rpcId: 'real' }, content: [text('empty reply')] }));
  turn.delta(completed); turn.update('prefix only'); await h.idle(id);
  assert.equal(h.events(id).findLast(e => e.type === 'turn/end').data.reason.error.code, 'AGY_EMPTY_RESPONSE');
  assert.equal(prompts(h).length, 2);
});

test('switching between two Gemini models retires detached work before its first notice', { timeout: 10000 }, async t => {
  const cancelled = Promise.withResolvers();
  const h = await fixture(t, { apis: { onCancel: cancelled.resolve }, send(turn) {
    turn.delta({ sessionUpdate: 'tool_call', toolCallId: 'daemon', status: 'in_progress' }); turn.update('service started'); turn.reply();
  } });
  const turn = await start(h), { id } = h;
  ok(await h.select(id, { ...model, model: 'gemini-3.1-pro-high' })); await cancelled.promise;
  assert.equal(notices(h, id).length, 0); assert.equal(h.agent(id).status, 'idle');
  ok(await h.prompt(id, 'model B')); await h.idle(id); assert.ok(h.acpExits.includes(turn.sessionId));
});

test('tightening policy retires detached work even before it emits a new frame', { timeout: 10000 }, async t => {
  const localPermissions = { mode: 'workspace-write', approval: 'never' }, cancelled = Promise.withResolvers();
  const h = await fixture(t, { localPermissions, apis: { onCancel: cancelled.resolve }, send(turn) {
    turn.delta({ sessionUpdate: 'tool_call', toolCallId: 'task', status: 'in_progress' }); turn.update('pending task'); turn.reply();
  } });
  await start(h); localPermissions.mode = 'read-only';
  h.agent(h.id).session.append('sandbox/mode', { mode: 'read-only' }); await cancelled.promise;
  assert.equal(notices(h, h.id).length, 0);
});

test('a pre-step rejection returning to idle does not leave an undrained wake in nextTurn', { timeout: 10000 }, async t => {
  const cancelled = Promise.withResolvers(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const h = await fixture(t, { apis: { onCancel: cancelled.resolve } }), turn = await start(h), agent = h.agent(h.id);
  const off = agent.ctx.on('agent/pre-step', async ({ messages }, next) => {
    if (messages.some(m => m.content.some(b => b.text === 'reject this step'))) {
      entered.resolve(); await gate.promise; return { kind: 'reject' };
    } return next();
  });
  try {
    ok(await h.prompt(h.id, 'reject this step')); await entered.promise; turn.update('queued wave');
    assert.ok(agent.inbox.nextTurn.some(isBackgroundNotice)); gate.resolve(); await h.idle(h.id); await cancelled.promise;
    assert.ok(!agent.inbox.nextTurn.some(isBackgroundNotice));
  } finally { gate.resolve(); off(); }
});

test('wire terminal revokes the tools/call lease before an async checkpoint settles', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await fixture(t, { localMcpMarker: 'should not execute', onBinding(row) {
    if (row.throughTurn === 1) { entered.resolve(); return release.promise; }
  } });
  const { id } = h; ok(await h.prompt(id, 'owner')); await entered.promise;
  try { const denied = await rpc(h.turns[0].mcpServers[0], 'tools/call', { name: 'mcp__knowledge__dsh_integration_marker' });
    assert.equal(denied.error.code, -32602);
  } finally { release.resolve(); }
  await h.idle(id);
});

test('Stop racing background checkpoint I/O restores the prior durable turn', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await fixture(t, { onBinding(row, signal) { if (row.throughTurn === 2) { entered.resolve(signal); return release.promise; } } });
  const { id } = h, turn = await start(h); turn.update('tail'); turn.delta(usage);
  const signal = await entered.promise;
  try { ok(await h.cancel(id)); assert.equal(signal.aborted, true); } finally { release.resolve(); }
  await h.idle(id); assert.equal(h.bindings.get(id).throughTurn, 1);
  assert.equal(h.events(id).findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted');
});

test('Stop after stream finish but before native turn commit rolls the checkpoint back', { timeout: 10000 }, async t => {
  const h = await fixture(t), { id } = h, turn = await start(h), agent = h.agent(id);
  const reached = Promise.withResolvers();
  const off = agent.ctx.on('agent/turn-stopping', ({ turn, signal }) => {
    if (turn !== 2) return;
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    reached.resolve(); return aborted;
  });
  try {
    turn.update('finished on wire'); turn.delta(usage); await reached.promise;
    assert.equal(h.bindings.get(id).throughTurn, 2, 'stream has written its provisional checkpoint');
    ok(await h.cancel(id)); await h.idle(id);
    assert.equal(h.events(id).findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted');
    assert.equal(h.bindings.get(id).throughTurn, 1, 'host did not commit this turn');
  } finally { off(); }
});

for (const purpose of ['session-title', 'compaction']) test(`${purpose} omits even a legacy notice body`, async t => {
  const h = await fixture(t); const real = createUserMessage({ source: { kind: 'user' }, content: [text('actual content')] });
  const legacy = createUserMessage({ source: { kind: 'tool-jobs', form: 'notice', summary: backgroundSummary }, content: [text('legacy synthetic payload')] });
  const job = createUserMessage({ source: { kind: 'tool-jobs', form: 'notice', summary: 'Local report finished' }, content: [text('report output: 42 rows')] });
  const chunks = await Array.fromAsync(h.ctx.llm.stream({ ...model, sessionId: h.id, purpose, messages: [real, legacy, job] }));
  assert.match(prompts(h)[0].params.prompt[0].text, /report output: 42 rows/);
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.match(prompts(h)[0].params.prompt[0].text, /actual content/);
  assert.doesNotMatch(prompts(h)[0].params.prompt[0].text, /legacy synthetic payload/);
});

test('expired unclaimed wave withdraws only its token and cancels early permissions', { timeout: 10000 }, async t => {
  const timeout = Promise.withResolvers(), cancelled = Promise.withResolvers(); let approvals = 0;
  const h = await fixture(t, { timing: { claimMs: 12345, arm(fn, ms) { if (ms === 12345) timeout.resolve(fn); return setTimeout(fn, ms); } },
    apis: { onCancel: cancelled.resolve }, localPermissions: { mode: 'workspace-write', approval: 'ask', request() { approvals++; return 'allowed-once'; } } });
  const turn = await start(h), agent = h.agent(h.id), release = Promise.withResolvers();
  const maintenance = agent.runMaintenance(() => release.promise);
  try {
    turn.delta(completed); turn.ask('early', { toolCallId: 'early', kind: 'fetch', title: 'early' });
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: 'next' }, content: [text('survives')] }));
    (await timeout.promise)(); await cancelled.promise; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(agent.inbox.nextTurn.map(m => m.content[0].text), ['survives']);
  } finally { release.resolve(); }
  await maintenance; await h.idle(h.id); assert.equal(approvals, 0); assert.equal(prompts(h).length, 2);
});

test('MCP wait belongs to one wave only: early call waits, cancellation cannot hand it to the next turn', { timeout: 10000 }, async t => {
  const bridge = await openAgyMcp({}); t.after(() => bridge.close()); const server = bridge.servers[0];
  for (const action of ['cancel', 'activate']) {
    const controller = new AbortController(), waiting = Promise.withResolvers();
    const wave = { signal: controller.signal, mcpCount(count) { if (count) waiting.resolve(); } };
    bridge.beginWave(wave);
    const pending = rpc(server, 'tools/call', { name: 'no-tool' }); await waiting.promise; assert.equal(bridge.inFlight, 1);
    let checked = 0;
    const turn = { wave, signal: wave.signal, canCall() { checked++; return false; } };
    if (action === 'cancel') controller.abort();
    bridge.setTurn(turn); const reply = await pending;
    assert.equal(reply.error.code, -32602); assert.equal(checked, action === 'cancel' ? 0 : 1);
    assert.equal(bridge.inFlight, 0); controller.abort(); bridge.setTurn(undefined);
  }
});
