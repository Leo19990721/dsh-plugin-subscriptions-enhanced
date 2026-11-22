import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { isAgyBrowserRequest } from './agy-ingress.js';
import { hasAgyNativeTurnHost } from './agy-compatibility.js';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';
import { AGY_NATIVE_PRESET } from './agy-identity.js';
import { AGY_TURN_EXECUTOR_PROVIDER, mountAgyTurnExecutor } from './agy-turn-executor.js';

const provider = AGY_TURN_EXECUTOR_PROVIDER;
const routes = new Map([
  ['/api/session/modelCatalog', 'modelCatalog'], ['/api/session/selectModel', 'selectModel'],
  ['/api/session/prompt', 'prompt'], ['/api/session/cancel', 'cancel'], ['/api/session/updateQueue', 'updateQueue'],
]);
const unavailable = () => new RemoteError('session/agent-busy', 'Antigravity is unavailable for this action in this window.', { reason: 'LOCAL_TURN_UNAVAILABLE' });
const missingModel = selection => new RemoteError('session/model-unavailable', 'The selected Antigravity model is unavailable.', {
  provider, model: selection.model,
});
const localHost = ctx => /^(?:::1|127(?:\.\d{1,3}){3})$/iu.test(ctx.webServer.host ?? '')
  && ctx.connection.allowsRemoteAuthorities === false;
const sameSelection = (a, b) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
const encloses = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function installIngress(ctx) {
  const storage = new AsyncLocalStorage();
  const dispose = ctx.on('connection/request', async (request, _response, next) => {
    const method = request.method === 'POST' ? routes.get(request.url) : undefined;
    if (method === undefined || !localHost(ctx) || !isAgyBrowserRequest(ctx, request, true)) return next();
    const witness = { method, peer: ctx.connection.browserPeer, live: true, used: false };
    try { return await storage.run(witness, next); }
    finally { witness.live = false; }
  });
  return {
    dispose,
    take(method, agent, invocation, check = () => true) {
      const witness = storage.getStore();
      // Gateway arguments are only checked for agreement. The authenticated
      // ingress and exact carrier Peer are both required before they are used.
      const request = invocation?.request.args?.request;
      if (!witness?.live || witness.used || witness.method !== method || !localHost(ctx)
        || invocation?.service !== 'sessionController' || invocation.request.namespace !== 'session'
        || invocation.request.method !== method || invocation.peer !== witness.peer
        || invocation.peer !== ctx.connection.browserPeer || invocation.peer.principal.kind !== 'owner'
        || invocation.peer.signal.aborted || invocation.signal.aborted || request?.sessionId !== agent.id || !check(request)) return;
      witness.used = true;
      return witness.peer;
    },
  };
}

/**
 * Reject an incompatible Host before sign-in or mounting any route. Passing
 * this check does not establish the Desktop carrier or Session compatibility.
 * @param {object} ctx - Context that owns the native Host services.
 * @throws If either required whole-turn registration method is absent.
 */
export function assertAgyNativeTurnHost(ctx) {
  if (!hasAgyNativeTurnHost(ctx)) {
    throw Object.assign(new Error('Antigravity requires native whole-turn execution and Session model routing.'), {
      code: 'native-turn-required',
    });
  }
}

/**
 * Attach the Antigravity consumer to the patched native Host. This is an
 * opt-in composition entry; the shipped status-only preview does not mount it.
 * The caller supplies a trusted catalog from an official clean-session snapshot
 * and a session factory rooted in a dedicated CLI environment.
 */
export function mountAgyNativeTurnHost(ctx, { options, defaultEffort, ledger, makeSession, blockedPaths = [], includeDshHistory = false }) {
  assertAgyNativeTurnHost(ctx);
  if (!options?.model?.options.length) throw new Error('Antigravity requires a verified native turn catalog.');
  const profile = ctx.get('profileContext');
  const protectedPaths = [profile?.dir, profile?.home, process.env.DSH_HOME, process.env.DSH_INSTALL_DIR, ...blockedPaths]
    .filter(isLocalAgyPath);
  const ingress = installIngress(ctx);
  const queued = new WeakMap();
  const claims = new WeakMap();
  let offer;
  let live = true;

  function attached(agent) {
    const { session } = agent;
    const header = session.header;
    return live && ctx.agents.get(agent.id) === agent && ctx.sessions.get(agent.id) === session
      && header.id === agent.id && header.origin === undefined && header.parentSession === undefined
      && header.isSeeded === false && (header.delegationDepth === undefined || header.delegationDepth === 0)
      && header.agentPreset !== AGY_NATIVE_PRESET;
  }

  function workspaceOf(agent) {
    const cwd = agent.session.header.cwd;
    if (!attached(agent) || ctx.agents.isSessionArchived(agent) || !isLocalAgyPath(cwd)
      || !sameAgyPath(ctx.workingDirectory.get(agent.session), cwd)
      || sameAgyPath(cwd, path.parse(cwd).root) || protectedPaths.some(blocked => encloses(cwd, blocked) || encloses(blocked, cwd))) return;
    return ctx.workspaceRegistry.list().find(candidate => sameAgyPath(candidate.path, cwd) && candidate.sessionIds.includes(agent.id));
  }

  function directory(cwd) {
    try {
      const canonical = realpathSync.native(cwd);
      if (!sameAgyPath(canonical, cwd)) return;
      const info = lstatSync(canonical, { bigint: true });
      if (info.isDirectory()) return { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs };
    } catch (_error) { /* an unreadable or removed directory grants no eligibility */ }
  }

  function matches(evidence, agent, selection, message) {
    return evidence !== undefined && evidence.agent === agent && evidence.session === agent.session
      && sameSelection(evidence.selection, selection) && isDeepStrictEqual(evidence.message, message)
      && evidence.peer === ctx.connection.browserPeer && !evidence.peer.signal.aborted && localHost(ctx)
      && workspaceOf(agent) === evidence.workspace;
  }

  function authorize({ phase, agent, selection, message, previous }) {
    if (phase === 'claim') {
      const evidence = queued.get(message)
        ?? (offer?.admitted && !offer.claimed && offer.previous !== message ? offer : undefined);
      if (agent.inbox.nextTurn[0] !== message || !matches(evidence, agent, selection, message)) return false;
      evidence.claimed = true;
      claims.set(agent, evidence);
      return true;
    }
    if (offer?.admitted || !matches(offer, agent, selection, message)
      || ((phase === 'enqueue' && offer.previous !== undefined) || (phase === 'edit' && offer.previous !== previous))) return false;
    offer.admitted = true;
    return true;
  }

  const executor = mountAgyTurnExecutor(ctx, {
    enabled: true, ledger, options, defaultEffort, makeSession, authorize, includeDshHistory,
    verifyWorkspace(agent) {
      const evidence = claims.get(agent);
      if (!evidence || !matches(evidence, agent, evidence.selection, evidence.message)
        || !isDeepStrictEqual(evidence.directory, directory(evidence.workspace.path))) throw unavailable();
      return evidence.workspace.path;
    },
    assertAuthority(agent, selection, message) {
      const evidence = claims.get(agent);
      return agent.activeTurnProvider === provider && matches(evidence, agent, selection, message)
        && isDeepStrictEqual(evidence.directory, directory(evidence.workspace.path));
    },
    async readEvents(session, from, to, signal) {
      const handle = await ctx.sessionPersistence.open(session.id, 'read', { signal });
      try {
        // JSONL fills the omitted root depth with zero when opening a handle.
        const normalized = header => ({ ...header, delegationDepth: header.delegationDepth ?? 0 });
        if (!isDeepStrictEqual(normalized(handle.header), normalized(session.header)) || handle.inheritedEventCount !== 0) throw unavailable();
        const snapshot = await handle.read(from, to - from, { signal });
        return snapshot.events;
      } finally { await handle.close(); }
    },
  });
  const unregister = ctx.sessionController.registerTurnProvider(provider, {
    catalog(agent, invocation) {
      if (!workspaceOf(agent) || !executor.catalogGroup || !ingress.take('modelCatalog', agent, invocation,
        request => request.audience === 'conversation')) return;
      return executor.catalogGroup;
    },
    select(agent, selection, invocation) {
      if (!workspaceOf(agent) || !ingress.take('selectModel', agent, invocation, request => sameSelection(request, selection))) return false;
      const model = executor.catalogGroup?.models.find(item => item.id === selection.model);
      if (!model || (selection.reasoningEffort !== undefined
        && !model.reasoning?.efforts.some(item => item.id === selection.reasoningEffort))) throw missingModel(selection);
      return true;
    },
    withInput(agent, selection, message, invocation, accept, previous) {
      const workspace = workspaceOf(agent);
      const peer = workspace && ingress.take(previous === undefined ? 'prompt' : 'updateQueue', agent, invocation, request => previous === undefined
        ? (request.mode === 'queue' || request.mode === 'steer') && request.serializedReferences !== true && request.requestId === message.source.rpcId
          && isDeepStrictEqual(request.content, message.content)
        : request.itemId === previous.id && request.action?.kind === 'edit' && isDeepStrictEqual(request.action.content, message.content));
      if (!peer || offer !== undefined || message.source.kind !== 'user' || message.source.principal !== undefined) throw unavailable();
      const cwd = directory(workspace.path);
      if (cwd === undefined || workspaceOf(agent) !== workspace) throw unavailable();
      const pending = agent.inbox.nextTurn;
      const index = previous === undefined ? pending.length : pending.indexOf(previous);
      if (index === -1) throw unavailable();
      const requiresEvidence = pending.slice(0, previous === undefined ? index : index + 1);
      if (requiresEvidence.some(item => {
        const evidence = queued.get(item);
        return !matches(evidence, agent, selection, item) || !isDeepStrictEqual(evidence.directory, cwd);
      })) throw new RemoteError('session/agent-busy', 'Remove the earlier queued message and send again. Your draft is kept.', {
        reason: 'LOCAL_TURN_QUEUE_NEEDS_AUTHORIZATION',
      });
      try { executor.checkPrompt(agent, selection, message.content, previous); }
      catch (error) {
        if (error?.code === 'agy/model-unavailable') throw missingModel(selection);
        if (typeof error?.code === 'string' && error.code.startsWith('agy/')) {
          throw new RemoteError('session/agent-busy', error.message, { reason: error.code });
        }
        throw unavailable();
      }
      const candidate = { agent, session: agent.session, selection: { ...selection }, message, previous, workspace, directory: cwd, peer };
      offer = candidate;
      try { accept(); }
      finally {
        offer = undefined;
        if (candidate.admitted && !candidate.claimed) {
          const inserted = agent.inbox.nextTurn.find(item => item !== previous && item.id === message.id);
          if (inserted !== undefined && isDeepStrictEqual(inserted, message)) queued.set(inserted, candidate);
        }
      }
    },
    control(agent, action, invocation) {
      // Stop/remove/leave are recovery operations; require the same window and
      // live agent even when the workspace has been removed or the ledger is fenced.
      if (!attached(agent)) return false;
      if (action === 'stop') return !!ingress.take('cancel', agent, invocation);
      if (action === 'remove') return !!ingress.take('updateQueue', agent, invocation, request => request.action?.kind === 'remove');
      if (action === 'leave') return !!ingress.take('selectModel', agent, invocation, request => request.provider !== provider);
      if (action === 'receipt') return !!ingress.take('prompt', agent, invocation,
        request => (request.mode === 'queue' || request.mode === 'steer') && request.serializedReferences !== true);
      return false;
    },
  });
  const dispose = ctx.effect(() => async () => {
    live = false;
    await Promise.all([ingress.dispose(), unregister(), executor.dispose()]);
  }, 'Antigravity native Host');
  return Object.freeze({ dispose });
}
