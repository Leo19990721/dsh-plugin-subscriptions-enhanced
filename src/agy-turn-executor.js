import { Buffer } from 'node:buffer';
import { AgyAcpErrorCode } from './agy-acp-client.js';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';
import { isAgySessionId } from './agy-session.js';
import { agyContextText, projectAgyContext } from './agy-turn-context.js';

export const AGY_TURN_EXECUTOR_PROVIDER = 'turn:antigravity';
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_QUEUED = 8;
const MAX_ADMISSION_EVENTS = 128;
const STOP_OUTCOME = new Map([
  ['end_turn', ['completed', 'completed']], ['refusal', ['completed', 'completed']],
  ['max_tokens', ['max-tokens', 'max-tokens']], ['max_turn_requests', ['max-tokens', 'max-tokens']],
  ['cancelled', ['cancelled', 'aborted']],
]);
// A failed reap fences even a replacement registration in the same Host.
const unreapedHosts = new WeakSet();
const problem = (code, message) => Object.assign(new Error(message), { code });
const notAllowed = () => problem('agy/local-only', 'Antigravity requires an authorized action in this workspace.');
const badPrompt = () => problem('agy/prompt-unavailable', 'Antigravity accepts a directly submitted text prompt as a new turn.');
const busy = () => problem('agy/turn-busy', 'Antigravity cannot accept more queued work right now.');
const pendingOutcome = () => problem('agy/outcome-unknown', 'The previous Antigravity turn is unconfirmed. It was not sent again.');
const bindingUnavailable = () => problem('agy/binding-unavailable', 'The Antigravity session binding could not be verified.');
const missingModel = () => problem('agy/model-unavailable', 'The selected Antigravity model is unavailable.');
const cleanupUnconfirmed = () => problem('agy/cleanup-unconfirmed', 'Could not confirm that the Antigravity process stopped.');
const validSeq = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const safeSelector = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(value);

function strictTrue(result) {
  // Reject an accidentally async policy, including a later rejection.
  if (result instanceof Promise) void result.catch(() => {});
  return result === true;
}

function promptText(content) {
  if (!Array.isArray(content) || !content.length || content.length > 64) throw badPrompt();
  const chunks = [];
  let bytes = content.length - 1;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') throw badPrompt();
    bytes += Buffer.byteLength(block.text);
    if (bytes > MAX_PROMPT_BYTES) throw badPrompt();
    chunks.push(block.text);
  }
  const text = chunks.join('\n');
  if (!text.trim()) throw badPrompt();
  return text;
}

function humanText(message) {
  const source = message?.source;
  if (message?.role !== 'user' || typeof message.id !== 'string' || !message.id
    || source?.kind !== 'user' || (source.principal !== undefined && source.principal?.kind !== 'owner')) throw badPrompt();
  return promptText(message.content);
}

function eligible(agent) {
  const session = agent?.session;
  const header = session?.header;
  if (!header || typeof agent.id !== 'string' || !agent.id || header.id !== agent.id
    || header.origin !== undefined || header.parentSession !== undefined || header.isSeeded !== false
    || (header.delegationDepth !== undefined && header.delegationDepth !== 0)
    || !isLocalAgyPath(header.cwd) || !validSeq(header.createdAt)) throw notAllowed();
  return session;
}

function sameBinding(row, base) {
  return row?.createdAt === base.createdAt && row.cwd === base.cwd && row.officialId === base.officialId
    && row.throughSeq === base.throughSeq && row.stopReason === base.stopReason;
}

function isPending(row, state) {
  return state.pending !== undefined && sameBinding(row, state.base) && row.pending?.turn === state.turn;
}

function asFailure(code, message) { return { kind: 'error', error: { code, message } }; }

function publicFailure(error, { sent, fenced, aborted }) {
  if (sent || error?.code === 'agy/outcome-unknown') {
    return asFailure('TURN_OUTCOME_UNKNOWN', 'The Antigravity turn ended without a confirmed result. It was not retried.');
  }
  if (fenced || error?.code === 'agy/binding-unavailable') return asFailure('AGY_BINDING_UNAVAILABLE', bindingUnavailable().message);
  if (aborted) return asFailure('AGY_STOPPED_BEFORE_SEND', 'The Antigravity prompt was stopped before it was sent.');
  if (error?.code === AgyAcpErrorCode.AUTH_REQUIRED || error?.code === 'auth-required') {
    return asFailure('AGY_LOGIN_REQUIRED', 'Antigravity requires sign-in before it can accept a prompt.');
  }
  if (error?.code === 'context-too-large') return asFailure('AGY_CONTEXT_TOO_LARGE', 'The earlier conversation exceeds the Antigravity handoff limit.');
  if (['model-unavailable', 'reasoning-effort-unavailable', 'agy/model-unavailable'].includes(error?.code)) {
    return asFailure('AGY_MODEL_UNAVAILABLE', missingModel().message);
  }
  return asFailure('AGY_TURN_UNAVAILABLE', 'Antigravity could not start this turn; no automatic retry was made.');
}

/**
 * Register the Host-only executor from the consuming plugin's Cordis fiber. The
 * native loop owns queue tickets, Session events, Stop, and both checkpoints.
 *
 * @param {object} owner - Context passed to the consuming Host plugin's apply.
 * @param {object} config - Explicit opt-in and trusted Host capabilities.
 * @param {true} config.enabled - Required opt-in; nothing is mounted by default.
 * @param {Function} config.authorize - Synchronously authorize the native admission (strict true).
 * @param {Function} config.verifyWorkspace - Revalidate and return the canonical workspace cwd, possibly asynchronously.
 * @param {Function} config.assertAuthority - Synchronously revalidate `(agent, selection, message)` (strict true).
 * @param {Function} config.makeSession - Construct the owned AgyTurnSession for `{ cwd }`, with `beforeDispatch` authorization and exact `onDispatch` write marking.
 * @param {object} config.ledger - Exclusive durable binding ledger, with synchronous read and awaited write.
 * @param {Function} config.readEvents - Read the exact Session's stored range `(session, from, toExclusive, signal)` after the core checkpoint. It may omit an unflushed suffix added after admission.
 * @param {boolean} [config.includeDshHistory=false] - Synthetic test opt-in to include earlier DSH messages in the ACP prompt.
 * @param {object} [config.options] - Trusted parsed ACP model options; no provider discovery is performed.
 * @param {string} [config.defaultEffort] - Independently verified default for the snapshot's current model.
 * @returns {object} Static conversation catalog, provider preflight, active-turn check and draining disposer.
 */
export function mountAgyTurnExecutor(owner, {
  enabled, authorize, verifyWorkspace, assertAuthority, makeSession, ledger, readEvents, options, defaultEffort,
  includeDshHistory = false,
} = {}) {
  if (enabled !== true) throw problem('agy/turn-disabled', 'Antigravity native turn execution requires explicit opt-in.');
  let loop;
  try { loop = owner?.agentLoop; }
  catch { /* Cordis can throw on an unavailable required service. */ }
  if (typeof loop?.registerTurnExecutor !== 'function') {
    throw problem('agy/native-turn-required', 'This Host does not support native turn executor registration.');
  }
  const root = owner.root;
  if (!root || !owner.fiber || owner.fiber === root.fiber || typeof owner.effect !== 'function') {
    throw problem('agy/plugin-owner-required', 'Antigravity must be registered by its Host plugin fiber.');
  }
  if ([authorize, verifyWorkspace, assertAuthority, makeSession, ledger?.read, ledger?.write, readEvents]
    .some(fn => typeof fn !== 'function')) throw new TypeError('Antigravity turn capabilities are incomplete.');

  const reasoning = options?.thoughtLevel?.options.some(choice => choice.value === defaultEffort)
    ? Object.freeze({ defaultEffort, efforts: Object.freeze(options.thoughtLevel.options.map(({ value, name }) => Object.freeze({ id: value, name }))) })
    : undefined;
  const modelWithDefault = options?.model.currentValue;
  const catalogGroup = options && Object.freeze({
    id: AGY_TURN_EXECUTOR_PROVIDER, name: 'Antigravity', input: 'text-only', models: Object.freeze(
      options.model.options.map(({ value, name }) => Object.freeze({ id: value, name,
        ...(reasoning && value === modelWithDefault ? { reasoning } : {}) })),
    ),
  });
  const fenced = new Set();
  let claimed, active, revoked = false;

  function canSelect(selection) {
    if (selection?.provider !== AGY_TURN_EXECUTOR_PROVIDER || !safeSelector(selection.model)
      || (catalogGroup && !catalogGroup.models.some(model => model.id === selection.model))
      || (selection.reasoningEffort !== undefined && (!safeSelector(selection.reasoningEffort)
        || (catalogGroup && (selection.model !== modelWithDefault
          || !reasoning?.efforts.some(item => item.id === selection.reasoningEffort)))))) throw missingModel();
  }

  function currentClaim() {
    if (claimed && (claimed.agent.session !== claimed.session
      || claimed.agent.activeTurnProvider !== AGY_TURN_EXECUTOR_PROVIDER)) claimed = undefined;
    return claimed;
  }

  function available() {
    if (revoked) throw notAllowed();
    if (unreapedHosts.has(root)) throw cleanupUnconfirmed();
  }

  function readStored(id) {
    try { return ledger.read(id); }
    catch { throw bindingUnavailable(); }
  }

  function readBinding(agent, session, mayQueue) {
    if (fenced.has(agent.id)) throw pendingOutcome();
    const row = readStored(agent.id);
    if (row === undefined) return undefined;
    if (row?.createdAt !== session.header.createdAt || row.cwd !== session.header.cwd || !isAgySessionId(row.officialId)
      || (row.throughSeq !== -1 && (!validSeq(row.throughSeq) || row.throughSeq >= session.seq))
      || (row.throughSeq === -1 ? row.stopReason !== undefined : !STOP_OUTCOME.has(row.stopReason))) throw bindingUnavailable();
    if (row.pending !== null && (!mayQueue || active?.agent !== agent || active.session !== session
      || active.failed || !isPending(row, active))) throw pendingOutcome();
    return row;
  }

  function admissionStart({ session, admissionSeq, turn }) {
    if (!validSeq(admissionSeq) || typeof session.eventAt !== 'function') throw bindingUnavailable();
    // Session.eventAt locates the boundary in the live log; the stored read below proves it.
    const first = Math.max(0, admissionSeq - MAX_ADMISSION_EVENTS);
    for (let seq = admissionSeq - 1; seq >= first; seq--) {
      const event = session.eventAt(seq);
      if (event?.seq !== seq || event.type === 'turn/end') break;
      if (event.type === 'turn/start') {
        if (event.data?.turn === turn) return seq;
        break;
      }
    }
    throw bindingUnavailable();
  }

  async function readStoredRange({ session, input: { signal } }, from, to) {
    let events;
    try { events = await readEvents(session, from, to, signal); }
    catch {
      signal.throwIfAborted();
      throw bindingUnavailable();
    }
    signal.throwIfAborted();
    if (!Array.isArray(events) || events.length > to - from) throw bindingUnavailable();
    return events;
  }

  function verifyBindingEnd(event, binding) {
    if (event?.seq !== binding.throughSeq || event.type !== 'turn/end'
      || event.data?.reason?.kind !== STOP_OUTCOME.get(binding.stopReason)[1]) throw bindingUnavailable();
  }

  async function verifyAdmission(state, binding, message, text) {
    const afterSeq = binding?.throughSeq ?? -1;
    const handoff = includeDshHistory === true;
    const from = handoff ? Math.max(0, afterSeq) : admissionStart(state);
    if (!handoff) {
      if (from <= afterSeq) throw bindingUnavailable();
      if (afterSeq >= 0) {
        const [anchor] = await readStoredRange(state, afterSeq, afterSeq + 1);
        verifyBindingEnd(anchor, binding);
      }
    }
    const events = await readStoredRange(state, from, state.admissionSeq);
    if (handoff && afterSeq >= 0) verifyBindingEnd(events[0], binding);
    if (!handoff && (events[0]?.type !== 'turn/start' || events[0].data?.turn !== state.turn)) throw bindingUnavailable();

    let currentStart, accepted;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event?.seq !== from + i) throw bindingUnavailable();
      if (event.type === 'turn/start') currentStart = event.data?.turn === state.turn ? i : undefined;
      if (currentStart !== undefined && event.type === 'turn/end') throw bindingUnavailable();
      if (currentStart !== undefined && event.type === 'user/message') {
        if (event.surfaceOp !== 'append' || event.data?.id !== message.id || humanText(event.data) !== text) throw bindingUnavailable();
        accepted = event.seq;
        break;
      }
    }
    // A caller can enqueue new items immediately after the checkpoint. The stored prefix need only cover the current prompt.
    if (accepted === undefined) throw bindingUnavailable();
    state.acceptedSeq = accepted;
    return handoff ? agyContextText(projectAgyContext(events.slice(0, currentStart), { afterSeq }).rows) : undefined;
  }

  function preflight(agent, session, phase) {
    available();
    const reserved = currentClaim();
    if ((active && (active.agent !== agent || active.session !== session || phase === 'claim'))
      || (reserved && reserved.agent !== agent)) throw busy();
    if (phase === 'enqueue' && (agent.inbox.nextStep.length !== 0
      || agent.inbox.nextTurn.length >= (agent.status === 'idle' ? MAX_QUEUED : MAX_QUEUED - 1))) throw busy();
    readBinding(agent, session, phase !== 'claim');
  }

  function requireAuthority(input, state) {
    input.signal.throwIfAborted();
    available();
    if (active !== state || eligible(input.agent) !== state.session
      || !strictTrue(assertAuthority(input.agent, input.selection, input.message))) throw notAllowed();
    input.assertDispatchable();
  }

  async function rollbackUnsent(state) {
    if (!state.pending || state.sent) return;
    // A rejected write can have published the mark. Restore only our exact
    // pending row; leave mismatches and ambiguous durability fenced.
    if (state.agent.session !== state.session || !isPending(ledger.read(state.id), state)) throw bindingUnavailable();
    await ledger.write(state.id, state.base);
    const row = ledger.read(state.id);
    if (!sameBinding(row, state.base) || row.pending !== null) throw bindingUnavailable();
  }

  const executor = Object.freeze({
    authorize(input) {
      try {
        const { agent, selection, message, previous, phase } = input;
        const session = eligible(agent);
        canSelect(selection);
        humanText(message);
        if (phase === 'edit') {
          humanText(previous);
          if (previous.id !== message.id) return false;
        } else if (phase !== 'claim' && phase !== 'enqueue') return false;
        if (!strictTrue(authorize(input))) return false;
        preflight(agent, session, phase);
        // New native loops expose the pinned provider through the checkpoint.
        // Reserve across Agent checkpoints without issuing our own queue tickets.
        if (phase === 'claim' && agent.activeTurnProvider === AGY_TURN_EXECUTOR_PROVIDER) claimed = { agent, session };
        return true;
      } catch {
        return false;
      }
    },

    async run(input) {
      const { agent, message, selection, signal, turn } = input;
      let state;
      try {
        available();
        const session = eligible(agent);
        const reserved = currentClaim();
        if (active || (reserved && reserved.agent !== agent)) throw busy();
        if (!validSeq(turn) || turn === 0) throw badPrompt();
        const text = humanText(message);
        canSelect(selection);
        claimed = undefined;
        state = active = { input, agent, id: agent.id, session, turn, admissionSeq: session.seq, acceptingText: true };
        requireAuthority(input, state);
        const base = readBinding(agent, session, false);
        const contextText = await verifyAdmission(state, base, message, text);
        requireAuthority(input, state);
        const cwd = await verifyWorkspace(agent, selection);
        if (!isLocalAgyPath(cwd) || !sameAgyPath(cwd, session.header.cwd)) throw notAllowed();
        requireAuthority(input, state);
        const cli = state.cli = await makeSession({ cwd });
        requireAuthority(input, state);
        await cli.open(base?.officialId);
        requireAuthority(input, state);
        const officialId = cli.id;
        if (!isAgySessionId(officialId) || (base && base.officialId !== officialId)) throw bindingUnavailable();
        state.base = base ?? Object.freeze({ createdAt: session.header.createdAt, cwd: session.header.cwd,
          officialId, throughSeq: -1, pending: null });
        if (!base) {
          if (ledger.read(state.id) !== undefined) throw bindingUnavailable();
          await ledger.write(state.id, state.base);
          requireAuthority(input, state);
        }
        const effective = selection.reasoningEffort === undefined && selection.model === modelWithDefault && reasoning
          ? { ...selection, reasoningEffort: reasoning.defaultEffort } : selection;
        await cli.prepare(effective, signal);
        requireAuthority(input, state);
        const row = ledger.read(state.id);
        if (!sameBinding(row, state.base) || row.pending !== null) throw bindingUnavailable();
        state.pending = Object.freeze({ ...state.base, pending: Object.freeze({ turn }) });
        await ledger.write(state.id, state.pending);

        signal.throwIfAborted();
        const recheckedCwd = await verifyWorkspace(agent, selection);
        if (!isLocalAgyPath(recheckedCwd) || !sameAgyPath(cwd, recheckedCwd)) throw notAllowed();
        const result = await cli.runTurn(text, { contextText, signal,
          onDelta(fragment) {
            if (active === state && state.sent && state.acceptingText && typeof fragment === 'string' && fragment !== '') {
              input.writeText(fragment);
            }
          },
          beforeDispatch() {
            if (state.sent || !state.acceptingText || cli.id !== officialId || !isPending(ledger.read(state.id), state)) throw bindingUnavailable();
            requireAuthority(input, state);
            signal.throwIfAborted();
            available();
          },
          onDispatch() { state.sent = true; },
        });
        if (!state.sent) throw badPrompt();
        const outcome = STOP_OUTCOME.get(result?.stopReason);
        if (!outcome) throw pendingOutcome();
        state.stopReason = result.stopReason;
        return { kind: outcome[0] };
      } catch (error) {
        if (state) {
          state.failed = true;
          state.acceptingText = false;
          if (state.sent) fenced.add(state.id);
          else {
            try { await rollbackUnsent(state); }
            catch { fenced.add(state.id); }
          }
        }
        return publicFailure(error, { sent: state?.sent, fenced: state && fenced.has(state.id), aborted: signal.aborted });
      } finally {
        if (state) state.acceptingText = false;
      }
    },

    async afterCommit(input, end) {
      const state = active;
      if (!state || state.input !== input || !state.stopReason || state.committing || state.releasing) return;
      if (state.agent.session !== state.session || end?.type !== 'turn/end' || end.data?.turn !== state.turn
        || end.data.reason?.kind !== STOP_OUTCOME.get(state.stopReason)[1]
        || !validSeq(end.seq) || end.seq <= state.acceptedSeq || end.seq >= state.session.seq) throw bindingUnavailable();
      state.committing = true;
      try {
        if (!isPending(ledger.read(state.id), state)) throw bindingUnavailable();
        await ledger.write(state.id, { ...state.base, throughSeq: end.seq, pending: null, stopReason: state.stopReason });
      } catch {
        fenced.add(state.id);
        throw bindingUnavailable();
      }
    },

    async release(input) {
      const state = active;
      if (!state || state.input !== input) return;
      state.releasing ??= (async () => {
        try { await state.cli?.close(); }
        catch {
          unreapedHosts.add(root);
          throw cleanupUnconfirmed();
        } finally {
          if (active === state) active = undefined;
        }
      })();
      await state.releasing;
    },
  });

  const withdraw = owner.effect(() => {
    const unregister = loop.registerTurnExecutor(AGY_TURN_EXECUTOR_PROVIDER, executor);
    return async () => {
      // The native effect owns cancellation and waits for exact job cleanup.
      revoked = true;
      claimed = undefined;
      await unregister();
    };
  }, 'Antigravity native turn executor');
  let disposing;

  return Object.freeze({
    get catalogGroup() { return !revoked && !unreapedHosts.has(root) ? catalogGroup : undefined; },
    isActive: agent => agent != null && (agent.activeTurnProvider === AGY_TURN_EXECUTOR_PROVIDER || active?.agent === agent),
    checkPrompt(agent, selection, content, previous) {
      const session = eligible(agent);
      canSelect(selection);
      promptText(content);
      if (previous !== undefined) humanText(previous);
      preflight(agent, session, previous === undefined ? 'enqueue' : 'edit');
      return true;
    },
    dispose: () => disposing ??= Promise.resolve(withdraw()),
  });
}
