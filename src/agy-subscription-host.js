import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAgentLoopRequest, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { AGY_LOOPBACK } from './agy-ingress.js';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';
import { observeAgySubscriptionRequests } from './agy-subscription-ingress.js';
import { openAgySubscriptionReceipts } from './agy-subscription-ledger.js';
import { AGY_SUBSCRIPTION_PROVIDER as PROVIDER, agySubscriptionModels, isAgySubscriptionModel } from './agy-subscription-models.js';

const MAX_QUEUE = 16;
const MAX_ADMISSION_EVENTS = 128;
const NO_RETRY = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Google subscription');
const sameSelection = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort;
const isGoogle = selection => selection?.provider === PROVIDER;
const failure = (code, message) => new LlmError(message, code);
const unavailable = () => failure('AGY_INPUT_UNAVAILABLE', '谷歌订阅只接收当前 DSH 窗口发出的纯文本。请移除附件或会话引用后发送。');
const queueConflict = () => failure('AGY_QUEUE_ROUTE_CHANGED', '请先处理待发消息，再切换谷歌订阅。');
const running = () => failure('AGY_TURN_RUNNING', '请等当前回复结束，再切换谷歌订阅。');
const busy = () => failure('AGY_BUSY', '官方 Google Antigravity 正有操作在运行，请等它结束后再发。');
const noModel = () => failure('AGY_MODEL_UNAVAILABLE', '官方 Google Antigravity 未提供所选模型或思考档位，请在模型设置中检查。');
const unknown = () => failure('AGY_OUTCOME_UNKNOWN', '官方 Google Antigravity 未确认本轮结果，DSH 没有重发。');
const inside = (dir, entry) => {
  const rel = path.relative(dir, entry);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

function safeError(error, sent = false) {
  if (error instanceof LlmError && error.code.startsWith('AGY_')) return error;
  if (sent) return unknown();
  switch (error?.code) {
    case -32000:
    case 'auth-required': return failure('AGY_LOGIN_REQUIRED', '请先在 Google 官方 Antigravity CLI 登录，再回到 DSH。');
    case 'model-unavailable':
    case 'reasoning-effort-unavailable': return noModel();
    case 'missing-cli':
    case 'unsupported-cli':
    case 'unverified-cli':
    case 'cli-version-mismatch': return failure('AGY_CLI_UNAVAILABLE', '未找到已验证的 Google Antigravity CLI，请在模型设置中检查。');
    case 'cli-busy': return busy();
    case 'cleanup-unconfirmed': return failure('AGY_CLEANUP_UNCONFIRMED', '未能确认官方 Google Antigravity 已退出，后续发送已暂停。');
    default: return failure('AGY_REQUEST_UNAVAILABLE', '官方 Google Antigravity 暂时无法处理这条消息，DSH 没有重发。');
  }
}

/** Mount ordinary provider identity; execution needs matching native HTTP input and one live stock-loop request. */
export async function mountAgySubscription(ctx, { cli, blockedPaths = [] }) {
  const lifetime = new AbortController();
  const active = new Set();
  const queue = new WeakMap(); // Session -> exact committed input, indexed by native message ID.
  const claimed = new Map(); // Agent -> exact occurrence and owning turn, from claim until settlement.
  const candidates = new WeakMap();
  const steps = new WeakMap(); // live Agent -> exact open step, never restored from the log.
  const streams = new AsyncLocalStorage();
  const receipts = await openAgySubscriptionReceipts(ctx.storageDomain);
  const ingress = observeAgySubscriptionRequests(ctx);
  const protectedPaths = [...blockedPaths, ...(cli.blockedPaths ?? [])].filter(isLocalAgyPath);
  let options, status = 'unchecked', inspecting, closing, queueOwner;

  function updateCatalog(nextOptions, nextStatus) {
    const before = agySubscriptionModels(options).map(item => item.id);
    options = nextOptions;
    status = nextStatus;
    if (!lifetime.signal.aborted && !isDeepStrictEqual(before, agySubscriptionModels(options).map(item => item.id))) {
      try { ctx.emit('llm/models-updated', PROVIDER); }
      catch (_error) { /* A catalog observer cannot revoke or grant a turn. */ }
    }
  }

  function freeQueueOwner(agent) {
    if (queueOwner === agent && !queue.get(agent.session)?.size && !claimed.has(agent)) queueOwner = undefined;
  }

  function queueOf(session) {
    let messages = queue.get(session);
    if (!messages) { messages = new Map(); queue.set(session, messages); }
    return messages;
  }

  function workspaceOf(agent) {
    if (lifetime.signal.aborted || ctx.connection.allowsRemoteAuthorities !== false || !AGY_LOOPBACK.test(ctx.webServer.host ?? '')
      || !agent || ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session) return;
    const session = agent.session;
    const { header } = session;
    const cwd = header.cwd;
    const effective = ctx.get('workingDirectory')?.get(session);
    if (header.id !== agent.id || header.origin !== undefined || header.parentSession !== undefined
      || header.isSeeded !== false || (header.delegationDepth ?? 0) !== 0 || session.inheritedEventCount !== 0
      || !isLocalAgyPath(cwd) || !isLocalAgyPath(effective) || !sameAgyPath(cwd, effective)
      || sameAgyPath(cwd, path.parse(cwd).root) || ctx.workspaceRegistry.archivedSessionIds.includes(agent.id)
      || protectedPaths.some(item => inside(item, cwd) || inside(cwd, item))) return;
    const workspace = ctx.workspaceRegistry.list().find(item => sameAgyPath(item.path, cwd) && item.sessionIds.includes(agent.id));
    if (!workspace) return;
    try {
      if (!sameAgyPath(realpathSync.native(cwd), cwd)) return;
      const info = lstatSync(cwd, { bigint: true });
      if (!info.isDirectory()) return;
      return { id: workspace.id, cwd, dev: info.dev, ino: info.ino, born: info.birthtimeNs };
    } catch (_error) { /* Missing, replaced, or inaccessible directories authorize nothing. */ }
  }

  function authority(agent, evidence, selection) {
    return evidence !== undefined && evidence.agent === agent && sameSelection(evidence.selection, selection)
      && evidence.peer === ctx.connection.browserPeer && !evidence.peer.signal.aborted
      && isDeepStrictEqual(evidence.workspace, workspaceOf(agent));
  }

  // In rc.5, Session calls this synchronous dispatch collection after validating
  // a candidate but before log.push. Throw here so the stock RPC rejects without
  // admitting the draft. Only the matching committed event publishes evidence.
  const offBefore = ctx.on('internal/dispatch', (mode, eventName, args) => {
    if (mode !== 'emit' || eventName !== 'session/event') return;
    const [session, event] = args;
    if (event?.type !== 'agent/inbox/spliced' && event?.type !== 'model/selection') return;
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session !== session) return;
    const selection = agent.model.current();
    if (event.type === 'model/selection') {
      if ((isGoogle(selection) || isGoogle(event.data)) && !sameSelection(selection, event.data)) {
        if (agent.inbox.hasPending) throw queueConflict();
        if (agent.status !== 'idle') throw running();
      }
      return;
    }
    const { target, start, removedCount = 0, inserted, outcome } = event.data;
    if (inserted.some(message => ingress.changedPromptRoute(agent, selection, message, PROVIDER))) throw queueConflict();
    const current = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
    const removed = current.slice(start, start + removedCount);
    // Stock queue steering removes the earlier occurrence before it inserts
    // the replacement. Refuse unsupported steering while the row still exists.
    if (isGoogle(selection) && outcome === 'canceled' && inserted.length === 0
      && removed.some(message => ingress.isQueueSteer(session, message))) throw unavailable();
    let admitted;
    if (isGoogle(selection) && inserted.length !== 0) {
      const message = inserted[0];
      const previous = removed.length === 1 && outcome === 'canceled' ? removed[0] : undefined;
      const prior = previous === undefined ? undefined : queue.get(session)?.get(previous.id);
      if (!isAgySubscriptionModel(selection) || !agySubscriptionModels(options).some(model => model.id === selection.model)) throw noModel();
      if ((queueOwner && queueOwner !== agent) || inspecting) throw busy();
      if (lifetime.signal.aborted || target !== 'next-turn' || inserted.length !== 1 || removedCount > 1
        || (previous !== undefined && (!authority(agent, prior, selection) || !isDeepStrictEqual(previous, prior.message)))
        || (previous === undefined && (removedCount !== 0 || start !== current.length))) throw unavailable();
      const workspace = workspaceOf(agent);
      if (!workspace) throw unavailable();
      if (agent.inbox.nextStep.length !== 0 || (previous === undefined && current.length >= MAX_QUEUE)
        || current.some(item => !authority(agent, queue.get(session)?.get(item.id), selection))) throw queueConflict();
      const proof = ingress.take({ agent, selection, inserted: message, previous, target });
      if (!proof) throw unavailable();
      admitted = Object.freeze({ ...proof, agent, selection: Object.freeze({ ...selection }), workspace, message, insertedSeq: event.seq });
    }
    if (admitted || (queue.has(session) && (inserted.length > 0 || (outcome !== undefined && removed.length !== 0)))) {
      candidates.set(event, { admitted, removed: outcome === undefined ? [] : removed });
    }
  }, { prepend: true });

  const offEvent = ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    const candidate = candidates.get(event);
    if (candidate) {
      candidates.delete(event);
      const messages = queueOf(session);
      for (const message of candidate.removed) messages.delete(message.id);
      for (const message of event.data.inserted) messages.delete(message.id);
      if (candidate.admitted) {
        messages.set(candidate.admitted.message.id, candidate.admitted);
        queueOwner = candidate.admitted.agent;
      }
      if (agent?.session === session) freeQueueOwner(agent);
    }
    if (agent?.session !== session) return;
    if ((event.type === 'step/end' || event.type === 'turn/end') && steps.get(agent)?.turn === event.data.turn) steps.delete(agent);
    if (event.type === 'turn/end') {
      const pending = claimed.get(agent);
      if (pending?.turn === event.data.turn) {
        queue.get(session)?.delete(pending.id);
        claimed.delete(agent);
      }
      freeQueueOwner(agent);
    }
  }, { prepend: true });

  const offClaim = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const proof = queue.get(agent.session)?.get(message.id);
    if (proof?.agent === agent && isDeepStrictEqual(message, proof.message)) claimed.set(agent, { id: message.id, turn });
  }, { prepend: true });

  const offAgent = ctx.on('agent/disposed', ({ agent }) => {
    claimed.delete(agent);
    queue.delete(agent.session);
    if (queueOwner === agent) queueOwner = undefined;
  });

  const offStep = ctx.on('agent/pre-step', ({ agent, messages, turn, step, signal, modelSelection }, next) => {
    const scoped = queue.get(agent.session);
    const proofs = messages.map(message => scoped?.get(message.id));
    for (const message of messages) scoped?.delete(message.id);
    if (!isGoogle(modelSelection)) {
      if (proofs.some(Boolean)) throw queueConflict();
      return next();
    }
    if (step > 1 && messages.length === 0) return { kind: 'enter', messages: [] };
    const [proof] = proofs;
    const { openTurnStartSeq, lastTurn } = ctx.agents.turnBoundaryOf(agent.session);
    const pending = claimed.get(agent);
    if (step !== 1 || signal.aborted || messages.length !== 1 || pending?.turn !== turn || pending.id !== messages[0].id
      || !authority(agent, proof, modelSelection) || !isDeepStrictEqual(proof.message, messages[0]) || openTurnStartSeq === null || lastTurn !== turn
      || proof.insertedSeq >= openTurnStartSeq) throw unavailable();
    const queuedEvent = agent.session.eventAt(proof.insertedSeq);
    if (queuedEvent?.type !== 'agent/inbox/spliced' || !isDeepStrictEqual(queuedEvent.data.inserted[0], proof.message)) throw unavailable();
    steps.set(agent, { ...proof, turn, openTurnStartSeq, signal, offered: false, used: false });
    return next();
  }, { prepend: true });

  function dispatchable(ticket) {
    const { agent, signal, selection, openTurnStartSeq, turn, accepted } = ticket;
    if (signal.aborted || ctx.agents.currentInitiator() !== agent || steps.get(agent) !== ticket || !authority(agent, ticket, selection)) return false;
    const { session } = agent;
    const boundary = ctx.agents.turnBoundaryOf(session);
    const step = session.eventAt(boundary.lastStepStartSeq);
    return boundary.openTurnStartSeq === openTurnStartSeq && boundary.lastStepBoundary?.kind === 'start'
      && step?.type === 'step/start' && step.seq > openTurnStartSeq && step.data.turn === turn && step.data.step === 1
      && (!accepted || session.eventAt(accepted.seq) === accepted);
  }

  const offStream = ctx.on('llm/stream', (request, next) => {
    if (request.provider !== PROVIDER || request.purpose !== undefined || !isAgentLoopRequest(request)) return next();
    const agent = ctx.agents.currentInitiator();
    const ticket = agent && steps.get(agent);
    if (!ticket || ticket.offered || request.sessionId !== agent.id || request.signal !== ticket.signal
      || !sameSelection(ticket.selection, request) || !dispatchable(ticket)) return next();
    const session = agent.session;
    const start = ctx.agents.turnBoundaryOf(session).lastStepStartSeq;
    const end = session.seq;
    if (end - start > MAX_ADMISSION_EVENTS) return next();
    let accepted;
    for (let seq = start + 1; seq < end; seq++) {
      const event = session.eventAt(seq);
      if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue;
      if (accepted || event.surfaceOp !== 'append' || !isDeepStrictEqual(event.data, ticket.message)) return next();
      accepted = event;
    }
    if (!accepted) return next();
    ticket.offered = true;
    ticket.accepted = accepted;
    return (async function* () {
      const iterator = streams.run(ticket, () => next()[Symbol.asyncIterator]());
      try {
        for (;;) {
          const item = await streams.run(ticket, () => iterator.next());
          if (item.done) return;
          yield item.value;
        }
      } finally { await streams.run(ticket, () => iterator.return?.()); }
    })();
  }, { global: true, prepend: true });

  async function turn(ticket, signal, publish) {
    const { agent, text, selection, message } = ticket;
    let session, reserved, sent = false, result, problem;
    try {
      if (!dispatchable(ticket)) throw unavailable();
      if (!await ctx.sessions.flush(agent.session)) throw unavailable();
      signal.throwIfAborted();
      if (!dispatchable(ticket)) throw unavailable();
      session = await cli.makeSession({ signal });
      signal.throwIfAborted();
      await session.open();
      if (!dispatchable(ticket)) throw unavailable();
      const observed = session.options;
      const models = agySubscriptionModels(observed);
      updateCatalog(observed, models.length ? 'ready' : 'no-models');
      if (!models.some(model => model.id === selection.model)) throw noModel();
      await session.prepare(selection, signal);
      if (!dispatchable(ticket)) throw unavailable();
      signal.throwIfAborted();
      reserved = await receipts.reserve({ sessionId: agent.id, createdAt: agent.session.header.createdAt,
        messageId: message.id, requestId: message.source.rpcId });
      if (!reserved) throw unknown();
      result = await session.runTurn(text, {
        signal,
        onDelta: fragment => { if (sent && !signal.aborted) publish(fragment); },
        beforeDispatch() {
          signal.throwIfAborted();
          if (sent || !dispatchable(ticket) || !reserved.verify()) throw unavailable();
        },
        onDispatch() { sent = true; },
      });
      if (!sent) throw unavailable();
      if (!['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(result?.stopReason)) throw unknown();
      await reserved.settle();
    } catch (error) {
      problem = safeError(error, sent);
      if (problem.code === 'AGY_LOGIN_REQUIRED' || problem.code === 'AGY_CLI_UNAVAILABLE') {
        updateCatalog(undefined, problem.code === 'AGY_LOGIN_REQUIRED' ? 'signed-out' : 'missing-cli');
      } else if (['unsafe-storage', 'cleanup-unconfirmed'].includes(error?.code)) {
        updateCatalog(undefined, 'unavailable');
      }
    } finally {
      try { await session?.close(); }
      catch (_error) { problem ??= safeError({ code: 'cleanup-unconfirmed' }, sent); updateCatalog(undefined, 'unavailable'); }
      if (reserved && !sent) {
        try { await reserved.releaseUnsent(); }
        catch (_error) { problem = unknown(); }
      }
    }
    if (problem) throw problem;
    return result;
  }

  class GoogleSubscriptionAdapter extends LlmAdapter {
    providerInfo(id) { return { id, name: 'Google Antigravity' }; }
    providerRetryPolicy() { return NO_RETRY; }
    async listModels() { return agySubscriptionModels(options); }
    async resolveModel(provider, id, signal) {
      signal?.throwIfAborted();
      const model = agySubscriptionModels(options).find(model => model.id === id);
      if (provider !== PROVIDER || !model) throw noModel();
      return model;
    }
    async *stream(request) {
      const ticket = streams.getStore();
      if (!ticket?.offered || ticket.used || request.purpose !== undefined || request.signal !== ticket.signal
        || request.sessionId !== ticket.agent.id || !sameSelection(ticket.selection, request) || !dispatchable(ticket)) throw unavailable();
      ticket.used = true;
      const consumer = new AbortController();
      const signal = AbortSignal.any([ticket.signal, consumer.signal, lifetime.signal]);
      let buffer = '', text = '', result, problem, done;
      let notice = Promise.withResolvers();
      const wake = () => { const previous = notice; notice = Promise.withResolvers(); previous.resolve(); };
      const operation = turn(ticket, signal, fragment => { buffer += fragment; wake(); }).then(
        value => { result = value; }, error => { problem = error; },
      ).finally(() => { done = true; wake(); active.delete(operation); });
      active.add(operation);
      try {
        while (!done || buffer !== '') {
          signal.throwIfAborted();
          if (!buffer) { await notice.promise; continue; }
          const fragment = buffer;
          buffer = '';
          if (!text) yield { type: 'block-start', index: 0, blockType: 'text' };
          text += fragment;
          yield { type: 'text-delta', index: 0, text: fragment };
        }
        signal.throwIfAborted();
        if (problem) throw problem;
        if (result.stopReason === 'refusal' && !text) throw failure('AGY_REFUSED', '官方 Google Antigravity 没有回答这条消息。');
        if (result.stopReason === 'cancelled') throw failure('AGY_CANCELLED', '官方 Google Antigravity 已停止回复。');
        if (!text) throw failure('AGY_EMPTY_RESPONSE', '官方 Google Antigravity 没有返回正文，DSH 没有重发。');
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: ['max_tokens', 'max_turn_requests'].includes(result.stopReason) ? 'max-tokens' : 'stop' } };
      } finally {
        consumer.abort();
        await operation;
      }
    }
  }

  function getStatus() { return { status, modelCount: agySubscriptionModels(options).length }; }
  function inspect(signal) {
    if (lifetime.signal.aborted || signal?.aborted) return getStatus();
    if (inspecting) return inspecting;
    if (queueOwner) return { ...getStatus(), status: 'busy' };
    const probeSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    inspecting = Promise.resolve().then(async () => {
      try {
        const observed = await cli.probe(probeSignal);
        probeSignal.throwIfAborted();
        updateCatalog(observed, agySubscriptionModels(observed).length ? 'ready' : 'no-models');
      } catch (error) {
        if (!probeSignal.aborted) {
          const code = safeError(error).code;
          if (code !== 'AGY_BUSY') updateCatalog(undefined,
            code === 'AGY_LOGIN_REQUIRED' ? 'signed-out' : code === 'AGY_CLI_UNAVAILABLE' ? 'missing-cli' : 'unavailable');
        }
      }
      return getStatus();
    }).finally(() => { inspecting = undefined; });
    return inspecting;
  }

  function close() {
    if (closing) return closing;
    const latch = Promise.withResolvers();
    closing = latch.promise;
    lifetime.abort();
    // Start cancellation before the registry unregisters the adapter. A turn
    // may have claimed input but be waiting in working-directory/prompt assembly.
    // This only controls a clean detach; a persisted V4 queue survives a crash.
    const affected = new Set(), waitFor = [];
    let cleanupFailed = false;
    for (const agent of ctx.agents.list()) {
      const session = agent.session;
      if (claimed.has(agent)) {
        affected.add(session);
        try { agent.cancel({ kind: 'disposed' }, { keepInbox: true }); }
        catch (_error) { cleanupFailed = true; }
        waitFor.push(Promise.resolve().then(() => agent.whenIdle()));
      }
      const known = queue.get(session);
      if (!known?.size) continue;
      for (const item of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
        if (!known.has(item.id)) continue;
        affected.add(session);
        try { if (!agent.inbox.remove(item.id)) cleanupFailed = true; }
        catch (_error) { cleanupFailed = true; }
      }
    }
    void (async () => {
      const cleanup = await Promise.allSettled([Promise.resolve().then(() => cli.dispose?.()), inspecting, ...active, ...waitFor]);
      const checkpoints = await Promise.allSettled([...affected].map(async session => ctx.sessions.flush(session)));
      await receipts.close();
      if (cleanupFailed || cleanup.some(item => item.status === 'rejected')
        || checkpoints.some(item => item.status !== 'fulfilled' || item.value !== true)) throw safeError({ code: 'cleanup-unconfirmed' });
    })().then(latch.resolve, latch.reject);
    return closing;
  }

  ctx.effect(() => () => close(), 'Google subscription transport lifecycle');
  try { ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new GoogleSubscriptionAdapter())); }
  catch (error) {
    await Promise.allSettled([ingress.off(), offBefore(), offEvent(), offClaim(), offAgent(), offStep(), offStream(), close()]);
    throw error;
  }
  return Object.freeze({ getStatus, inspect, close });
}
