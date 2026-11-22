import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGY_NATIVE_PREFIX, assertAgyNativeSupport, publishAgyAgent } from '../src/agy-native-agent.js';

// Standalone: ELECTRON_RUN_AS_NODE=1 <DSH_NODE_EXECUTABLE> tests/agy-native-cache.test.mjs
// Load this release's packages from the installed CLI, without the profile runtime hook.
const install = process.env.DSH_INSTALL_DIR;
const runnable = install && isAbsolute(install) && process.versions.electron;
if (runnable) {
  const anchor = pathToFileURL(join(install, 'package.json')).href;
  const agentModule = new URL('../src/agy-native-agent.js', import.meta.url).href;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return next(specifier, specifier.startsWith('@deepseek-ai/')
        && (context.parentURL === import.meta.url || context.parentURL === agentModule)
        ? { ...context, parentURL: anchor } : context);
    },
  });
  test.after(() => hook.deregister());
}

const integration = (name, run) => test(name, {
  skip: !runnable && 'Requires DSH_INSTALL_DIR and the installed Electron executable in Node mode',
  timeout: 10_000,
}, async t => {
  const cli = JSON.parse(await readFile(join(install, 'package.json'), 'utf8'));
  assert.equal(cli.name, '@deepseek-ai/dsh');
  if (cli.version !== '0.2.2-rc.5') return t.skip(`This characterization targets DSH 0.2.2-rc.5, found ${cli.version}`);
  await using resources = new AsyncDisposableStack();
  await run(t, resources);
});

async function host(t, resources, { withUploads = false } = {}) {
  const [{ Context, symbols }, { Loader }, { TypertRegistry }, { SessionStore },
    { SessionProjectionRegistry }, { AgentRegistry }, { SessionTitleService },
    { SessionProjectionCache, projectionCacheDomainSpec }, { Storage }, storageJson, storageDomain, jsonl,
    { default: Presets }, { default: Query }, { default: Access }, { default: Gateway },
    { default: Controller }, { TYPERT }, { LlmRuntime, createUserMessage }, { default: Workspace },
  ] = await Promise.all([
    'cordis', 'cordis-plugin-loader', 'dsh-typert-registry', 'dsh-session', 'dsh-session-projection', 'dsh-agent',
    'dsh-session-title', 'dsh-session-projection-cache', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain',
    'dsh-session-persistence-jsonl', 'dsh-agent-preset-registry', 'dsh-session-query-sqlite', 'dsh-api-remote-access',
    'dsh-api-gateway', 'dsh-api-session-controller', 'dsh-api-session-controller/typert', 'dsh-llm', 'dsh-workspace',
  ].map(name => import(`@deepseek-ai/${name}`)));

  const dir = dirname(fileURLToPath(import.meta.url));
  const prefix = '.agy-native-cache-';
  const cwd = await mkdtemp(join(dir, prefix));
  resources.defer(async () => {
    assert.equal(dirname(cwd), dir);
    assert.ok(basename(cwd).startsWith(prefix) && (await lstat(cwd)).isDirectory());
    await rm(cwd, { recursive: true, force: true });
  });
  const storageRoot = join(cwd, 'storage');
  const logRoot = join(cwd, 'jsonl');
  const ctx = new Context();
  async function mount(plugin, config) {
    const fiber = ctx.plugin(plugin, config);
    resources.defer(() => fiber.dispose());
    await fiber.inertia;
    assert.equal(fiber.state, 2, `${fiber.name} did not become ACTIVE`);
    return fiber;
  }
  await mount({ name: 'unused controller dependency fixtures', apply(scope) {
    // No filesystem tools or model defaults are used by these Host tests.
    scope.provide('fs', {});
    scope.provide('agentDefaultModel', {});
    if (!withUploads) {
      scope.provide('attachments', { imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
        maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'],
      } });
      scope.provide('fileUploads', { registerAgentResolver: () => () => {} });
    }
  } });
  await mount(Loader);
  await mount(TypertRegistry);
  await mount({ inject: ['typert'], apply(scope) { scope.typert.register(TYPERT); } });
  await mount(SessionStore);
  await mount(SessionProjectionRegistry);
  await mount(AgentRegistry);
  await mount(Presets, { default: 'fixture' });
  await mount(SessionTitleService, { fallbackMaxWords: 1, fallbackMaxBytes: 32, maxTitleBytes: 100 });
  await mount(Storage);
  await mount(storageJson, { root: storageRoot });
  await mount(storageDomain, { backend: 'json' });
  await mount(jsonl, { root: logRoot, compression: 'none' });
  await mount(Workspace);
  await mount(Query, { path: ':memory:', openAt: 'never' });
  await mount(LlmRuntime);
  await mount(Access);
  if (withUploads) {
    const [{ HostConnectionService }, { LocalAttachmentStore }, { CommandRuntime }, { FileUploads }] = await Promise.all([
      import('@deepseek-ai/dsh-client-connection'), import('@deepseek-ai/dsh-attachment-local'),
      import('@deepseek-ai/dsh-commands'), import('@deepseek-ai/dsh-client-file-upload'),
    ]);
    // Use the actual local attachment store, with its home set to the owned
    // fixture directory. Connection receives an in-process Peer, no sockets.
    await mount(LocalAttachmentStore, { dshHome: cwd });
    await mount(CommandRuntime);
    await mount({ name: 'in-process connection', apply(scope) {
      new HostConnectionService(scope, [], { isAuthenticated: () => false, authenticateApi: () => undefined });
    } });
    await mount(FileUploads);
  }
  await mount(Gateway, {});
  await mount(Controller, { nativeOpen: false });
  const { ctx: owner } = await mount({ name: 'live-only session fixture owner', inject: ['sessions'], apply() {} });
  const domain = projectionCacheDomainSpec.name;
  const tableDir = join(storageRoot, domain, 'sessions');
  const document = id => join(tableDir, `${id}.json`);
  const isWrite = change => change.domain === domain && change.table === 'sessions' && change.operation === 'put';
  const writes = [];
  resources.defer(ctx.on('domain/changed', change => { if (isWrite(change)) writes.push(change); }));
  const original = service => service[symbols.original];
  // Pass-through spies record attempted mutations too, so a rolled-back Gemini
  // publication or a lazily acquired JSONL writer cannot look like zero writes.
  const writerCalls = ['create', 'open'].map(name => t.mock.method(original(ctx.sessionPersistence), name));

  async function eventAfter(name, matches, trigger) {
    t.signal.throwIfAborted();
    const event = Promise.withResolvers();
    using abort = addAbortListener(t.signal, () => event.reject(t.signal.reason));
    const off = ctx.on(name, (...args) => { if (matches(...args)) event.resolve(args[0]); });
    try {
      trigger();
      return await event.promise;
    } finally { off(); }
  }
  async function disk(id) {
    const { version, record } = JSON.parse(await readFile(document(id), 'utf8'));
    assert.equal(version, projectionCacheDomainSpec.version);
    return record;
  }
  async function checkpointAfter(id, trigger) {
    // `domain/changed` is emitted by the real domain after atomic publication.
    const change = await eventAfter('domain/changed', row => isWrite(row) && row.key === id, trigger);
    const record = await disk(id);
    assert.deepEqual(record, change.value);
    return record;
  }
  async function ordinary() {
    const id = `ordinary-${randomUUID()}`;
    const session = owner.sessions.prepare(id, { meta: { cwd } });
    const detach = owner.sessions.enter(session);
    resources.defer(detach);
    const empty = await checkpointAfter(id, () => owner.sessions.announce(session));
    assert.equal(ctx.sessions.get(id), session);
    assert.equal(empty.identity.createdAt, session.header.createdAt);
    assert.equal(empty.identity.formatVersion, session.header.version);
    assert.equal(empty.rows.titleInput.seq, -1);
    assert.deepEqual(empty.rows.titleInput.val, { first: null, count: 0, lastSeq: null });
    assert.equal(empty.rows.title.val, null);
    return { session, detach, empty };
  }
  function begin(session, turn, ...textParts) {
    const content = textParts.map(text => ({ type: 'text', text }));
    const message = session.append([
      ['turn/start', { turn }], ['step/start', { turn, step: 1 }],
      ['user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' }],
    ]).at(-1);
    assert.deepEqual(message.data.content, content);
    return message;
  }
  function end(session, turn) {
    return session.append([
      ['step/end', { turn, step: 1 }], ['turn/end', { turn, reason: { kind: 'completed' } }],
    ]).at(-1);
  }
  async function noJsonl() {
    await ctx.sessionPersistence.flush();
    assert.deepEqual(writerCalls.map(spy => spy.mock.callCount()), [0, 0]);
    assert.deepEqual(await ctx.sessionPersistence.list(), []);
    assert.deepEqual(await readdir(logRoot).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }), []);
  }
  return { ctx, owner, cwd, mount, storageRoot, original, writes, eventAfter, ordinary, begin, end, disk, checkpointAfter, document, noJsonl,
    async mountCache() {
      // Well beyond this fixture's event count and test timeout; no case races the throttles.
      const fiber = await mount(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 60_000 });
      assert.ok(ctx.get('sessionProjectionCache') instanceof SessionProjectionCache);
      return fiber;
    },
  };
}

function assertStored(record, first, watermark, title, last = first, count = 1) {
  assert.equal(record.rows.title.seq, watermark);
  assert.equal(record.rows.title.val, title);
  assert.equal(record.rows.titleInput.seq, watermark);
  assert.deepEqual(record.rows.titleInput.val, {
    first: { seq: first.seq, text: first.data.content.map(part => part.text).join('\n') },
    count,
    lastSeq: last.seq,
  });
}

integration('shared rc.5 cache blocks Gemini before publication; ordinary turn/end still stores the first full message', async (t, resources) => {
  const h = await host(t, resources);
  await assertAgyNativeSupport(h.owner); // Same native capability graph, before the cache mounts.
  await h.mountCache();
  const { session } = await h.ordinary();
  const cache = h.ctx.sessionProjectionCache;
  const geminiId = AGY_NATIVE_PREFIX + randomUUID();
  const attempts = [
    ...['prepare', 'enter', 'announce'].map(name => t.mock.method(h.original(h.ctx.sessions), name)),
    ...['enter', 'announce'].map(name => t.mock.method(h.original(h.ctx.agents), name)),
  ];
  const blocked = { code: 'agy/native-unavailable', message: /共享会话投影缓存/ };
  const shadow = h.owner.isolate('sessionProjectionCache');
  assert.equal(shadow.get('sessionProjectionCache', false), undefined);
  assert.equal(h.original(shadow.root.get('sessionProjectionCache', false)), h.original(cache));
  for (const owner of [h.owner, shadow]) {
    await assert.rejects(assertAgyNativeSupport(owner), blocked);
    await assert.rejects(publishAgyAgent(owner, {
      id: geminiId, cwd: h.cwd, title: 'Synthetic Gemini title',
      history: [{ prompt: 'Synthetic Gemini body that must never be published', status: 'completed', text: 'Synthetic reply' }],
      authorizePrompt: () => assert.fail('Gemini prompt authorization must not run'),
      runTurn: () => assert.fail('Gemini runner must not run'),
    }), blocked);
  }
  assert.deepEqual(attempts.map(spy => spy.mock.callCount()), [0, 0, 0, 0, 0]);
  assert.deepEqual(h.ctx.sessions.list(), [session]);
  assert.deepEqual(h.ctx.agents.list(), []);
  assert.equal(h.writes.length, 1, 'only the empty ordinary checkpoint has been written');
  await assert.rejects(readFile(h.document(geminiId)), { code: 'ENOENT' });
  assert.equal(await h.ctx.sessionPersistence.stat(geminiId), undefined);

  let first;
  await h.eventAfter('session/event', (subject, event) => subject === session && event.type === 'session/title', () => {
    first = h.begin(session, 1, 'Synthetic first ordinary prompt', '这行合成正文只来自第一条用户消息');
  });
  assert.equal(h.ctx.sessionTitle.get(session).title, 'Synthetic');
  let terminal;
  const afterTurn = await h.checkpointAfter(session.id, () => { terminal = h.end(session, 1); });
  assertStored(afterTurn, first, terminal.seq, 'Synthetic');
  // The displayed title is truncated, and its private input is still on disk.
  assert.deepEqual(cache.cachedSnapshot(session.header, ['title', 'titleInput']), {
    asOfSeq: terminal.seq, values: { title: 'Synthetic' },
  });
  const manual = 'Manual ordinary title';
  h.ctx.sessionTitle.rename(session, manual);
  const second = h.begin(session, 2, 'Synthetic later prompt with different text');
  const afterRename = await h.checkpointAfter(session.id, () => { terminal = h.end(session, 2); });
  assertStored(afterRename, first, terminal.seq, manual, second, 2);
  assert.equal(cache.cachedSnapshot(session.header).values.title, manual);
  assert.ok(h.writes.every(write => write.key === session.id));
  await h.noJsonl();
});

integration('detaching an open, manually titled Session queues its first full message before cache shutdown', async (t, resources) => {
  const h = await host(t, resources);
  const cacheFiber = await h.mountCache();
  const { session, detach, empty } = await h.ordinary();
  const manual = 'Title pinned before first message';
  h.ctx.sessionTitle.rename(session, manual);
  const first = h.begin(session, 1, 'Synthetic ordinary prompt before detach', '合成首条正文：还未结束这一轮');
  assert.deepEqual(await h.disk(session.id), empty);
  await h.noJsonl();

  detach();
  await cacheFiber.dispose(); // Real domain close drains the write queued by session/disposed.
  assert.equal(h.ctx.sessions.get(session.id), undefined);
  const detached = await h.disk(session.id);
  assertStored(detached, first, first.seq, manual);
  assert.deepEqual(h.writes.map(write => write.value), [empty, detached]);
  await h.mountCache();
  assert.deepEqual(h.ctx.sessionProjectionCache.cachedSnapshot(session.header, ['title']), {
    asOfSeq: first.seq, values: { title: manual },
  });
  await h.noJsonl();
});

integration('stopping the cache before detaching leaves an uncheckpointed open turn out of the file', async (t, resources) => {
  const h = await host(t, resources);
  const cacheFiber = await h.mountCache();
  const { session, detach, empty } = await h.ordinary();
  const manual = 'Title before cache stops';
  h.ctx.sessionTitle.rename(session, manual);
  const first = h.begin(session, 1, 'Synthetic uncheckpointed ordinary first message');
  assert.deepEqual(h.ctx.sessionProjections.checkpoint(session).titleInput.val.first,
    { seq: first.seq, text: first.data.content[0].text });

  await cacheFiber.dispose(); // Cancels the dirty interval; detach now has no cache listener.
  assert.equal(h.ctx.get('sessionProjectionCache', false), undefined);
  assert.equal(h.ctx.sessions.get(session.id), session);
  detach();
  assert.deepEqual(await h.disk(session.id), empty);
  assert.deepEqual(h.writes.map(write => write.value), [empty]);
  await h.noJsonl();
});

integration('a live Gemini fixture enters the ordinary catalog, pin and archive paths without any cache or workspace attachment', async (t, resources) => {
  const h = await host(t, resources);
  const [{ WorkspaceController }, { TYPERT }] = await Promise.all([
    import('@deepseek-ai/dsh-api-workspace-controller'), import('@deepseek-ai/dsh-api-workspace-controller/typert'),
  ]);
  await h.mount({ inject: ['typert'], apply(scope) { scope.typert.register(TYPERT); } });
  await h.mount(WorkspaceController);
  const registry = h.ctx.workspaceRegistry;
  const workspace = await registry.create(h.cwd, 'Synthetic workspace');
  const id = AGY_NATIVE_PREFIX + randomUUID();
  const peer = { principal: { kind: 'owner' }, signal: t.signal };
  const workspaceCommand = method => h.ctx.typertGateway.invoke({ namespace: 'workspace', method, args: { request: { sessionId: id } }, peer });
  const catalog = async () => (await h.ctx.typertGateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, peer })).items;
  const workspaceFile = async () => JSON.parse(await readFile(join(h.storageRoot, 'workspace.json'), 'utf8'));
  const initial = await workspaceFile();

  assert.equal(h.ctx.get('sessionProjectionCache', false), undefined);
  assert.deepEqual(await catalog(), []);
  await assert.rejects(workspaceCommand('pinSession'), { code: 'session/not-found' });
  await assert.rejects(workspaceCommand('archiveSession'), { code: 'session/not-found' });
  assert.deepEqual(await workspaceFile(), initial);

  const fixture = await publishAgyAgent(h.owner, {
    id, cwd: workspace.path, title: 'Synthetic Gemini',
    authorizePrompt: () => false,
    runTurn: () => assert.fail('Workspace operations must not send an ACP prompt'),
  });
  resources.defer(fixture.dispose);
  const rows = await catalog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, id);
  assert.equal(rows[0].agentAvailable, true);
  assert.deepEqual(workspace.sessionIds, []);

  assert.deepEqual(await workspaceCommand('pinSession'), { pinnedSessionIds: [id] });
  assert.deepEqual((await workspaceFile()).global.pinnedSessionIds, [id]);
  assert.deepEqual(await workspaceCommand('archiveSession'), { archivedSessionIds: [id] });
  await fixture.dispose();
  assert.equal(h.ctx.sessions.get(id), undefined);
  assert.equal(h.ctx.agents.get(id), undefined);
  assert.deepEqual(await catalog(), []);
  const stored = await workspaceFile();
  assert.deepEqual(stored.global.archivedSessionIds, [id], 'the ordinary archive record survives retirement');
  assert.deepEqual(stored.global.pinnedSessionIds, []);
  assert.deepEqual(stored.tables, initial.tables, 'no Workspace membership was added');
  assert.deepEqual(await workspaceCommand('unarchiveSession'), { archivedSessionIds: [] });
  assert.deepEqual(await workspaceFile(), initial);
  assert.deepEqual(h.writes, []);
  await h.noJsonl();
});

integration('the ordinary upload stores a file before a Gemini fixture rejects the prompt with its receipt', async (t, resources) => {
  const h = await host(t, resources, { withUploads: true });
  const id = AGY_NATIVE_PREFIX + randomUUID();
  const bytes = Buffer.from('Fixture attachment only. 合成文件内容。\n');
  const name = 'synthetic-upload.txt';
  const digest = createHash('sha256').update(bytes).digest('hex');
  const disk = join(h.cwd, 'attachments', 'v1', 'file-objects', digest.slice(0, 2), digest);
  const connection = h.ctx.connection;
  const peer = connection.browserPeer;
  const handler = connection.createSharedFetchHandler('/api');
  const url = new URL('http://127.0.0.1/api/session/uploadFileBinary'); // Only a synthetic Request; no listener.
  url.search = new URLSearchParams({ sessionId: id, name }).toString();
  const upload = async () => {
    const response = await handler.fetch(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes, signal: t.signal,
    }), peer);
    assert.equal(response.status, 200);
    return response.json();
  };

  assert.equal(h.ctx.get('sessionProjectionCache', false), undefined);
  assert.equal(h.ctx.attachments.root, join(h.cwd, 'attachments', 'v1'));
  assert.equal((await upload()).error?.code, 'session/not-found');
  await assert.rejects(readFile(disk), { code: 'ENOENT' });

  let authorized = 0;
  let turns = 0;
  const fixture = await publishAgyAgent(h.owner, {
    id, cwd: h.cwd, title: 'Synthetic Gemini',
    authorizePrompt() { authorized++; return true; },
    runTurn() { turns++; return { status: 'completed' }; },
  });
  resources.defer(fixture.dispose);
  const before = fixture.agent.session.seq;
  const reply = await upload();
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const { receiptId, file } = reply.value;
  assert.deepEqual(file, { attachmentId: `sha256:${digest}`, name, bytes: bytes.length });
  assert.deepEqual(await readFile(disk), bytes);
  assert.deepEqual(h.ctx.fileUploads.resolve(fixture.agent, receiptId), { type: 'file', attachment: file });

  await assert.rejects(h.ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', peer, args: { request: {
    sessionId: id, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Synthetic input with attachment' }, { type: 'file', receiptId }],
  } } }), { code: 'session/agent-busy' });
  assert.equal(fixture.agent.session.seq, before);
  assert.equal(authorized, 0);
  assert.equal(turns, 0);

  await fixture.dispose();
  assert.equal(h.ctx.fileUploads.resolve(fixture.agent, receiptId), undefined);
  assert.deepEqual(await readFile(disk), bytes, 'removing the receipt and Session does not remove the stored attachment');
  await h.noJsonl();
});
