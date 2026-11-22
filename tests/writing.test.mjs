import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertModelCategory, defaultNonWritingPreset, isGemini, matchesMode, matchingSelection } from '../src/writing-policy.js';
import { WritingController, apply } from '../src/writing-host.js';

const gemini = { provider: 'fixture-gemini-provider', model: 'gemini-4-hydrogen' };
const codex = { provider: 'codex', model: 'gpt-fixture' };
const localGemini = { provider: 'antigravity', model: 'gemini-3-flash' };
const localGroup = { id: localGemini.provider, models: [{ id: localGemini.model }] };
const production = { localGoogle: true };
const catalog = { default: codex, groups: [
  { id: 'codex', models: [{ id: codex.model }] },
  { id: 'fixture-gemini-provider', models: [{ id: gemini.model }, { id: 'gemini-99-future' }] },
], failures: [] };
function fixture({ preset = 'standard', current = codex, turns = 0, open = null, status = 'idle', defaultPreset = 'standard' } = {}) {
  const records = [], listeners = new Map(), disposers = [];
  let selection = current;
  const agent = { id: 'synthetic-session', ctx: { mode: preset }, status,
    session: { id: 'synthetic-session', header: {}, lastTurn: turns, open,
      snapshotEvents: () => records.filter(([type]) => type === 'model').map(([, data]) => ({ type: 'model/selection', data })),
    }, maintaining: false,
    model: { current: () => selection, select(next) {
      const event = { type: 'model/selection', data: next };
      listeners.get('internal/dispatch')?.('emit', 'session/event', [agent.session, event]);
      records.push(['model', { ...next }]); selection = { ...next };
      listeners.get('session/event')?.(agent.session, event);
    } },
    runMaintenance(job) {
      if (this.maintaining || this.status !== 'idle') throw new Error('active work');
      this.maintaining = true;
      this.maintenanceDone = (async () => {
        try { return await job(new AbortController().signal); } finally { this.maintaining = false; }
      })();
      return this.maintenanceDone;
    },
  };
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, list: () => [agent], turnBoundaryOf: s => ({ lastTurn: s.lastTurn, openTurnStartSeq: s.open }) },
    agentPresets: { defaultId: defaultPreset, list: async () => ['standard', 'ptc', 'minimal', 'cordis', 'writing'].map(id => ({ id })), composedPreset: actx => actx.mode, async select(target, mode) {
      if (target.session.open !== null || target.session.lastTurn > 0) throw new Error('locked');
      records.push(['preset', mode]); target.ctx.mode = mode;
      listeners.get('agent-preset/selected')?.(target.id, mode);
      return mode;
    } },
    sessionController: { modelCatalog: async () => catalog },
    llm: { resolveCallConfig: async value => value },
    on(name, fn) { listeners.set(name, fn); }, effect(fn) { const d = fn(); if (d) disposers.push(d); }, logger: { warn(message) { records.push(['warning', message]); } },
  };
  return { ctx, records, listeners, disposers, agent, controller: new WritingController(ctx) };
}

test('Gemini categories recognize future and per-account IDs without changing native modes', () => {
  for (const model of ['gemini-99-future', 'antigravity-gemini-5', '~account:synthetic:gemini-4-hydrogen']) assert.equal(isGemini({ model }), true);
  for (const model of ['gpt-fixture', 'claude-fixture', 'notgemini', '~account:a:%invalid']) assert.equal(isGemini({ model }), false);
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    assert.equal(matchesMode(codex, preset), true);
    assert.throws(() => assertModelCategory(gemini, preset), /非 Gemini/);
  }
  assert.equal(matchesMode(gemini, 'writing'), true);
  assert.throws(() => assertModelCategory(codex, 'writing'), /只能选择 Gemini/);
});

test('writing selects Gemini and nonwriting preserves available non-Gemini preferences', () => {
  assert.deepEqual(matchingSelection(catalog, 'writing', codex), gemini);
  assert.deepEqual(matchingSelection(catalog, 'standard', gemini), codex);
  assert.deepEqual(matchingSelection(catalog, 'writing', { ...gemini, reasoningEffort: 'high' }), { ...gemini, reasoningEffort: 'high' });
  assert.throws(() => matchingSelection({ groups: [catalog.groups[0]] }, 'writing', codex), /没有可用的 Gemini/);
});

test('production blank writing prefers available local Gemini and falls back to other Gemini', async () => {
  for (const [current, groups, expected] of [
    [codex, [...catalog.groups, localGroup], localGemini],
    [gemini, [...catalog.groups, localGroup], localGemini],
    [gemini, catalog.groups, gemini],
    [localGemini, catalog.groups, gemini],
    [localGemini, [...catalog.groups, localGroup], localGemini],
  ]) {
    const f = fixture({ preset: 'writing', current });
    const deploymentCatalog = { default: current, groups };
    const resolved = [];
    f.ctx.sessionController.modelCatalog = async () => deploymentCatalog;
    f.ctx.llm.resolveCallConfig = async selection => { resolved.push(selection); };
    apply(f.ctx, production);
    await f.agent.runMaintenance(signal => f.listeners.get('agent/created')({ agent: f.agent, signal }));
    assert.deepEqual(f.records, [['model', expected]]);
    assert.deepEqual(resolved, [expected]);
    assert.deepEqual(deploymentCatalog.default, current, 'automatic choice is session-local');
    assert.equal(f.agent.ctx.mode, 'writing');
  }
});

test('production preset switching picks a writing model but preserves a manually selected Gemini', async () => {
  for (const manual of [null, { ...gemini, reasoningEffort: 'high' }]) {
    const f = fixture();
    f.ctx.sessionController.modelCatalog = async () => {
      assert.equal(manual, null, 'a recorded Gemini needs no automatic pick');
      return { ...catalog, groups: [...catalog.groups, localGroup] };
    };
    apply(f.ctx, production);
    if (manual) f.agent.model.select(manual);
    await f.ctx.agentPresets.select(f.agent, 'writing');
    await f.agent.maintenanceDone;
    assert.deepEqual(f.records, manual ? [['model', manual], ['preset', 'writing']] : [['preset', 'writing'], ['model', localGemini]]);
    const selected = { ...gemini, reasoningEffort: 'low' };
    f.agent.model.select(selected);
    assert.deepEqual(f.agent.model.current(), selected);
    assert.equal(f.agent.ctx.mode, 'writing');
    assert.equal(f.agent.maintaining, false);
  }
});

test('production ordinary presets accept GPT and both kinds of Gemini without changing the preset', async () => {
  for (const [preset, turns] of [['standard', 0], ['ptc', 1], ['minimal', 2], ['cordis', 0]]) {
    const f = fixture({ preset, current: gemini, turns });
    f.ctx.sessionController.modelCatalog = async () => assert.fail('ordinary modes keep the native model');
    apply(f.ctx, production);
    await f.agent.runMaintenance(signal => f.listeners.get('agent/created')({ agent: f.agent, signal }));
    assert.deepEqual(f.records, []);
    for (const selected of [gemini, localGemini, codex]) {
      f.agent.model.select(selected);
      assert.equal(f.listeners.get('agent/pre-step')({ agent: f.agent, modelSelection: selected }, () => 'allowed'), 'allowed');
    }
    assert.equal(f.agent.ctx.mode, preset);
    assert.equal(f.agent.maintaining, false);
    assert.deepEqual(f.records, [['model', gemini], ['model', localGemini], ['model', codex]]);
  }
});

test('production writing rejects non-Gemini before append or pre-step, even while blank', () => {
  for (const turns of [0, 1]) {
    const f = fixture({ preset: 'writing', current: localGemini, turns });
    f.ctx.sessionController.registerTurnProvider = () => assert.fail('policy does not register turn providers');
    apply(f.ctx, production);
    const preStep = f.listeners.get('agent/pre-step');
    for (const selection of [codex, { provider: 'turn:antigravity', model: codex.model }]) {
      assert.throws(() => f.agent.model.select(selection), /只能选择 Gemini/);
      assert.throws(() => preStep({ agent: f.agent, modelSelection: selection }, () => assert.fail('wrong category')), /只能选择 Gemini/);
    }
    assert.deepEqual(f.records, []);
    assert.equal(f.agent.ctx.mode, 'writing');
    assert.equal(f.agent.maintaining, false);
    assert.deepEqual(f.agent.model.current(), localGemini);
  }
});

test('native new-writing initialization pairs model without nesting factory maintenance', async () => {
  const f = fixture({ preset: 'writing' }); apply(f.ctx);
  await f.agent.runMaintenance(signal => f.listeners.get('agent/created')({ agent: f.agent, signal }));
  assert.deepEqual(f.agent.model.current(), gemini);
  assert.deepEqual(f.records, [['model', gemini]]);
});

test('new nonwriting with Gemini default follows chosen native mode without recomposition', async () => {
  const f = fixture({ current: gemini }); apply(f.ctx);
  await f.agent.runMaintenance(signal => f.listeners.get('agent/created')({ agent: f.agent, signal }));
  assert.deepEqual(f.agent.model.current(), codex);
  assert.equal(f.agent.ctx.mode, 'standard');
});

test('a retired default repicks a usable local model for a blank session only', async () => {
  const retired = { provider: 'antigravity', model: 'gemini-4-hydrogen' };
  const oldGroup = { id: retired.provider, models: [{ id: retired.model }] };
  const withLegacy = { default: retired, groups: [oldGroup, ...catalog.groups] };
  for (const [preset, expected] of [['writing', gemini], ['standard', codex]]) {
    const f = fixture({ current: retired, preset });
    const resolved = [];
    f.ctx.sessionController.modelCatalog = async () => withLegacy;
    f.ctx.llm.resolveCallConfig = async next => { resolved.push(next); };
    apply(f.ctx);
    await f.agent.runMaintenance(signal => f.listeners.get('agent/created')({ agent: f.agent, signal }));
    assert.deepEqual(resolved, [expected]);
    assert.deepEqual(f.records, [['model', expected]]);
    assert.deepEqual(withLegacy.default, retired, 'do not write the DSH default');
    assert.throws(() => f.agent.model.select(retired), /旧 Antigravity 订阅已停用/);
    assert.deepEqual(f.records, [['model', expected]], 'retired selection is rejected before commit');
  }
  const historical = fixture({ current: retired, preset: 'writing', turns: 2 });
  historical.ctx.sessionController.modelCatalog = async () => assert.fail('do not normalize history');
  await historical.controller.initialize(historical.agent);
  assert.deepEqual(historical.agent.model.current(), retired);
  assert.deepEqual(historical.records, []);
  assert.throws(() => matchingSelection({ default: retired, groups: [oldGroup, catalog.groups[0]] }, 'writing', retired), /另行配置/);
});

test('Gemini native fixture is ignored by writing mode and resolves no ordinary model', async () => {
  const f = fixture({ preset: 'writing', current: codex });
  const { AGY_NATIVE_PRESET } = await import('../src/agy-native-agent.js');
  f.agent.session.header.agentPreset = AGY_NATIVE_PRESET;
  f.ctx.sessionController.modelCatalog = async () => assert.fail('no DSH model for ACP');
  await f.controller.initialize(f.agent);
  assert.deepEqual(f.records, []);
});

test('native preset event defers append but synchronously holds idle until paired', async () => {
  const f = fixture(); apply(f.ctx);
  f.agent.ctx.mode = 'writing';
  f.listeners.get('agent-preset/selected')(f.agent.id, 'writing');
  assert.equal(f.agent.maintaining, true);
  assert.deepEqual(f.records, [], 'no synchronous postcommit append');
  await f.disposers[0]();
  // Use a separate direct controller to cover successful completion, as close
  // intentionally cancels the not-yet-committed automatic operation above.
  const g = fixture({ preset: 'writing' });
  g.controller.onPresetSelected(g.agent);
  await Promise.all([...g.controller.pending]);
  assert.deepEqual(g.agent.model.current(), gemini);
});

test('started sessions still reject wrong category before mutation including running sessions', () => {
  for (const options of [{ turns: 2 }, { turns: 2, open: 11, status: 'running' }]) {
    const f = fixture(options); apply(f.ctx);
    assert.throws(() => f.agent.model.select(gemini), /当前模式只能/);
    assert.deepEqual(f.agent.model.current(), codex);
    assert.deepEqual(f.records, []);
    f.agent.model.select({ ...codex, reasoningEffort: 'high' });
    assert.equal(f.agent.model.current().reasoningEffort, 'high');
  }
});

test('native blank Gemini choice holds idle then changes only its preset after commit', async () => {
  const f = fixture(); apply(f.ctx);
  f.agent.model.select(gemini);
  assert.equal(f.agent.maintaining, true, 'first prompt cannot wake during auto-pairing');
  assert.equal(f.agent.ctx.mode, 'standard', 'preset append never reenters model publication');
  assert.deepEqual(f.records, [['model', gemini]]);
  await f.agent.maintenanceDone;
  assert.equal(f.agent.ctx.mode, 'writing');
  assert.deepEqual(f.agent.model.current(), gemini, 'keep the exact user-selected Gemini');
  assert.deepEqual(f.records, [['model', gemini], ['preset', 'writing']]);
  await f.disposers[0]();
});

test('uncommitted or failed candidate never changes a blank preset', async () => {
  const f = fixture();
  f.controller.onModelSelection(f.agent, { type: 'model/selection', data: gemini });
  await Promise.all([...f.controller.pending]);
  assert.deepEqual(f.records, []);
  assert.equal(f.agent.ctx.mode, 'standard');
  f.agent.maintaining = true;
  assert.throws(() => f.controller.onModelSelection(f.agent, {}), /active work/);
  assert.equal(f.controller.normalizing.has(f.agent), false);
});

test('blank writing exits to the default nonwriting mode and keeps the clicked model and effort', async () => {
  for (const defaultPreset of ['standard', 'ptc', 'minimal', 'cordis']) {
    const f = fixture({ preset: 'writing', current: gemini, defaultPreset }); apply(f.ctx);
    const selected = { ...codex, reasoningEffort: 'high' };
    f.agent.model.select(selected);
    assert.equal(f.agent.maintaining, true);
    assert.equal(f.agent.ctx.mode, 'writing', 'defer preset until model publication completes');
    await f.agent.maintenanceDone;
    assert.equal(f.agent.ctx.mode, defaultPreset);
    assert.deepEqual(f.agent.model.current(), selected);
    assert.deepEqual(f.records, [['model', selected], ['preset', defaultPreset]]);
  }
});

test('nonwriting fallback never chooses writing or a broken preset', () => {
  const rows = [{ id: 'writing' }, { id: 'ptc', broken: 'fixture' }, { id: 'standard' }, { id: 'minimal' }];
  assert.equal(defaultNonWritingPreset(rows, 'minimal'), 'minimal');
  for (const preferred of ['writing', 'ptc', 'missing']) assert.equal(defaultNonWritingPreset(rows, preferred), 'standard');
  assert.equal(defaultNonWritingPreset([{ id: 'writing' }, { id: 'minimal' }], 'writing'), 'minimal');
  assert.throws(() => defaultNonWritingPreset([{ id: 'writing' }], 'writing'), /没有可用的非写作模式/);
});

test('blank reverse choice falls back to standard when writing is the deployment default', async () => {
  const f = fixture({ preset: 'writing', current: gemini, defaultPreset: 'writing' }); apply(f.ctx);
  f.agent.model.select(codex);
  await f.agent.maintenanceDone;
  assert.equal(f.agent.ctx.mode, 'standard');
  assert.deepEqual(f.agent.model.current(), codex);
});

test('started writing still refuses non-Gemini without mode or model writes', () => {
  const f = fixture({ preset: 'writing', current: gemini, turns: 1 }); apply(f.ctx);
  assert.throws(() => f.agent.model.select(codex), /只能选择 Gemini/);
  assert.equal(f.agent.ctx.mode, 'writing');
  assert.deepEqual(f.agent.model.current(), gemini);
  assert.deepEqual(f.records, []);
});

test('history and delegated conversations remain unchanged by initialization', async () => {
  const f = fixture({ preset: 'writing', turns: 1 });
  await f.controller.initialize(f.agent);
  assert.deepEqual(f.records, []);
  const g = fixture({ preset: 'writing' }); g.agent.session.header.origin = 'subagent';
  await g.controller.initialize(g.agent);
  assert.deepEqual(g.records, []);
});

test('existing active tool steps continue without cancellation, next round obeys policy', () => {
  const f = fixture({ current: gemini, status: 'running', turns: 1, open: 11 }); apply(f.ctx);
  const guard = f.listeners.get('agent/pre-step');
  assert.equal(guard({ agent: f.agent, modelSelection: gemini }, () => 'old-turn'), 'old-turn');
  f.agent.session.open = 20;
  assert.throws(() => guard({ agent: f.agent, modelSelection: gemini }, () => 'wrong'), /非 Gemini/);
  assert.deepEqual(f.records, []);
});

test('acceptance guard is scoped to exact ordinary live Session and model events', () => {
  const f = fixture(); apply(f.ctx);
  const guard = f.listeners.get('internal/dispatch');
  guard('emit', 'session/event', [{ id: f.agent.id }, { type: 'model/selection', data: gemini }]);
  guard('emit', 'session/event', [f.agent.session, { type: 'agent-preset/selected', data: { agentPreset: 'writing' } }]);
  guard('emit', 'other/event', [f.agent.session, { type: 'model/selection', data: gemini }]);
  f.agent.session.header.origin = 'subagent';
  guard('emit', 'session/event', [f.agent.session, { type: 'model/selection', data: gemini }]);
  assert.deepEqual(f.records, []);
});

test('whole-turn Antigravity choices retain the current preset even before the first prompt', async () => {
  const external = { provider: 'turn:antigravity', model: 'gemini-official-fixture' };
  for (const [preset, ordinary, wrong] of [['standard', codex, gemini], ['writing', gemini, codex]]) {
    const f = fixture({ preset, current: ordinary });
    f.ctx.sessionController.registerTurnProvider = () => assert.fail('policy never registers or grants a route');
    apply(f.ctx);
    f.agent.model.select(external);
    assert.equal(f.agent.maintaining, false);
    await f.listeners.get('agent/created')({ agent: f.agent, signal: new AbortController().signal });
    assert.deepEqual(f.agent.model.current(), external);
    assert.throws(() => f.agent.model.select(wrong), /模式/);
    f.agent.model.select(ordinary);
    assert.equal(f.agent.ctx.mode, preset);
    assert.deepEqual(f.records, [['model', external], ['model', ordinary]]);
  }
});

test('Host leaves native services, transport, credentials and defaults alone', async () => {
  const source = await readFile(new URL('../src/writing-host.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.cancel\(|connection\.|fetch\.register|modelDirectories|\.prototype|agentDefaultModel|settings\.|workingDirectory|resolveAgent|selectModel\(/);
  assert.match(source, /internal\/dispatch/);
  assert.match(source, /event\?\.type !== 'model\/selection'/);
});
