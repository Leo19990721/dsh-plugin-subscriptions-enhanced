import { AsyncLocalStorage } from 'node:async_hooks';
import { agyContextText, projectAgyContext } from './agy-turn-context.js';
import { isAgyBrowserRequest } from './agy-ingress.js';
import { isLocalAgyPath } from './agy-launch.js';
import { isAgySessionId } from './agy-session.js';
import { AGY_TURN_PROVIDER, isAgyTurnSelection as isExternal } from './agy-turn-input.js';

export { AGY_TURN_PROVIDER };
const SURFACE = Object.freeze({ surfaceOp: 'append' });
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_QUEUED = 8;
const STOP = new Set(['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal']);
const sameSelection = (left, right) => left?.provider === right?.provider && left?.model === right?.model
  && left?.reasoningEffort === right?.reasoningEffort;
const problem = (code, message) => Object.assign(new Error(message), { code });
const notAllowed = () => problem('agy/local-only', 'Antigravity requires a direct action in this local DSH window.');
const badPrompt = () => problem('agy/prompt-unavailable', 'Antigravity accepts a directly submitted text prompt as a new turn.');
const busy = () => problem('agy/turn-busy', 'Finish or remove the queued work before switching to Antigravity.');
const pendingOutcome = () => problem('agy/outcome-unknown', 'The previous Antigravity turn is unconfirmed. It was not sent again.');
const bindingUnavailable = () => problem('agy/binding-unavailable', 'The Antigravity session binding could not be verified.');
const missingModel = () => problem('agy/model-unavailable', 'The selected Antigravity model is unavailable.');
const noDurability = () => problem('agy/not-durable', 'Could not confirm the DSH conversation was saved.');
const EMPTY = Object.freeze({ kind: 'completed' });

function cancellation(signal) {
  const cause = signal.reason;
  if (['user', 'parent', 'disposed'].includes(cause?.kind)) return { kind: cause.kind };
  if (cause?.kind === 'hook' && typeof cause.reason === 'string') return { kind: 'hook', reason: cause.reason };
  return { kind: 'legacy' };
}

/** Only the exact authenticated local HTTP request may create a one-use witness. */
export function installAgyTurnWitness(ctx) {
  const storage = new AsyncLocalStorage();
  const routes = new Map([
    ['/api/session/modelCatalog', 'catalog'], ['/api/session/selectModel', 'select'],
    ['/api/session/prompt', 'prompt'], ['/api/session/cancel', 'cancel'],
    ['/api/session/updateQueue', 'editQueue'],
  ]);
  const dispose = ctx.on('connection/request', async (req, _res, next) => {
    const action = req.method === 'POST' ? routes.get(req.url) : undefined;
    if (action === undefined || !isAgyBrowserRequest(ctx, req)) return next();
    const witness = { action, live: true, used: false };
    try { return await storage.run(witness, next); }
    finally { witness.live = false; }
  });
  return Object.freeze({
    take(action, caller) {
      const witness = storage.getStore();
      const peer = caller?.invocation?.peer;
      const browser = ctx.connection.browserPeer;
      if (witness?.live !== true || witness.used || witness.action !== action || !peer?.id
        || peer.id !== browser?.id || peer.signal.aborted || browser.signal.aborted || caller.invocation.signal?.aborted) return false;
      witness.used = true;
      return true;
    },
    dispose,
  });
}

function promptText(content) {
  if (!Array.isArray(content) || content.length === 0 || content.length > 64
    || !content.every(part => part?.type === 'text' && typeof part.text === 'string')) throw badPrompt();
  const chunks = content.map(part => part.text);
  let bytes = chunks.length - 1;
  for (const text of chunks) {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_PROMPT_BYTES) throw badPrompt();
  }
  const text = chunks.join('\n');
  if (text.trim() === '') throw badPrompt();
  return text;
}

// This implementation deliberately has no installed-profile activation path.
// The amended Host contract and the official CLI policy must be validated first.
export function createAgyTurnRuntime({
  options, defaultEffort, authorize, makeSession, ledger, checkWorkspace, verifyWorkspace, snapshotEvents, flush,
  createAssistantMessage,
}) {
  const modelNames = new Map(options.model.options.map(({ value, name }) => [value, name]));
  // The caller must independently know the default for the snapshot's exact
  // current model. A loaded conversation's currentValue may be a past override.
  const reasoning = options.thoughtLevel?.options.some(choice => choice.value === defaultEffort)
    ? Object.freeze({ defaultEffort, efforts: Object.freeze(
      options.thoughtLevel.options.map(({ value, name }) => Object.freeze({ id: value, name })),
    ) }) : undefined;
  const group = Object.freeze({
    id: AGY_TURN_PROVIDER, name: 'Antigravity',
    models: Object.freeze(Array.from(modelNames, ([id, name]) => Object.freeze({
      id, name, ...(reasoning && id === options.model.currentValue ? { reasoning } : {}),
    }))),
  });
  const stamps = new WeakMap();
  const receipts = new WeakMap();
  const pending = new WeakMap();
  const active = new WeakMap();
  let owner;
  let unreaped = false;

  function eligible(agent) {
    const header = agent.session.header;
    if (header.origin !== undefined || header.parentSession !== undefined || header.isSeeded
      || !isLocalAgyPath(header.cwd) || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0
      || checkWorkspace(agent) !== true) throw notAllowed();
    return header;
  }

  function readBinding(agent, allowActive = false) {
    const header = eligible(agent);
    const row = ledger.read(agent.id);
    if (row === undefined) return undefined;
    if (row?.createdAt !== header.createdAt || row.cwd !== header.cwd || !isAgySessionId(row.officialId)
      || !Number.isSafeInteger(row.throughSeq) || row.throughSeq < -1 || row.throughSeq >= agent.session.seq) {
      throw bindingUnavailable();
    }
    if (row.pending !== null) {
      const current = allowActive ? active.get(agent) : undefined;
      if (!current?.marking || current.failed || !ownsPending(current, row)) throw pendingOutcome();
    }
    return row;
  }

  function sameBinding(row, base) {
    return row?.createdAt === base.createdAt && row.cwd === base.cwd && row.officialId === base.officialId
      && row.throughSeq === base.throughSeq && row.stopReason === base.stopReason;
  }

  function ownsPending(state, row) {
    return sameBinding(row, state.binding) && row.pending?.turn === state.turn;
  }

  function context(agent, binding) {
    const afterSeq = binding?.throughSeq ?? -1;
    if (afterSeq >= 0 && snapshotEvents(agent.session, afterSeq, afterSeq + 1)[0]?.type !== 'turn/end') {
      throw bindingUnavailable();
    }
    return agyContextText(projectAgyContext(snapshotEvents(agent.session, afterSeq + 1), { afterSeq }).rows);
  }

  function offersFor(agent) {
    const offers = pending.get(agent);
    if (!offers) return;
    const queued = new Set(agent.inbox.nextTurn.map(message => message.id));
    for (const id of offers.keys()) if (!queued.has(id)) offers.delete(id);
    return offers;
  }

  function matchesOffer(message, offer, selection) {
    if (!message || !offer || message.source.kind !== 'user' || message.source.rpcId !== offer.requestId
      || message.source.principal !== undefined || !sameSelection(selection, offer.selection)) return false;
    try { return promptText(message.content) === offer.text; }
    catch { return false; }
  }

  function queueRoom(agent, selection, wakesIdle) {
    const { nextTurn, nextStep } = agent.inbox;
    // Reserve one slot while work is active. After Stop, a new local Send
    // can wake the parked queue at the native idle boundary without evicting
    // an already accepted message. The head is claimed before the first await.
    const limit = wakesIdle ? MAX_QUEUED : MAX_QUEUED - 1;
    if (nextStep.length || nextTurn.length >= limit) throw busy();
    const offers = offersFor(agent);
    if (!nextTurn.every(message => matchesOffer(message, offers?.get(message.id), selection))) throw busy();
    return offers;
  }

  function canSelect(selection) {
    if (!isExternal(selection) || !modelNames.has(selection.model) || (selection.reasoningEffort !== undefined
      && (selection.model !== options.model.currentValue
        || !reasoning?.efforts.some(item => item.id === selection.reasoningEffort)))) throw missingModel();
  }

  function finishFor(stopReason) {
    if (stopReason === 'cancelled') return { kind: 'aborted', failure: { code: 'ABORTED', message: 'Antigravity stopped this turn.' } };
    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') return { kind: 'max-tokens' };
    return { kind: 'stop' };
  }

  function publicFailure(error, sent) {
    if (sent || error?.code === 'agy/outcome-unknown') return { code: 'AGY_TURN_UNCONFIRMED', message: pendingOutcome().message };
    if (error?.code === -32000 || error?.code === 'auth-required') {
      return { code: 'AGY_LOGIN_REQUIRED', message: 'Sign in using the official Antigravity CLI before sending again.' };
    }
    if (error?.code === 'context-too-large') return { code: 'AGY_CONTEXT_TOO_LARGE', message: 'The earlier conversation exceeds the Antigravity handoff limit.' };
    if (['model-unavailable', 'reasoning-effort-unavailable', 'agy/model-unavailable'].includes(error?.code)) {
      return { code: 'AGY_MODEL_UNAVAILABLE', message: missingModel().message };
    }
    return { code: 'AGY_TURN_UNAVAILABLE', message: 'Antigravity could not start this turn; no automatic retry was made.' };
  }

  async function checkpoint(session) {
    if (await flush(session) !== true) throw noDurability();
  }

  return Object.freeze({
    catalog(base, request, agent, caller) {
      if (request?.audience !== 'conversation' || !agent || agent.id !== request.sessionId
        || unreaped || base.groups.some(item => item.id === group.id) || !authorize('catalog', caller)) return base;
      try { eligible(agent); }
      catch { return base; }
      // The audience is a presentation switch; the one-use browser witness and
      // live ordinary Session are the actual eligibility check. In particular,
      // the unscoped Settings call stays identical to the stock LLM directory.
      return { ...base, groups: [...base.groups, group] };
    },
    async select(agent, selection, caller) {
      if (!authorize('select', caller)) throw notAllowed();
      if (unreaped) throw bindingUnavailable();
      eligible(agent);
      canSelect(selection);
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw busy();
      const cwd = await verifyWorkspace(agent);
      if (eligible(agent).cwd !== cwd) throw bindingUnavailable();
      if (unreaped) throw bindingUnavailable();
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw busy();
      agent.model.select(selection);
    },
    leave(agent, selection) {
      if (isExternal(selection)) throw missingModel();
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw busy();
      agent.model.select(selection);
    },
    checkPrompt(agent, request, caller) {
      const selection = agent.model.current();
      const receipt = Object.freeze({});
      if (!isExternal(selection)) {
        if (active.has(agent) && (request.mode !== 'queue' || request.content.length === 0)) throw badPrompt();
        receipts.set(receipt, { agent, external: false });
        return receipt;
      }
      if (!authorize('prompt', caller)) throw notAllowed();
      if (unreaped) throw bindingUnavailable();
      if (request.mode !== 'queue') throw badPrompt();
      if (owner && owner.agent !== agent) throw busy();
      const text = promptText(request.content);
      const binding = readBinding(agent, true);
      queueRoom(agent, selection, agent.status === 'idle');
      context(agent, binding); // preflight: an over-budget history keeps the native draft before acceptance.
      receipts.set(receipt, { agent, external: true, selection: Object.freeze({ ...selection }), text, requestId: request.requestId });
      return receipt;
    },
    stampPrompt(agent, message, receipt) {
      const value = receipts.get(receipt);
      receipts.delete(receipt);
      if (!value || value.agent !== agent) throw badPrompt();
      const current = agent.model.current();
      if (value.external !== isExternal(current)) throw badPrompt();
      if (!value.external) return;
      if (!matchesOffer(message, value, current)) throw badPrompt();
      stamps.set(message, value);
    },
    permitSend(agent, message, target, wakeup, wakesIdle = false) {
      const selected = agent.model.current();
      if (!isExternal(selected)) {
        if (active.has(agent) && target !== 'next-turn') throw badPrompt();
        return;
      }
      // A running DSH turn may still receive its own non-waking derived input.
      // The external claim below cannot consume any such input.
      if (!wakeup && target === 'next-step' && agent.status === 'running' && !active.has(agent)) return;
      const offer = stamps.get(message);
      stamps.delete(message);
      if (offer?.agent !== agent || target !== 'next-turn' || !wakeup || !matchesOffer(message, offer, selected)) throw badPrompt();
      if (unreaped) throw bindingUnavailable();
      if (owner && owner.agent !== agent) throw busy();
      readBinding(agent, true);
      const offers = queueRoom(agent, selected, wakesIdle) ?? new Map();
      offers.set(message.id, offer);
      pending.set(agent, offers);
    },
    replaceQueued(agent, previous, updated, caller) {
      const selected = agent.model.current();
      if (!isExternal(selected)) return agent.inbox.replace(previous.id, updated);
      if (!authorize('editQueue', caller)) throw notAllowed();
      eligible(agent);
      const offers = offersFor(agent);
      const original = offers?.get(previous.id);
      if (!matchesOffer(previous, original, selected) || updated.id !== previous.id) throw badPrompt();
      const revised = { ...original, text: promptText(updated.content) };
      if (!matchesOffer(updated, revised, selected)) throw badPrompt();
      // The native splice and its projection publication are synchronous. If
      // publication throws, revoke the ticket instead of guessing what landed.
      offers.set(previous.id, revised);
      try {
        if (agent.inbox.replace(previous.id, updated)) return true;
      } catch (error) {
        offers.delete(previous.id);
        throw error;
      }
      offers.delete(previous.id);
      return false;
    },
    authorizeCancel(agent, caller) {
      if (agent && active.has(agent) && !authorize('cancel', caller)) throw notAllowed();
    },
    async runNativeTurn({ agent, selection, turn, signal, claim, open, stream }) {
      if (agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0) return EMPTY;
      const offers = offersFor(agent);
      const head = agent.inbox.nextTurn[0];
      const offered = head && offers?.get(head.id);
      if (agent.inbox.nextStep.length || !matchesOffer(head, offered, selection)) {
        // A restored or non-browser item has no in-memory ticket. Keep it in
        // the ordinary queue for explicit removal; never dispatch or migrate it.
        return { kind: 'blocked' };
      }
      if (owner !== undefined || unreaped) return { kind: 'blocked' };
      let binding, history;
      try {
        binding = readBinding(agent);
        history = context(agent, binding);
        canSelect(selection);
      } catch (error) {
        // Admission may have succeeded while an earlier turn was still live.
        // Recheck before claiming or discarding any queued user input.
        return { kind: 'error', error: publicFailure(error, false) };
      }
      offers.delete(head.id);
      const messages = claim();
      if (messages.length !== 1 || messages[0].id !== head.id || !matchesOffer(messages[0], offered, selection)) return { kind: 'blocked' };
      const state = { turn, agent, session: undefined, sent: false, terminal: undefined };
      owner = state;
      active.set(agent, state);
      let live, text = '', hasText = false;
      function delta(fragment) {
        if (typeof fragment !== 'string' || fragment === '') return;
        if (!hasText) { live.push({ type: 'block-start', index: 0, blockType: 'text' }); hasText = true; }
        text += fragment;
        live.push({ type: 'text-delta', index: 0, text: fragment });
      }
      function settle(finish, visible, interrupted = false) {
        if (!live || live.ended) return;
        if (hasText) live.push({ type: 'block-end', index: 0, block: { type: 'text', text } });
        live.push({ type: 'finish', reason: finish });
        const record = { turn, step: 1, stream: live.stream };
        if (visible && hasText) {
          live.settle('assistant/message', () => agent.session.append('assistant/message', {
            ...record, ...(interrupted ? { interrupted: true } : {}),
            message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: selection.provider, model: selection.model } }),
          }, SURFACE).seq);
        } else live.settle('assistant/attempt', () => agent.session.append('assistant/attempt', record).seq);
      }
      try {
        open(messages[0]); // The native log contains the user's visible input, never the history envelope.
        const cwd = await verifyWorkspace(agent);
        const header = eligible(agent);
        if (cwd !== header.cwd) throw bindingUnavailable();
        signal.throwIfAborted();
        const cli = await makeSession({ cwd });
        state.session = cli;
        signal.throwIfAborted();
        eligible(agent);
        await cli.open(binding?.officialId);
        if (!isAgySessionId(cli.id) || (binding !== undefined && cli.id !== binding.officialId)) throw bindingUnavailable();
        const base = binding ?? { createdAt: header.createdAt, cwd, officialId: cli.id, throughSeq: -1, pending: null };
        if (!binding) await ledger.write(agent.id, base);
        signal.throwIfAborted();
        eligible(agent);
        const effective = selection.reasoningEffort === undefined && selection.model === options.model.currentValue && reasoning
          ? { ...selection, reasoningEffort: reasoning.defaultEffort }
          : selection;
        await cli.prepare(effective, signal);
        signal.throwIfAborted();
        await checkpoint(agent.session);
        signal.throwIfAborted();
        eligible(agent);
        state.binding = base;
        state.marking = true;
        await ledger.write(agent.id, { ...base, pending: { turn } });
        signal.throwIfAborted();
        live = stream();
        const result = await cli.runTurn(offered.text, {
          contextText: history, signal, onDelta: delta,
          beforeDispatch() {
            signal.throwIfAborted();
            if (eligible(agent).cwd !== cwd || owner !== state || active.get(agent) !== state
              || !ownsPending(state, ledger.read(agent.id))) throw bindingUnavailable();
          },
          onDispatch() { state.sent = true; },
        });
        if (!state.sent) {
          signal.throwIfAborted();
          throw problem('agy/turn-unavailable', 'Antigravity did not dispatch the prompt.');
        }
        if (!STOP.has(result?.stopReason)) throw pendingOutcome();
        const finish = finishFor(result.stopReason);
        settle(finish, true, result.stopReason === 'cancelled');
        state.terminal = result.stopReason;
        if (result.stopReason === 'cancelled') return { kind: 'aborted', reason: cancellation(signal) };
        return finish.kind === 'max-tokens' ? { kind: 'max-tokens' } : EMPTY;
      } catch (error) {
        state.failed = true;
        if (state.marking && !state.sent) {
          try {
            const row = ledger.read(agent.id);
            if (ownsPending(state, row)) await ledger.write(agent.id, state.binding);
            else if (!sameBinding(row, state.binding) || row.pending !== null) throw bindingUnavailable();
            state.marking = false;
          } catch { /* A removal with unknown durability must still fence the binding. */ }
        }
        if (signal.aborted && !state.sent && !state.marking) {
          settle(finishFor('cancelled'), false);
          return { kind: 'aborted', reason: cancellation(signal) };
        }
        const failure = publicFailure(error, state.sent || state.marking);
        const interrupted = state.sent && signal.aborted;
        // A stopped stream's visible prefix survives restart. The error and
        // pending record still distinguish this from a confirmed cancellation.
        settle({ kind: 'error', failure }, interrupted, interrupted);
        return { kind: 'error', error: failure };
      } finally {
        if (live && !live.ended) live.abandon();
      }
    },
    async commitTurn(agent, end) {
      const state = active.get(agent);
      if (!state?.terminal || end?.type !== 'turn/end' || end.data.turn !== state.turn) return;
      await checkpoint(agent.session);
      await ledger.write(agent.id, { ...state.binding, throughSeq: end.seq, pending: null, stopReason: state.terminal });
    },
    async releaseTurn(agent) {
      const state = active.get(agent);
      if (!state) return;
      try { await state.session?.close(); }
      catch { unreaped = true; }
      finally {
        if (owner === state) owner = undefined;
        active.delete(agent);
      }
    },
  });
}
