import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { AgyAcpClient } from '../src/agy-acp-client.js';
import { AGY_TURN_EXECUTOR_PROVIDER, mountAgyTurnExecutor } from '../src/agy-turn-executor.js';
import { parseAgyTurnOptions } from '../src/agy-turn-options.js';
import { createAgyTurnSession } from '../src/agy-turn-session.js';

const provider = AGY_TURN_EXECUTOR_PROVIDER;
const selection = Object.freeze({ provider, model: 'm-a' });
const cwd = resolve('synthetic-closed-workspace');
const officialId = 'synthetic-official-session';
const text = value => ({ type: 'text', text: value });
const human = (value, overrides = {}) => Object.freeze({
  id: 'fixture-human', role: 'user', content: [text(value)], source: { kind: 'user' }, ...overrides,
});
const configOption = (category, currentValue, values) => ({ type: 'select', id: category, name: category,
  category, currentValue, options: values.map(value => ({ value, name: value })),
});
const configOptions = (effort = 'e-a') => [configOption('model', 'm-a', ['m-a', 'm-b']),
  configOption('thought_level', effort, ['e-a', 'e-b'])];
const baseRow = (agent, overrides = {}) => ({
  createdAt: agent.session.header.createdAt, cwd: agent.session.header.cwd,
  officialId, throughSeq: -1, pending: null, ...overrides,
});

// This fixture models native leases and sends real ACP frames over fake pipes.
// Delaying the response's write callback independently of stdout exposes the
// window after admission when a prompt is queued but has not reached stdin.
function fakeChild(onFrame, holdWrite) {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new EventEmitter() });
  child.send = frame => child.stdout.write(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`));
  child.stdin.write = (bytes, done) => {
    const frame = JSON.parse(bytes.toString('utf8'));
    onFrame(frame);
    if (holdWrite && frame.method === 'session/new') holdWrite(done, child.send);
    else done();
    return false;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit'));
  child.stdin.destroy = () => {};
  child.kill = () => queueMicrotask(() => child.emit('exit'));
  return child;
}
function makeFixture(setup = {}) {
  const events = [], trace = [], deltas = [], effects = [], rows = new Map();
  const agent = {
    id: 'fixture-native-session', status: 'idle', activeTurnProvider: undefined, inbox: { nextTurn: [], nextStep: [] },
    session: { header: { id: 'fixture-native-session', createdAt: 1000, cwd, isSeeded: false },
      get seq() { return events.length; }, eventAt(seq) { return events[seq]; } },
  };
  const root = setup.root ?? { fiber: {} };
  const caller = { fiber: {}, root };
  let registration, current, authority = true, liveWorkspace = true;
  const append = (type, data, surfaceOp = undefined) => {
    const event = Object.freeze({ type, seq: events.length, data, ...(surfaceOp && { surfaceOp }) });
    events.push(event);
    return event;
  };
  const ledger = setup.ledger ?? {
    read(id) { return rows.get(id); },
    async write(id, row) {
      const save = () => rows.set(id, Object.freeze(structuredClone(row)));
      trace.push(['ledger', id, structuredClone(row)]);
      if (setup.write) await setup.write(id, row, save);
      else save();
    },
  };

  caller.effect = factory => {
    const cleanup = factory();
    let disposed;
    const stop = () => disposed ??= cleanup();
    effects.push(stop);
    return stop;
  };
  caller.agentLoop = {
    registerTurnExecutor(key, executor) {
      assert.equal(this, caller.agentLoop);
      assert.equal(registration, undefined);
      assert.equal(key, provider);
      registration = { key, executor, available: true };
      return caller.effect(() => async () => {
        registration.available = false;
        trace.push(['revoke']);
        current?.controller.abort({ kind: 'disposed' });
        await current?.done.promise;
      });
    },
  };

  const caps = {
    enabled: true,
    authorize: setup.authorize ?? (() => true),
    assertAuthority(...args) {
      trace.push(['authority', rows.get(agent.id)?.pending]);
      return setup.assertAuthority ? setup.assertAuthority(...args) : authority && liveWorkspace;
    },
    verifyWorkspace(...args) {
      const pending = rows.get(agent.id)?.pending;
      trace.push(['verify-workspace', pending]);
      return setup.verifyWorkspace ? setup.verifyWorkspace(pending, ...args) : liveWorkspace ? cwd : undefined;
    },
    ledger,
    async readEvents(session, from, to, signal) {
      assert.equal(session, agent.session);
      assert.equal(signal, current.controller.signal);
      trace.push(['read-events', from, to]);
      const range = events.slice(from, to);
      return setup.readEvents ? setup.readEvents(range, signal) : range;
    },
    makeSession({ cwd: sessionCwd }) {
      trace.push(['make-session']);
      if (setup.makeSession) return setup.makeSession({ cwd: sessionCwd });
      let currentConfig = configOptions();
      const session = createAgyTurnSession({ cwd: sessionCwd, timeLimits: { open: 1500, turn: setup.turnTimeout ?? 1500, cancel: 500 }, makeClient(hooks) {
        const pipe = fakeChild(({ id, method, params }) => {
          trace.push(method === 'initialize' ? [method] : [method, params]);
          const reply = result => pipe.send({ id, result });
          switch (method) {
            case 'initialize': return reply({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: 'synthetic' },
              agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } });
            case 'session/new':
            case 'session/load': return reply({ sessionId: officialId, configOptions: currentConfig });
            case 'session/set_config_option':
              currentConfig = configOptions(params.value);
              return reply({ configOptions: currentConfig });
            case 'session/close': return reply({});
            case 'session/cancel': return;
            case 'session/prompt': {
              const update = (value, sessionId = officialId) => pipe.send({ method: 'session/update', params: { sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: text(value) } } });
              const disconnect = () => pipe.emit('exit');
              if (setup.prompt) return setup.prompt({ params, update, reply, disconnect });
              return reply({ stopReason: 'end_turn' });
            }
            default: assert.fail(`Unexpected ACP method ${method}`);
          }
        }, setup.holdWrite);
        const client = new AgyAcpClient({ executable: process.execPath, cwd: sessionCwd, env: {}, timeoutMs: 1500,
          spawnFactory: () => pipe, ...hooks });
        return {
          start: () => client.start(),
          request(method, params, opts) {
            const pending = client.request(method, params, opts);
            if (method === 'session/prompt') setup.promptQueued?.();
            return pending;
          },
          notify: (method, params) => client.notify(method, params),
          async close() { trace.push(['transport-close']); await client.close(); await setup.reap?.(); },
        };
      } });
      // Catch any attempt to replace the native Stop signal before entering ACP.
      return Object.freeze({ get id() { return session.id; }, open: session.open, prepare: session.prepare, close: session.close,
        runTurn(prompt, input) {
          assert.equal(input.signal, current.controller.signal);
          setup.beforeDispatch?.();
          return session.runTurn(prompt, input);
        } });
    },
    ...setup.capabilities,
  };
  const handle = mountAgyTurnExecutor(caller, caps);

  function offer(phase, message, previous, selected = selection, subject = agent) {
    return registration.available && registration.executor.authorize(Object.freeze({
      phase, agent: subject, selection: selected, message, ...(previous ? { previous } : {}),
    }));
  }

  function claim(turn, message = human('本轮输入'), selected = selection) {
    assert.equal(current, undefined);
    agent.status = 'running';
    agent.activeTurnProvider = provider;
    append('turn/start', { turn });
    assert.equal(offer('claim', message, undefined, selected), true);
    // The stored UserMessage may be a detached copy of the admitted occurrence.
    const stored = structuredClone(message);
    append('step/start', { turn, step: 1 });
    append('user/message', stored, 'append');
    append('agent/inbox/spliced', { target: 'next-turn', removedCount: 1 });
    const controller = new AbortController();
    const done = Promise.withResolvers();
    let running = false;
    const input = Object.freeze({ agent, message: stored, selection: selected, turn, signal: controller.signal,
      assertDispatchable() {
        trace.push(['native-lease', rows.get(agent.id)?.pending]);
        controller.signal.throwIfAborted();
        if (!running || !registration.available) throw new Error('synthetic-private native lease failure');
        setup.assertDispatchable?.();
      },
      writeText(value) { if (running) deltas.push(value); },
    });
    const job = current = {
      input, controller, done,
      async run() {
        trace.push(['core-admission-durable']);
        if (controller.signal.aborted || !registration.available) return undefined;
        running = true;
        try { return await registration.executor.run(input); }
        finally { running = false; }
      },
      appendEnd(kind) { return append('turn/end', { turn, reason: { kind } }); },
      async commit(end) {
        trace.push(['core-end-durable', end.seq]);
        await registration.executor.afterCommit(input, end);
      },
      async finish() {
        try { await registration.executor.release(input); }
        finally {
          agent.activeTurnProvider = undefined;
          agent.status = 'idle';
          current = undefined;
          done.resolve();
        }
      },
    };
    return job;
  }

  return { agent, append, caps, claim, deltas, handle, offer, trace, rows, ledger, get executor() { return registration.executor; },
    revokeAuthority() { authority = false; }, detachWorkspace() { liveWorkspace = false; },
    close: async () => { for (const cleanup of [...effects].reverse()) await cleanup(); },
  };
}

const calls = (fixture, name) => fixture.trace.filter(([label]) => label === name);
const pending = fixture => fixture.ledger.read(fixture.agent.id)?.pending;
const publicCode = (result, code) => { assert.equal(result.kind, 'error'); assert.equal(result.error.code, code); };
const bounded = (name, run) => test(name, { timeout: 5000 }, run);

bounded('only explicit opt-in from the owning Host fiber invokes native registration', async () => {
  let registrations = 0;
  const root = { fiber: {} };
  root.root = root;
  root.effect = () => assert.fail('root effects are unavailable');
  root.agentLoop = { registerTurnExecutor() { registrations++; } };
  assert.throws(() => mountAgyTurnExecutor(root), { code: 'agy/turn-disabled' });
  assert.throws(() => mountAgyTurnExecutor({ root, fiber: {}, agentLoop: {} }, { enabled: true }), { code: 'agy/native-turn-required' });
  assert.throws(() => mountAgyTurnExecutor(root, { enabled: true }), { code: 'agy/plugin-owner-required' });
  assert.equal(registrations, 0);
  const f = makeFixture({ capabilities: { options: parseAgyTurnOptions(configOptions()), defaultEffort: 'e-a' } });
  assert.equal(provider, 'turn:antigravity');
  assert.deepEqual(f.handle.catalogGroup, { id: provider, name: 'Antigravity', input: 'text-only', models: [
    { id: 'm-a', name: 'm-a', reasoning: { defaultEffort: 'e-a', efforts: [{ id: 'e-a', name: 'e-a' }, { id: 'e-b', name: 'e-b' }] } },
    { id: 'm-b', name: 'm-b' },
  ] });
  assert.ok(Object.isFrozen(f.handle.catalogGroup.models[0].reasoning.efforts[0]));
  assert.equal(f.handle.run, undefined);
  assert.equal(f.handle.checkPrompt(f.agent, selection, [text('合成预检')]), true);
  assert.deepEqual(f.trace, []);
  await f.handle.dispose();
  await f.close();
  assert.equal(f.handle.catalogGroup, undefined);
  assert.equal(f.executor.authorize({ agent: f.agent, selection, phase: 'enqueue', message: human('no') }), false);
  assert.deepEqual(f.trace, [['revoke']]);
});

bounded('admission forwards the exact witness input and rejects non-Human, non-native and oversized inputs', async () => {
  const witness = [], original = human('提交的正文'), edited = human('编辑后的正文');
  let allow = true;
  const f = makeFixture({ authorize(input) { witness.push(input); return allow; } });
  for (const content of [[], [text(' \n')], [text('允许'), { type: 'image' }], [text('中'.repeat(22_000))], Array(65).fill(text('a'))]) {
    assert.throws(() => f.handle.checkPrompt(f.agent, selection, content), { code: 'agy/prompt-unavailable' });
    assert.equal(f.offer('enqueue', human('', { content })), false);
  }
  for (const source of [{ kind: 'schedule' }, { kind: 'retry' }, { kind: 'tool' }, { kind: 'user', principal: { kind: 'remote' } }]) {
    assert.equal(f.offer('enqueue', human('不转发', { source })), false);
  }
  for (const patch of [{ parentSession: 'parent' }, { origin: 'subagent' }, { isSeeded: true }, { cwd: 'relative' }, { delegationDepth: 1 }]) {
    const subject = { ...f.agent, session: { ...f.agent.session, header: { ...f.agent.session.header, ...patch } } };
    assert.equal(f.offer('enqueue', original, undefined, selection, subject), false);
  }
  assert.equal(f.offer('enqueue', original, undefined, { provider: 'antigravity-cli', model: 'm-a' }), false);
  assert.equal(f.offer('enqueue', original, undefined, { ...selection, reasoningEffort: 'invalid\n' }), false);
  assert.equal(f.offer('edit', edited, human('另一条', { id: 'different-id' })), false);
  assert.deepEqual(witness, []);
  allow = 1;
  assert.equal(f.offer('enqueue', original), false);
  allow = Promise.reject(new Error('synthetic private rejected policy'));
  assert.equal(f.offer('enqueue', original), false);
  allow = true;
  assert.equal(f.offer('enqueue', original), true);
  assert.equal(f.offer('edit', edited, original), true);
  assert.equal(f.offer('claim', edited), true);
  assert.deepEqual(witness.map(input => input.phase), ['enqueue', 'enqueue', 'enqueue', 'edit', 'claim']);
  assert.equal(witness.at(-2).previous, original);
  assert.equal(witness.at(-2).message, edited);
  assert.equal(witness.at(-2).agent, f.agent);
  assert.equal(witness.at(-2).selection, selection);
  assert.deepEqual(f.trace, []);
  await f.close();
});

bounded('the synthetic history opt-in sends only visible text and advances the cursor after the matching durable end', async () => {
  const f = makeFixture({ prompt({ update, reply }) {
    update('wrong session', 'other-id');
    update('合成首片');
    update('合成尾片');
    reply({ stopReason: 'end_turn' });
  }, capabilities: { includeDshHistory: true, options: parseAgyTurnOptions(configOptions()), defaultEffort: 'e-b' } });
  f.append('turn/start', { turn: 1 });
  f.append('system/message', { message: 'synthetic-private system instructions' }, 'append');
  f.append('user/message', human('旧轮正文'), 'append');
  f.append('tool/result', { message: 'synthetic-private tool result' }, 'append');
  f.append('assistant/message', { turn: 1, message: { role: 'assistant', id: 'fixture-a1', content: [
    text('旧轮可见回复'), { type: 'reasoning', text: 'synthetic-private reasoning' },
  ] } }, 'append');
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const job = f.claim(2, human('本轮', { content: [text('本轮'), text('继续')] }));
  assert.equal(f.handle.isActive(f.agent), true, 'the pinned route also covers the native checkpoint');
  assert.deepEqual(f.trace, []);
  assert.deepEqual(await job.run(), { kind: 'completed' });
  assert.deepEqual(f.deltas, ['合成首片', '合成尾片']);
  assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent, { pending: { turn: 2 } }));
  const [, request] = calls(f, 'session/prompt')[0];
  const history = request.prompt[0].text;
  assert.deepEqual(JSON.parse(history.slice(history.indexOf('\n') + 1)), [
    { role: 'user', content: [text('旧轮正文')] }, { role: 'assistant', content: [text('旧轮可见回复')] },
  ]);
  assert.deepEqual(request.prompt[1], text('本轮\n继续'));
  assert.doesNotMatch(JSON.stringify(request), /synthetic-private|fixture-human|reasoning/);
  assert.deepEqual(calls(f, 'session/set_config_option'), [['session/set_config_option', { sessionId: officialId,
    configId: 'thought_level', value: 'e-b' }]]);
  const sendIndex = f.trace.findIndex(([label]) => label === 'session/prompt');
  assert.deepEqual(f.trace.slice(sendIndex - 3, sendIndex), [
    ['verify-workspace', { turn: 2 }], ['authority', { turn: 2 }], ['native-lease', { turn: 2 }],
  ]);
  assert.ok(f.trace.findIndex(([label]) => label === 'core-admission-durable') < f.trace.findIndex(([label]) => label === 'make-session'));
  assert.ok(f.trace.findIndex(([label, , row]) => label === 'ledger' && row.pending) < sendIndex);
  const end = job.appendEnd('completed');
  await f.executor.afterCommit({ ...job.input }, end);
  await f.executor.release({ ...job.input });
  assert.equal(calls(f, 'session/close').length, 0);
  assert.deepEqual(pending(f), { turn: 2 });
  await job.commit(end);
  assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent, { throughSeq: end.seq, stopReason: 'end_turn' }));
  await job.commit(end);
  await job.finish();
  assert.equal(calls(f, 'session/close').length, 1);
  assert.equal(calls(f, 'transport-close').length, 1);
  assert.equal(f.handle.isActive(f.agent), false);

  const next = f.claim(3);
  assert.deepEqual(await next.run(), { kind: 'completed' });
  assert.deepEqual(calls(f, 'session/load'), [['session/load', { cwd, mcpServers: [], sessionId: officialId }]]);
  assert.deepEqual(calls(f, 'session/prompt')[1][1].prompt, [text('本轮输入')]);
  await f.executor.release(job.input);
  assert.equal(calls(f, 'transport-close').length, 1, 'stale release cannot close the next turn');
  await next.commit(next.appendEnd('completed'));
  await next.finish();
  await f.close();
});

bounded('default prompts omit oversized DSH history on first use and when reusing the official binding', async () => {
  const f = makeFixture();
  const marker = 'synthetic-private old DSH conversation';
  const ordinaryTurn = turn => {
    f.append('turn/start', { turn });
    f.append('user/message', human(`${marker}\n${'雪'.repeat(11_000)}`), 'append');
    f.append('assistant/message', { turn, message: { role: 'assistant', id: `fixture-ordinary-${turn}`, content: [text(marker)] } }, 'append');
    f.append('turn/end', { turn, reason: { kind: 'completed' } });
  };
  ordinaryTurn(1);
  const firstStart = f.agent.session.seq;
  const first = f.claim(2, human('本轮正文'));
  assert.deepEqual(await first.run(), { kind: 'completed' });
  assert.deepEqual(calls(f, 'read-events'), [['read-events', firstStart, firstStart + 4]]);
  assert.deepEqual(calls(f, 'session/prompt').at(-1)[1], { sessionId: officialId, prompt: [text('本轮正文')] });
  const firstEnd = first.appendEnd('completed');
  await first.commit(firstEnd);
  await first.finish();

  ordinaryTurn(3);
  const nextStart = f.agent.session.seq;
  const next = f.claim(4, human('新一轮正文'));
  assert.deepEqual(await next.run(), { kind: 'completed' });
  assert.deepEqual(calls(f, 'read-events').slice(1), [
    ['read-events', firstEnd.seq, firstEnd.seq + 1], ['read-events', nextStart, nextStart + 4],
  ]);
  assert.equal(calls(f, 'session/new').length, 1);
  assert.deepEqual(calls(f, 'session/load'), [['session/load', { cwd, mcpServers: [], sessionId: officialId }]]);
  assert.deepEqual(calls(f, 'session/prompt').at(-1)[1], { sessionId: officialId, prompt: [text('新一轮正文')] });
  assert.doesNotMatch(JSON.stringify(calls(f, 'session/prompt')), /synthetic-private/);
  const nextEnd = next.appendEnd('completed');
  await next.commit(nextEnd);
  assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent, { throughSeq: nextEnd.seq, stopReason: 'end_turn' }));
  await next.finish();
  await f.close();
});

for (const denial of ['workspace', 'host', 'core', 'stop']) bounded(`revocation at ${denial} before dispatch clears only the unsent mark`, async () => {
  const marked = Promise.withResolvers(), continueWrite = Promise.withResolvers();
  let nativeLease = true;
  const f = makeFixture({
    async write(_id, row, save) {
      save();
      if (row.pending) { marked.resolve(); await continueWrite.promise; }
    },
    assertDispatchable() { if (!nativeLease) throw new Error('synthetic-private lease data'); },
  });
  const job = f.claim(1);
  const result = job.run();
  await marked.promise;
  assert.deepEqual(pending(f), { turn: 1 });
  switch (denial) {
    case 'workspace': f.detachWorkspace(); break;
    case 'host': f.revokeAuthority(); break;
    case 'core': nativeLease = false; break;
    case 'stop': job.controller.abort({ kind: 'user' }); break;
  }
  continueWrite.resolve();
  const refused = await result;
  publicCode(refused, denial === 'stop' ? 'AGY_STOPPED_BEFORE_SEND' : 'AGY_TURN_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(refused), /synthetic-private/);
  assert.equal(calls(f, 'session/prompt').length, 0);
  assert.equal(calls(f, 'session/cancel').length, 0);
  job.appendEnd('error');
  await job.finish();
  assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent));
  await f.close();
});

for (const denial of ['workspace', 'host', 'core', 'Stop', 'generation', 'configuration']) bounded(`queued prompt fails closed when ${denial} changes before stdin.write`, async () => {
  const queued = Promise.withResolvers();
  let flush, send, validLease = true, disposing;
  const f = makeFixture({
    holdWrite(done, sendFrame) { flush = done; send = sendFrame; },
    promptQueued() { queued.resolve(); },
    assertDispatchable() { if (!validLease) throw new Error('synthetic-private lease revoked during backpressure'); },
  });
  const job = f.claim(1);
  const running = job.run();
  try {
    await queued.promise;
    assert.ok(flush, 'a previous write is still waiting for its callback');
    assert.deepEqual(pending(f), { turn: 1 });
    assert.deepEqual(calls(f, 'session/prompt'), []);
    assert.equal(calls(f, 'native-lease').some(([, mark]) => mark), false, 'do not mark a possible send at queue entry');
    switch (denial) {
      case 'workspace': f.detachWorkspace(); break;
      case 'host': f.revokeAuthority(); break;
      case 'core': validLease = false; break;
      case 'Stop': job.controller.abort(new Error('synthetic-private Stop')); break;
      case 'generation': disposing = f.handle.dispose(); break;
      case 'configuration': send({ method: 'session/update', params: { sessionId: officialId, update: {
        sessionUpdate: 'config_option_update', configOptions: configOptions('e-b'),
      } } }); break;
    }
    flush();
    const refused = await running;
    publicCode(refused, job.controller.signal.aborted ? 'AGY_STOPPED_BEFORE_SEND' : 'AGY_TURN_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(refused), /synthetic-private/);
    assert.deepEqual(calls(f, 'session/prompt'), []);
    assert.deepEqual(calls(f, 'session/cancel'), []);
    assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent));
    assert.deepEqual(f.deltas, []);
    job.appendEnd('error');
  } finally {
    await job.finish();
    await disposing;
    await f.close();
  }
  assert.equal(calls(f, 'transport-close').length, 1);
});

for (const settle of [
  ['cancelled', { kind: 'cancelled' }, 'aborted'],
  ['end_turn', { kind: 'completed' }, 'completed'],
  ['max_turn_requests', { kind: 'max-tokens' }, 'max-tokens'],
  ['refusal', { kind: 'completed' }, 'completed'],
  ['loss', 'TURN_OUTCOME_UNKNOWN', 'error'],
]) bounded(`Stop preserves the ACP tail and distinguishes ${settle[0]} from local cancellation`, async () => {
  const [stopReason, expected, nativeKind] = settle;
  const entered = Promise.withResolvers();
  const f = makeFixture({ prompt(turn) { turn.update('前片'); entered.resolve(turn); } });
  const job = f.claim(1);
  const running = job.run();
  const { update, reply, disconnect } = await entered.promise;
  job.controller.abort({ kind: 'user' });
  assert.deepEqual(calls(f, 'session/cancel'), [['session/cancel', { sessionId: officialId }]]);
  assert.deepEqual(pending(f), { turn: 1 });
  update('停止后的尾片');
  if (stopReason === 'loss') disconnect();
  else reply({ stopReason });
  update('终包后的无效片段');
  const result = await running;
  if (typeof expected === 'string') publicCode(result, expected);
  else assert.deepEqual(result, expected);
  assert.deepEqual(f.deltas, ['前片', '停止后的尾片']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  assert.deepEqual(pending(f), { turn: 1 });
  const end = job.appendEnd(nativeKind);
  await job.commit(end);
  await job.finish();
  if (stopReason === 'loss') {
    assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent, { pending: { turn: 1 } }));
    assert.throws(() => f.handle.checkPrompt(f.agent, selection, [text('再发')]), { code: 'agy/outcome-unknown' });
    assert.equal(f.offer('claim', human('保留的队列任务')), false);
  } else {
    assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent, { throughSeq: end.seq, stopReason }));
  }
  assert.equal(calls(f, 'session/prompt').length, 1);
  await f.close();
});

bounded('a synchronously reentrant Stop in the final native lease does not retain a sent mark', async () => {
  let job;
  const f = makeFixture({ assertDispatchable() {
    if (pending(f)) job.controller.abort(new Error('synthetic-private reentrant Stop'));
  } });
  job = f.claim(1);
  try {
    publicCode(await job.run(), 'AGY_STOPPED_BEFORE_SEND');
    assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent));
    assert.deepEqual(calls(f, 'session/prompt'), []);
    assert.deepEqual(calls(f, 'session/cancel'), []);
    job.appendEnd('error');
  } finally {
    await job.finish();
    await f.close();
  }
});

bounded('a deadline exhausted during final authorization leaves the ACP prompt unsent', async () => {
  const queued = Promise.withResolvers();
  let flush, checked = false;
  const f = makeFixture({
    turnTimeout: 250,
    holdWrite(done) { flush = done; },
    promptQueued() { queued.resolve(); },
    assertDispatchable() {
      if (!pending(f)) return;
      checked = true;
      // Expire the already armed write without letting its timer callback run.
      const deadline = performance.now() + 280;
      while (performance.now() < deadline) { /* hold this synchronous guard */ }
    },
  });
  const job = f.claim(1);
  try {
    const result = job.run();
    await queued.promise;
    assert.deepEqual(pending(f), { turn: 1 });
    assert.ok(flush);
    flush();
    publicCode(await result, 'AGY_TURN_UNAVAILABLE');
    assert.equal(checked, true);
    assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent));
    assert.deepEqual(calls(f, 'session/prompt'), []);
    assert.deepEqual(calls(f, 'session/cancel'), []);
    job.appendEnd('error');
  } finally {
    await job.finish();
    await f.close();
  }
});

bounded('a stored prefix through the checkpoint can omit a later queued item', async () => {
  const f = makeFixture({ readEvents: events => events.slice(0, -1) });
  const job = f.claim(1);
  f.append('agent/inbox/spliced', { target: 'next-turn', inserted: [human('未落盘的新一条')] });
  assert.deepEqual(await job.run(), { kind: 'completed' });
  assert.deepEqual(calls(f, 'session/prompt')[0][1].prompt, [text('本轮输入')]);
  await job.commit(job.appendEnd('completed'));
  await job.finish();
  await f.close();
});

for (const [name, readEvents] of [
  ['missing input', events => events.slice(0, -2)],
  ['missing sequence', events => events.slice(1)],
  ['substituted input', events => events.map(event => event.type === 'user/message'
    ? { ...event, data: human('替换后的持久化文本') } : event)],
  ['read failure', () => { throw new Error('synthetic-private ledger path'); }],
]) bounded(`stored history with ${name} never opens ACP or writes a binding`, async () => {
  const f = makeFixture({ readEvents });
  const job = f.claim(1);
  const result = await job.run();
  publicCode(result, 'AGY_BINDING_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  assert.deepEqual(calls(f, 'make-session'), []);
  assert.deepEqual(calls(f, 'ledger'), []);
  job.appendEnd('error');
  await job.finish();
  await f.close();
});

bounded('an existing binding without its durable ending never opens ACP', async () => {
  const f = makeFixture({ readEvents: events => events[0]?.type === 'turn/end' ? [] : events });
  f.append('turn/start', { turn: 1 });
  const end = f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const binding = baseRow(f.agent, { throughSeq: end.seq, stopReason: 'end_turn' });
  f.rows.set(f.agent.id, binding);
  const job = f.claim(2);
  publicCode(await job.run(), 'AGY_BINDING_UNAVAILABLE');
  assert.deepEqual(calls(f, 'read-events'), [['read-events', end.seq, end.seq + 1]]);
  assert.deepEqual(calls(f, 'make-session'), []);
  assert.equal(f.ledger.read(f.agent.id), binding);
  job.appendEnd('error');
  await job.finish();
  await f.close();
});

bounded('a missing live admission boundary does not scan older DSH history or open ACP', async () => {
  const f = makeFixture();
  const job = f.claim(1);
  for (let i = 0; i < 128; i++) f.append('model/selection', selection);
  publicCode(await job.run(), 'AGY_BINDING_UNAVAILABLE');
  assert.deepEqual(calls(f, 'read-events'), []);
  assert.deepEqual(calls(f, 'make-session'), []);
  assert.deepEqual(calls(f, 'ledger'), []);
  job.appendEnd('error');
  await job.finish();
  await f.close();
});

bounded('the native Stop aborts the admission read before ACP setup', async () => {
  const entered = Promise.withResolvers();
  const f = makeFixture({ readEvents(_events, signal) {
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const job = f.claim(1);
  const running = job.run();
  await entered.promise;
  job.controller.abort({ kind: 'user' });
  publicCode(await running, 'AGY_STOPPED_BEFORE_SEND');
  assert.deepEqual(calls(f, 'make-session'), []);
  assert.deepEqual(calls(f, 'ledger'), []);
  job.appendEnd('error');
  await job.finish();
  await f.close();
});

bounded('oversized history in the synthetic opt-in still fails before ACP setup', async () => {
  const f = makeFixture({ capabilities: { includeDshHistory: true } });
  f.append('turn/start', { turn: 1 });
  f.append('user/message', human('雪'.repeat(11_000)), 'append');
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(f.handle.checkPrompt(f.agent, selection, [text('新正文')]), true);
  assert.deepEqual(calls(f, 'read-events'), []);
  const job = f.claim(2);
  assert.deepEqual(calls(f, 'read-events'), []);
  publicCode(await job.run(), 'AGY_CONTEXT_TOO_LARGE');
  assert.deepEqual(calls(f, 'make-session'), []);
  assert.deepEqual(calls(f, 'ledger'), []);
  job.appendEnd('error');
  await job.finish();
  await f.close();
});

bounded('a missing durable native end keeps the pending fence after close and reopen', async () => {
  const warm = makeFixture();
  const job = warm.claim(1);
  assert.deepEqual(await job.run(), { kind: 'completed' });
  job.appendEnd('completed');
  await job.finish(); // Core never notified that end was durable.
  assert.deepEqual(pending(warm), { turn: 1 });
  await warm.close();
  const cold = makeFixture({ ledger: warm.ledger });
  assert.throws(() => cold.handle.checkPrompt(cold.agent, selection, [text('冷重开')]), { code: 'agy/outcome-unknown' });
  assert.equal(cold.offer('claim', human('仍在队列的输入')), false);
  assert.deepEqual(cold.trace, []);
  await cold.close();
});

bounded('processing leases park a second agent and a bounded queue without claiming its input', async () => {
  const f = makeFixture();
  const job = f.claim(1);
  const other = { ...f.agent, id: 'different', session: { ...f.agent.session,
    header: { ...f.agent.session.header, id: 'different' } } };
  assert.equal(f.offer('claim', human('其他会话'), undefined, selection, other), false);
  assert.equal(f.offer('enqueue', human('同一会话可排队')), true);
  f.agent.inbox.nextTurn = Array(7).fill(human('排队项'));
  assert.throws(() => f.handle.checkPrompt(f.agent, selection, [text('还想排队')]), { code: 'agy/turn-busy' });
  assert.equal(f.handle.checkPrompt(f.agent, selection, [text('编辑可用')], f.agent.inbox.nextTurn[0]), true);
  assert.throws(() => f.handle.checkPrompt(f.agent, selection, [text(' ')], f.agent.inbox.nextTurn[0]), { code: 'agy/prompt-unavailable' });
  assert.equal(f.offer('edit', human('修改等待项'), human('排队项')), true);
  assert.equal(f.offer('enqueue', human('还想排队')), false);
  assert.deepEqual(f.trace, []);
  job.controller.abort({ kind: 'user' });
  assert.equal(await job.run(), undefined);
  await job.finish();
  assert.equal(f.handle.checkPrompt(f.agent, selection, [text('唤醒等待项')]), true);
  await f.close();
});

bounded('a stale or replaced pending row cannot be sent or overwritten during cleanup', async () => {
  const f = makeFixture({ beforeDispatch() {
    f.rows.set(f.agent.id, baseRow(f.agent, { pending: { turn: 97 }, officialId: 'replacement' }));
  } });
  const job = f.claim(1);
  publicCode(await job.run(), 'AGY_BINDING_UNAVAILABLE');
  assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent, { pending: { turn: 97 }, officialId: 'replacement' }));
  assert.equal(calls(f, 'session/prompt').length, 0);
  job.appendEnd('error');
  await job.finish();
  assert.equal(calls(f, 'transport-close').length, 1);
  await f.close();
});

bounded('a pending-mark write that rejects after publishing is rolled back without sending', async () => {
  const f = makeFixture({ async write(_id, row, save) {
    save();
    if (row.pending) throw new Error('synthetic-private pending write failure');
  } });
  const job = f.claim(1);
  const result = await job.run();
  publicCode(result, 'AGY_TURN_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent));
  assert.deepEqual(calls(f, 'session/prompt'), []);
  job.appendEnd('error');
  await job.finish();
  assert.equal(f.handle.checkPrompt(f.agent, selection, [text('手动发送下一条')]), true);
  await f.close();
});

bounded('a failed final ledger write stays fenced for the current registration', async () => {
  const f = makeFixture({ async write(_id, row, save) {
    save();
    if (row.throughSeq >= 0) throw new Error('synthetic-private ledger failure');
  } });
  const job = f.claim(1);
  assert.deepEqual(await job.run(), { kind: 'completed' });
  await assert.rejects(job.commit(job.appendEnd('completed')), { code: 'agy/binding-unavailable' });
  await job.finish();
  assert.throws(() => f.handle.checkPrompt(f.agent, selection, [text('重试')]), { code: 'agy/outcome-unknown' });
  assert.equal(f.offer('claim', human('仍未领取')), false);
  await f.close();
});

bounded('owner disposal waits for the exact native Stop, durable settlement, and ACP process cleanup', async () => {
  const entered = Promise.withResolvers();
  const closing = Promise.withResolvers(), closeGate = Promise.withResolvers();
  const f = makeFixture({ prompt(turn) { entered.resolve(turn); },
    async reap() { closing.resolve(); await closeGate.promise; },
    capabilities: { options: parseAgyTurnOptions(configOptions()) },
  });
  const job = f.claim(1);
  const running = job.run();
  const { update, reply } = await entered.promise;
  let disposed = false;
  const disposing = f.close().then(() => { disposed = true; });
  assert.equal(f.handle.catalogGroup, undefined);
  assert.equal(f.handle.isActive(f.agent), true);
  assert.equal(job.controller.signal.aborted, true);
  assert.deepEqual(job.controller.signal.reason, { kind: 'disposed' });
  assert.equal(calls(f, 'session/cancel').length, 1);
  assert.equal(f.offer('enqueue', human('拒绝新工作')), false);
  update('撤销后现有终态前的尾片');
  reply({ stopReason: 'cancelled' });
  assert.deepEqual(await running, { kind: 'cancelled' });
  assert.deepEqual(f.deltas, ['撤销后现有终态前的尾片']);
  const end = job.appendEnd('aborted');
  await job.commit(end);
  const releasing = job.finish();
  await closing.promise;
  assert.equal(disposed, false);
  closeGate.resolve();
  await releasing;
  await disposing;
  assert.equal(disposed, true);
  assert.equal(f.handle.isActive(f.agent), false);
  assert.deepEqual(f.ledger.read(f.agent.id), baseRow(f.agent, { throughSeq: end.seq, stopReason: 'cancelled' }));
});

bounded('a failed reap blocks a replacement registration on the same Host', async () => {
  const root = { fiber: {} };
  const fixture = makeFixture({ root, reap() { throw new Error('synthetic-private process path'); } });
  const job = fixture.claim(1);
  assert.deepEqual(await job.run(), { kind: 'completed' });
  await job.commit(job.appendEnd('completed'));
  await assert.rejects(job.finish(), { code: 'agy/cleanup-unconfirmed' });
  await fixture.close();
  const replacement = makeFixture({ root, capabilities: { options: parseAgyTurnOptions(configOptions()) } });
  assert.equal(replacement.handle.catalogGroup, undefined);
  assert.throws(() => replacement.handle.checkPrompt(replacement.agent, selection, [text('无法确认旧进程退出')]), { code: 'agy/cleanup-unconfirmed' });
  assert.equal(replacement.offer('claim', human('新轮')), false);
  assert.deepEqual(replacement.trace, []);
  await replacement.close();
});
