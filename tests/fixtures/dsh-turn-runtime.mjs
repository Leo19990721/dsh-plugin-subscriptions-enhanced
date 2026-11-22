// Test-only source injection for the exact Desktop rc.5 build. Imported classes
// retain native Cordis, Session, Gateway and stream primitives. No package on
// disk, browser bundle, or normal import is replaced.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '0.2.2-rc.5';
const PINNED = {
  'dsh-agent-loop': 'f09f60814d4e96a880f41b9fc3832f33c56a28f954f48810d8439ce83ad6ffa8',
  'dsh-api-session-controller': 'c6ce8f8014d943c8f2dceaf7a9b184a56b2de757de6097938646549d2d2a9087',
};
const EXTERNAL = 'antigravity-cli';
const CONTROLLER_CONTRACT_HASH = '16074047e84df9f0e54be62316b35a3d3f35fc53e8ab6b755699b10fa1aed436';

function replaceOnce(input, anchor, replacement, label) {
  const offset = input.indexOf(anchor);
  if (offset < 0 || input.indexOf(anchor, offset + 1) !== -1) {
    throw new Error(`DSH ${VERSION} turn fixture anchor missing or ambiguous: ${label}`);
  }
  return input.slice(0, offset) + replacement + input.slice(offset + anchor.length);
}

export async function loadPinned(anchorDir, packageId, expectedHash = PINNED[packageId], relativePath = 'lib/index.js') {
  if (typeof anchorDir !== 'string' || !isAbsolute(anchorDir) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) {
    throw new TypeError('An absolute installed DSH anchor and pinned SHA-256 are required');
  }
  const packageName = `@deepseek-ai/${packageId}`;
  const anchorRequire = createRequire(join(anchorDir, 'package.json'));
  let manifestPath;
  try {
    manifestPath = anchorRequire.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    // The Desktop fixture also accepts its installed CLI package or its scope directory.
    for (const candidate of [join(anchorDir, packageId, 'package.json'), join(anchorDir, '..', packageId, 'package.json')]) {
      try {
        manifestPath = anchorRequire.resolve(candidate);
        break;
      } catch (lookupError) {
        if (lookupError?.code !== 'MODULE_NOT_FOUND') throw lookupError;
      }
    }
    if (manifestPath === undefined) throw error;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== packageName || manifest.version !== VERSION) {
    throw new Error(`Expected installed ${packageName} ${VERSION} for the isolated turn fixture`);
  }
  const bundle = join(dirname(manifestPath), relativePath);
  const bytes = await readFile(bundle);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new Error(`Installed ${packageName} ${VERSION} does not match the pinned turn fixture hash`);
  }
  return { bundle, manifestPath, source: bytes.toString('utf8') };
}

function patchLoop(code) {
  const replace = (anchor, replacement, label) => { code = replaceOnce(code, anchor, replacement, `Agent Loop / ${label}`); };
  replace('\t\tthis.inbox.splice(resolvedTarget, Infinity, 0, [message]);',
    `\t\tconst agyRuntime = this.ctx.get('agyTurnRuntime', false);
\t\tif (agyRuntime === undefined && this.model.current()?.provider === '${EXTERNAL}') {
\t\t\tthrow new LlmError('External ACP turn runner fixture is unavailable', 'AGY_TURN_RUNTIME_REQUIRED');
\t\t}
\t\tagyRuntime?.permitSend(this, message, target, wakeup, this.phase.kind === 'idle');
\t\tthis.inbox.splice(resolvedTarget, Infinity, 0, [message]);`, 'guard native send');

  replace('\t\tconst selection = this.model.current();\n\t\tif (selection === void 0) throw new Error(`agent',
    `\t\tconst current = this.model.current();
\t\tconst selection = current?.provider === '${EXTERNAL}' ? this.phase.fallbackSelection : current;
\t\tif (selection?.provider === '${EXTERNAL}') throw new LlmError('ACP route reached regular step preparation', 'AGY_TURN_RUNTIME_REQUIRED');
\t\tthis.phase.fallbackSelection = selection;
\t\tif (selection === void 0) throw new Error(\`agent`, 'hold last ordinary step selection');

  replace('\t\tconst turn = phase.turn + 1;\n\t\ttry {',
    `\t\tconst turn = phase.turn + 1;
\t\tconst turnSelection = this.model.current();
\t\tphase.fallbackSelection = turnSelection;
\t\tconst agyTurn = turnSelection?.provider === '${EXTERNAL}';
\t\tconst agyRuntime = agyTurn ? this.ctx.get('agyTurnRuntime', false) : undefined;
\t\ttry {`, 'capture route before native turn start');

  replace('\t\tlet target = "next-turn";\n\t\ttry {\n\t\t\twhile (true) {',
    `\t\tlet target = "next-turn";
\t\ttry {
\t\t\tif (agyTurn) {
\t\t\t\tif (agyRuntime === undefined) throw new LlmError('External ACP turn runner fixture is unavailable', 'AGY_TURN_RUNTIME_REQUIRED');
\t\t\t\tlet claimed, live;
\t\t\t\tlet stepOpened = false;
\t\t\t\tlet running = true;
\t\t\t\ttry {
\t\t\t\t\tturnEnds = await agyRuntime.runNativeTurn({
\t\t\t\t\t\tagent: this, selection: turnSelection, turn, signal,
\t\t\t\t\t\tclaim: () => {
\t\t\t\t\t\t\tsignal.throwIfAborted();
\t\t\t\t\t\t\tif (!running || claimed !== undefined || this.inbox.nextStep.length > 0) {
\t\t\t\t\t\t\t\tthrow new Error('External turn can only claim one ordinary queue boundary');
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\tclaimed = Object.freeze(this.inbox.claim('next-turn', turn));
\t\t\t\t\t\t\treturn claimed;
\t\t\t\t\t\t},
\t\t\t\t\t\topen: (message) => {
\t\t\t\t\t\t\tsignal.throwIfAborted();
\t\t\t\t\t\t\tif (!running || stepOpened || claimed?.length !== 1 || claimed[0] !== message) {
\t\t\t\t\t\t\t\tthrow new Error('External turn must open once with the exact claimed native message');
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\tthis.session.append('step/start', { turn, step: 1 });
\t\t\t\t\t\t\tstepOpened = true;
\t\t\t\t\t\t\tphase.step = 1;
\t\t\t\t\t\t\tthis.session.append('user/message', message, { surfaceOp: 'append' });
\t\t\t\t\t\t},
\t\t\t\t\t\tstream: () => {
\t\t\t\t\t\t\tif (!running || !stepOpened || live !== undefined) throw new Error('External turn can start one assistant attempt after opening its step');
\t\t\t\t\t\t\tlive = new AssistantStreamAttempt(this.session.id, ++this.assistantAttemptCounter,
\t\t\t\t\t\t\t\t() => ++this.assistantStreamRevision, turn, 1,
\t\t\t\t\t\t\t\t(frame) => this.dispatch.emit('agent/assistant-stream', { frame }));
\t\t\t\t\t\t\tlive.start();
\t\t\t\t\t\t\treturn live;
\t\t\t\t\t\t}
\t\t\t\t\t});
\t\t\t\t\t// The official terminal response wins over a coincident local Stop.
\t\t\t\t\tif (!turnEnds) throw new Error('External turn runner did not return a terminal result');
\t\t\t\t} finally {
\t\t\t\t\trunning = false;
\t\t\t\t\tif (live && !live.ended) live.abandon();
\t\t\t\t\tif (stepOpened) this.session.append('step/end', { turn, step: 1 });
\t\t\t\t}
\t\t\t} else while (true) {`, 'run the external turn before ordinary preparation');

  replace('\t\t\t\tthis.session.append("turn/end", {\n\t\t\t\t\tturn,\n\t\t\t\t\treason: turnEnds\n\t\t\t\t});\n\t\t\t} catch (error) {\n\t\t\t\tthis.throwError(error);\n\t\t\t}',
    `\t\t\t\tconst endEvent = this.session.append("turn/end", { turn, reason: turnEnds });
\t\t\t\tif (agyRuntime !== undefined) await agyRuntime.commitTurn(this, endEvent);
\t\t\t} catch (error) {
\t\t\t\tthis.throwError(error);
\t\t\t} finally {
\t\t\t\tif (agyRuntime !== undefined) await agyRuntime.releaseTurn(this);
\t\t\t}`, 'commit and release after the native turn closes');
  replace('\t\tif (!this.inbox.hasPending) return false;\n\t\tphase.abort = new AbortController();',
    `\t\t// Park the queue after Stop/failure. kick() still honors an already latched wake.
\t\tif (agyTurn && (signal.aborted || turnEnds.kind === 'blocked' || turnEnds.kind === 'aborted' || turnEnds.kind === 'error')) return false;
\t\tif (!this.inbox.hasPending) return false;
\t\tphase.abort = new AbortController();`, 'preserve the native queue convergence after external Stop or refusal');
  return code;
}

function patchController(code, manifestPath) {
  const replace = (anchor, replacement, label) => { code = replaceOnce(code, anchor, replacement, `Session Controller / ${label}`); };
  const mime = pathToFileURL(createRequire(manifestPath).resolve('mime-types')).href;
  replace('from "mime-types"', `from ${JSON.stringify(mime)}`, 'resolve MIME dependency for data URL');

  replace('\t\tselectModel(request) {\n\t\t\treturn this.commands.selectModel(request);',
    '\t\tselectModel(request) {\n\t\t\treturn this.commands.selectModel(request, this.ctx);', 'keep invocation context for selection');
  replace('\t\tmodelCatalog() {\n\t\t\treturn buildModelCatalog(this.ctx);',
    `\t\tmodelCatalog(request) {
\t\t\tconst controllerCtx = this.ctx;
\t\t\tconst base = buildModelCatalog(controllerCtx);
\t\t\tif (request?.audience !== 'conversation') return base;
\t\t\tconst runtime = controllerCtx.get('agyTurnRuntime', false);
\t\t\treturn runtime === undefined ? base : base.then((catalog) => runtime.catalog(catalog, request,
\t\t\t\tcontrollerCtx.agents.get(request.sessionId), controllerCtx));`, 'add ACP only to the addressed conversation chooser');
  replace('\tasync selectModel(request) {\n\t\tconst agent = await this.resolveAgent(request.sessionId);',
    '\tasync selectModel(request, controllerCtx) {\n\t\tconst agent = await this.resolveAgent(request.sessionId);', 'carry selection caller into the command');
  replace('\t\t\t\tawait this.requireModel(request);\n\t\t\t\tconst selected = {',
    '\t\t\t\tconst selected = {', 'normalize selection first');
  replace('\t\t\t\tawait this.ctx.llm.resolveCallConfig(selected);\n\t\t\t\tagent.model.select(selected);',
    `\t\t\t\tconst runtime = controllerCtx.get('agyTurnRuntime', false);
\t\t\t\tif (selected.provider === '${EXTERNAL}') {
\t\t\t\t\tif (runtime === undefined) throw new RemoteError('session/model-unavailable', 'Antigravity turn fixture is unavailable.', selected);
\t\t\t\t\tawait runtime.select(agent, selected, controllerCtx);
\t\t\t\t\treturn { selected: { ...selected } };
\t\t\t\t}
\t\t\t\tawait this.requireModel(request);
\t\t\t\tawait this.ctx.llm.resolveCallConfig(selected);
\t\t\t\tif (agent.model.current()?.provider === '${EXTERNAL}') {
\t\t\t\t\tif (runtime === undefined) agent.model.select(selected);
\t\t\t\t\telse runtime.leave(agent, selected);
\t\t\t\t\treturn { selected: { ...selected } };
\t\t\t\t}
\t\t\t\tagent.model.select(selected);`, 'select and leave ACP locally without changing the default');

  replace('return this.commands.prompt(request, source);',
    'return this.commands.prompt(request, source, this.ctx);', 'keep invocation context for prompt');
  replace('\tasync prompt(request, source) {\n\t\tconst agent = await this.resolveAgent(request.sessionId);\n\t\tif (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true };',
    `\tasync prompt(request, source, controllerCtx) {
\t\tconst agent = await this.resolveAgent(request.sessionId);
\t\tif (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true };
\t\tconst runtime = controllerCtx.get('agyTurnRuntime', false);
\t\tlet receipt;
\t\ttry {
\t\t\tif (runtime === undefined && agent.model.current()?.provider === '${EXTERNAL}') throw new Error('Antigravity turn fixture is unavailable.');
\t\t\treceipt = runtime?.checkPrompt(agent, request, controllerCtx);
\t\t} catch (error) {
\t\t\tif (remoteErrorOf(error) !== void 0) throw error;
\t\t\tthrow new RemoteError('session/agent-busy', error instanceof Error ? error.message : 'Prompt admission rejected.', {});
\t\t}`, 'authorize new native prompt before attachments');
  replace('\t\t\t\tagent.followup(createUserMessage({\n\t\t\t\t\tcontent: [],\n\t\t\t\t\tsource\n\t\t\t\t}));',
    `\t\t\t\tconst message = createUserMessage({ content: [], source });
\t\t\t\truntime?.stampPrompt(agent, message, receipt);
\t\t\t\tagent.followup(message);`, 'retain ordinary empty continuation with cross-mode race guard');
  replace('\t\t\t\t\tif (request.mode === "steer") agent.steer(message);\n\t\t\t\t\telse agent.followup(message);',
    `\t\t\t\t\truntime?.stampPrompt(agent, message, receipt);
\t\t\t\t\tif (request.mode === "steer") agent.steer(message);
\t\t\t\t\telse agent.followup(message);`, 'stamp exact message immediately before native queue insertion');

  replace('return this.commands.updateQueue(request);',
    'return this.commands.updateQueue(request, this.ctx);', 'keep invocation context for queue changes');
  replace('\tasync updateQueue(request) {\n\t\tif (request.action.kind === "edit") {',
    '\tasync updateQueue(request, controllerCtx) {\n\t\tif (request.action.kind === "edit") {', 'carry queue caller into the command');
  replace('\t\t\tcase "edit":\n\t\t\t\tagent.inbox.replace(request.itemId, freezeMessage({\n\t\t\t\t\t...message,\n\t\t\t\t\tcontent: [...request.action.content]\n\t\t\t\t}));\n\t\t\t\tbreak;',
    `\t\t\tcase "edit": {
\t\t\t\tconst updated = freezeMessage({ ...message, content: [...request.action.content] });
\t\t\t\tconst runtime = controllerCtx.get('agyTurnRuntime', false);
\t\t\t\tif (agent.model.current()?.provider !== '${EXTERNAL}') agent.inbox.replace(request.itemId, updated);
\t\t\t\telse try {
\t\t\t\t\tif (!runtime?.replaceQueued(agent, message, updated, controllerCtx)) throw new Error();
\t\t\t\t} catch {
\t\t\t\t\tthrow new RemoteError('session/agent-busy', 'This queued Antigravity message cannot be edited from this request.', {});
\t\t\t\t}
\t\t\t\tbreak;
\t\t\t}`, 'require a new local witness before editing an ACP occurrence');
  replace('\t\t\t\tagent.inbox.remove(request.itemId);\n\t\t\t\tagent.steer(message);',
    `\t\t\t\ttry {
\t\t\t\t\tconst runtime = controllerCtx.get('agyTurnRuntime', false);
\t\t\t\t\tif (runtime === undefined && agent.model.current()?.provider === '${EXTERNAL}') throw new Error();
\t\t\t\t\truntime?.permitSend(agent, message, 'next-step', true);
\t\t\t\t} catch {
\t\t\t\t\tthrow new RemoteError('session/steer-unavailable', 'The current turn does not accept steering.', { itemId: request.itemId });
\t\t\t\t}
\t\t\t\tagent.inbox.remove(request.itemId);
\t\t\t\tagent.steer(message);`, 'keep the queued item when external steering is refused');

  replace('return this.commands.cancel(request);',
    'return this.commands.cancel(request, this.ctx);', 'keep invocation context for Stop');
  replace('\tcancel(request) {\n\t\tconst agent = this.ctx.agents.get(request.sessionId);',
    '\tcancel(request, controllerCtx) {\n\t\tconst agent = this.ctx.agents.get(request.sessionId);', 'carry Stop caller into the command');
  replace('\t\tagent.cancel({ kind: "user" }, { keepInbox: true });',
    `\t\ttry {
\t\t\tcontrollerCtx.get('agyTurnRuntime', false)?.authorizeCancel(agent, controllerCtx);
\t\t} catch {
\t\t\tthrow new RemoteError('session/agent-busy', 'Use this local DSH window to stop the active Antigravity turn.', {});
\t\t}
\t\tagent.cancel({ kind: "user" }, { keepInbox: true });`, 'authorize Stop on the active external turn');
  return code;
}

function patchControllerContract(code) {
  const anchor = "    'session/modelCatalog': {\n      service: 'sessionController',\n      description: 'Describe every currently routable model for Host-generation selectors.',\n      invocation: { kind: 'direct' },\n      parameters: [\n      ],";
  const parameters = `
        {
          name: 'request',
          source: 'json',
          acceptsUndefined: true,
          codec: {
            mode: 'strict',
            typeSymbol: 'fixture#ConversationModelCatalogRequest',
            create: () => z.strictObject({ audience: z.literal('conversation'), sessionId: z.string().min(1) }),
            jsonSchema: { type: 'object', properties: { audience: { const: 'conversation' }, sessionId: { type: 'string', minLength: 1 } },
              required: ['audience', 'sessionId'], additionalProperties: false },
          },
          get strictCodec() { return this.codec; },
        },`;
  return replaceOnce(code, anchor, anchor.replace('\n      ],', `${parameters}\n      ],`), 'scoped catalog input codec');
}

/** Load isolated classes from the installed rc.5 artifacts, without altering normal modules. */
export async function loadTurnRuntimeFixture(anchorDir) {
  if (typeof anchorDir !== 'string' || !isAbsolute(anchorDir)) throw new TypeError('An absolute installed DSH anchor is required');
  const [loop, controller, contract] = await Promise.all([
    loadPinned(anchorDir, 'dsh-agent-loop'),
    loadPinned(anchorDir, 'dsh-api-session-controller'),
    loadPinned(anchorDir, 'dsh-api-session-controller', CONTROLLER_CONTRACT_HASH, 'lib/typert.host.js'),
  ]);
  const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const loopUrl = dataUrl(patchLoop(loop.source));
  const controllerUrl = dataUrl(patchController(controller.source, controller.manifestPath));
  const contractUrl = dataUrl(patchControllerContract(contract.source));
  const parents = new Map([[loopUrl, loop], [controllerUrl, controller], [contractUrl, contract]]
    .map(([url, entry]) => [url, pathToFileURL(entry.bundle).href]));
  // These data: modules have no directory. Rebase only their own dependency
  // imports on the original installed bundle; leave ordinary imports untouched.
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const parentURL = parents.get(context.parentURL);
      return next(specifier, parentURL === undefined ? context : { ...context, parentURL });
    },
  });
  try {
    const [{ AgentLoop }, { SessionController }, { TYPERT }] = await Promise.all([
      import(loopUrl), import(controllerUrl), import(contractUrl),
    ]);
    if (typeof AgentLoop !== 'function' || typeof SessionController !== 'function' || !TYPERT) {
      throw new Error('Pinned turn fixture exports are unavailable');
    }
    return { AgentLoop, SessionController, TYPERT };
  } finally {
    hook.deregister();
  }
}
