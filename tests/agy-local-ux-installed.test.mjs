import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, lstat, stat, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zod from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { AGY_API, AGY_METHOD } from '../lib/agy-ingress.js';
import { apply as applyGoogle } from '../lib/agy-local-plugin.js';
import { agyMcpTools, mcpToolResult } from '../lib/agy-local-mcp.js';
import { AGY_TOOL_CARD, AGY_TOOL_RECORD } from '../lib/agy-local-tool-data.js';
import { agyToolDefinition } from '../src/agy-tool-cards-client.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

const selection = { provider: 'antigravity', model: 'gemini-3-flash' };
const address = sessionId => ({ kind: 'session', sessionId });
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const config = options => ({ ...options, agentsFile: '' });
const asTool = (toolCallId, status, rest = {}) => ({ sessionUpdate: 'tool_call_update', toolCallId, status, ...rest });

function mountLocal(options) {
  return ({ scope, makeSession }) => applyGoogle(scope, config(options), () => ({
    async open(signal, params = {}) {
      const session = makeSession({ ...params, signal });
      await session.open(params.officialId);
      return session;
    },
    async dispose() {},
  }));
}

async function capability(h, who) {
  return h.requestPost(AGY_API, JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: AGY_METHOD,
    payload: { action: 'tool-cards-v1' } }), who);
}

// Use the installed client bundle's real registration, placement and assembly
// classes with DOM-only imports inert. No browser profile or app modification.
async function conversationAssembly() {
  const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const React = { createContext: value => ({ value }), createElement: () => null,
    forwardRef: render => render, memo: render => render, createRef: () => ({ current: null }) };
  async function load(pkg, expose = []) {
    let source = await readFile(require.resolve(`@deepseek-ai/${pkg}/client`), 'utf8');
    // Export existing DOM-free registration helpers only in this in-memory copy.
    if (expose.length) {
      assert.equal(source.split('return module.exports').length, 2);
      source = source.replace('return module.exports', `${expose.map(name => `exports.${name}=${name};`).join('')}return module.exports`);
    }
    let descriptor;
    new Script(source).runInNewContext({ window: { __ModuleLoader__: { load: value => { descriptor = value; } } } });
    const lookup = id => {
      if (id === 'react') return React;
      if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
      if (id === 'zod') return zod;
      if (id === '@deepseek-ai/cordis') return { Service: class {} };
      if (id === '@deepseek-ai/dsh-client-store') return { defineStore: value => value, notifySubscribers: values => values.forEach(fn => fn()) };
      return {};
    };
    lookup.asset = name => name;
    return descriptor.factory(lookup);
  }
  const { ConversationEventRegistry, ConversationViewRegistry, ConversationNodeAssembler } = await load('dsh-client-ui-conversation');
  const names = ['registerChatConversationView', 'registerAssistantConversationNode', 'registerTurnProcess', 'registerToolConversationNode'];
  const chat = await load('dsh-client-ui-chat', names);
  const events = new ConversationEventRegistry(new Context());
  const views = new ConversationViewRegistry(new Context());
  for (const name of names) chat[name]({ uiConversation: { events, views } });
  events.register(agyToolDefinition());
  return new ConversationNodeAssembler(events, views);
}

test('installed Desktop persists and follows one lifecycle card, pages it after reopen, and passes clean context to a different model', { timeout: 20_000 }, async t => {
  const prompting = Promise.withResolvers();
  const h = await createTurnHost(t, { releasedReader: true, desktopRequests: true, withCompaction: true,
    mountSubscription: mountLocal({ backgroundTiming: { shortMs: 12, longMs: 500 } }), acpPrompt: prompting.resolve });
  const id = await h.create();
  assert.equal((await capability(h, 'api')).status, 403);
  const response = await capability(h);
  assert.equal(response.status, 200);
  assert.deepEqual(ok((await response.json()).result), { enabled: true });
  ok(await h.select(id, selection));
  const feed = await h.follow(id);
  t.after(() => feed.return());
  await feed.next();
  ok(await h.prompt(id, 'Run one synthetic tool'));
  const turn = await prompting.promise;
  turn.delta({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Synthetic reasoning only' } });
  turn.delta(asTool('edit-x', 'in_progress', { title: 'Edit fixture', kind: 'edit', locations: [{ path: 'fixture.txt' }] }));
  let live;
  for (;;) {
    const { value, done } = await feed.next();
    assert.equal(done, false);
    if (value.type !== 'event') continue;
    if (value.event.type === 'turn/end') assert.fail(JSON.stringify(value.event));
    if (value.event.type === AGY_TOOL_RECORD) { live = value.event; break; }
  }
  assert.equal(live.data.status, 'in_progress');
  assert.equal(live.surfaceOp, undefined);
  turn.update('Synthetic Gemini answer'); turn.reply();
  await h.idle(id); await feed.return();
  const all = h.events(id);
  assert.equal(all.filter(e => e.type === AGY_TOOL_RECORD).length, 1);
  assert.deepEqual(all.filter(e => e.type === 'assistant/message').at(-1).data.message.content.map(b => [b.type, b.text]), [
    ['reasoning', 'Synthetic reasoning only'], ['text', 'Synthetic Gemini answer'],
  ]);
  assert.ok(!all.some(e => ['tool/call', 'tool/result'].includes(e.type)));
  assert.ok(!h.agent(id).session.deriveMessages().some(message => message.role === 'tool'));
  // A post-terminal ACP update gets a separate DSH wakeup turn, but must
  // settle the original card rather than publishing a second row.
  turn.delta(asTool('edit-x', 'completed', { content: [{ type: 'diff', path: 'fixture.txt', oldText: 'before', newText: 'after' }] }));
  turn.update('Synthetic background answer');
  turn.delta({ sessionUpdate: 'usage_update', used: 15 });
  await h.idle(id);
  assert.equal(h.events(id).findLast(e => e.type === AGY_TOOL_RECORD).data.status, 'completed');
  ok(await h.select(id, ORDINARY_SELECTION));
  ok(await h.prompt(id, 'Switch to the ordinary model'));
  await h.idle(id);
  assert.ok(!h.ordinaryCalls.at(-1).messages.some(message => message.role === 'tool'));
  assert.doesNotMatch(JSON.stringify(h.ordinaryCalls.at(-1).messages), /fixture\.txt|edit-x/);
  await h.ctx.sessionPersistence.flush();
  await h.dispose();

  // Torn down Host and session store; new Host reads the same durable JSONL,
  // while Session Query/SQLite and SessionController provide the public page.
  const cold = await createTurnHost(t, { root: h.root, releasedReader: true });
  assert.equal(cold.agent(id), undefined, 'run a cold public history read, not a live in-memory snapshot');
  const wire = (await cold.invoke('session', 'page', { request: { address: address(id), maxMessages: 20 } })).records;
  const replay = wire.filter(e => e.event.type === AGY_TOOL_RECORD).map(e => e.event);
  assert.deepEqual(replay.map(e => e.data.status), ['in_progress', 'completed']);
  assert.equal(replay[0].data.id, replay[1].data.id);
  assert.ok(replay.every(e => e.ignorable === true && !e.surfaceOp));
  const assembly = await conversationAssembly();
  assembly.activateTarget('chat');
  assembly.replaceWindow(wire.filter(e => e.event.seq <= live.seq), true); assembly.flush();
  const view = () => {
    const snapshot = assembly.snapshot('chat');
    return Array.from(snapshot.order, key => snapshot.nodes.get(key)).filter(node => node.kind === AGY_TOOL_CARD);
  };
  assert.equal(view().length, 1);
  assert.equal(view()[0].data.state.status, 'in_progress');
  assert.equal(view()[0].location.kind, 'step');
  const key = view()[0].key;
  for (const entry of wire.filter(e => e.event.seq > live.seq)) assembly.append(entry);
  assembly.flush();
  assert.deepEqual(view().map(node => [node.key, node.data.state.status, node.data.state.diffs[0].newPreview]), [[key, 'completed', 'after']]);
  assembly.replaceWindow(wire, false); assembly.flush();
  assert.deepEqual(view().map(node => [node.key, node.data.state.status]), [[key, 'completed']]);
  assert.equal(assembly.snapshot('chat').nodes.get(key).location.turn.data.get('turn-process').toolCallCount, 0,
    'native process counts are not falsified by display-only ACP cards');
  await t.test('installed remote_read_session preserves the opaque envelope without activating the session', async remoteTest => {
    const profile = createRequire(join(process.env.DSH_PROFILE_DIR, 'package.json'));
    let entry;
    try { entry = profile.resolve('ds-harness-remote'); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND') return remoteTest.skip('optional Desktop Remote package not present'); throw error; }
    const entryUrl = pathToFileURL(entry).href;
    const source = await readFile(entry, 'utf8');
    if (!/\b(?:var|let|const|class) RemoteSessionTools\b/.test(source)) return remoteTest.skip('installed Remote bundle does not expose the test seam');
    // The shipped Remote entry bundles its private client dependencies. Make
    // just the tool class visible in memory, without applying or installing it.
    let RemoteSessionTools;
    const hooks = registerHooks({ load(url, state, next) {
      if (url !== `${entryUrl}?agy-tool-test`) return next(url, state);
      return { format: 'module', source: `${source}\nexport { RemoteSessionTools as FixtureRemoteSessionTools };`, shortCircuit: true };
    } });
    try { ({ FixtureRemoteSessionTools: RemoteSessionTools } = await import(`${entryUrl}?agy-tool-test`)); }
    finally { hooks.deregister(); }
    const listeners = new Set();
    const requests = [];
    const client = {
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }, onClose: () => () => {},
      async rpc(method, payload, signal) {
        if (method === 'harness.transport.describe') return {};
        if (method === 'harness.remote.stream.close') return {};
        requests.push([method, payload.endpoint]);
        const [namespace, operation] = payload.endpoint.split('/');
        if (method === 'harness.remote.call') return { ok: true, value: await cold.invoke(namespace, operation, payload.payload.args) };
        assert.equal(method, 'harness.remote.stream.open');
        const stream = await cold.ctx.typertGateway.wireStream.open(payload.endpoint, payload.payload, (async function* () {})(),
          cold.ctx.connection.browserPeer, signal);
        for await (const value of stream) {
          for (const fn of listeners) fn({ event: 'harness.remote.frame', data: { streamId: payload.streamId, hasValue: true, value } });
          break;
        }
        return {};
      },
    };
    const remote = new RemoteSessionTools((host, signal, callback) => {
      assert.equal(host, 'fixture-host');
      return callback({ features: { remoteGateway: true }, client }, signal);
    });
    const result = await remote.run('remote_read_session', { hostId: 'fixture-host', backend: 'harness',
      workspaceId: cold.workspace.id, sessionId: id }, remoteTest.signal);
    assert.ok(requests.some(([, endpoint]) => endpoint === 'session/follow'));
    assert.equal(cold.agent(id), undefined);
    const reported = result.records.filter(e => e.type === AGY_TOOL_RECORD);
    assert.equal(reported.length, 2);
    assert.ok(reported.every(e => e.truncated === false));
    assert.deepEqual(reported.map(e => JSON.parse(e.json).event), replay);
  });
});

const required = ['todo_write', 'ask_user_question', 'present', 'office_render', 'office_convert', 'office_recalculate',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'];
test('all named native utilities require both scoped definition and executable admission; default is not a prefix wildcard', () => {
  const defs = [...required, 'office_unknown', 'session_delete', 'schedule_unlisted'].map(name => ({ name }));
  const agent = {}, toolSet = {};
  let withdrawn = 'office_convert';
  const ctx = { tools: { definitions(owner, set) { assert.equal(owner, agent); assert.equal(set, toolSet); return defs; },
    executable(name, owner, set) { assert.equal(owner, agent); assert.equal(set, toolSet); return defs.find(row => row.name === name && name !== withdrawn); } } };
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet).keys()], required.filter(name => name !== withdrawn));
  withdrawn = '';
  assert.deepEqual([...agyMcpTools(ctx, agent, toolSet, ['*']).keys()], required);
  for (const prefixes of [[], ['remote'], ['office']]) assert.equal(agyMcpTools(ctx, agent, toolSet, prefixes).size, 0);
});

test('MCP conversion preserves ordered text, raster bytes, and reviewed structured values without leaking presentationMeta', async () => {
  const signal = new AbortController().signal;
  const attachments = { async readImage(ref, control) {
    assert.equal(ref.id, 'image'); assert.equal(control, signal);
    return { ref: { mediaType: 'image/png' }, data: Buffer.from([1, 2, 3]) };
  } };
  const result = { isError: false, content: [{ type: 'text', text: 'hello' }, { type: 'image', attachment: { id: 'image' } },
    { type: 'future-block', data: ['do not lose me'] }], value: { images: ['image'] }, meta: { private: 'not sent' } };
  assert.deepEqual(await mcpToolResult({ get: () => attachments }, 'office_render', result, signal), {
    content: [{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: 'AQID' },
      { type: 'text', text: '{"type":"future-block","data":["do not lose me"]}' }],
    structuredContent: { images: ['image'] }, isError: false,
  });
  assert.deepEqual((await mcpToolResult({}, 'mcp__fixture__get', { ...result, content: [], value: { structuredContent: { nested: [1] } } })).structuredContent, { nested: [1] });
  assert.equal((await mcpToolResult({}, 'unreviewed', { ...result, content: [] })).structuredContent, undefined);
  assert.equal((await mcpToolResult({}, 'office_render', { ...result, content: [], isError: true })).structuredContent, undefined);
});

test('installed DSH ToolExecutionPipeline publishes todo and file events and keeps a restricted foreground turn alive waiting for native questions', { timeout: 14_000 }, async t => {
  const prompting = Promise.withResolvers(), asked = Promise.withResolvers(), answer = Promise.withResolvers();
  t.after(() => answer.resolve({ answers: [] }));
  const h = await createTurnHost(t, { releasedReader: true, desktopRequests: true, withWorkingDirectory: true,
    localPermissions: { mode: 'workspace-write' }, mountSubscription: mountLocal({ restrictedSilenceMs: 170 }), acpPrompt: prompting.resolve,
    async mountTools({ mount, ctx, cwd }) {
      await writeFile(join(cwd, 'fixture.txt'), 'synthetic deliverable');
      const fs = ctx.fs;
      Object.assign(fs, {
        async lstat(file, options) { const found = await lstat(resolve(options.cwd, file)); return { type: found.isFile() ? 'file' : 'directory' }; },
        resolve: (file, options) => resolve(options.cwd, file),
        async stat(file) { const found = await stat(file); return { type: found.isFile() ? 'file' : 'directory' }; }, processPath: path => path,
      });
      const [todo, present, ask, service] = await Promise.all(['dsh-tool-todo', 'dsh-tool-present', 'dsh-tool-ask-user', 'dsh-user-questions']
        .map(name => import(`@deepseek-ai/${name}`)));
      await mount(service.default);
      await mount(todo, { allowParallelInProgress: true });
      await mount(present, { maxFiles: 8 });
      await mount(ask);
      ctx.on('user-questions/request', (question, next) => {
        if (question.questions[0]?.id !== 'fixture-q') return next();
        asked.resolve(question);
        return answer.promise;
      }, { global: true });
    },
  });
  const id = await h.create();
  ok(await h.select(id, selection));
  ok(await h.prompt(id, 'Use native tools in this test'));
  const turn = await prompting.promise;
  const server = turn.mcpServers[0];
  const rpc = async (method, params) => {
    const reply = await fetch(server.url, { method: 'POST', signal: t.signal, headers: { authorization: server.headers[0].value },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    assert.equal(reply.status, 200);
    return reply.json();
  };
  const tool = async (name, args) => {
    const value = await rpc('tools/call', { name, arguments: args });
    assert.equal(value.result?.isError, false, JSON.stringify(value));
    return value.result;
  };
  const listing = (await rpc('tools/list')).result.tools.map(row => row.name);
  assert.ok(['todo_write', 'present', 'ask_user_question'].every(name => listing.includes(name)));
  assert.ok(!listing.includes('office_convert'), 'unmounted utility stays hidden');
  const waiting = tool('ask_user_question', { questions: [{ id: 'fixture-q', question: 'Choose both?', multi_select: true,
    options: [{ label: 'A' }, { label: 'B' }] }] });
  const request = await Promise.race([asked.promise, waiting.then(() => assert.fail('question did not reach native service'))]);
  assert.equal(request.agent, h.agent(id));
  assert.equal(request.questions[0].multiSelect, true);
  try {
    await delay(260);
    assert.equal(request.signal.aborted, false);
    assert.equal(h.agent(id).status, 'running');
  } finally { answer.resolve({ answers: [{ id: 'fixture-q', selected: ['A', 'B'] }] }); }
  assert.deepEqual((await waiting).structuredContent, { answers: [{ id: 'fixture-q', selected: ['A', 'B'] }] });
  assert.deepEqual((await tool('todo_write', { todos: [{ content: 'fixture todo', status: 'completed' }] })).structuredContent.counts,
    { pending: 0, inProgress: 0, completed: 1 });
  assert.match((await tool('present', { files: [{ path: 'fixture.txt' }] })).content[0].text, /Presented .*fixture\.txt/);
  turn.update('The files and todo are ready.'); turn.reply(); await h.idle(id);
  const events = h.events(id);
  assert.equal(events.filter(e => e.type === 'todo/write').length, 1);
  assert.equal(events.filter(e => e.type === 'deliverables/presented').length, 1);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
  assert.equal(h.acpCalls.filter(row => row.method === 'session/cancel').length, 0);
  assert.ok(events.every(e => !['tool/call', 'tool/result'].includes(e.type)));
  assert.ok(h.agent(id).session.deriveMessages().every(message => message.role !== 'tool'));
});
