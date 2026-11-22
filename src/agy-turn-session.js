import { isPromise } from 'node:util/types';
import { AgySession, AgySessionError, isAgySessionId } from './agy-session.js';
import { configureAgyTurn, parseAgyTurnOptions } from './agy-turn-options.js';

const MAX_SETUP_IDS = 8;
const CANCELLED_PERMISSION = Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) });
const readAbortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const fail = code => new AgySessionError(code);
const sameSelector = (a, b) => a === b || Boolean(a && b && a.id === b.id && a.currentValue === b.currentValue
  && a.options.length === b.options.length && a.options.every((item, i) => item.value === b.options[i].value && item.name === b.options[i].name));
const sameSnapshot = (a, b) => a === b || Boolean(a && b && sameSelector(a.model, b.model) && sameSelector(a.thoughtLevel, b.thoughtLevel));

/**
 * One Host-owned ACP conversation. Storage and permission decisions live in the caller.
 * A successful prepare admits at most one prompt. Failed configuration fences
 * the wrapper; close and reopen the same official ID to refresh it.
 */
export function createAgyTurnSession({ cwd, makeClient, timeLimits, mcpServers, captureHistory, onPermission,
  configTimeoutMs = timeLimits?.open ?? 20_000, ignoreUnchangedConfigNotices = false }) {
  let session, transport, options, prepared, current, batch, closing;
  let poisoned = false, disconnected = false;
  const live = () => !poisoned && !disconnected && !closing;

  function invalidate() {
    options = undefined;
    prepared = undefined;
  }

  function poison() {
    poisoned = true;
    invalidate();
  }

  function begin(kind) {
    const op = { kind, done: Promise.withResolvers() };
    current = op;
    return op;
  }

  function end(op) {
    current = undefined;
    op.done.resolve();
  }

  function observe(params) {
    const update = own(params, 'update');
    if (!live() || own(update, 'sessionUpdate') !== 'config_option_update') return;
    const id = own(params, 'sessionId');
    if (!isAgySessionId(id)) return;
    if (batch) {
      if (batch.overflow || (batch.id !== undefined && id !== batch.id)) return;
      const previous = batch.notices.get(id);
      if (!previous && batch.notices.size >= MAX_SETUP_IDS) {
        batch.overflow = true;
        batch.notices.clear();
        return;
      }
      const snapshot = parseAgyTurnOptions(own(update, 'configOptions'));
      // agy 1.5.12 can deliver the last confirmed snapshot late, just as the
      // next setter is in flight. It is not a new configuration decision.
      if (!previous && !batch.setup && batch.ignoreUnchanged && sameSnapshot(snapshot, batch.before)) return;
      if (!previous) batch.notices.set(id, { snapshot, conflicts: false });
      else if (!sameSnapshot(previous.snapshot, snapshot)) previous.conflicts = true;
      return;
    }
    if (id !== (session?.id ?? current?.openedId)) return;
    const snapshot = parseAgyTurnOptions(own(update, 'configOptions'));
    if (sameSnapshot(options, snapshot)) return;
    options = snapshot;
    prepared = undefined;
    if (current?.kind === 'open' || current?.kind === 'prepare') current.conflicted = true;
  }

  async function configRequest(method, params, requestOptions, expectedId, setup = false) {
    if (!live() || batch || current?.conflicted) throw fail('config-unconfirmed');
    const pending = batch = { id: expectedId, notices: new Map(), overflow: false,
      setup, before: options, ignoreUnchanged: ignoreUnchangedConfigNotices };
    try {
      // Notifications from the same stdout read are delivered synchronously,
      // even those following a response, before this await resumes. A different
      // snapshot in that window makes the selected route ambiguous.
      const result = await transport.request(method, params, requestOptions);
      const reportedId = own(result, 'sessionId');
      const id = expectedId ?? reportedId;
      if (!record(result) || !isAgySessionId(id) || (reportedId !== undefined && reportedId !== id)) {
        throw fail(setup ? 'invalid-session' : 'config-unconfirmed');
      }
      const rawOptions = own(result, 'configOptions');
      const notice = pending.notices.get(id);
      const reported = parseAgyTurnOptions(rawOptions);
      // A setup response may omit the initial options. Every setter response
      // must carry the complete list; a matching notification cannot replace it.
      const hasReported = rawOptions !== undefined && rawOptions !== null;
      const conflicted = pending.overflow || notice?.conflicts
        || (notice && (hasReported || !setup) && !sameSnapshot(reported, notice.snapshot));
      if (setup) {
        // Let AgySession record the validated ID even when its configuration
        // is unusable. The Host can then close and recover that same session.
        current.openedId = id;
        if (conflicted) current.conflicted = true;
      } else if (conflicted) throw fail('config-unconfirmed');
      if (live() && !conflicted) options = setup && !hasReported && notice ? notice.snapshot : reported;
      return result;
    } finally {
      batch = undefined;
    }
  }

  // A response can arrive before the active turn's Promise continuation.
  const outsidePrompt = params => current?.kind === 'turn' && (!current.writing || current.terminalArrived)
    && own(params, 'sessionId') === session.id;

  session = new AgySession({ cwd, timeLimits, mcpServers, captureHistory, makeClient(hooks) {
    transport = makeClient({
      onUpdate(params) {
        observe(params);
        if (!outsidePrompt(params)) hooks.onUpdate(params);
      },
      onPermission(params) {
        const turn = current;
        if (turn?.kind !== 'turn' || !live() || !turn.writing || turn.terminalArrived || turn.signal.aborted
          || own(params, 'sessionId') !== session.id || !onPermission) return CANCELLED_PERMISSION;
        return onPermission(params, turn.signal);
      },
      onClosed(error) { disconnected = true; invalidate(); hooks.onClosed(error); },
    });
    return {
      start() {
        if (!live()) throw fail('closed');
        return transport.start();
      },
      async request(method, params, requestOptions) {
        if (method === 'session/close') return transport.request(method, params, requestOptions);
        if (!live()) throw fail('closed');
        if (method === 'session/new' || method === 'session/load') {
          return configRequest(method, params, requestOptions, params.sessionId, true);
        }
        const turn = current;
        if (method !== 'session/prompt' || turn?.kind !== 'turn' || turn.queued || params.sessionId !== session.id) {
          throw fail('turn-unavailable');
        }
        turn.queued = true;
        const { contextText, beforeDispatch, onDispatch, signal, snapshot } = turn;
        turn.contextText = undefined;
        turn.beforeDispatch = undefined;
        turn.onDispatch = undefined;
        const prompt = contextText === undefined ? params.prompt : [{ type: 'text', text: contextText }, ...params.prompt];
        const request = { sessionId: params.sessionId, prompt };
        const checkWrite = () => {
          if (!live() || current !== turn || turn.writing || readAbortState.call(signal)) throw fail('turn-unavailable');
          if (!sameSnapshot(snapshot, options)) throw fail('config-unconfirmed');
        };
        const result = await transport.request(method, request, {
          ...requestOptions,
          beforeWrite() {
            checkWrite();
            // Return a Promise unchanged so the transport can reject the write
            // and observe a later rejection without exposing it.
            const result = beforeDispatch?.();
            if (isPromise(result)) return result;
            if (typeof result?.then === 'function') throw fail('turn-unavailable');
            checkWrite(); // Also refuse a Stop or close triggered reentrantly by the guard.
          },
          onWriteStarted() {
            turn.writing = true;
            onDispatch?.();
          },
          onResponse() { turn.terminalArrived = true; },
        });
        const stopReason = own(result, 'stopReason');
        turn.stopReason = stopReason;
        turn.usage = own(result, 'usage');
        // AgySession remains the authority on valid stop reasons. Return the
        // same captured field it validates so callers see the exact reason.
        return { stopReason };
      },
      notify(method, params) {
        if (method === 'session/cancel' && outsidePrompt(params)) return Promise.resolve();
        return transport.notify(method, params);
      },
      close() { return transport.close(); },
    };
  } });

  return Object.freeze({
    get id() { return session.id; },
    get capabilities() { return session.capabilities; },
    get options() { return live() && session.usable && current?.kind !== 'open' ? options : undefined; },

    async open(officialId) {
      if (!live() || current || session.id !== undefined) throw fail('invalid-session');
      const op = begin('open');
      try {
        const opened = await session.open(officialId);
        if (!live() || !session.usable) throw fail('closed');
        if (op.conflicted) throw fail('config-unconfirmed');
        return opened;
      } catch (error) {
        poison();
        throw error;
      } finally { end(op); }
    },

    async prepare(selection, signal) {
      if (!live() || !session.usable || current) throw fail('turn-unavailable');
      const op = begin('prepare');
      prepared = undefined;
      try {
        const selected = await configureAgyTurn({ sessionId: session.id, options, selection, signal,
          send: params => configRequest('session/set_config_option', params, { timeoutMs: configTimeoutMs }, session.id),
        });
        if (!live() || !session.usable || op.conflicted || !sameSnapshot(selected, options)) throw fail('config-unconfirmed');
        prepared = options;
        return prepared;
      } catch (error) {
        poison();
        throw error;
      } finally { end(op); }
    },

    // beforeDispatch may deny the prompt. onDispatch only marks the write attempt.
    async runTurn(input, { contextText, signal, onDelta, onThought, onTool, beforeDispatch, onDispatch } = {}) {
      if (!live() || !session.usable || current || !prepared || prepared !== options) throw fail('turn-unavailable');
      if (!(typeof input === 'string' ? input.trim() !== '' : Array.isArray(input) && input.length > 0)
        || (contextText !== undefined && typeof contextText !== 'string')
        || typeof onDelta !== 'function' || [onThought, onTool, beforeDispatch, onDispatch].some(fn => fn !== undefined && typeof fn !== 'function')) {
        throw fail('turn-unavailable');
      }
      try { readAbortState.call(signal); }
      catch { throw fail('turn-unavailable'); }
      const turn = begin('turn');
      turn.snapshot = prepared;
      prepared = undefined;
      turn.contextText = contextText === '' ? undefined : contextText;
      turn.beforeDispatch = beforeDispatch;
      turn.onDispatch = onDispatch;
      turn.signal = signal;
      try {
        const result = await session.runTurn(input, { signal, onDelta, onThought, onTool, onUsage: value => { turn.contextUsage = { ...turn.contextUsage, ...value }; } });
        return {
          status: result.status, stopReason: turn.stopReason,
          ...(turn.usage ? { usage: turn.usage } : {}),
          ...(turn.contextUsage ? { contextUsage: turn.contextUsage } : {}),
        };
      } catch (error) {
        poison();
        throw error;
      } finally { end(turn); }
    },

    close() {
      if (closing) return closing;
      const running = current;
      invalidate();
      closing = Promise.resolve().then(async () => {
        // Keep AgySession's active-turn Stop handling. For a setup or setter,
        // first drain its bounded in-flight request and block any successor.
        if (running && running.kind !== 'turn') await running.done.promise;
        await session.close();
      });
      return closing;
    },
  });
}
