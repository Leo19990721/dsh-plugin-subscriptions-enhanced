import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertModelCategory, defaultNonWritingPreset, isGemini, matchesMode, matchingSelection } from '../src/writing-policy.js';
import { WritingController, apply } from '../src/writing-host.js';

const gemini = { provider: 'antigravity', model: 'gemini-4-hydrogen' };
const codex = { provider: 'codex', model: 'gpt-fixture' };
const catalog = { default: codex, groups: [
  { id: 'codex', models: [{ id: codex.model }] },
  { id: 'antigravity', models: [{ id: gemini.model }, { id: 'gemini-99-future' }] },
], failures: [] };
function fixture({ preset = 'standard', current = codex, turns = 0, open = null, status = 'idle', defaultPreset = 'standard' } = {}) {
  const records = [], listeners = new Map(), disposers = [];
  let selection = current;
  const agent = { id: 'synthetic-session', ctx: { mode: preset }, status,
    session: { id: 'synthetic-session', header: {}, lastTurn: turns, open }, maintaining: false,
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

test('Host leaves native services, transport, credentials and defaults alone', async () => {
  const source = await readFile(new URL('../src/writing-host.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.cancel\(|connection\.|fetch\.register|modelDirectories|\.prototype|agentDefaultModel|settings\.|workingDirectory|resolveAgent|selectModel\(/);
  assert.match(source, /internal\/dispatch/);
  assert.match(source, /event\?\.type !== 'model\/selection'/);
});
