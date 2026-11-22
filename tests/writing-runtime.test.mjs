import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { AgentModel } from '@deepseek-ai/dsh-agent';
import { apply } from '../src/writing-host.js';

const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
const { load } = require('js-yaml');
const { entryListSchema } = await import('@deepseek-ai/cordis-plugin-include');

test('writing composition exactly matches the installed Minimal plugins on this DSH release', async () => {
  const installed = load(await readFile(join(process.env.DSH_INSTALL_DIR, '../dsh-web-app/presets/minimal.patch.yml'), 'utf8'), { schema: entryListSchema });
  const ours = load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema });
  const writing = ours.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-writing');
  assert.equal(writing.config.id, 'writing');
  assert.equal(writing.config.name, '写作模式');
  // Only the user-approved identity sentence differs; operational composition
  // and !!js loader expressions remain identical to the installed Minimal.
  assert.equal(writing.config.plugins[0].config.prefix, '你是一名中文写作助手，帮助用户起草、修改和整理文字材料。');
  writing.config.plugins[0].config.prefix = installed[0].insert[0].config.plugins[0].config.prefix;
  assert.equal(JSON.stringify(writing.config.plugins), JSON.stringify(installed[0].insert[0].config.plugins));
  assert.equal(ours.some(row => row.id === 'ui-model-selection'), false, 'native model selection stays unchanged');
  assert.equal(ours.some(row => row.id === 'ui-agent-preset'), false, 'preserve original Settings mode management');
});

test('native Session acceptance rejects category before append and remains usable after plugin removal', async () => {
  const ctx = new Context();
  const agents = new Map();
  let writing, session, agent;
  const gemini = { provider: 'fixture-gemini-provider', model: 'gemini-fixture' };
  const codex = { provider: 'codex', model: 'gpt-fixture' };
  const base = ctx.plugin({ apply(scope) {
    new SessionStore(scope);
    for (const [key, value] of Object.entries({
      agents: { get: id => agents.get(id), list: () => [...agents.values()], turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 1 }) },
      agentPresets: { composedPreset: () => 'standard' }, llm: {}, sessionController: {},
    })) Object.assign(new Service(scope, key, true), value);
  } });
  try {
    await base.inertia;
    session = ctx.sessions.create('writing-native-fixture', { meta: { cwd: process.cwd() } });
    agent = { id: session.id, session, ctx, status: 'idle' };
    agent.model = new AgentModel(() => ({ lastUsed: codex, pending: null }), session, {});
    agents.set(agent.id, agent);
    writing = ctx.plugin({ inject: ['agents', 'agentPresets', 'llm', 'sessionController'], apply });
    await writing.inertia;
    assert.equal(writing.state, 2);
    const before = session.seq;
    assert.throws(() => agent.model.select(gemini), /非 Gemini/);
    assert.equal(session.seq, before, 'real append boundary veto precedes durable log mutation');
    agent.model.select({ ...codex, reasoningEffort: 'high' });
    assert.equal(session.seq, before + 1);
    await writing.dispose(); writing = undefined;
    agent.model.select(gemini);
    assert.equal(session.seq, before + 2, 'disposal restores plain native behavior');
  } finally { await writing?.dispose(); await base.dispose(); }
});

// Exercise the installed native command unchanged. Its non-exported command
// class is exposed only in this test's in-memory module, never in the Host.
async function nativeSelectFixture(t, localGoogle) {
  let native = await readFile(join(process.env.DSH_INSTALL_DIR, '../dsh-api-session-controller/lib/index.js'), 'utf8');
  const nativeRequire = createRequire(join(process.env.DSH_INSTALL_DIR, '../dsh-api-session-controller/package.json'));
  native = native.replace('from "mime-types"', `from ${JSON.stringify(pathToFileURL(nativeRequire.resolve('mime-types')).href)}`);
  native += '\nexport { SessionCommandController };';
  const { SessionCommandController } = await import(`data:text/javascript;base64,${Buffer.from(native).toString('base64')}`);
  const ctx = new Context();
  const agents = new Map();
  const codex = { provider: 'codex', model: 'gpt-fixture' };
  const gemini = { provider: 'fixture-gemini-provider', model: 'gemini-fixture' };
  const localGemini = { provider: 'antigravity', model: 'gemini-local-fixture' };
  const models = localGoogle ? [codex, gemini, localGemini] : [codex, gemini];
  let deploymentDefault = codex;
  let saved = 0;
  let blank = false;
  let preset = 'standard';
  const llm = {
    listProviders: () => models.map(({ provider }) => ({ id: provider })),
    listModels: async id => models.filter(({ provider }) => provider === id).map(({ model }) => ({ id: model })),
    resolveModelInfo: async () => ({}), resolveCallConfig: async selection => selection,
  };
  const base = ctx.plugin({ apply(scope) {
    new SessionStore(scope);
    for (const [key, value] of Object.entries({
      agents: { get: id => agents.get(id), list: () => [...agents.values()], turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: blank ? 0 : 1 }) },
      agentPresets: { defaultId: 'ptc', list: async () => ['standard', 'ptc', 'writing'].map(id => ({ id })), composedPreset: () => preset, async select(agent, mode) {
        assert.equal(blank, true);
        preset = mode;
        agent.session.append('agent-preset/selected', { agentPreset: mode });
        scope.emit('agent-preset/selected', agent.id, mode);
      } }, llm, sessionController: { async modelCatalog() {
        return { default: deploymentDefault, groups: models.map(({ provider, model }) => ({ id: provider, models: [{ id: model }] })) };
      } },
      agentDefaultModel: { saveSelection: async selection => { saved++; deploymentDefault = selection; } },
    })) Object.assign(new Service(scope, key, true), value);
  } });
  t.after(() => base.dispose());
  await base.inertia;
  function makeAgent(id) {
    const session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } });
    const agent = { id, session, ctx, status: 'idle', maintaining: false,
      model: new AgentModel(() => ({ lastUsed: null, pending: session.snapshotEvents().findLast(event => event.type === 'model/selection')?.data ?? null }), session, {
        get provider() { return deploymentDefault.provider; }, get model() { return deploymentDefault.model; },
      }),
      runMaintenance(job) {
        if (this.maintaining) throw new Error('active work');
        this.maintaining = true;
        this.maintenanceDone = (async () => {
          try { return await job(new AbortController().signal); } finally { this.maintaining = false; }
        })();
        return this.maintenanceDone;
      },
    };
    agents.set(id, agent);
    return agent;
  }
  const agent = makeAgent('native-select-fixture');
  const writing = ctx.plugin({ inject: ['agents', 'agentPresets', 'llm', 'sessionController'], apply }, { localGoogle });
  t.after(() => writing.dispose());
  await writing.inertia;
  const commands = new SessionCommandController(ctx, { resolveAgent: async id => ({ agent: agents.get(id) }), serializeImageAdmission: async (_agent, job) => job() }, process.cwd());
  return { ctx, agent, makeAgent, codex, gemini, localGemini, commands, get saved() { return saved; }, get preset() { return preset; },
    set blank(value) { blank = value; } };
}

test('native command keeps started modes fixed and pairs blank model choices in both directions', async t => {
  const f = await nativeSelectFixture(t, false);
  const { agent, codex, gemini, commands } = f;
  const { session } = agent;
  const before = session.seq;
  await assert.rejects(commands.selectModel({ sessionId: agent.id, ...gemini }), error => error.code === 'session/model-unavailable' && /非 Gemini/.test(error.message));
  assert.equal(session.seq, before);
  assert.equal(f.saved, 0);
  assert.deepEqual(await commands.selectModel({ sessionId: agent.id, ...codex, reasoningEffort: 'high' }), { selected: { ...codex, reasoningEffort: 'high' } });
  assert.equal(session.seq, before + 1);
  assert.equal(f.saved, 1, 'valid native choice keeps normal default persistence');
  f.blank = true;
  const beforeBlank = session.seq;
  assert.deepEqual(await commands.selectModel({ sessionId: agent.id, ...gemini }), { selected: gemini });
  await agent.maintenanceDone;
  assert.equal(f.preset, 'writing');
  assert.deepEqual(agent.model.current(), gemini);
  assert.deepEqual(session.snapshotEvents().slice(beforeBlank).map(event => event.type), ['model/selection', 'agent-preset/selected']);
  assert.equal(f.saved, 2, 'blank choice keeps the native successful default save');
  const beforeReverse = session.snapshotEvents().length;
  const selectedGpt = { ...codex, reasoningEffort: 'high' };
  assert.deepEqual(await commands.selectModel({ sessionId: agent.id, ...selectedGpt }), { selected: selectedGpt });
  await agent.maintenanceDone;
  assert.equal(f.preset, 'ptc', 'reverse follows the configured default mode');
  assert.deepEqual(agent.model.current(), selectedGpt, 'do not substitute the clicked model or effort');
  assert.deepEqual(session.snapshotEvents().slice(beforeReverse).map(event => event.type), ['model/selection', 'agent-preset/selected']);
  assert.equal(f.saved, 3, 'reverse choice keeps the normal native save');
  f.blank = false;
  const beforeStarted = session.seq;
  await assert.rejects(commands.selectModel({ sessionId: agent.id, ...gemini }), error => error.code === 'session/model-unavailable');
  assert.equal(session.seq, beforeStarted);
  assert.equal(f.saved, 3);
});

test('production native commands leave ordinary modes fixed and guard writing at the append boundary', async t => {
  const f = await nativeSelectFixture(t, true);
  const { ctx, agent, commands, codex, gemini, localGemini } = f;
  const select = (target, selection) => commands.selectModel({ sessionId: target.id, ...selection });
  for (const model of [localGemini, codex, gemini]) {
    assert.deepEqual(await select(agent, model), { selected: model });
    assert.equal(f.preset, 'standard');
  }
  assert.equal(f.saved, 3);
  assert.ok(agent.session.snapshotEvents().every(event => event.type === 'model/selection'));

  f.blank = true;
  const writer = f.makeAgent('native-writing-fixture');
  assert.deepEqual(writer.model.current(), gemini, 'the blank session inherits the ordinary model default');
  await ctx.agentPresets.select(writer, 'writing');
  await writer.maintenanceDone;
  assert.deepEqual(writer.model.current(), localGemini);
  assert.equal(f.saved, 3, 'automatic writing pick never changes the deployment default');
  const beforeRejection = writer.session.seq;
  await assert.rejects(select(writer, codex), error => error.code === 'session/model-unavailable' && /只能选择 Gemini/.test(error.message));
  assert.equal(writer.session.seq, beforeRejection);
  assert.equal(f.saved, 3, 'a rejected choice never saves a model default');
  const manual = { ...gemini, reasoningEffort: 'high' };
  assert.deepEqual(await select(writer, manual), { selected: manual });
  assert.deepEqual(writer.model.current(), manual);
  assert.equal(f.preset, 'writing');
  assert.equal(f.saved, 4);
  assert.deepEqual(writer.session.snapshotEvents().map(event => event.type), ['agent-preset/selected', 'model/selection', 'model/selection']);
});
