import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { AGY_NATIVE_PREFIX, AGY_NATIVE_PRESET, assertAgyNativeSupport, publishAgyAgent } from '../src/agy-native-agent.js';

const fixtureId = () => AGY_NATIVE_PREFIX + randomUUID();
const invalid = code => error => error?.code === code;
const noNative = invalid('agy/native-unavailable');
const denied = invalid('session/agent-busy');

test('validates the entry contract and closes on missing Host support', async () => {
  const args = { id: fixtureId(), cwd: process.cwd(), authorizePrompt: () => true, runTurn: () => ({ status: 'completed' }) };
  await assert.rejects(publishAgyAgent({}, { ...args, id: 'agy-native-unsafe' }), /UUID/);
  await assert.rejects(publishAgyAgent({}, { ...args, id: `${args.id}\n` }), /UUID/);
  await assert.rejects(publishAgyAgent({}, { ...args, cwd: 'relative' }), /absolute/);
  await assert.rejects(publishAgyAgent({}, { ...args, authorizePrompt: undefined }), /authorizer/);
  await assert.rejects(publishAgyAgent({}, { ...args, history: [{ prompt: 'old', status: 'busy' }] }), /turn record/);
  await assert.rejects(publishAgyAgent({}, args), noNative);
});

const install = process.env.DSH_INSTALL_DIR;
const canReadRuntime = Boolean(install && (!install.includes('.asar') || process.versions.electron));
if (canReadRuntime) {
  const anchor = pathToFileURL(join(install, 'package.json')).href;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      // Resolve only from the installed DSH distribution. Its own transitive
      // dependencies retain their normal package-relative resolution.
      const inArchive = context.parentURL?.includes('.asar/');
      return next(specifier, (specifier.startsWith('@deepseek-ai/') || specifier === 'zod') && !inArchive
        ? { ...context, parentURL: anchor } : context);
    },
  });
  test.after(() => hook.deregister());
}

let runtime;
async function installed() {
  runtime ??= Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-preset-registry',
    '@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-session-query-sqlite', '@deepseek-ai/dsh-typert-registry',
    '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-session-controller/typert', '@deepseek-ai/dsh-agent-preset-registry/typert', '@deepseek-ai/dsh-llm',
  ].map(name => import(name)));
  return runtime;
}

const integration = (name, run) => test(name, {
  skip: canReadRuntime ? false : 'Requires the installed DSH runtime (use Electron as Node for Desktop ASAR)',
  timeout: 10_000,
}, run);

/** Real Session, Agent, command and Gateway classes; no server, profile, persistence or production process. */
async function host(t, { workspaces = [] } = {}) {
  const [cordis, { Loader }, { SessionStore }, { SessionProjectionRegistry }, { AgentRegistry },
    { AgentPresetRegistry }, { SessionTitleService }, { SqliteSessionQueryEngine }, { TypertRegistry },
    { RemoteAccessService }, { TypertGatewayService }, { SessionController }, nativeTypes, presetTypes, llm] = await installed();
  const { Context } = cordis;
  const { version } = (await import(pathToFileURL(join(install, 'package.json')).href, { with: { type: 'json' } })).default;
  t.diagnostic(`DSH ${version} · isolated Cordis, no web listener or credentials`);
  const ctx = new Context();
  const fibers = [];
  const calls = { saveDefault: 0, providerResolves: 0, createWriter: 0, openWriter: 0 };
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  });
  async function mount(plugin, config) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.inertia;
    assert.equal(fiber.state, 2, `${fiber.name} did not activate`); // Cordis FiberState.ACTIVE is compiled away
    return fiber;
  }
  await mount({ name: 'fixture dependencies', apply(scope) {
    scope.provide('fs', {});
    scope.provide('workspaceRegistry', {
      archivedSessionIds: [], list: () => workspaces, get: id => workspaces.find(item => item.id === id),
    });
    scope.provide('attachments', {
      admitPromptContent: async content => content,
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
        maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'],
      },
    });
    scope.provide('fileUploads', {
      registerAgentResolver: () => () => {}, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
    });
    scope.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      async saveSelection() { calls.saveDefault++; },
    });
    scope.provide('llm', {
      listProviders: () => [{ id: 'fixture', name: 'test' }], listModels: async () => [{ id: 'fixture-model' }],
      async resolveCallConfig() { calls.providerResolves++; },
    });
    scope.provide('sessionPersistence', {
      stat: async () => undefined, async *list() {},
      async create() { calls.createWriter++; throw Error('unexpected writer create'); },
      async open() { calls.openWriter++; throw Error('unexpected persistence open'); },
    });
  } });
  await mount(Loader);
  await mount(TypertRegistry);
  const registrations = await mount({ inject: ['typert'], apply(scope) {
    scope.typert.register(nativeTypes.TYPERT);
    scope.typert.register(presetTypes.TYPERT);
  } });
  await mount(SessionStore);
  await mount(SessionProjectionRegistry);
  await mount(AgentRegistry);
  await mount(AgentPresetRegistry, { default: 'fixture' });
  await mount(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 100 });
  await mount(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' });
  await mount(RemoteAccessService);
  await mount(TypertGatewayService, {});
  await mount(SessionController, { nativeOpen: false });
  await mount({ inject: ['agentPresets'], async apply(scope) {
    const release = await scope.agentPresets.register({ id: 'fixture', plugins: [] });
    scope.effect(() => release);
  } });
  const owner = await mount({ name: 'Gemini fixture owner', apply() {} });
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const witness = new AsyncLocalStorage();
  const send = (namespace, method, args) => ctx.typertGateway.invoke({ namespace, method, args, peer });
  const sendPrompt = (id, text, { requestId = randomUUID(), mode = 'queue', content = [{ type: 'text', text }] } = {}) =>
    send('session', 'prompt', { request: { sessionId: id, requestId, content, mode } });
  const sendCancel = id => send('session', 'cancel', { request: { sessionId: id } });
  function browser(action, sessionId, call) {
    const value = { action, sessionId, active: true, used: false };
    return witness.run(value, async () => {
      try { return await call(); } finally { value.active = false; }
    });
  }
  function authorize(action, id) {
    return ({ sessionId }) => {
      const value = witness.getStore();
      if (sessionId !== id || !value?.active || value.action !== action || value.sessionId !== id || value.used) return false;
      value.used = true;
      return true;
    };
  }
  const follow = (id, signal) => ctx.typertGateway.wireStream.open('session/follow', {
    args: { request: { address: { kind: 'session', sessionId: id }, assistantStream: true, activate: true } },
  }, (async function* () {})(), peer, signal);
  async function publish(args) {
    const id = args.id ?? fixtureId();
    return publishAgyAgent(owner.ctx, {
      id, cwd: process.cwd(), authorizePrompt: authorize('prompt', id), authorizeCancel: authorize('cancel', id),
      runTurn: async () => ({ status: 'completed' }), ...args,
    });
  }
  return { ctx, owner, calls, llm, send, sendPrompt, sendCancel, browser, follow, publish, mount, registrations };
}

integration('shared cache, registered sentinel and missing Gateway definitions prevent publication', async t => {
  const { ctx, owner, publish, mount, registrations } = await host(t);
  let created = 0;
  ctx.on('session/created', () => { created++; });
  await assertAgyNativeSupport(owner.ctx);
  await assert.rejects(publishAgyAgent({ get: () => undefined, effect: owner.ctx.effect, events: owner.ctx.events }, {
    id: fixtureId(), cwd: process.cwd(), authorizePrompt: () => true, runTurn: () => ({ status: 'completed' }),
  }), noNative);
  const cache = await mount({ apply(scope) { scope.provide('sessionProjectionCache', {}); } });
  await assert.rejects(assertAgyNativeSupport(owner.ctx), error => noNative(error) && /投影缓存/.test(error.message));
  await assert.rejects(publish({}), noNative);
  await cache.dispose();
  const preset = await mount({ inject: ['agentPresets'], async apply(scope) {
    const release = await scope.agentPresets.register({ id: AGY_NATIVE_PRESET, plugins: [] });
    scope.effect(() => release);
  } });
  await assert.rejects(publish({}), error => noNative(error) && /已被注册/.test(error.message));
  await preset.dispose();
  await registrations.dispose();
  await assert.rejects(publish({}), error => noNative(error) && /session\//.test(error.message));
  assert.equal(created, 0);
  assert.deepEqual(ctx.sessions.list(), []);
  assert.deepEqual(ctx.agents.list(), []);
});

integration('native Follow and transcript preserve Stop-tail chunks through the official terminal result', async t => {
  const { ctx, calls, publish, follow, sendPrompt, sendCancel, browser, llm } = await host(t);
  const id = fixtureId();
  const first = Promise.withResolvers(), terminal = Promise.withResolvers();
  t.after(() => terminal.resolve({ status: 'failed' }));
  let onDelta, signal, runnerCalls = 0;
  const handle = await publish({ id, title: 'Gemini · fixture', async runTurn(text, feed) {
    assert.equal(ctx.agents.currentInitiator(), handle.agent);
    assert.equal(text, '我的提问');
    runnerCalls++;
    ({ signal, onDelta } = feed);
    onDelta('前文');
    first.resolve();
    return terminal.promise;
  } });
  const streamAbort = new AbortController();
  const stream = (await follow(id, streamAbort.signal))[Symbol.asyncIterator]();
  try {
    const { value: baseline } = await stream.next();
    assert.equal(baseline.type, 'snapshot');
    assert.equal(baseline.header.id, id);
    assert.equal(baseline.projections.values.agentPreset, AGY_NATIVE_PRESET);
    assert.equal(baseline.projections.values.title, 'Gemini · fixture');
    assert.equal(baseline.assistantStream.revision, 0);
    const options = { requestId: randomUUID() };
    await assert.rejects(sendPrompt(id, '我的提问', options), denied);
    assert.equal(handle.agent.session.seq, baseline.cursor + 1);
    assert.deepEqual(await browser('prompt', id, () => sendPrompt(id, '我的提问', options)), { accepted: true });
    await first.promise;
    assert.equal(handle.agent.status, 'running');
    const running = ctx.agents.turnBoundaryOf(handle.agent.session);
    assert.equal(running.lastTurn, 1);
    assert.equal(running.openTurnStartSeq, baseline.cursor + 1);
    await assert.rejects(browser('prompt', id, () => sendPrompt(id, '不要排队')), denied);
    await assert.rejects(sendCancel(id), denied);
    assert.equal(signal.aborted, false);
    assert.deepEqual(await browser('cancel', id, () => sendCancel(id)), { accepted: true });
    assert.equal(signal.aborted, true);
    onDelta('停后尾片');
    assert.equal(handle.agent.status, 'running');

    const reconnectAbort = new AbortController();
    const reconnect = (await follow(id, reconnectAbort.signal))[Symbol.asyncIterator]();
    try {
      const { value } = await reconnect.next();
      assert.equal(value.type, 'snapshot');
      const chunks = llm.expandAssistantStream(value.assistantStream.activeAttempt.stream);
      assert.deepEqual(chunks.filter(x => x.chunk.type === 'text-delta').map(x => x.chunk.text), ['前文', '停后尾片']);
    } finally { reconnectAbort.abort(); await reconnect.return(); }

    terminal.resolve({ status: 'interrupted' });
    await handle.agent.whenIdle();
    onDelta('乱序晚到');
    assert.equal(handle.agent.status, 'idle');
    assert.equal(ctx.agents.turnBoundaryOf(handle.agent.session).openTurnStartSeq, null);
    const increments = [];
    for await (const frame of stream) {
      increments.push(frame);
      if (frame.type === 'event' && frame.event.type === 'turn/end') break;
    }
    const nativeFrames = increments.filter(x => x.type === 'assistant-stream').map(x => x.frame);
    assert.deepEqual(nativeFrames.map(x => x.revision), nativeFrames.map((_, i) => i + 1));
    assert.equal(nativeFrames[0].type, 'start');
    assert.equal(nativeFrames[0].startedAfterSeq, running.openTurnStartSeq + 2);
    assert.deepEqual(nativeFrames.filter(x => x.chunk?.type === 'text-delta').map(x => x.chunk.text), ['前文', '停后尾片']);
    const nativeEvents = increments.filter(x => x.type === 'event').map(x => x.event);
    assert.deepEqual(nativeEvents.map(x => x.type), ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end']);
    const committed = nativeEvents[3];
    assert.deepEqual(nativeFrames.at(-1).outcome, { kind: 'committed', seq: committed.seq, eventType: 'assistant/message' });
    assert.equal(committed.data.interrupted, true);
    assert.deepEqual(nativeEvents.at(-1).data.reason, { kind: 'aborted', reason: { kind: 'user' } });
    assert.deepEqual(handle.agent.session.deriveMessages().map(x => x.content[0].text), ['我的提问', '前文停后尾片']);
    assert.deepEqual(await sendPrompt(id, '我的提问', options), { accepted: true }, 'native duplicate receipt acknowledges without running again');
    assert.equal(runnerCalls, 1);
    assert.deepEqual(calls, { saveDefault: 0, providerResolves: 0, createWriter: 0, openWriter: 0 });
  } finally {
    terminal.resolve({ status: 'failed' });
    streamAbort.abort();
    await stream.return();
    await handle.dispose();
  }
});

integration('ordinary preset, default-model, fork and cold activation are fenced; reopen takes ACP replay', async t => {
  const { ctx, calls, publish, send, sendPrompt, browser, follow, llm } = await host(t);
  const live = await publish({});
  const { id, session, model } = live.agent;
  const before = session.seq;
  try {
    assert.equal(model.current(), undefined);
    assert.equal(ctx.agentPresets.composedPreset(live.agent.ctx), undefined);
    await assert.rejects(send('agentPresets', 'select', { agentId: id, agentPreset: 'fixture' }), /already bound/);
    await assert.rejects(send('session', 'selectModel', { request: { sessionId: id, provider: 'fixture', model: 'fixture-model' } }), invalid('session/model-unavailable'));
    assert.equal(calls.saveDefault, 0);
    assert.equal(session.seq, before);
    assert.equal(ctx.agentPresets.presetForSession(session), AGY_NATIVE_PRESET);
    await browser('prompt', id, () => sendPrompt(id, 'one'));
    await live.agent.whenIdle();
    await assert.rejects(send('session', 'fork', { request: { sessionId: id } }), invalid('agent-preset/not-found'));
    assert.deepEqual(ctx.agents.list(), [live.agent]);
  } finally { await live.dispose(); }
  assert.equal(ctx.agents.get(id), undefined);
  assert.equal(ctx.sessions.get(id), undefined);
  await assert.rejects(sendPrompt(id, 'cold'), invalid('session/not-found'));
  assert.equal(calls.createWriter, 0);
  assert.equal(calls.openWriter, 0);

  const history = [
    { prompt: 'previous', text: 'reply', status: 'completed' },
    { prompt: 'stopped', text: 'prefix', status: 'interrupted' },
    { prompt: 'failed', text: 'preview', status: 'failed' },
  ];
  const restored = await publish({ history });
  const controller = new AbortController();
  const stream = (await follow(restored.agent.id, controller.signal))[Symbol.asyncIterator]();
  try {
    assert.notEqual(restored.agent.id, id);
    const { value } = await stream.next();
    assert.equal(value.assistantStream.activeAttempt, undefined);
    assert.equal(value.projections.values.agentPreset, AGY_NATIVE_PRESET);
    const events = value.records.map(record => record.event);
    assert.deepEqual(events.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['completed', 'aborted', 'error']);
    assert.deepEqual(restored.agent.session.deriveMessages().map(msg => msg.content[0].text), ['previous', 'reply', 'stopped', 'prefix', 'failed']);
    const attempt = events.findLast(e => e.type === 'assistant/attempt');
    assert.deepEqual(llm.expandAssistantStream(attempt.data.stream).filter(x => x.chunk.type === 'text-delta').map(x => x.chunk.text), ['preview']);
    await browser('prompt', restored.agent.id, () => sendPrompt(restored.agent.id, 'continue official thread'));
    await restored.agent.whenIdle();
    assert.equal(ctx.agents.turnBoundaryOf(restored.agent.session).lastTurn, 4);
  } finally {
    controller.abort();
    await stream.return();
    await restored.dispose();
  }
});

integration('fail-closed prompt shapes and witnesses never enter the native Session', async t => {
  const { llm, publish, sendPrompt, sendCancel, browser } = await host(t);
  const args = [];
  const { agent, dispose } = await publish({
    authorizeCancel: undefined,
    authorizePrompt(input) { args.push(input); return Promise.reject(Error('private auth diagnostic')); },
    runTurn() { assert.fail('must never open the ACP runner'); },
  });
  const { id, session, inbox } = agent;
  const before = session.seq;
  try {
    const candidate = (content, source) => llm.createUserMessage({ content, source });
    const text = [{ type: 'text', text: 'fixture' }];
    const owner = { kind: 'user', rpcId: randomUUID() };
    for (const message of [
      candidate(text, { kind: 'retry', rpcId: owner.rpcId }),
      candidate(text, { ...owner, principal: { kind: 'remote' } }),
      candidate(text, { kind: 'user' }),
      candidate([], owner),
      candidate([{ type: 'image', attachment: {} }], owner),
    ]) assert.throws(() => agent.followup(message), denied);
    assert.throws(() => agent.followup(candidate([{ type: 'text', text: '龙'.repeat(22000) }], owner)), invalid('gateway/bad-request'));
    assert.throws(() => agent.followup(candidate([{ type: 'text', text: ' \t' }], owner)), invalid('gateway/bad-request'));
    await assert.rejects(browser('prompt', id, () => sendPrompt(id, 'steer', { mode: 'steer' })), denied);
    await assert.rejects(sendPrompt(id, '', { content: [] }), denied);
    await assert.rejects(browser('cancel', id, () => sendCancel(id)), denied);
    assert.throws(() => agent.cancel({ kind: 'disposed' }), denied, 'the disposal bypass stays private');
    assert.throws(() => inbox.append('next-turn', candidate(text, owner)), denied);
    assert.deepEqual(inbox.nextTurn, []);
    assert.equal(args.length, 0);
    assert.throws(() => agent.followup(candidate(text, owner)), denied);
    assert.deepEqual(args.map(x => [x.sessionId, x.text]), [[id, 'fixture']]);
    assert.equal(session.seq, before);
  } finally { await dispose(); }
});

integration('runner throw locks unknown state; a confirmed failure and a completion crossing Stop retain their meanings', async t => {
  const { publish, browser, sendPrompt, sendCancel, llm } = await host(t);
  const terminal = Promise.withResolvers();
  let call = 0;
  const { agent, dispose } = await publish({ async runTurn(text, { signal, onDelta }) {
    switch (++call) {
      case 1: onDelta('failure preview'); return { status: 'failed' };
      case 2:
        onDelta('part');
        signal.addEventListener('abort', () => onDelta(' tail'), { once: true });
        return terminal.promise;
      default: onDelta('in flight'); throw Error('private ACP diagnostic');
    }
  } });
  const id = agent.id;
  try {
    await browser('prompt', id, () => sendPrompt(id, 'first'));
    await agent.whenIdle();
    await browser('prompt', id, () => sendPrompt(id, 'second'));
    await browser('cancel', id, () => sendCancel(id));
    terminal.resolve({ status: 'completed', text: 'terminal correction' });
    await agent.whenIdle();
    const message = agent.session.snapshotEvents().find(e => e.type === 'assistant/message');
    assert.equal(message.data.message.content[0].text, 'terminal correction');
    assert.equal(message.data.interrupted, undefined);
    assert.deepEqual(llm.expandAssistantStream(message.data.stream).filter(x => x.chunk.type === 'text-delta').map(x => x.chunk.text), ['part', ' tail']);
    await browser('prompt', id, () => sendPrompt(id, 'third'));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents();
    assert.deepEqual(events.filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['error', 'completed', 'error']);
    assert.match(events.at(-1).data.reason.error.message, /未收到.*最终状态/);
    assert.doesNotMatch(JSON.stringify(events), /private ACP diagnostic/);
    await assert.rejects(browser('prompt', id, () => sendPrompt(id, 'do not resend blindly')), denied);
    assert.equal(call, 3);
  } finally {
    terminal.resolve({ status: 'failed' });
    await dispose();
  }
});

integration('rollback pairs both creation events; owner teardown drains a stopping turn before unregistering', async t => {
  const { ctx, owner, publish, browser, sendPrompt } = await host(t);
  const lifecycle = [];
  const id = fixtureId();
  for (const event of ['session/created', 'agent/created', 'agent/disposed', 'session/disposed']) {
    ctx.on(event, value => { if ((value.agent?.id ?? value.id) === id) lifecycle.push(event); });
  }
  const veto = ctx.on('agent/created', ({ agent }) => { if (agent.id === id) throw Error('fixture veto'); });
  await assert.rejects(publish({ id }), /fixture veto/);
  assert.equal(ctx.sessions.get(id), undefined);
  assert.equal(ctx.agents.get(id), undefined);
  assert.deepEqual(lifecycle, ['session/created', 'agent/created', 'agent/disposed', 'session/disposed']);
  veto();
  lifecycle.length = 0;

  const terminal = Promise.withResolvers();
  let feed;
  const live = await publish({ id, runTurn(_text, input) { feed = input; return terminal.promise; } });
  ctx.on('session/event', (session, event) => {
    if (session.id === id && event.type === 'turn/end') lifecycle.push('turn/end');
  });
  try {
    await browser('prompt', id, () => sendPrompt(id, 'active'));
    const unloading = owner.dispose();
    const disposed = live.dispose();
    assert.equal(live.dispose(), disposed);
    await Promise.resolve();
    assert.equal(feed.signal.aborted, true);
    assert.equal(ctx.sessions.get(id), live.agent.session);
    assert.equal(ctx.agents.get(id), live.agent);
    feed.onDelta('last official fragment');
    terminal.resolve({ status: 'interrupted' });
    await Promise.all([unloading, disposed]);
    assert.deepEqual(lifecycle, ['session/created', 'agent/created', 'turn/end', 'agent/disposed', 'session/disposed']);
    assert.equal(ctx.sessions.get(id), undefined);
    assert.equal(ctx.agents.get(id), undefined);
    const turnEnd = live.agent.session.snapshotEvents().at(-1);
    assert.deepEqual(turnEnd.data.reason, { kind: 'aborted', reason: { kind: 'disposed' } });
    assert.equal(live.agent.session.deriveMessages().at(-1).content[0].text, 'last official fragment');
  } finally { terminal.resolve({ status: 'failed' }); await live.dispose(); }
});

/** ACP JSON-RPC over in-memory streams. The returned child is never a process. */
function fakeAcpChild(handle) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.send = message => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  let ended = false;
  function exit() {
    if (ended) return;
    ended = true;
    child.emit('exit', 0, null);
  }
  child.stdin = new Writable({
    write(bytes, _encoding, done) {
      let frame;
      try { frame = JSON.parse(bytes.toString('utf8')); }
      catch (error) { done(error); return; }
      done();
      handle(frame, child);
    },
    final(done) { done(); queueMicrotask(exit); },
  });
  child.kill = () => { queueMicrotask(exit); return true; };
  return child;
}

integration('mounted Gemini Host uses the browser witness and reopens via ACP list and load', async t => {
  const [[{ AGY_API, mountAgyHost }, { AgySession }, { AgyAcpClient }], { HostConnectionService }] = await Promise.all([
    Promise.all([import('../src/agy-host.js'), import('../src/agy-session.js'), import('../src/agy-acp-client.js')]),
    import('@deepseek-ai/dsh-client-connection'),
  ]);
  const cwd = process.cwd();
  const workspaceId = randomUUID();
  const workspace = Object.freeze({ id: workspaceId, title: 'Synthetic workspace', path: cwd, sessionIds: Object.freeze([]) });
  const { ctx, mount, calls } = await host(t, { workspaces: [workspace] });
  const origin = 'http://127.0.0.1:12345'; // Synthetic request metadata; no server binds it.
  const gatewayReady = Promise.withResolvers();
  await mount({ name: 'in-memory web route registry', apply(scope) {
    scope.provide('webServer', { host: '127.0.0.1', protocol: 'http:', registerUpgrade() {
      gatewayReady.resolve();
      return () => {};
    } });
  } });
  let anotherOwnerId;
  const caller = new WeakMap();
  const carrier = await mount({ name: 'real Host Connection with synthetic admission', apply(scope) {
    new HostConnectionService(scope, [], {
      isAuthenticated: request => caller.get(request) === 'browser',
      authenticateApi: request => caller.get(request) === 'other-owner' ? anotherOwnerId : undefined,
      // Exercise the real Connection Peer registry without minting any credential.
      authorizeConnect(_req, _res, _secure, publishPeer) { anotherOwnerId = publishPeer('none'); },
    });
  } });
  const connection = ctx.connection;
  const trustHeaders = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  connection.authorizeConnect({ url: '/connect', headers: trustHeaders }, {});
  assert.notEqual(anotherOwnerId, undefined);
  assert.notEqual(anotherOwnerId, connection.browserPeer.id);
  await gatewayReady.promise;
  const shared = connection.createSharedFetchHandler('/api');

  // Feed the installed Host Connection/Gateway exactly the registered Fetch
  // route and RPC envelopes. Only the Node HTTP request and admission data are
  // synthetic; there is no fake Gemini witness or session operation here.
  async function post(path, payload, who = 'browser') {
    const request = { url: path, method: 'POST', headers: trustHeaders, socket: { remoteAddress: '127.0.0.1' } };
    caller.set(request, who);
    const admission = connection.admit(request);
    assert.ok(admission.peer, 'both callers are admitted owners on the shared carrier');
    assert.equal(admission.peer.principal.kind, 'owner');
    assert.equal(admission.peer.id, who === 'browser' ? connection.browserPeer.id : anotherOwnerId);
    const rpcId = randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method: path.slice('/api/'.length), payload });
    const response = await ctx.waterfall('connection/request', request, {}, () => shared.fetch(new Request(origin + path, {
      method: 'POST', headers: request.headers, body,
    }), admission.peer));
    if (response.status !== 200) return { status: response.status };
    const reply = await response.json();
    assert.equal(reply.type, 'server-response');
    assert.equal(reply.rpcId, rpcId);
    return { status: response.status, ...reply.result };
  }
  async function bridge(action, args = {}) {
    const result = await post(AGY_API, { action, ...args });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  }
  const prompt = (sessionId, text, who) => post('/api/session/prompt', { args: { request: {
    sessionId, requestId: randomUUID(), content: [{ type: 'text', text }], mode: 'queue',
  } } }, who);
  const cancel = (sessionId, who) => post('/api/session/cancel', { args: { request: { sessionId } } }, who);
  const streamAbort = new AbortController();
  const streamSignal = AbortSignal.any([streamAbort.signal, t.signal]);
  const follow = async id => (await ctx.typertGateway.wireStream.open('session/follow', {
    args: { request: { address: { kind: 'session', sessionId: id }, assistantStream: true, activate: true } },
  }, (async function* () {})(), connection.browserPeer, streamSignal))[Symbol.asyncIterator]();

  const officialId = 'opaque-acp-session-fixture';
  const userText = '请按原生会话回复';
  const prefix = '原生前文', tail = '；停止后的尾片', loadText = '由 session/load 返回的官方文本';
  const receivedPrompt = Promise.withResolvers();
  const receivedCancel = Promise.withResolvers();
  const acpCalls = [];
  function update(child, sessionUpdate, text, messageId) {
    child.send({ method: 'session/update', params: { sessionId: officialId, update: {
      sessionUpdate, messageId, content: { type: 'text', text },
    } } });
  }
  async function makeSession({ cwd: sessionCwd }) {
    return new AgySession({ cwd: sessionCwd, timeLimits: { open: 2000, turn: 3000, cancel: 2000 }, makeClient: callbacks => new AgyAcpClient({
      ...callbacks, cwd: sessionCwd, executable: join(cwd, 'never-spawned-fixture.exe'), env: {}, timeoutMs: 2000,
      spawnFactory() {
        return fakeAcpChild(({ id, method, params }, child) => {
          acpCalls.push({ method, params, hasId: id !== undefined });
          const reply = result => child.send({ id, result });
          switch (method) {
            case 'initialize':
              reply({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: 'fixture' },
                agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } });
              break;
            case 'session/new': reply({ sessionId: officialId }); break;
            case 'session/prompt':
              update(child, 'agent_message_chunk', prefix, 'current-reply');
              receivedPrompt.resolve({ id, child });
              break;
            case 'session/cancel': receivedCancel.resolve(); break;
            case 'session/close': reply({}); break;
            case 'session/list':
              reply({ sessions: [{ sessionId: officialId, cwd, title: '官方旧会话' },
                { sessionId: 'outside-workspace', cwd: join(cwd, 'another'), title: 'Exclude' }] });
              break;
            case 'session/load':
              update(child, 'user_message_chunk', userText, 'historical-user');
              update(child, 'agent_message_chunk', loadText, 'historical-reply');
              reply({});
              break;
            default: child.send({ id, error: { code: -32601, message: 'fixture unexpected method' } });
          }
        });
      },
    }) });
  }
  const plugin = await mount({ name: 'mounted Gemini ACP fixture', inject: ['connection', 'webServer', 'workspaceRegistry'], apply(scope) {
    mountAgyHost(scope, { makeSession, async verifyWorkspace(_ctx, id) { assert.equal(id, workspaceId); return cwd; } });
  } });

  let stream, reopenedStream;
  try {
    // The same admitted API owner can still call ordinary native endpoints.
    // The mounted witness does not replace the Gateway or change its services.
    const ordinary = await post('/api/session/modelCatalog', { args: {} }, 'other-owner');
    assert.equal(ordinary.ok, true);
    assert.deepEqual(ordinary.value.default, { provider: 'fixture', model: 'fixture-model' });
    assert.deepEqual(await post(AGY_API, { action: 'open', workspaceId }, 'other-owner'), { status: 403 });
    assert.deepEqual(acpCalls, []);
    assert.deepEqual(await bridge('status'), { available: true, workspaces: [{ id: workspaceId, title: workspace.title }] });
    const { sessionId } = await bridge('open', { workspaceId });
    assert.ok(sessionId.startsWith(AGY_NATIVE_PREFIX) && sessionId !== officialId);
    assert.deepEqual(acpCalls.map(x => x.method), ['initialize', 'session/new']);
    stream = await follow(sessionId);
    const { value: baseline } = await stream.next();
    assert.equal(baseline.type, 'snapshot');
    assert.equal(baseline.header.id, sessionId);
    assert.equal(baseline.projections.values.agentPreset, AGY_NATIVE_PRESET);
    const otherPrompt = await prompt(sessionId, 'not the browser', 'other-owner');
    assert.equal(otherPrompt.error.code, 'session/agent-busy');
    assert.equal(acpCalls.length, 2);
    assert.deepEqual(await prompt(sessionId, userText), { status: 200, ok: true, value: { accepted: true } });
    const live = ctx.agents.get(sessionId);
    const { child, id: requestId } = await receivedPrompt.promise;
    assert.equal(live.status, 'running');
    assert.deepEqual(acpCalls.at(-1).params, { sessionId: officialId, prompt: [{ type: 'text', text: userText }] });
    assert.equal((await cancel(sessionId, 'other-owner')).error.code, 'session/agent-busy');
    assert.equal(acpCalls.at(-1).method, 'session/prompt');
    assert.deepEqual(await cancel(sessionId), { status: 200, ok: true, value: { accepted: true } });
    await receivedCancel.promise;
    assert.deepEqual(acpCalls.at(-1), { method: 'session/cancel', params: { sessionId: officialId }, hasId: false });
    update(child, 'agent_message_chunk', tail, 'current-reply');
    assert.equal(live.status, 'running');
    child.send({ id: requestId, result: { stopReason: 'cancelled' } });
    await live.whenIdle();
    const deltas = [];
    let assistant;
    for await (const frame of stream) {
      if (frame.type === 'assistant-stream' && frame.frame.chunk?.type === 'text-delta') deltas.push(frame.frame.chunk.text);
      if (frame.type === 'event' && frame.event.type === 'assistant/message') assistant = frame.event;
      if (frame.type === 'event' && frame.event.type === 'turn/end') {
        assert.deepEqual(frame.event.data.reason, { kind: 'aborted', reason: { kind: 'user' } });
        break;
      }
    }
    assert.deepEqual(deltas, [prefix, tail]);
    assert.equal(assistant.data.message.content[0].text, prefix + tail);
    assert.equal(assistant.data.interrupted, true);
    assert.deepEqual(await bridge('close', { sessionId }), { accepted: true });
    assert.equal(ctx.agents.get(sessionId), undefined);
    assert.equal(ctx.sessions.get(sessionId), undefined);
    assert.equal((await prompt(sessionId, 'ordinary cold path')).error.code, 'session/not-found');

    const { threads } = await bridge('list', { workspaceId });
    assert.equal(threads.length, 1);
    const [{ ticket, title }] = threads;
    assert.equal(title, '官方旧会话');
    assert.match(ticket, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(JSON.stringify(threads), new RegExp(officialId));
    const reopened = await bridge('open', { workspaceId, ticket });
    assert.notEqual(reopened.sessionId, sessionId);
    assert.equal(acpCalls.at(-1).method, 'session/load');
    assert.deepEqual(acpCalls.at(-1).params, { sessionId: officialId, cwd, mcpServers: [] });
    reopenedStream = await follow(reopened.sessionId);
    const { value: loaded } = await reopenedStream.next();
    const transcript = loaded.records.map(record => record.event);
    assert.deepEqual(transcript.filter(e => e.type === 'user/message' || e.type === 'assistant/message').map(e => (
      e.type === 'user/message' ? e.data : e.data.message
    ).content[0].text), [userText, loadText]);
    assert.deepEqual(acpCalls.map(x => x.method), [
      'initialize', 'session/new', 'session/prompt', 'session/cancel', 'session/close',
      'initialize', 'session/list', 'initialize', 'session/load',
    ]);
    assert.deepEqual(workspace.sessionIds, []);
    assert.deepEqual(calls, { saveDefault: 0, providerResolves: 0, createWriter: 0, openWriter: 0 });
    await bridge('close', { sessionId: reopened.sessionId });
    await plugin.dispose();
    assert.deepEqual(await post(AGY_API, { action: 'status' }), { status: 404 });
  } finally {
    streamAbort.abort();
    await stream?.return();
    await reopenedStream?.return();
    await plugin.dispose();
    await carrier.dispose();
  }
});
