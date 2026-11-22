import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localHistory, prepareLocalHistory } from '../src/agy-local-context.js';
import { agyGptBridgeTools, createGptReturns, extractAssistantReplies, isForbiddenGptProvider } from '../src/agy-local-gpt-bridge.js';
import { createLocalAgy } from '../src/agy-local-runtime.js';

const textBlock = text => ({ type: 'text', text });

test('Upgrade 3: built Host & Client support Codex ultrafast tier, catalog discovery, wire format, and /speed command', async () => {
  const hostSource = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

  assert.match(clientSource, /speedUltrafast: "Ultrafast"/);
  assert.match(clientSource, /speedUltrafast: "超快"/);
  assert.match(clientSource, /state\.ultrafastModels/);
  assert.match(clientSource, /value: "ultrafast"/);

  assert.match(hostSource, /CODEX_ULTRAFAST_SERVICE_TIER = "ultrafast"/);
  assert.match(hostSource, /name: "speed"/);
  assert.match(hostSource, /ultrafastModels/);

  const readFn = (name) => {
    const start = hostSource.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing ${name}`);
    let depth = 0, i = hostSource.indexOf('{', start);
    for (; i < hostSource.length; i++) {
      if (hostSource[i] === '{') depth++;
      else if (hostSource[i] === '}' && --depth === 0) return hostSource.slice(start, i + 1);
    }
    throw new Error(`unclosed ${name}`);
  };
  const evalCode = `
    const CODEX_FAST_SERVICE_TIER = "priority";
    const CODEX_FAST_SPEED_TIER = "fast";
    const CODEX_ULTRAFAST_SERVICE_TIER = "ultrafast";
    const CODEX_ULTRAFAST_SPEED_TIER = "ultrafast";
    const DEFAULT_CODEX_INSTRUCTIONS = "default";
    const normalizeCodexCallIds = x => x;
    const reconcileResponsesToolCalls = x => x;
    const codexWireEffort = x => x;
    const toResponsesTools = x => x;
    class BadRequest extends Error {}
    ${readFn('supportsFastTier')}
    ${readFn('supportsUltrafastTier')}
    ${readFn('readSpeedTier')}
    ${readFn('codexRequestBody')}
    return { supportsFastTier, supportsUltrafastTier, readSpeedTier, codexRequestBody };
  `;
  const { supportsFastTier, supportsUltrafastTier, readSpeedTier, codexRequestBody } = new Function(evalCode)();

  assert.equal(supportsUltrafastTier({ service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] }), true);
  assert.equal(supportsUltrafastTier({ additional_speed_tiers: ['fast', 'ultrafast'] }), true);
  assert.equal(supportsUltrafastTier({ service_tiers: [{ id: 'priority' }], additional_speed_tiers: ['fast'] }), false);
  assert.equal(supportsFastTier({ service_tiers: [{ id: 'priority' }] }), true);

  assert.equal(readSpeedTier({ tier: 'standard' }), 'standard');
  assert.equal(readSpeedTier({ tier: 'fast' }), 'fast');
  assert.equal(readSpeedTier({ tier: 'ultrafast' }), 'ultrafast');
  assert.throws(() => readSpeedTier({ tier: 'warp' }));

  const reqOpts = { model: 'gpt-6.2-sol' };
  const resolved = { input: [], instructions: 'hi' };
  assert.equal(codexRequestBody(reqOpts, resolved, 'standard').service_tier, undefined);
  assert.equal(codexRequestBody(reqOpts, resolved, 'fast').service_tier, 'priority');
  assert.equal(codexRequestBody(reqOpts, resolved, true).service_tier, 'priority');
  assert.equal(codexRequestBody(reqOpts, resolved, 'ultrafast').service_tier, 'ultrafast');
});

test('parallel returns correlate the exact request, bound the summary and honor cancellation', async () => {
  const parent = { id: 'parent' };
  const message = (seq, rpcId) => ({ seq, type: 'user/message', surfaceOp: 'append', data: { source: { rpcId } } });
  const event = (seq, type, data) => ({ seq, type, data });
  const reply = (seq, text) => event(seq, 'assistant/message', { message: { content: [textBlock(text)] } });
  const end = (seq, kind = 'completed') => event(seq, 'turn/end', { reason: { kind } });
  const events = [event(1, 'turn/start'), message(2, 'old'), reply(3, 'unrelated'), end(4),
    event(5, 'turn/start'), message(6, 'wanted'), reply(7, `start ${'中'.repeat(7000)} end`), end(8),
    event(9, 'turn/start'), message(10, 'later'), reply(11, 'wrong'), end(12)];
  const child = { session: { snapshotEvents: start => events.filter(e => e.seq >= start) } };
  let wait;
  const controller = { wait: (request, signal) => {
    wait = Promise.withResolvers();
    signal.addEventListener('abort', () => wait.reject(signal.reason), { once: true });
    return wait.promise;
  } };
  const services = { sessionController: controller, agents: { get: () => child } };
  const notices = [];
  const lifetime = new AbortController();
  const returns = createGptReturns({ get: name => services[name] }, lifetime.signal, (...args) => notices.push(args));
  assert.equal(returns.watch(parent, 'child', 'wanted', 0, '任务'), true);
  wait.resolve({ reason: 'idle', state: { cursor: 12 } });
  await returns.drain();
  assert.equal(notices.length, 1);
  const [destination, body] = notices[0];
  assert.equal(destination, parent);
  assert.match(body, /^\[GPT 回传 · 任务（本轮已结束）\]\n\nstart[\s\S]*end$/);
  assert.doesNotMatch(body, /unrelated|wrong/);
  assert.ok(body.length < 5300);
  for (const cancel of [() => returns.cancel('parent'), () => returns.cancel('child'), () => lifetime.abort()]) {
    assert.equal(returns.watch(parent, 'child', 'wanted', 0), true);
    cancel();
    await returns.drain();
  }
  assert.equal(notices.length, 1);
  assert.equal(returns.watch(parent, 'child', 'wanted', 0), false);
});

test('Upgrade 4: Parallel GPT bridge tools block Google recursion, avoid global default mutation, and coordinate sessions', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-gpt-bridge-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const createdSessions = new Map();
  const prompts = [];
  const cancelled = [];
  let globalDefaultSaved = false;

  const parentAgent = {
    id: 'session-gemini-parent',
    session: { header: { id: 'session-gemini-parent', cwd: root } },
    model: { current: () => ({ provider: 'antigravity', model: 'gemini-3-flash' }) },
  };
  const existingAntigravitySession = {
    id: 'session-other-gemini',
    session: { header: { id: 'session-other-gemini', cwd: root } },
    model: { current: () => ({ provider: 'antigravity', model: 'gemini-3.1-pro-high' }) },
  };
  const agentsMap = new Map([
    [parentAgent.id, parentAgent],
    [existingAntigravitySession.id, existingAntigravitySession],
  ]);

  const controller = {
    async create(req) {
      const id = req.sessionId ?? `session-${createdSessions.size + 1}`;
      let selected = { provider: 'deepseek-account', model: 'deepseek-chat' };
      const agent = {
        id,
        session: { header: { id, cwd: root } },
        model: {
          current: () => selected,
          select(next) { selected = next; },
        },
      };
      createdSessions.set(id, { req, agent, title: null, running: false, cursor: 10 });
      agentsMap.set(id, agent);
      return { sessionId: id };
    },
    async resolveAgent(sessionId) {
      const agent = agentsMap.get(sessionId);
      return agent ? { agent } : { error: new Error(`not found: ${sessionId}`) };
    },
    async selectModel() {
      globalDefaultSaved = true;
      throw new Error('should not call selectModel when resolveAgent is available');
    },
    async rename({ sessionId, title }) {
      const row = createdSessions.get(sessionId);
      if (row) row.title = title;
      return { title, seq: 1 };
    },
    async prompt(req) {
      prompts.push(req);
      const row = createdSessions.get(req.sessionId);
      if (row) { row.running = true; row.cursor += 2; }
      return { accepted: true };
    },
    async wait({ sessionId }) {
      const row = createdSessions.get(sessionId);
      if (row) row.running = false;
      return {
        reason: 'idle',
        state: { cursor: row?.cursor ?? 12, active: true, running: false, queue: [], pendingInput: [] },
        output: {
          truncated: false,
          records: [
            { type: 'event', event: { seq: 12, type: 'assistant/message', data: { message: { content: [textBlock('第二段结论')] } } } },
            { type: 'event', event: { seq: 11, type: 'assistant/message', data: { message: { content: [textBlock('第一段分析')] } } } },
          ],
        },
      };
    },
    async state({ sessionId }) {
      const row = createdSessions.get(sessionId);
      return { cursor: row?.cursor ?? 5, active: true, running: Boolean(row?.running), queue: [], pendingInput: [] };
    },
    async events({ address }) {
      return {
        cursor: 12,
        hasMore: false,
        records: [
          { type: 'event', event: { seq: 12, type: 'assistant/message', data: { message: { content: [textBlock(`最新回复@${address.sessionId}`)] } } } },
        ],
      };
    },
    async projections({ sessionId }) {
      const row = createdSessions.get(sessionId);
      return { kind: 'sequenced', asOfSeq: 12, values: { title: row?.title ?? null } };
    },
    async list() {
      return {
        items: [
          { sessionId: parentAgent.id, cwd: root, running: true, updatedAt: 100, projections: { values: { title: 'Gemini 主会话' } } },
          { sessionId: 'subagent-1', origin: 'subagent', cwd: root, running: false, updatedAt: 200 },
          { sessionId: 'archived-1', cwd: root, running: false, updatedAt: 300 },
          ...[...createdSessions.values()].map(row => ({
            sessionId: row.agent.id, cwd: root, running: row.running, updatedAt: 400,
            projections: { values: { title: row.title } },
          })),
        ],
      };
    },
    async cancel({ sessionId }) {
      cancelled.push(sessionId);
      return { accepted: true };
    },
  };

  const services = new Map([
    ['sessionController', controller],
    ['agents', { get: id => agentsMap.get(id) }],
    ['workspaceRegistry', {
      archivedSessionIds: ['archived-1'],
      list: () => [{ id: 'ws-main', path: root, sessionIds: [parentAgent.id] }],
      async resolveByPath(path) { return path === root ? this.list()[0] : undefined; },
    }],
    ['llm', {
      listProviders: () => [{ id: 'antigravity' }, { id: 'codex' }, { id: 'deepseek-account' }],
      listModels: async provider => ({
        codex: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.1-sol' }],
        'deepseek-account': [{ id: 'deepseek-chat' }],
      })[provider] ?? [],
      resolveCallConfig: async () => ({}),
    }],
  ]);
  const ctx = { get: name => services.get(name) };

  assert.equal(isForbiddenGptProvider('antigravity'), true);
  assert.equal(isForbiddenGptProvider('Antigravity'), true);
  assert.equal(isForbiddenGptProvider('turn:antigravity'), true);
  assert.equal(isForbiddenGptProvider('codex'), false);

  const tools = agyGptBridgeTools(ctx);
  assert.deepEqual([...tools.keys()].sort(), [
    'dsh_delegate_gpt', 'dsh_gpt_list', 'dsh_gpt_status', 'dsh_gpt_stop', 'dsh_gpt_wait',
  ]);

  const signal = new AbortController().signal;
  const turn = { agent: parentAgent };

  await assert.rejects(
    tools.get('dsh_delegate_gpt').execute({ prompt: 'do work', provider: 'antigravity', model: 'gemini-3-flash' }, turn, signal),
    /Google Antigravity is forbidden/
  );
  await assert.rejects(
    tools.get('dsh_delegate_gpt').execute({ prompt: 'continue', sessionId: existingAntigravitySession.id }, turn, signal),
    /Google Antigravity/
  );
  await assert.rejects(
    tools.get('dsh_delegate_gpt').execute({ prompt: 'loop', sessionId: parentAgent.id }, turn, signal),
    /current Gemini session/
  );

  const started = await tools.get('dsh_delegate_gpt').execute({ prompt: '帮我写一个重构方案', title: '架构重构', cwd: root }, turn, signal);
  assert.equal(started.status, 'started');
  assert.equal(started.title, '架构重构（GPT）');
  assert.deepEqual(started.selection, { provider: 'codex', model: 'gpt-6.2-sol' });
  assert.equal(globalDefaultSaved, false, 'parallel session selection never overwrites global default');
  assert.equal(createdSessions.get(started.sessionId).req.workspaceId, 'ws-main');

  const listed = await tools.get('dsh_gpt_list').execute({}, turn, signal);
  assert.deepEqual(listed.sessions.map(s => s.sessionId), [started.sessionId, parentAgent.id]);

  const statusRes = await tools.get('dsh_gpt_status').execute({ sessionId: started.sessionId }, turn, signal);
  assert.equal(statusRes.status, 'running');
  assert.equal(statusRes.title, '架构重构（GPT）');
  assert.deepEqual(statusRes.model, { provider: 'codex', model: 'gpt-6.2-sol' });

  const waitRes = await tools.get('dsh_gpt_wait').execute({ sessionId: started.sessionId, timeoutSec: 30 }, turn, signal);
  assert.equal(waitRes.reason, 'idle');
  assert.equal(waitRes.reply, '第一段分析\n\n第二段结论');

  await assert.rejects(tools.get('dsh_gpt_stop').execute({ sessionId: parentAgent.id }, turn, signal), /current Gemini session/);
  const stopped = await tools.get('dsh_gpt_stop').execute({ sessionId: started.sessionId }, turn, signal);
  assert.equal(stopped.accepted, true);
  assert.deepEqual(cancelled, [started.sessionId]);
  assert.equal(extractAssistantReplies([]).reply, '');

  const delegate = tools.get('dsh_delegate_gpt');
  assert.match(delegate.inputSchema.properties.title.description, /Task（GPT）/u);
  for (const [args, expectedTitle] of [
    [{ title: '架构重构（GPT）' }, '架构重构（GPT）'],
    [{ title: '[GPT] 架构重构 (gpt)' }, '架构重构（GPT）'],
    [{ title: '架构重构（gpt-6.1-sol）', model: 'gpt-6.1-sol' }, '架构重构（GPT）'],
    [{ title: '[GPT] 架构重构（GPT） (deepseek-chat)', provider: 'deepseek-account' }, '架构重构（DeepSeek）'],
    [{ title: '[GPT]', prompt: '  帮我\n写方案  ' }, '帮我 写方案（GPT）'],
    [{ title: '架构重构（草案）' }, '架构重构（草案）（GPT）'],
    [{ title: '改'.repeat(100) }, `${'改'.repeat(75)}（GPT）`],
  ]) {
    const result = await delegate.execute({ prompt: '帮我写一个重构方案', cwd: root, ...args }, turn, signal);
    assert.equal(result.title, expectedTitle);
    assert.equal(createdSessions.get(result.sessionId).title, expectedTitle);
  }

  const watched = [];
  const stopReturns = [];
  const notifying = agyGptBridgeTools(ctx, { notify: (...args) => { watched.push(args); return true; }, cancelReturns: id => stopReturns.push(id) });
  const task = { sessionId: started.sessionId, prompt: '继续', title: '不要重命名' };
  assert.equal((await notifying.get('dsh_delegate_gpt').execute(task, turn, signal)).notifyParent, true);
  assert.equal((await notifying.get('dsh_delegate_gpt').execute({ ...task, notifyParent: false }, turn, signal)).notifyParent, false);
  await notifying.get('dsh_delegate_gpt').execute({ ...task, wait: true }, turn, signal);
  assert.equal(watched.length, 1);
  assert.equal(watched[0][0], parentAgent);
  assert.equal(watched[0][1], started.sessionId);
  await notifying.get('dsh_gpt_stop').execute({ sessionId: started.sessionId }, turn, signal);
  assert.deepEqual(stopReturns, [started.sessionId]);
  assert.equal(createdSessions.get(started.sessionId).title, '架构重构（GPT）');
});

test('Parallel GPT placement uses only registered workspaces and fails closed without one', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-gpt-placement-')));
  const home = join(root, 'home');
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previousHome = process.env[homeVar];
  process.env[homeVar] = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env[homeVar];
    else process.env[homeVar] = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  const parentPath = join(root, 'project');
  const childPath = join(parentPath, 'unregistered');
  const namedPath = join(root, 'other-project');
  const defaultPath = join(home, '.dsh', 'workspaces', 'GPT');
  await Promise.all([childPath, namedPath, home].map(path => mkdir(path, { recursive: true })));
  const parentAgent = { id: 'parent', session: { header: { cwd: parentPath } } };
  const parent = { id: 'ws-parent', title: 'Project', path: parentPath, sessionIds: [parentAgent.id] };
  const named = { id: 'ws-named', title: 'GPT', path: namedPath, sessionIds: [] };
  const registrations = [];
  const rows = [parent, named];
  let refuseRegistration = false;
  const registry = {
    list: () => rows.slice(),
    async resolveByPath(path) {
      const canonical = await realpath(path);
      return rows.find(row => row.path === canonical);
    },
    async create(path, title) {
      registrations.push({ path, title });
      assert.ok((await stat(path)).isDirectory(), 'directory must exist before registration');
      if (refuseRegistration) throw new Error('fixture registration failed');
      const row = { id: 'ws-default', title, path, sessionIds: [] };
      rows.push(row);
      return row;
    },
  };
  const creations = [];
  const controller = {
    async create({ sessionId, ...req }) {
      assert.deepEqual(Object.keys(req), ['workspaceId'], 'must never send a cwd-only or ungrouped request');
      assert.ok(rows.some(row => row.id === req.workspaceId), 'workspace must already be registered');
      creations.push(req.workspaceId);
      return { sessionId };
    },
    async resolveAgent() { return { agent: { model: { select() {} } } }; },
    async prompt() {},
  };
  const services = new Map([['sessionController', controller], ['workspaceRegistry', registry], ['llm', {
    listProviders: () => [{ id: 'codex' }], listModels: async () => [{ id: 'gpt-6.2-sol' }],
  }]]);
  const delegate = agyGptBridgeTools({ get: name => services.get(name) }).get('dsh_delegate_gpt');
  const start = args => delegate.execute({ prompt: 'Synthetic task', title: '[GPT] Design (GPT)（Codex）', ...args }, { agent: parentAgent }, t.signal);

  assert.equal((await start({ cwd: `${parentPath}/.` })).title, 'Design（GPT）');
  assert.deepEqual(creations, [parent.id], 'explicit exact cwd wins over a named GPT workspace');
  assert.equal((await start()).title, 'Design（GPT）', 'display name GPT alone does not suppress the directory-based suffix');
  assert.equal(creations.at(-1), named.id);
  assert.deepEqual(registrations, []);
  await assert.rejects(stat(defaultPath), { code: 'ENOENT' });

  rows.pop();
  await assert.rejects(start({ cwd: join(root, 'not-a-directory') }), /Invalid or unavailable working directory/);
  assert.equal(creations.length, 2);
  const obstruction = join(home, '.dsh');
  await writeFile(obstruction, 'fixture obstruction');
  assert.equal((await start({ cwd: childPath })).title, 'Design（GPT）');
  assert.equal(creations.at(-1), parent.id, 'fallback uses the parent workspace after mkdir failure');
  assert.deepEqual(registrations, []);

  // An existing directory at a new synthetic home permits mkdir but not registration.
  const secondHome = join(root, 'second-home');
  process.env[homeVar] = secondHome;
  const secondDefault = join(secondHome, '.dsh', 'workspaces', 'GPT');
  refuseRegistration = true;
  await start();
  assert.equal(creations.at(-1), parent.id, 'fallback uses the parent workspace after registry failure');
  rows[0] = { ...parent, path: join(root, 'missing-project') };
  await assert.rejects(start(), /no usable parent workspace.*no session was created/);
  assert.equal(creations.length, 4, 'retained membership of a missing directory cannot admit a new session');
  rows.splice(0, 1);
  await assert.rejects(start(), /no usable parent workspace.*no session was created/);
  assert.equal(creations.length, 4, 'unregistered parent cwd does not become a workspace');

  refuseRegistration = false;
  rows.push(parent);
  assert.equal((await start({ cwd: childPath })).title, 'Design', 'an ancestor match does not displace the GPT group');
  assert.equal(creations.at(-1), 'ws-default');
  assert.deepEqual(registrations.at(-1), { path: secondDefault, title: 'GPT' });
  assert.equal((await start({ cwd: secondDefault })).title, 'Design');
  await start();
  assert.equal(creations.at(-1), 'ws-default');
  assert.equal(registrations.length, 4, 'registered GPT workspace is reused');

  services.delete('workspaceRegistry');
  await assert.rejects(start(), /no usable parent workspace.*no session was created/);
  assert.equal(creations.length, 7);
});

test('Upgrade 5: localHistory preserves compaction summaries and prepareLocalHistory writes an archive only when truncated', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-history-archive-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const compactedEvents = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock('早期决策 A')] } },
    { seq: 3, surfaceOp: 'append', type: 'assistant/message', data: { turn: 1, message: { content: [textBlock('确认决策 A')] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 5, type: 'compaction/summary', data: { summary: [textBlock('压缩摘要：项目采用插件式双模型架构，核心结论是决策 A。')], shadowedRange: { start: 1, end: 4 } } },
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock('第二轮问题')] } },
    { seq: 8, surfaceOp: 'append', type: 'assistant/message', data: { turn: 2, message: { content: [textBlock('第二轮答复')] } } },
    { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { seq: 10, type: 'turn/start', data: { turn: 3 } },
    { seq: 11, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock('最新问题')] } },
    { seq: 12, surfaceOp: 'append', type: 'assistant/message', data: { turn: 3, message: { content: [textBlock('最新答复')] } } },
    { seq: 13, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ];
  const shortArchive = join(root, 'short-archive.md');
  const withSummary = await prepareLocalHistory({ snapshotEvents: () => compactedEvents }, 14, 0, { archivePath: shortArchive });
  assert.match(withSummary, /"role":"summary".*压缩摘要：项目采用插件式双模型架构/);
  assert.match(withSummary, /最新问题.*最新答复/);
  assert.doesNotMatch(withSummary, /archived at/, 'short history does not write an archive');

  // If afterTurn already passed turn 2 (after compaction at seq 5), do not re-inject the old compaction summary
  const incremental = localHistory({ snapshotEvents: () => compactedEvents }, 14, 2);
  assert.doesNotMatch(incremental, /"role":"summary"/);
  assert.match(incremental, /最新问题/);

  const hugeEvents = [];
  let seq = 0;
  for (let turn = 1; turn <= 12; turn++) {
    hugeEvents.push({ seq: ++seq, type: 'turn/start', data: { turn } });
    hugeEvents.push({ seq: ++seq, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock(`TURN-${turn}-MARKER ` + 'A'.repeat(12_000))] } });
    hugeEvents.push({ seq: ++seq, surfaceOp: 'append', type: 'assistant/message', data: { turn, message: { content: [textBlock(`REPLY-${turn}-MARKER ` + 'B'.repeat(12_000))] } } });
    hugeEvents.push({ seq: ++seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
  const bigArchive = join(root, 'dsh-history-archive.md');
  const handoff = await prepareLocalHistory({ snapshotEvents: () => hugeEvents }, seq + 1, 0, { archivePath: bigArchive });
  assert.match(handoff, /TURN-12-MARKER/);
  assert.doesNotMatch(handoff, /TURN-1-MARKER/, 'oldest turns dropped from inline handoff');
  assert.ok(handoff.includes(JSON.stringify(bigArchive)), 'handoff points Gemini to the archive path');
  const archivedText = await readFile(bigArchive, 'utf8');
  assert.match(archivedText, /TURN-1-MARKER/);
  assert.match(archivedText, /REPLY-1-MARKER/);
  assert.match(archivedText, /TURN-12-MARKER/);
});

test('Upgrade 6 (0.3.0-gemini.7): createLocalAgy supports official ACP authenticate and logout without touching credentials', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-auth-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const runtime = createLocalAgy({ dataDir: join(root, 'data') }, {
    verify: async () => join(root, 'agy.exe'),
    resolveProxy: async () => ({}),
    makeTransport(options) {
      events.push({ event: 'spawn', allowAuthentication: options.allowAuthentication, permissionMode: options.permissionMode });
      return {
        async start() {
          events.push({ event: 'start' });
          return { agentInfo: { version: '1.5.13' }, agentCapabilities: { auth: { logout: {} } }, authMethods: [{ id: 'oauth-personal' }] };
        },
        async authenticate(methodId) { events.push({ event: 'authenticate', methodId }); },
        async logout() { events.push({ event: 'logout' }); },
        async close() { events.push({ event: 'close' }); },
      };
    },
  });
  const signal = new AbortController().signal;
  await runtime.authenticate(signal);
  await runtime.logout(signal);
  await runtime.dispose();
  assert.deepEqual(events, [
    { event: 'spawn', allowAuthentication: true, permissionMode: 'sandbox' },
    { event: 'start' },
    { event: 'authenticate', methodId: 'oauth-personal' },
    { event: 'close' },
    { event: 'spawn', allowAuthentication: true, permissionMode: 'sandbox' },
    { event: 'start' },
    { event: 'logout' },
    { event: 'close' },
  ]);
});
