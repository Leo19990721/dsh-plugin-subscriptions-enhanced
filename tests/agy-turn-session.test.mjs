import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { AgyAcpError, AgyAcpErrorCode } from '../src/agy-acp-client.js';
import { createAgyTurnSession } from '../src/agy-turn-session.js';

const cwd = path.resolve('fixture-project');
const id = 'synthetic-session';
const other = 'other-session';
const code = expected => error => error?.code === expected;
const response = (...configOptions) => ({ configOptions });
const selector = (category, pickerId, currentValue, ...values) => ({
  id: pickerId, category, name: '合成选项', type: 'select', currentValue,
  options: values.map(value => ({ value, name: value })),
});
const model = (current = 'm-a') => selector('model', 'model-picker', current, 'm-a', 'm-b');
const effort = (current = 'e-a', key = 'effort-picker') => selector('thought_level', key, current, 'e-a', 'e-b');
const defaultSelection = { model: 'm-a' };
const stopped = { outcome: { outcome: 'cancelled' } };

function fixture(customize, { timeLimits = { open: 2345 }, beforePrompt, ignoreUnchangedConfigNotices } = {}) {
  let hooks, ended = false;
  const sent = [], deltas = [];
  const update = (update, sessionId = id) => hooks.onUpdate({ sessionId, update });
  const config = (data, sessionId) => update({ sessionUpdate: 'config_option_update', ...data }, sessionId);
  const delta = (text, sessionId) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, sessionId);
  const disconnect = () => { ended = true; hooks.onClosed(); };
  const ask = ({ toolCallId = 'fixture-read', sessionId = id } = {}) => hooks.onPermission({
    sessionId, toolCall: { toolCallId, kind: 'read', title: '仅合成请求', rawInput: { path: path.join(cwd, 'example.txt') } },
    options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'reject' }],
  });
  const run = (fields = {}) => session.runTurn('用户原文 🌱', { signal: new AbortController().signal, onDelta: text => deltas.push(text), ...fields });
  const session = createAgyTurnSession({ cwd, timeLimits, ignoreUnchangedConfigNotices, makeClient(callbacks) {
    hooks = callbacks;
    return {
      async start() { sent.push(['initialize']); return { agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }; },
      async request(method, params, requestOptions) {
        const isPrompt = method === 'session/prompt';
        assert.equal(ended, false);
        if (isPrompt) {
          if (beforePrompt) await beforePrompt();
          assert.equal(ended, false);
          const guard = requestOptions.beforeWrite;
          const result = guard();
          if (typeof result?.then === 'function') {
            void Promise.resolve(result).catch(() => {});
            throw new AgyAcpError(AgyAcpErrorCode.BEFORE_WRITE_FAILED);
          }
          requestOptions.onWriteStarted();
        } else assert.equal(requestOptions?.beforeWrite, undefined);
        sent.push([method, params, requestOptions?.timeoutMs]);
        const terminal = isPrompt ? Promise.withResolvers() : undefined;
        let responded = false;
        const respond = result => {
          assert.equal(responded, false);
          responded = true;
          requestOptions.onResponse();
          terminal.resolve(result);
        };
        const fallback = () => {
          if (method === 'session/new') return { sessionId: id, ...response(model(), effort()) };
          if (method === 'session/load') return response(model(), effort());
          if (method === 'session/close') return {};
          if (isPrompt) return { stopReason: 'end_turn' };
          assert.fail(`Unexpected fixture method: ${method}`);
        };
        const result = customize ? customize({ method, params, fallback, respond, config, delta, update, disconnect }) : fallback();
        if (!isPrompt) return result;
        // Sync replies seal immediately; deferred replies call respond() on
        // the exact frame before sending anything else in that batch.
        if (result !== undefined) respond(result);
        return terminal.promise;
      },
      async notify(method, params) { sent.push([method, params]); },
      async close() { if (!ended) { sent.push(['close-transport']); disconnect(); } },
    };
  } });
  return { session, sent, deltas, config, delta, ask, disconnect, run };
}

const methods = fixture => fixture.sent.map(([method]) => method);

test('setup, model/effort setters and one prompt use ACP v1 shapes with separate reference text', async () => {
  const f = fixture(({ method, params, config, delta, fallback }) => {
    if (method === 'session/new') {
      config(response(model(), effort()));
      config(response(model('m-b')), other);
    } else if (method === 'session/set_config_option') {
      const result = params.configId === 'model-picker' ? response(model('m-b'), effort('e-a', 'new-effort'))
        : response(model('m-b'), effort('e-b', 'new-effort'));
      config(result);
      config(result);
      return result;
    } else if (method === 'session/prompt') {
      delta('其他会话', other);
      delta('合成回覆');
      return { stopReason: 'max_turn_requests' };
    }
    return fallback();
  });
  try {
    assert.equal(f.session.id, undefined);
    assert.equal(f.session.options, undefined);
    assert.deepEqual(await f.session.open(), { title: '', history: [] });
    assert.equal(f.session.id, id);
    assert.equal(f.session.options.model.currentValue, 'm-a');
    await assert.rejects(f.run(), code('turn-unavailable'));
    const prepared = await f.session.prepare({ model: 'm-b', reasoningEffort: 'e-b' });
    assert.equal(prepared, f.session.options);
    assert.equal(prepared.model.currentValue, 'm-b');
    assert.equal(prepared.thoughtLevel.currentValue, 'e-b');
    assert.deepEqual(await f.run({ contextText: '历史资料，仅供参考\n合成文字' }), { status: 'completed', stopReason: 'max_turn_requests' });
    await assert.rejects(f.run(), code('turn-unavailable'));
    assert.deepEqual(f.deltas, ['合成回覆']);
    assert.deepEqual(f.sent, [
      ['initialize'], ['session/new', { cwd, mcpServers: [] }, 2345],
      ['session/set_config_option', { sessionId: id, configId: 'model-picker', value: 'm-b' }, 2345],
      ['session/set_config_option', { sessionId: id, configId: 'new-effort', value: 'e-b' }, 2345],
      ['session/prompt', { sessionId: id, prompt: [{ type: 'text', text: '历史资料，仅供参考\n合成文字' }, { type: 'text', text: '用户原文 🌱' }] }, 1_200_000],
    ]);
  } finally { await f.session.close(); }
  assert.deepEqual(f.sent.slice(-2), [['session/close', { sessionId: id }, 2_000], ['close-transport']]);
});

test('local agy tolerates only late repeats of the previously confirmed idle configuration', async () => {
  for (const conflict of [false, true]) {
    const f = fixture(({ method, config, fallback }) => {
      if (method !== 'session/set_config_option') return fallback();
      config(response(model(), effort())); // late notification from the previous selection
      config(response(model('m-b'), effort(conflict ? 'e-b' : 'e-a')));
      return response(model('m-b'), effort());
    }, { ignoreUnchangedConfigNotices: true });
    try {
      await f.session.open();
      const selecting = f.session.prepare({ model: 'm-b' });
      if (conflict) await assert.rejects(selecting, code('config-unconfirmed'));
      else assert.equal((await selecting).model.currentValue, 'm-b');
    } finally { await f.session.close(); }
  }
});

test('load keeps the requested official identity, replay and full options', async () => {
  const f = fixture(({ method, update, config, fallback }) => {
    if (method !== 'session/load') return fallback();
    update({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: '旧消息' } });
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: '旧回复' } });
    update({ sessionUpdate: 'session_info_update', title: '旧标题' });
    config(response(model('m-b')), other);
    return response(model('m-b'));
  });
  try {
    assert.deepEqual(await f.session.open(id), { title: '旧标题', history: [{ prompt: '旧消息', status: 'completed', text: '旧回复' }] });
    assert.equal(f.session.id, id);
    assert.equal(f.session.options.model.currentValue, 'm-b');
    assert.deepEqual(f.sent.slice(0, 2), [['initialize'], ['session/load', { cwd, mcpServers: [], sessionId: id }, 2345]]);
  } finally { await f.session.close(); }
  const wrong = fixture(({ method, fallback }) => method === 'session/load' ? { sessionId: other, ...response(model()) } : fallback());
  try {
    await assert.rejects(wrong.session.open(id), code('invalid-session'));
    assert.equal(wrong.session.id, undefined);
    assert.equal(wrong.session.options, undefined);
    await assert.rejects(wrong.session.open(id), code('invalid-session'));
  } finally { await wrong.session.close(); }
});

test('setup reconciles only matching-session complete snapshots and leaves missing choices unavailable', async () => {
  const noticeOnly = fixture(({ method, config, fallback }) => {
    if (method !== 'session/new') return fallback();
    config(response(model()));
    return { sessionId: id };
  });
  try {
    await noticeOnly.session.open();
    assert.equal(noticeOnly.session.options.model.currentValue, 'm-a');
  } finally { await noticeOnly.session.close(); }
  const noOptions = fixture(({ method, config, fallback }) => {
    if (method !== 'session/new') return fallback();
    config(response(model()), other);
    return { sessionId: id };
  });
  try {
    await noOptions.session.open();
    assert.equal(noOptions.session.options, undefined);
    await assert.rejects(noOptions.session.prepare(defaultSelection), code('model-unavailable'));
    noOptions.config(response(model()));
    assert.equal(noOptions.session.options, undefined);
    await assert.rejects(noOptions.run(), code('turn-unavailable'));
    assert.deepEqual(methods(noOptions), ['initialize', 'session/new']);
  } finally { await noOptions.session.close(); }
  const conflict = fixture(({ method, config, fallback }) => {
    if (method !== 'session/new') return fallback();
    config(response(model('m-b')));
    return { sessionId: id, ...response(model()) };
  });
  try {
    await assert.rejects(conflict.session.open(), code('config-unconfirmed'));
    assert.equal(conflict.session.options, undefined);
    assert.equal(conflict.session.id, id, 'do not lose the validated official ID during refresh');
    await assert.rejects(conflict.run(), code('turn-unavailable'));
  } finally { await conflict.session.close(); }
  assert.deepEqual(conflict.sent.slice(-2), [['session/close', { sessionId: id }, 2_000], ['close-transport']]);
});

test('conflicting or incomplete setter results fence the wrapper instead of prompting or retrying', async () => {
  const failures = [
    ({ config }) => { config(response(model('m-b'), effort('e-b'))); return response(model('m-b'), effort()); },
    ({ config }) => { config(response(model('m-b'), effort('e-b'))); config(response(model('m-b'), effort())); return response(model('m-b'), effort()); },
    ({ config }) => { config(response(model('m-b'), effort())); return {}; },
    () => ({ sessionId: other, ...response(model('m-b'), effort()) }),
  ];
  for (const failSetter of failures) {
    const f = fixture(data => data.method === 'session/set_config_option' ? failSetter(data) : data.fallback());
    try {
      await f.session.open();
      await assert.rejects(f.session.prepare({ model: 'm-b', reasoningEffort: 'e-b' }), code('config-unconfirmed'));
      assert.equal(f.session.options, undefined);
      f.config(response(model('m-b'), effort('e-b')));
      await assert.rejects(f.session.prepare(defaultSelection), code('turn-unavailable'));
      await assert.rejects(f.run(), code('turn-unavailable'));
      assert.equal(f.session.id, id, 'the owner can reopen the same Google session after close');
      assert.deepEqual(methods(f), ['initialize', 'session/new', 'session/set_config_option']);
    } finally { await f.session.close(); }
  }
});

test('a synchronous notification after resolving the underlying setter must be considered too', async () => {
  const setter = Promise.withResolvers(), received = Promise.withResolvers();
  const f = fixture(({ method, fallback }) => {
    if (method !== 'session/set_config_option') return fallback();
    received.resolve();
    return setter.promise;
  });
  try {
    await f.session.open();
    const configuring = f.session.prepare({ model: 'm-b' });
    await received.promise;
    setter.resolve(response(model('m-b'), effort()));
    f.config(response(model(), effort()));
    await assert.rejects(configuring, code('config-unconfirmed'));
    await assert.rejects(f.run(), code('turn-unavailable'));
  } finally { await f.session.close(); }
});

test('later updates do not silently change the route of a prepared turn', async () => {
  const f = fixture();
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    f.config(response(model('m-b')), other);
    f.config(response(model(), effort()));
    assert.deepEqual(await f.run(), { status: 'completed', stopReason: 'end_turn' });
    await f.session.prepare(defaultSelection);
    f.config(response(model('m-b'), effort()));
    assert.equal(f.session.options.model.currentValue, 'm-b');
    await assert.rejects(f.run(), code('turn-unavailable'));
    await f.session.prepare({ model: 'm-b' });
    assert.deepEqual(await f.run(), { status: 'completed', stopReason: 'end_turn' });
    assert.deepEqual(methods(f), ['initialize', 'session/new', 'session/prompt', 'session/prompt']);
  } finally { await f.session.close(); }
});

test('rejected local history sends nothing and valid retry of the unsent turn keeps only one prompt', async () => {
  const f = fixture();
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    await assert.rejects(f.run({ contextText: { role: 'system', content: 'no' } }), code('turn-unavailable'));
    await assert.rejects(f.run({ signal: {} }), code('turn-unavailable'));
    assert.deepEqual(methods(f), ['initialize', 'session/new']);
    await f.run({ contextText: '' });
    assert.deepEqual(f.sent.at(-1)[1].prompt, [{ type: 'text', text: '用户原文 🌱' }]);
  } finally { await f.session.close(); }
});

test('Stop does not start a second prompt and native permissions are cancelled synchronously', async () => {
  let reply;
  const f = fixture(({ method, delta, respond, fallback }) => {
    if (method !== 'session/prompt') return fallback();
    delta('开始');
    reply = stopReason => respond({ stopReason });
  });
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    assert.equal(f.session.decide, undefined);
    const controller = new AbortController();
    const run = f.run({ signal: controller.signal });
    await assert.rejects(f.run(), code('turn-unavailable'));
    await assert.rejects(f.session.prepare(defaultSelection), code('turn-unavailable'));
    assert.deepEqual(f.ask(), stopped, 'a valid read must be denied immediately while the turn is still open');
    assert.deepEqual(f.ask({ sessionId: other }), stopped);
    controller.abort(new Error('synthetic-private-reason'));
    f.delta('停止后的尾片');
    reply('cancelled');
    assert.deepEqual(await run, { status: 'interrupted', stopReason: 'cancelled' });
    assert.deepEqual(f.deltas, ['开始', '停止后的尾片']);
    assert.deepEqual(f.sent.at(-1), ['session/cancel', { sessionId: id }]);
    await f.session.prepare(defaultSelection);
    const beforeSend = new AbortController();
    beforeSend.abort();
    assert.deepEqual(await f.run({ signal: beforeSend.signal }), { status: 'interrupted', stopReason: undefined });
    assert.equal(methods(f).filter(method => method === 'session/prompt').length, 1);
  } finally { await f.session.close(); }
});

test('the prompt response seals the same pipe read before late chunks, permissions and Stop', async () => {
  let reply;
  const f = fixture(({ method, respond, fallback }) => {
    if (method !== 'session/prompt') return fallback();
    reply = stopReason => respond({ stopReason });
  });
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    const signal = new AbortController();
    const turn = f.run({ signal: signal.signal });
    f.delta('合法尾片');
    assert.deepEqual(f.ask(), stopped);
    reply('end_turn');
    // Same pipe read: none of the prompt Promise continuations have run yet.
    f.delta('x'.repeat(512 * 1024 + 1));
    const latePermission = f.ask();
    assert.deepEqual(latePermission, stopped, 'no new review request enters the completed turn');
    f.config(response(model('m-b'), effort()));
    signal.abort();
    assert.deepEqual(await turn, { status: 'completed', stopReason: 'end_turn' });
    assert.deepEqual(f.deltas, ['合法尾片']);
    assert.equal(f.session.options.model.currentValue, 'm-b', 'independent config updates must still be observed');
    assert.deepEqual(methods(f), ['initialize', 'session/new', 'session/prompt']);
    await f.session.prepare({ model: 'm-b' });
  } finally { await f.session.close(); }
});

test('Stop before the terminal response sends one cancel and keeps the official end_turn race', async () => {
  let reply;
  const f = fixture(({ method, respond, fallback }) => {
    if (method !== 'session/prompt') return fallback();
    reply = stopReason => respond({ stopReason });
  });
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    const signal = new AbortController();
    const turn = f.run({ signal: signal.signal });
    signal.abort();
    f.delta('停止后的合法尾片');
    reply('end_turn');
    f.delta('终包后的无效尾片');
    assert.deepEqual(await turn, { status: 'completed', stopReason: 'end_turn' });
    assert.deepEqual(f.deltas, ['停止后的合法尾片']);
    assert.deepEqual(f.sent.at(-1), ['session/cancel', { sessionId: id }]);
    assert.equal(methods(f).filter(method => method === 'session/cancel').length, 1);
  } finally { await f.session.close(); }
});

test('disconnect or missing terminal response fences the wrapper without replaying', async () => {
  for (const lose of [() => ({}), ({ disconnect }) => {
    disconnect();
    throw new AgyAcpError(AgyAcpErrorCode.PROCESS_EXIT);
  }]) {
    const f = fixture(data => {
      if (data.method !== 'session/prompt') return data.fallback();
      data.delta('还未确认');
      return lose(data);
    });
    try {
      await f.session.open();
      await f.session.prepare(defaultSelection);
      await assert.rejects(f.run({ contextText: '合成历史' }), code('turn-unconfirmed'));
      assert.deepEqual(f.deltas, ['还未确认']);
      assert.equal(f.session.options, undefined);
      await assert.rejects(f.session.prepare(defaultSelection), code('turn-unavailable'));
      await assert.rejects(f.run(), code('turn-unavailable'));
      assert.equal(methods(f).filter(method => method === 'session/prompt').length, 1);
    } finally { await f.session.close(); }
  }
});

test('onDispatch is never called for Stop before send or an option change that revokes prepare', async () => {
  const f = fixture();
  let dispatches = 0;
  const onDispatch = () => { dispatches++; };
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    const stoppedBeforeSend = AbortSignal.abort();
    assert.deepEqual(await f.run({ signal: stoppedBeforeSend, onDispatch }), { status: 'interrupted', stopReason: undefined });
    await f.session.prepare(defaultSelection);
    f.config(response(model('m-b'), effort()));
    await assert.rejects(f.run({ onDispatch }), code('turn-unavailable'));
    assert.equal(dispatches, 0);
    assert.deepEqual(methods(f), ['initialize', 'session/new']);
  } finally { await f.session.close(); }
});

test('onDispatch runs once at the prompt write, after an equivalent queued snapshot and before a lost response', async () => {
  const order = [], gate = Promise.withResolvers();
  const f = fixture(({ method, delta, fallback }) => {
    if (method !== 'session/prompt') return fallback();
    order.push('prompt');
    delta('写后到达');
    throw new AgyAcpError(AgyAcpErrorCode.PROCESS_EXIT);
  }, { beforePrompt() { order.push('queued'); return gate.promise; } });
  const onDispatch = (...args) => { assert.deepEqual(args, []); order.push('dispatch'); };
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    const rejected = assert.rejects(f.run({ onDispatch }), code('turn-unconfirmed'));
    assert.deepEqual(order, ['queued']);
    f.delta('写前到达');
    f.config(response(model('m-b'), effort('e-b')), other);
    f.config(response(model(), effort()));
    gate.resolve();
    await rejected;
    await assert.rejects(f.run({ onDispatch }), code('turn-unavailable'));
    assert.deepEqual(order, ['queued', 'dispatch', 'prompt']);
    assert.deepEqual(f.deltas, ['写后到达']);
    assert.equal(methods(f).filter(method => method === 'session/prompt').length, 1);
  } finally { await f.session.close(); }
});

for (const [change, configOptions] of [
  ['model', response(model('m-b'), effort())],
  ['effort', response(model(), effort('e-b'))],
  ['selector', response(model(), effort('e-a', 'new-effort'))],
  ['missing configuration', response()],
]) test(`a queued prompt cannot dispatch after a matching-session ${change} update invalidates prepare`, async () => {
  const gate = Promise.withResolvers();
  const f = fixture(undefined, { beforePrompt: () => gate.promise });
  let dispatches = 0;
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    const rejected = assert.rejects(f.run({ onDispatch() { dispatches++; } }), code('turn-unconfirmed'));
    f.config(configOptions);
    gate.resolve();
    await rejected;
    assert.equal(dispatches, 0);
    assert.deepEqual(methods(f), ['initialize', 'session/new']);
    assert.equal(f.session.options, undefined);
    await assert.rejects(f.session.prepare(defaultSelection), code('turn-unavailable'));
  } finally { await f.session.close(); }
});

test('a configuration change after the prompt write applies to the next prepare without invalidating the result', async () => {
  const f = fixture(({ method, config, fallback }) => {
    if (method === 'session/prompt') config(response(model('m-b'), effort('e-b')));
    return fallback();
  });
  let dispatches = 0;
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    assert.deepEqual(await f.run({ onDispatch() { dispatches++; } }), { status: 'completed', stopReason: 'end_turn' });
    assert.equal(dispatches, 1);
    assert.equal(f.session.options.model.currentValue, 'm-b');
    assert.equal((await f.session.prepare({ model: 'm-b', reasoningEffort: 'e-b' })).thoughtLevel.currentValue, 'e-b');
    assert.deepEqual(methods(f), ['initialize', 'session/new', 'session/prompt']);
  } finally { await f.session.close(); }
});

for (const reason of ['Stop', 'close']) test(`${reason} while the prompt is queued prevents both the prompt and cancel frames`, async () => {
  const gate = Promise.withResolvers();
  const f = fixture(undefined, { beforePrompt: () => gate.promise });
  const controller = new AbortController();
  let dispatches = 0;
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    const rejected = assert.rejects(f.run({ signal: controller.signal, onDispatch() { dispatches++; } }), code('turn-unconfirmed'));
    const closing = reason === 'close' ? f.session.close() : undefined;
    if (!closing) controller.abort(new Error('synthetic-private-reason'));
    gate.resolve();
    await rejected;
    await closing;
    assert.equal(dispatches, 0);
    assert.equal(methods(f).some(method => method === 'session/prompt' || method === 'session/cancel'), false);
  } finally { await f.session.close(); }
});

test('a synchronous Stop inside beforeDispatch still prevents the prompt write', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    await f.session.open();
    await f.session.prepare(defaultSelection);
    await assert.rejects(f.run({ signal: controller.signal, beforeDispatch() { controller.abort(); },
      onDispatch() { assert.fail('the stopped prompt started writing'); } }), code('turn-unconfirmed'));
    assert.deepEqual(methods(f), ['initialize', 'session/new']);
  } finally { await f.session.close(); }
});

test('close drains a pending config, blocks new work, and never sends a dependent setter', async () => {
  const setter = Promise.withResolvers(), received = Promise.withResolvers();
  const f = fixture(({ method, fallback }) => {
    if (method !== 'session/set_config_option') return fallback();
    received.resolve();
    return setter.promise;
  });
  await f.session.open();
  const configuring = f.session.prepare({ model: 'm-b', reasoningEffort: 'e-b' });
  const rejected = assert.rejects(configuring, code('config-unconfirmed'));
  await received.promise;
  const close = f.session.close();
  assert.equal(close, f.session.close());
  assert.equal(f.session.options, undefined);
  await assert.rejects(f.run(), code('turn-unavailable'));
  assert.deepEqual(methods(f), ['initialize', 'session/new', 'session/set_config_option']);
  setter.resolve(response(model('m-b'), effort()));
  await rejected;
  await close;
  assert.deepEqual(methods(f), ['initialize', 'session/new', 'session/set_config_option', 'session/close', 'close-transport']);
});
