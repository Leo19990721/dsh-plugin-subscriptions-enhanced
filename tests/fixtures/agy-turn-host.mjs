import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AgyAcpClient } from '../../src/agy-acp-client.js';
import { openAgyTurnLedger } from '../../src/agy-turn-ledger.js';
import { parseAgyTurnOptions } from '../../src/agy-turn-options.js';
import { AGY_TURN_PROVIDER, createAgyTurnRuntime, installAgyTurnWitness } from '../../src/agy-turn-runtime.js';
import { createAgyTurnSession } from '../../src/agy-turn-session.js';
import { loadTurnRuntimeFixture } from './dsh-turn-runtime.mjs';
import { loadTurnUploadFixture } from './dsh-turn-upload.mjs';

export const ORDINARY_SELECTION = Object.freeze({ provider: 'codex', model: 'synthetic-dsh' });
export const AGY_SELECTION = Object.freeze({ provider: AGY_TURN_PROVIDER, model: 'fixture-pro', reasoningEffort: 'fixture-high' });
const sessions = new Map(); // Temporary roots may be reused only by the fixture that allocated them.
const parent = dirname(dirname(fileURLToPath(import.meta.url)));
const prefix = '.agy-native-turn-';
const baseConfig = Object.freeze([
  { type: 'select', id: 'fixture-model-selector', category: 'model', name: 'Model', currentValue: 'fixture-pro',
    options: [{ value: 'fixture-pro', name: 'Synthetic Pro' }, { value: 'fixture-fast', name: 'Synthetic Fast' }] },
  { type: 'select', id: 'fixture-effort-selector', category: 'thought_level', name: 'Thinking', currentValue: 'fixture-low',
    options: [{ value: 'fixture-low', name: 'Low' }, { value: 'fixture-high', name: 'High' }] },
]);
const subscriptionConfig = Object.freeze([
  { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: 'gemini-3.1-pro-high',
    options: [{ value: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High' }, { value: 'gemini-3-flash', name: 'Gemini 3 Flash' }] },
  { type: 'select', id: 'thought_level', category: 'thought_level', name: 'Thinking', currentValue: 'low',
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
]);

function fakeChild(onRequest, onExit) {
  const child = new EventEmitter();
  child.once('exit', onExit);
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let exited;
  function exit(code) {
    if (exited) return;
    exited = true;
    child.emit('exit', code, null);
  }
  child.send = message => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  child.disconnect = () => exit(1);
  child.stdin = new Writable({
    write(bytes, _encoding, done) {
      try { onRequest(JSON.parse(bytes.toString('utf8')), child); done(); }
      catch (error) { done(error); }
    },
    final(done) { done(); queueMicrotask(() => exit(0)); },
  });
  child.kill = () => { queueMicrotask(() => exit(0)); return true; };
  return child;
}

function fakeSessionFactory({ root, cwd, configurations, acpConfig, acpCalls, acpExits, acpPrompt, apis }) {
  return ({ cwd: requestedCwd = cwd, signal, mcpServers } = {}) => {
    signal?.throwIfAborted();
    assert.equal(requestedCwd, cwd, 'only the fixture directory can reach synthetic ACP');
    let id;
    return createAgyTurnSession({ cwd, mcpServers, timeLimits: { open: 2500, turn: 4500, cancel: 2500 }, makeClient: callbacks => new AgyAcpClient({
      ...callbacks, cwd, executable: join(root, 'never-launched-agy.exe'), env: {}, timeoutMs: 2500, allowMcpServers: Boolean(mcpServers?.length),
      spawnFactory: () => fakeChild(({ id: rpcId, method, params }, child) => {
        acpCalls.push({ method, params, hasId: rpcId !== undefined });
        const result = value => child.send({ id: rpcId, result: value });
        const error = (code, message) => child.send({ id: rpcId, error: { code, message } });
        if (method === 'initialize') return result({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: 'synthetic' },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: {} } } });
        if (method === 'session/new' || method === 'session/load') {
          if (apis.setupError) return error(apis.setupError, 'synthetic setup failure');
          id = method === 'session/new' ? `official-${randomUUID()}` : params.sessionId;
          if (method === 'session/new') configurations.set(id, structuredClone(acpConfig));
          const configOptions = configurations.get(id);
          if (!configOptions || (method === 'session/load' && apis.failLoad)) return error(-32602, 'Unknown synthetic session');
          if (method === 'session/load') child.send({ method: 'session/update', params: { sessionId: id, update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic history from CLI (do not display again)' },
          } } });
          return result({ ...(method === 'session/new' ? { sessionId: id } : {}), configOptions });
        }
        assert.equal(params.sessionId, id);
        if (method === 'session/set_config_option') {
          const configOptions = configurations.get(id);
          const chosen = configOptions.find(option => option.id === params.configId);
          assert.ok(chosen?.options.some(option => option.value === params.value));
          chosen.currentValue = params.value;
          apis.onConfig?.(configOptions, chosen);
          return result({ configOptions });
        }
        if (method === 'session/close') return result({});
        if (method === 'session/cancel') { apis.onCancel?.(id); return; }
        if (method === 'session/prompt') {
          const delta = update => child.send({ method: 'session/update', params: { sessionId: id, update } });
          const update = text => delta({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
          const reply = (stopReason = 'end_turn') => result({ stopReason });
          const prompt = apis.acpPrompt ?? acpPrompt;
          if (prompt) return prompt({ id: rpcId, sessionId: id, params, reply, update, delta, disconnect: child.disconnect, error });
          update('合成 Antigravity 回复');
          return reply();
        }
        error(-32601, 'Unexpected fixture method');
      }, () => acpExits.push(id)),
    }) });
  };
}

async function loadReleasedRuntime() {
  const [{ AgentLoop }, { SessionController }, { TYPERT }] = await Promise.all([
    import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-api-session-controller'), import('@deepseek-ai/dsh-api-session-controller/typert'),
  ]);
  return { AgentLoop, SessionController, TYPERT };
}

/** In-process Host with owned temporary stores, synthetic auth and ACP, and no listening socket. */
export async function createTurnHost(t, {
  root, acpPrompt, beforeFlush, afterLedgerWrite, toolStep, ordinaryPrompt, withUploads = false, apis = {}, releasedReader = false,
  mountSubscription, acpConfig: initialAcpConfig = mountSubscription ? subscriptionConfig : baseConfig, desktopRequests = false, withCompaction = false,
  withRetry = false, withCheckpoint = false, withWorkingDirectory = false, localPermissions, localAttachments = false, localMcpMarker,
} = {}) {
  if (releasedReader && withUploads) throw new Error('Use the unmodified reader without fixture upload injection');
  if (mountSubscription && !releasedReader) throw new Error('Mount the ordinary subscription adapter with the unmodified runtime');
  const hasUploads = withUploads || localAttachments;
  const acpConfig = structuredClone(initialAcpConfig);
  const [native, cordis, loader, registry, sessionMod, projections, agentMod, titles, cache, storage, storageJson,
    storageDomain, jsonl, presets, query, access, gateway, workspaces, workspaceController, workspaceTypes,
    llm, connectionMod, system, tools, toolExecutor] = await Promise.all([
    releasedReader ? loadReleasedRuntime() : loadTurnRuntimeFixture(process.env.DSH_INSTALL_DIR), ...[
      'cordis', 'cordis-plugin-loader', 'dsh-typert-registry', 'dsh-session', 'dsh-session-projection', 'dsh-agent',
      'dsh-session-title', 'dsh-session-projection-cache', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain',
      'dsh-session-persistence-jsonl', 'dsh-agent-preset-registry', 'dsh-session-query-sqlite', 'dsh-api-remote-access',
      'dsh-api-gateway', 'dsh-workspace', 'dsh-api-workspace-controller',
      'dsh-api-workspace-controller/typert', 'dsh-llm', 'dsh-client-connection', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native',
    ].map(name => import(`@deepseek-ai/${name}`)),
  ]);
  if (root === undefined) {
    root = await mkdtemp(join(parent, prefix));
    const allocated = { test: t, live: false, configurations: new Map() };
    sessions.set(root, allocated);
    t.after(async () => {
      await allocated.close?.();
      assert.equal(sessions.get(root), allocated);
      assert.equal(allocated.live, false, 'dispose the fixture Host before cleaning its files');
      assert.equal(dirname(root), parent);
      assert.ok(basename(root).startsWith(prefix) && (await lstat(root)).isDirectory());
      await rm(root, { force: true, recursive: true });
      sessions.delete(root);
    });
  }
  const fixture = sessions.get(root);
  assert.ok(fixture?.test === t && !fixture.live);
  fixture.live = true;
  const ctx = new cordis.Context();
  const fibers = [];
  const streamLifetime = new AbortController();
  const ordinaryCalls = [], acpCalls = [], acpExits = [], selects = [], records = [];
  let disposing;
  const dispose = () => disposing ??= (async () => {
    streamLifetime.abort();
    const failures = [];
    for (const fiber of fibers.reverse()) {
      try { await fiber.dispose(); }
      catch (error) { failures.push(error); }
    }
    fixture.live = false;
    if (failures.length) throw new AggregateError(failures, 'Fixture Host cleanup failed');
  })();
  async function mount(plugin, config) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, `${fiber.name} did not become ACTIVE`);
    return fiber;
  }

  try {
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const cwd = await realpath(project);
    const origin = 'http://127.0.0.1:12345'; // Request metadata only.
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const caller = new WeakMap();
    let apiPeerId;
    const ready = Promise.withResolvers();
    await mount({ name: 'in-process transport', apply(scope) {
      scope.provide('fs', {
        processPathFromHostPath(hostPath) {
          const from = relative(join(root, 'attachments', 'v1'), hostPath);
          return from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from) ? hostPath : undefined;
        },
      });
      scope.provide('webServer', { host: '127.0.0.1', protocol: 'http:', registerUpgrade() { ready.resolve(); return () => {}; } });
      new connectionMod.HostConnectionService(scope, [], {
        isAuthenticated: request => caller.get(request) === 'browser',
        authenticateApi: request => caller.get(request) === 'api' ? apiPeerId : undefined,
        authorizeConnect(_req, _res, _secure, publishPeer) { apiPeerId = publishPeer('none'); },
      });
      scope.provide('agentDefaultModel', {
        currentSelection: () => selects.at(-1) ?? ORDINARY_SELECTION,
        async saveSelection(selection) { selects.push({ ...selection }); },
      });
      if (withWorkingDirectory) scope.provide('workingDirectory', {
        get: session => typeof apis.workingDirectory === 'function' ? apis.workingDirectory(session)
          : (apis.workingDirectory ?? session.header.cwd ?? cwd),
      });
      if (localPermissions) {
        scope.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: localPermissions.mode ?? 'danger-full-access', workspaceRoot: session.header.cwd ?? cwd }) });
        scope.provide('approval', { overrideOf: () => localPermissions.approval ?? 'never', request: input => localPermissions.request?.(input) ?? 'rejected' });
      }
      if (!hasUploads) {
        scope.provide('attachments', {
          imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024,
            maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] },
          async admitPromptContent(content) {
            await apis.beforePromptAdmission?.(content);
            return content;
          },
        });
        scope.provide('fileUploads', {
          registerAgentResolver: () => () => {},
          retirePrompt() {}, // This composition never allocates a file receipt.
          resolve() { assert.fail('An ACP prompt may not resolve file receipts'); },
          bindPrompt: (_agent, ids) => { assert.deepEqual(ids, []); return { commit() {}, [Symbol.dispose]() {} }; },
        });
      }
    } });
    const connection = ctx.connection;
    connection.authorizeConnect({ url: '/connect', headers }, {});
    assert.ok(apiPeerId && apiPeerId !== connection.browserPeer.id);
    await mount(loader.Loader);
    await mount(registry.TypertRegistry);
    const uploadTypes = hasUploads ? await import('@deepseek-ai/dsh-client-file-upload/typert') : undefined;
    await mount({ inject: ['typert'], apply(scope) {
      scope.typert.register(native.TYPERT);
      scope.typert.register(workspaceTypes.TYPERT);
      if (uploadTypes) scope.typert.register(uploadTypes.TYPERT);
    } });
    await mount(sessionMod.SessionStore);
    await mount(projections.SessionProjectionRegistry);
    await mount(agentMod.AgentRegistry);
    await mount(presets.default, { default: 'fixture' });
    await mount(titles.SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 100 });
    await mount(storage.Storage);
    await mount(storageJson, { root: join(root, 'storage') });
    await mount(storageDomain, { backend: 'json' });
    await mount(jsonl, { root: join(root, 'jsonl'), compression: 'none' });
    await mount(workspaces.default);
    await mount(cache.SessionProjectionCache, { writeEveryEvents: 2, writeIntervalMs: 60_000 });
    await mount(query.default, { path: ':memory:', openAt: 'startup' });
    await mount(llm.LlmRuntime);
    if (withCompaction) {
      const [{ TokenMeter }, { BasicCompactionEngine }] = await Promise.all([
        import('@deepseek-ai/dsh-token-meter'), import('@deepseek-ai/dsh-compaction-basic'),
      ]);
      await mount(TokenMeter);
      await mount(BasicCompactionEngine, {});
    }
    await mount(system.SystemPrompt, {});
    await mount(tools.ToolsService, {});
    await mount(toolExecutor);
    await mount(access.default);
    if (hasUploads) {
      const [{ FileUploads }, { LocalAttachmentStore }, { CommandRuntime }] = await Promise.all([
        withUploads ? loadTurnUploadFixture(process.env.DSH_INSTALL_DIR) : import('@deepseek-ai/dsh-client-file-upload'),
        import('@deepseek-ai/dsh-attachment-local'), import('@deepseek-ai/dsh-commands'),
      ]);
      await mount(LocalAttachmentStore, { dshHome: root });
      await mount(CommandRuntime);
      await mount(FileUploads);
    }
    await mount(gateway.default, {});
    await ready.promise;
    const workspace = await ctx.workspaceRegistry.resolveByPath(cwd) ?? await ctx.workspaceRegistry.create(cwd, 'Synthetic project');
    const makeSession = fakeSessionFactory({ root, cwd, configurations: fixture.configurations, acpConfig, acpCalls, acpExits, acpPrompt, apis });
    async function probe(signal) {
      const session = makeSession({ signal });
      try {
        await session.open();
        signal?.throwIfAborted();
        return session.options;
      } finally { await session.close(); }
    }
    let ledger;
    if (!releasedReader) await mount({ name: 'isolated Antigravity turn binding', inject: ['storageDomain', 'connection', 'webServer', 'sessionPersistence', 'workspaceRegistry', 'agents'],
      async apply(scope) {
        const backendLedger = await openAgyTurnLedger(scope.storageDomain);
        scope.effect(() => backendLedger.close);
        ledger = Object.freeze({
          read: backendLedger.read,
          async write(id, row) {
            await backendLedger.write(id, row);
            await afterLedgerWrite?.(id, row);
          },
        });
        const witness = installAgyTurnWitness(scope);
        const runtime = createAgyTurnRuntime({
          options: parseAgyTurnOptions(acpConfig), defaultEffort: 'fixture-low', authorize: witness.take, ledger,
          createAssistantMessage: llm.createAssistantMessage,
          snapshotEvents: (session, start, end) => {
            const entries = session.snapshotEvents(start);
            return end === undefined ? entries : entries.slice(0, end - start);
          },
          checkWorkspace: agent => scope.agents.get(agent.id) === agent && agent.session.header.cwd === cwd
            && !scope.workspaceRegistry.archivedSessionIds.includes(agent.id)
            && scope.workspaceRegistry.get(workspace.id)?.sessionIds.includes(agent.id) === true,
          async verifyWorkspace(agent) {
            assert.equal(agent.session.header.cwd, cwd, 'only the fixture directory can reach synthetic ACP');
            assert.equal(await realpath(cwd), cwd);
            return cwd;
          },
          async flush(session) {
            const through = session.seq;
            if (await beforeFlush?.(session) === false) return false;
            await scope.sessionPersistence.flush();
            const handle = await scope.sessionPersistence.open(session.id, 'read');
            try {
              const stored = await handle.read();
              return handle.header.id === session.id && handle.header.createdAt === session.header.createdAt
                && stored.events.length >= through;
            } finally { await handle.close(); }
          },
          makeSession,
        });
        scope.provide('agyTurnRuntime', runtime);
      },
    });
    await mount({ name: 'synthetic ordinary model and preset', inject: ['llm', 'agentPresets', 'systemPrompt', 'tools'], async apply(scope) {
      for (const name of localMcpMarker ? ['mcp__knowledge__dsh_integration_marker', 'remote_list_hosts', 'remote_workspaces'] : []) scope.tools.register({
        name, description: 'Return the synthetic DSH MCP integration marker.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(_args, execution) { assert.ok(execution.agent); return localMcpMarker; },
      });
      if (toolStep) {
        scope.tools.register({
          name: 'fixture_counter', description: 'Return an in-memory fixture value.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
          async execute(_args, execution) {
            await toolStep(execution);
            return 'synthetic private tool result';
          },
        });
      }
      class SyntheticOrdinary extends llm.LlmAdapter {
        async listModels(provider) { return [{ provider, id: ORDINARY_SELECTION.model, name: 'Synthetic DSH' }]; }
        async resolveModel(provider, model) { return { provider, id: model, name: 'Synthetic DSH', context: { contextWindow: 128_000 } }; }
        async *stream(options) {
          ordinaryCalls.push(options);
          assert.equal(options.model, ORDINARY_SELECTION.model);
          const callCount = ordinaryCalls.length;
          await ordinaryPrompt?.(options, callCount);
          if (toolStep && callCount === 1) {
            const block = { type: 'tool-call', id: 'fixture-call-1', name: 'fixture_counter', arguments: '{}' };
            yield { type: 'block-start', index: 0, blockType: 'tool-call' };
            yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' };
            yield { type: 'block-end', index: 0, block };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          const text = `合成 DSH 回复 ${callCount}`;
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
      scope.effect(() => scope.llm.registerAdapter([ORDINARY_SELECTION.provider], new SyntheticOrdinary()));
      scope.systemPrompt.section({ name: 'fixture', order: 0, text: 'Synthetic private DSH system text' });
      const off = await scope.agentPresets.register({ id: 'fixture', plugins: [] });
      scope.effect(() => off);
      const writing = await scope.agentPresets.register({ id: 'writing', plugins: [] });
      scope.effect(() => writing);
    } });
    await mount(native.AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await mount(native.SessionController, { nativeOpen: false });
    await mount(workspaceController.WorkspaceController);
    if (withRetry) await mount(await import('@deepseek-ai/dsh-llm-retry'), {});
    if (withCheckpoint) await mount(await import('@deepseek-ai/dsh-session-checkpoint-policy'));
    if (mountSubscription) await mount({ name: 'synthetic subscription binding',
      inject: ['agentDefaultModel', 'agentLoop', 'agents', 'attachments', 'connection', 'fileUploads', 'fs', 'llm', 'sessionController',
        'sessionPersistence', 'sessionProjections', 'sessions', 'storageDomain', 'systemPrompt', 'tools', 'typertGateway', 'webServer',
        'workspaceRegistry', ...(withWorkingDirectory ? ['workingDirectory'] : []), ...(localPermissions ? ['sandboxPolicy', 'approval'] : [])],
      async apply(scope) { await mountSubscription({ scope, cwd, root, workspace, makeSession, probe, acpConfig, apis }); },
    });
    const off = ctx.on('domain/changed', change => { if (change.domain === 'subscriptions_agy_turns') records.push(change); });
    const release = () => { off(); return dispose(); };
    // The temporary root hook runs first (in test registration order); one
    // owned root can host multiple disjoint generations within one test.
    fixture.close = release;
    const shared = connection.createSharedFetchHandler('/api');
    async function requestPost(path, body, options = {}) {
      const { who = 'browser', headers: overrides = {}, remoteAddress = '127.0.0.1', desktopRequests: desktop = desktopRequests, signal }
        = typeof options === 'string' ? { who: options } : options;
      const requestSignal = signal === undefined ? t.signal : AbortSignal.any([t.signal, signal]);
      requestSignal.throwIfAborted();
      const requestHeaders = { ...headers };
      // The Desktop carrier authenticates its owner without browser Origin or Fetch Metadata.
      if (desktop) {
        delete requestHeaders.origin;
        delete requestHeaders['sec-fetch-site'];
      }
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete requestHeaders[name.toLowerCase()];
        else requestHeaders[name.toLowerCase()] = value;
      }
      const metadata = { url: path, method: 'POST', headers: requestHeaders, socket: { remoteAddress } };
      const request = mountSubscription
        ? Object.assign(Readable.from(body == null ? [] : [Buffer.from(body)], { objectMode: false }), metadata) : metadata;
      caller.set(request, who === 'owner' ? 'api' : who);
      const admission = connection.admit(request);
      if (!admission.peer) {
        request.destroy?.();
        return new Response(admission.rejection === 401 ? 'unauthorized' : 'forbidden', { status: admission.rejection });
      }
      assert.equal(admission.peer.id, who === 'browser' ? connection.browserPeer.id : apiPeerId);
      const dispatch = (bytes, fetchHeaders = requestHeaders) => shared.fetch(new Request(origin + path, {
        method: 'POST', headers: fetchHeaders, body: bytes, duplex: 'half', signal: requestSignal,
      }), admission.peer);
      if (!mountSubscription) return ctx.waterfall('connection/request', request, {}, () => dispatch(body));

      // Mirror rc.5's buffered bridge: listeners see the Node stream before
      // the terminal reads it. Only its iterator supplies bytes to Gateway.
      let response, responseHeaders;
      const wire = Object.assign(new EventEmitter(), {
        statusCode: 200, headersSent: false, writableEnded: false,
        writeHead(statusCode, headers) { this.statusCode = statusCode; responseHeaders = headers; this.headersSent = true; return this; },
        end(bytes) {
          response = new Response(bytes, { status: this.statusCode, headers: responseHeaders });
          this.headersSent = this.writableEnded = true;
          return this;
        },
      });
      const onAbort = () => { request.destroy(); wire.emit('close'); };
      requestSignal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await ctx.waterfall('connection/request', request, wire, async () => {
          const fetchHeaders = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === 'string'));
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          requestSignal.throwIfAborted();
          response = await dispatch(chunks.length ? Buffer.concat(chunks) : undefined, fetchHeaders);
          wire.statusCode = response.status;
          wire.headersSent = wire.writableEnded = true;
        });
        return response ?? result;
      } catch (error) {
        requestSignal.throwIfAborted();
        throw error;
      } finally {
        requestSignal.removeEventListener('abort', onAbort);
        request.destroy();
      }
    }
    async function post(namespace, method, args = {}, who = 'browser') {
      const path = `/api/${namespace}/${method}`;
      const rpcId = randomUUID();
      const body = JSON.stringify({ type: 'client-request', rpcId, method: `${namespace}/${method}`, payload: { args } });
      const response = await requestPost(path, body, who);
      assert.equal(response.status, 200, await response.clone().text());
      const reply = await response.json();
      assert.equal(reply.type, 'server-response');
      assert.equal(reply.rpcId, rpcId);
      return reply.result;
    }
    async function uploadBinary(sessionId, { bytes, name, mediaType, who = 'browser' }) {
      assert.equal(hasUploads, true);
      const query = new URLSearchParams({ sessionId });
      if (name !== undefined) query.set('name', name);
      if (mediaType !== undefined) query.set('mediaType', mediaType);
      const response = await requestPost(`/api/session/uploadFileBinary?${query}`, bytes,
        { who, headers: { 'content-type': 'application/octet-stream' } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    }
    function invoke(namespace, method, args = {}, who = 'owner') {
      const peer = who === 'browser' ? connection.browserPeer : { principal: { kind: 'owner' }, signal: t.signal };
      return ctx.typertGateway.invoke({ namespace, method, args, peer });
    }
    const agent = id => ctx.agents.get(id);
    async function follow(id) {
      return (await ctx.typertGateway.wireStream.open('session/follow', { args: { request: {
        address: { kind: 'session', sessionId: id }, assistantStream: true, activate: true,
      } } }, (async function* () {})(), connection.browserPeer, AbortSignal.any([t.signal, streamLifetime.signal])))[Symbol.asyncIterator]();
    }
    return {
      root, cwd, ctx, workspace, records, acpCalls, acpExits, ordinaryCalls, selects, ledger, apis, makeSession, probe,
      requestPost, post, uploadBinary, invoke, agent, follow, dispose: release,
      catalog: (sessionId, who) => post('session', 'modelCatalog', { request: { audience: 'conversation', sessionId } }, who),
      async create(options = {}) {
        const result = await post('session', 'create', { request: { workspaceId: workspace.id, ...options } });
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.value.sessionId;
      },
      select: (id, selection = AGY_SELECTION, who) => post('session', 'selectModel', { request: { sessionId: id, ...selection } }, who),
      prompt: (id, content, { requestId = randomUUID(), mode = 'queue', who } = {}) => post('session', 'prompt', { request: {
        sessionId: id, mode, requestId, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      } }, who),
      cancel: (id, who) => post('session', 'cancel', { request: { sessionId: id } }, who),
      idle: id => agent(id).whenIdle(),
      events: id => agent(id).session.snapshotEvents(),
    };
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Fixture setup failed'); }
    throw error;
  }
}
