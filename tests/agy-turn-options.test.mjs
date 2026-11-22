import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureAgyTurn, parseAgyTurnOptions } from '../src/agy-turn-options.js';

const sessionId = 'synthetic-session';
const choice = (value, name = value) => ({ value, name });
const group = (id, options) => ({ group: id, name: '合成模型组', options });
const selector = (category, id, currentValue, options) => ({ category, id, name: '合成选项', type: 'select', currentValue, options });
const model = (current = 'm-a', options = [choice('m-a'), choice('m-b')], id = 'route-picker') => selector('model', id, current, options);
const effort = (current = 'level-a', options = [choice('level-a'), choice('level-b')], id = 'effort-picker') => selector('thought_level', id, current, options);
const code = expected => error => error?.code === expected;
const response = (...configOptions) => ({ configOptions });

function fixture(options, selection, replies = []) {
  const sent = [];
  const controller = new AbortController();
  const result = () => configureAgyTurn({ sessionId, options, selection, signal: controller.signal, async send(params) {
    const reply = replies[sent.push(params) - 1];
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(params) : reply;
  } });
  return { controller, sent, result };
}

test('flattens ACP v1 groups in order and returns detached, deeply immutable selectors', () => {
  const first = choice('m-b', '合成 🌱 模型');
  const level = choice('level-a', '低');
  const raw = [
    selector('mode', 'irrelevant', 'default', [choice('default')]),
    model('m-a', [group('preferred', [first]), group('other', [choice('m-a', '第二个')])]),
    effort('level-a', [level, choice('level-b', '高')]),
  ];
  raw[1].options[0]._meta = { unused: true };
  first.description = 'not exposed';
  const rows = parseAgyTurnOptions(raw);
  assert.deepEqual(rows, {
    model: { id: 'route-picker', currentValue: 'm-a', options: [choice('m-b', '合成 🌱 模型'), choice('m-a', '第二个')] },
    thoughtLevel: { id: 'effort-picker', currentValue: 'level-a', options: [choice('level-a', '低'), choice('level-b', '高')] },
  });
  first.name = 'different';
  level.value = 'different';
  raw[1].currentValue = 'm-b';
  assert.equal(rows.model.currentValue, 'm-a');
  assert.equal(rows.model.options[0].name, '合成 🌱 模型');
  assert.equal(rows.thoughtLevel.options[0].value, 'level-a');
  for (const item of [rows, rows.model, rows.model.options, ...rows.model.options, rows.thoughtLevel,
    rows.thoughtLevel.options, ...rows.thoughtLevel.options]) assert.equal(Object.isFrozen(item), true);
});

test('fails closed for unavailable, ambiguous, duplicate, invalid or excessive models', () => {
  const sparse = new Array(2);
  sparse[0] = choice('m-a');
  const duplicateGroups = model('m-a', [group('same', [choice('m-a')]), group('same', [choice('m-b')])]);
  const wide = (count, prefix) => Array.from({ length: count }, (_, i) => choice(`${prefix}-${i}`));
  const invalid = [
    null, {}, [], [null], [effort()], [{ ...model(), category: undefined, id: 'model' }],
    [{ ...model(), id: undefined, configId: 'route-picker' }], [{ ...model(), type: 'boolean' }],
    [{ ...model(), currentValue: true }], [model('missing')], [model(), model('m-a', undefined, 'second')],
    [model(), selector('mode', 'route-picker', 'm-a', [choice('m-a')])],
    [model('m-a', [choice('m-a'), choice('m-a', '不同名称')])],
    [model('m-a', [group('a', [choice('m-a')]), group('b', [choice('m-a')])])], [duplicateGroups],
    [model('m-a', [choice('m-a'), group('b', [choice('m-b')])])],
    [model('m-a', [group('a', [choice('m-a')]), choice('m-b')])],
    [model('m-a', [group('a', [choice('m-a')]), group('empty', [])])], [model('m-a', sparse)],
    [model('m-a', [choice('m-a', '  '), choice('m-b')])],
    [model('m-a', [choice('m-a', 'e\u202evaded')])], [model('m-a', [choice('m-a', 'a\nb')])],
    [model('m-a', [choice('m-a', 'a\u2028b')])], [model('m-a', [choice('m-a', '\ud800a')])],
    [model('m-a', [choice('m-a', 'x'.repeat(257))])], [{ ...model(), name: 'ok\u200b' }],
    [{ ...model(), id: 'x'.repeat(513) }], [model('m-a', undefined, ' id')],
    [model('m-a', [choice('m-a'), choice('m\0b')])],
    [model('value-0', wide(257, 'value'))],
    [model('a-0', [group('a', wide(128, 'a')), group('b', wide(129, 'b'))])],
    [model('value-0', wide(33, 'value').map(({ value }) => group(value, [choice(value)])))],
    [model(), ...Array.from({ length: 32 }, (_, i) => selector('custom', `conf-${i}`, 'x', [choice('x')]))],
  ];
  for (const value of invalid) assert.equal(parseAgyTurnOptions(value), undefined);
  let getterCalls = 0;
  const getter = { ...model(), get id() { getterCalls++; return 'not-json'; } };
  assert.equal(parseAgyTurnOptions([getter]), undefined);
  assert.equal(getterCalls, 0);
});

test('offers only the model when thinking level is missing, ambiguous or malformed', () => {
  const expected = { model: { id: 'route-picker', currentValue: 'm-a', options: [choice('m-a'), choice('m-b')] } };
  for (const others of [[], [effort('missing')], [effort(), effort('level-a', undefined, 'second')],
    [effort(), selector('model_config', 'effort-picker', 'level-a', [choice('level-a')])],
    [{ ...effort(), category: 'model_config' }]]) {
    assert.deepEqual(parseAgyTurnOptions([model(), ...others]), expected);
  }
});

test('uses opaque v1 config ids and revalidates thinking level against the model reply', async () => {
  const snapshot = parseAgyTurnOptions([model(), effort('level-a', [choice('level-a')])]);
  const switched = effort('level-new', [choice('level-new'), choice('level-b')], 'updated-compute-selector');
  const selected = { ...switched, currentValue: 'level-b' };
  const f = fixture(snapshot, { model: 'm-b', reasoningEffort: 'level-b' }, [response(model('m-b'), switched), response(model('m-b'), selected)]);
  const next = await f.result();
  assert.deepEqual(f.sent, [
    { sessionId, configId: 'route-picker', value: 'm-b' },
    { sessionId, configId: 'updated-compute-selector', value: 'level-b' },
  ]);
  assert.deepEqual(next, parseAgyTurnOptions([model('m-b'), selected]));
  assert.equal(Object.isFrozen(next.thoughtLevel.options[0]), true);
  assert.equal(snapshot.model.currentValue, 'm-a');
});

test('sends only changed selectors and leaves server effort alone if it is omitted', async () => {
  const snapshot = parseAgyTurnOptions([model(), effort()]);
  const noop = fixture(snapshot, { model: 'm-a', reasoningEffort: 'level-a' });
  assert.equal(await noop.result(), snapshot);
  assert.deepEqual(noop.sent, []);
  const onlyEffort = fixture(snapshot, { model: 'm-a', reasoningEffort: 'level-b' }, [response(model(), effort('level-b'))]);
  assert.equal((await onlyEffort.result()).thoughtLevel.currentValue, 'level-b');
  assert.deepEqual(onlyEffort.sent, [{ sessionId, configId: 'effort-picker', value: 'level-b' }]);
  const onlyModel = fixture(snapshot, { model: 'm-b' }, [response(model('m-b'), effort('level-b'))]);
  assert.equal((await onlyModel.result()).thoughtLevel.currentValue, 'level-b');
  assert.deepEqual(onlyModel.sent, [{ sessionId, configId: 'route-picker', value: 'm-b' }]);
  const newDefault = fixture(snapshot, { model: 'm-b', reasoningEffort: 'level-b' }, [response(model('m-b'), effort('level-b'))]);
  assert.equal((await newDefault.result()).thoughtLevel.currentValue, 'level-b');
  assert.deepEqual(newDefault.sent, [{ sessionId, configId: 'route-picker', value: 'm-b' }]);
});

test('rejects unadvertised or forged selections before issuing any setter', async () => {
  const snapshot = parseAgyTurnOptions([model(), effort()]);
  for (const [options, selection, kind] of [
    [undefined, { model: 'm-a' }, 'model-unavailable'],
    [{ ...snapshot }, { model: 'm-a' }, 'model-unavailable'],
    [snapshot, { model: 'm-missing' }, 'model-unavailable'],
    [snapshot, { model: 'M-A' }, 'model-unavailable'],
    [snapshot, { model: 'm-a', reasoningEffort: 'level-missing' }, 'reasoning-effort-unavailable'],
    [snapshot, { model: 'm-b', reasoningEffort: null }, 'reasoning-effort-unavailable'],
  ]) {
    const f = fixture(options, selection);
    await assert.rejects(f.result(), code(kind));
    assert.deepEqual(f.sent, []);
  }
});

test('does not send effort after a rejected model, partial reply or changed effort list', async () => {
  const snapshot = parseAgyTurnOptions([model(), effort()]);
  for (const [reply, kind] of [
    [response(model('m-a'), effort()), 'model-unavailable'],
    [response(model('m-b', undefined, 'different-id'), effort()), 'model-unavailable'],
    [response(effort()), 'config-unconfirmed'],
    [[model('m-b'), effort()], 'config-unconfirmed'],
    [response(model('m-b')), 'reasoning-effort-unavailable'],
    [response(model('m-b'), effort('level-a', [choice('level-a')])), 'reasoning-effort-unavailable'],
  ]) {
    const f = fixture(snapshot, { model: 'm-b', reasoningEffort: 'level-b' }, [reply]);
    await assert.rejects(f.result(), code(kind));
    assert.deepEqual(f.sent, [{ sessionId, configId: 'route-picker', value: 'm-b' }]);
  }
});

test('requires the full final configuration to still match both requested choices', async () => {
  const snapshot = parseAgyTurnOptions([model(), effort()]);
  for (const [lastReply, kind] of [
    [response(model('m-a'), effort('level-b')), 'model-unavailable'],
    [response(model('m-b'), effort()), 'reasoning-effort-unavailable'],
    [response(model('m-b'), effort('level-b', undefined, 'different-effort')), 'reasoning-effort-unavailable'],
    [response(effort('level-b')), 'config-unconfirmed'],
  ]) {
    const f = fixture(snapshot, { model: 'm-b', reasoningEffort: 'level-b' }, [response(model('m-b'), effort()), lastReply]);
    await assert.rejects(f.result(), code(kind));
    assert.deepEqual(f.sent, [
      { sessionId, configId: 'route-picker', value: 'm-b' },
      { sessionId, configId: 'effort-picker', value: 'level-b' },
    ]);
  }
});

test('does not read inherited or accessor-based selections or expose invalid-signal errors', async () => {
  const snapshot = parseAgyTurnOptions([model()]);
  let reads = 0;
  const callback = () => assert.fail('an invalid configuration cannot write to ACP');
  const base = { sessionId, options: snapshot, send: callback };
  for (const [extra, expected] of [
    [{ selection: Object.create({ model: 'm-b' }) }, 'model-unavailable'],
    [{ selection: { get model() { reads++; throw new Error('synthetic-private'); } } }, 'model-unavailable'],
    [{ selection: { model: 'm-b', get reasoningEffort() { reads++; throw new Error('synthetic-private'); } } }, 'reasoning-effort-unavailable'],
    [{ selection: { model: 'm-b' }, signal: { get aborted() { reads++; throw new Error('synthetic-private'); } } }, 'model-unavailable'],
  ]) {
    await assert.rejects(configureAgyTurn({ ...base, ...extra }), error => error.code === expected && !error.stack.includes('synthetic-private'));
  }
  assert.equal(reads, 0);
});

test('sanitizes RPC errors and never retries or displays an incomplete configuration', async () => {
  const snapshot = parseAgyTurnOptions([model('upstream-private-a', [choice('upstream-private-a'), choice('upstream-private-b')])]);
  const leak = Object.assign(new Error('upstream-private-rpc-error'), { code: 'upstream-private', cause: 'upstream-private-cause' });
  const f = fixture(snapshot, { model: 'upstream-private-b' }, [leak]);
  await assert.rejects(f.result(), error => {
    assert.equal(error.code, 'config-unconfirmed');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /upstream-private/);
    return true;
  });
  assert.equal(f.sent.length, 1);
});

test('abort before send or while waiting cannot send the next setter', async () => {
  const snapshot = parseAgyTurnOptions([model(), effort()]);
  const before = fixture(snapshot, { model: 'm-b' });
  before.controller.abort(new Error('synthetic-private-cause'));
  await assert.rejects(before.result(), error => error.code === 'cancelled' && !error.stack.includes('synthetic-private-cause'));
  assert.deepEqual(before.sent, []);

  const modelReply = Promise.withResolvers();
  const waiting = fixture(snapshot, { model: 'm-b', reasoningEffort: 'level-b' }, [() => modelReply.promise]);
  let settled = false;
  const result = waiting.result().finally(() => { settled = true; });
  const check = assert.rejects(result, code('cancelled'));
  waiting.controller.abort();
  await Promise.resolve();
  assert.equal(settled, false, 'do not return while the setter can still apply');
  modelReply.resolve(response(model('m-b'), effort()));
  await check;
  assert.deepEqual(waiting.sent, [{ sessionId, configId: 'route-picker', value: 'm-b' }]);
});
