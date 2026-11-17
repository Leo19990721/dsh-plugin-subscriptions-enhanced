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
  const gemini = { provider: 'antigravity', model: 'gemini-fixture' };
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
test('native command keeps started modes fixed and pairs blank model choices in both directions', async () => {
  let native = await readFile(join(process.env.DSH_INSTALL_DIR, '../dsh-api-session-controller/lib/index.js'), 'utf8');
  const nativeRequire = createRequire(join(process.env.DSH_INSTALL_DIR, '../dsh-api-session-controller/package.json'));
  native = native.replace('from "mime-types"', `from ${JSON.stringify(pathToFileURL(nativeRequire.resolve('mime-types')).href)}`);
  native += '\nexport { SessionCommandController };';
  const { SessionCommandController } = await import(`data:text/javascript;base64,${Buffer.from(native).toString('base64')}`);
  const ctx = new Context();
  const agents = new Map();
  let writing;
  const codex = { provider: 'codex', model: 'gpt-fixture' };
  const gemini = { provider: 'antigravity', model: 'gemini-fixture' };
  let saved = 0;
  let blank = false;
  let preset = 'standard';
  const llm = {
    listProviders: () => [{ id: 'codex' }, { id: 'antigravity' }],
    listModels: async id => [{ id: id === 'codex' ? codex.model : gemini.model }],
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
      } }, llm, sessionController: {},
      agentDefaultModel: { saveSelection: async () => { saved++; } },
    })) Object.assign(new Service(scope, key, true), value);
  } });
  try {
    await base.inertia;
    const session = ctx.sessions.create('native-select-fixture', { meta: { cwd: process.cwd() } });
    const agent = { id: session.id, session, ctx, status: 'idle', maintaining: false,
      model: new AgentModel(() => ({ lastUsed: codex, pending: session.snapshotEvents().findLast(event => event.type === 'model/selection')?.data ?? null }), session, {}),
      runMaintenance(job) {
        if (this.maintaining) throw new Error('active work');
        this.maintaining = true;
        this.maintenanceDone = (async () => {
          try { return await job(new AbortController().signal); } finally { this.maintaining = false; }
        })();
        return this.maintenanceDone;
      },
    };
    agents.set(agent.id, agent);
    writing = ctx.plugin({ inject: ['agents', 'agentPresets', 'llm', 'sessionController'], apply });
    await writing.inertia;
    const commands = new SessionCommandController(ctx, { resolveAgent: async () => ({ agent }), serializeImageAdmission: async (_agent, job) => job() }, process.cwd());
    const before = session.seq;
    await assert.rejects(commands.selectModel({ sessionId: agent.id, ...gemini }), error => error.code === 'session/model-unavailable' && /非 Gemini/.test(error.message));
    assert.equal(session.seq, before);
    assert.equal(saved, 0);
    assert.deepEqual(await commands.selectModel({ sessionId: agent.id, ...codex, reasoningEffort: 'high' }), { selected: { ...codex, reasoningEffort: 'high' } });
    assert.equal(session.seq, before + 1);
    assert.equal(saved, 1, 'valid native choice keeps normal default persistence');
    blank = true;
    const beforeBlank = session.seq;
    assert.deepEqual(await commands.selectModel({ sessionId: agent.id, ...gemini }), { selected: gemini });
    await agent.maintenanceDone;
    assert.equal(preset, 'writing');
    assert.deepEqual(agent.model.current(), gemini);
    assert.deepEqual(session.snapshotEvents().slice(beforeBlank).map(event => event.type), ['model/selection', 'agent-preset/selected']);
    assert.equal(saved, 2, 'blank choice keeps the native successful default save');
    const beforeReverse = session.snapshotEvents().length;
    const selectedGpt = { ...codex, reasoningEffort: 'high' };
    assert.deepEqual(await commands.selectModel({ sessionId: agent.id, ...selectedGpt }), { selected: selectedGpt });
    await agent.maintenanceDone;
    assert.equal(preset, 'ptc', 'reverse follows the configured default mode');
    assert.deepEqual(agent.model.current(), selectedGpt, 'do not substitute the clicked model or effort');
    assert.deepEqual(session.snapshotEvents().slice(beforeReverse).map(event => event.type), ['model/selection', 'agent-preset/selected']);
    assert.equal(saved, 3, 'reverse choice keeps the normal native save');
    blank = false;
    const beforeStarted = session.seq;
    await assert.rejects(commands.selectModel({ sessionId: agent.id, ...gemini }), error => error.code === 'session/model-unavailable');
    assert.equal(session.seq, beforeStarted);
    assert.equal(saved, 3);
  } finally { await writing?.dispose(); await base.dispose(); }
});
