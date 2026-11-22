import { isAbsolute } from 'node:path';
import { isPromise } from 'node:util/types';
import { AGY_NATIVE_PRESET } from './agy-identity.js';

export { AGY_NATIVE_PRESET };
export const AGY_NATIVE_PREFIX = 'agy-native-';
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const SCOPE_PARENT = Object.freeze({});
const SOURCE = Object.freeze({ provider: AGY_NATIVE_PRESET, model: 'Gemini' });
const SURFACE = Object.freeze({ surfaceOp: 'append' });
const NO_MESSAGES = Object.freeze([]);
const NO_OPTIONS = Object.freeze({});
const FAILED = Object.freeze({ code: 'UNKNOWN', message: 'Gemini 未能完成此轮。' });
const UNCONFIRMED = Object.freeze({ code: 'UNKNOWN', message: '未收到 Gemini 此轮的最终状态。请重新打开官方会话，核对后再发送。' });
const ABORTED = Object.freeze({ code: 'ABORTED', message: 'Gemini 已停止此轮。' });
const USER_STOP = Object.freeze({ kind: 'user' });
const DISPOSE_STOP = Object.freeze({ kind: 'disposed' });
const STATUSES = new Set(['completed', 'interrupted', 'failed']);
const MAX_PROMPT_BYTES = 64 * 1024;

function unavailable(detail) {
  return Object.assign(new Error(`Gemini 原生会话不可用：${detail}`), { code: 'agy/native-unavailable' });
}

function checkNoProjectionCache(ctx) {
  // rc.5's shared cache checkpoints every announced Session, even without a
  // sessionPersistence writer. It has no per-Session exclusion API.
  if (ctx.get('sessionProjectionCache', false) !== undefined
    || ctx.root?.get('sessionProjectionCache', false) !== undefined) {
    throw unavailable('此 DSH Host 的共享会话投影缓存无法排除此会话。');
  }
}

function service(ctx, name, ...methods) {
  const value = ctx.get(name);
  if (methods.some(method => typeof value?.[method] !== 'function')) throw unavailable(`缺少 ${name} 原生接口。`);
  return value;
}

async function nativeSupport(ctx) {
  if (typeof ctx?.get !== 'function' || typeof ctx.effect !== 'function'
    || typeof ctx.events?.dispatch !== 'function') throw unavailable('缺少原生 Host 上下文。');
  checkNoProjectionCache(ctx);
  let llm, native, scope, protocol;
  try {
    [llm, native, scope, protocol] = await Promise.all([
      import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-agent'),
      import('@deepseek-ai/dsh-scope'), import('@deepseek-ai/dsh-typert-protocol'),
    ]);
    if ([llm.AssistantStreamAccumulator, llm.createAssistantMessage, llm.createUserMessage,
      native.agentEvents, scope.createScope, scope.scopeParentOf,
      protocol.RemoteError, protocol.remoteErrorOf].some(fn => typeof fn !== 'function')) throw new Error();
  } catch {
    throw unavailable('缺少原生消息流或会话隔离接口。');
  }
  const sessions = service(ctx, 'sessions', 'prepare', 'enter', 'announce', 'get');
  const agents = service(ctx, 'agents', 'enter', 'announce', 'get', 'withInitiator', 'turnBoundaryOf');
  const presets = service(ctx, 'agentPresets', 'resolve', 'presetForSession');
  const titles = service(ctx, 'sessionTitle', 'rename');
  service(ctx, 'sessionProjections', 'snapshot');
  service(ctx, 'sessionQuery', 'observeSession');
  service(ctx, 'sessionController', 'prompt', 'cancel', 'follow');
  const gateway = service(ctx, 'typertGateway', 'invoke', 'stream');
  const typert = ctx.get('typert');
  if (typeof gateway.wireStream?.open !== 'function' || typeof typert?.local?.get !== 'function') {
    throw unavailable('缺少原生 Gateway 消息接口。');
  }
  for (const method of ['prompt', 'cancel', 'follow']) {
    const descriptor = typert.local.get(`session/${method}`);
    if (descriptor?.service !== 'sessionController' || descriptor.mode !== (method === 'follow' ? 'stream' : undefined)
      || descriptor.parameters?.length !== 1 || descriptor.parameters[0]?.wire !== 'request'
      || descriptor.parameters[0].codec?.mode !== 'strict' || descriptor.result?.mode !== 'strict') {
      throw unavailable(`缺少原生 session/${method} 请求定义。`);
    }
  }
  try {
    await presets.resolve(AGY_NATIVE_PRESET);
  } catch (error) {
    if (protocol.remoteErrorOf(error)?.code !== 'agent-preset/not-found') {
      throw unavailable('无法验证 Gemini 会话的模式隔离。');
    }
    checkNoProjectionCache(ctx);
    return { llm, native, scope, protocol, sessions, agents, presets, titles };
  }
  throw unavailable('Gemini 的保留模式标识已被注册。');
}

/** Run before starting the backend; publishAgyAgent checks the same gates again. */
export async function assertAgyNativeSupport(ctx) {
  await nativeSupport(ctx);
}

function historyRows(history) {
  if (!Array.isArray(history)) throw new TypeError('Gemini history must be an array of terminal turn records');
  return Array.from(history, row => {
    const { prompt, status, text } = row ?? {};
    if (typeof prompt !== 'string' || prompt.trim() === '' || !STATUSES.has(status)
      || (text !== undefined && typeof text !== 'string')) throw new TypeError('Invalid Gemini turn record');
    return { prompt, status, text };
  });
}

function allows(authorize, input) {
  try {
    const allowed = authorize?.(input);
    // A misconfigured async authorizer does not grant admission or leak a
    // rejected Promise to the Host. Witness consumption must be synchronous.
    if (isPromise(allowed)) void allowed.catch(() => {});
    return allowed === true;
  } catch {
    return false;
  }
}

function openTurn(session, turn, message) {
  session.append([
    ['turn/start', { turn }],
    ['step/start', { turn, step: 1 }],
    ['user/message', message, SURFACE],
  ]);
}

function closeTurn(session, turn, status, failure, cause) {
  const reason = status === 'completed' ? { kind: 'completed' }
    : status === 'interrupted' ? { kind: 'aborted', reason: cause ?? { kind: 'legacy' } }
      : { kind: 'error', error: failure };
  session.append([
    ['step/end', { turn, step: 1 }],
    ['turn/end', { turn, reason }],
  ]);
}

/** Native assistant-stream attempt. The source on the log message is display provenance. */
function textAttempt(llm, session, turn, notify) {
  const stream = new llm.AssistantStreamAccumulator();
  const attemptId = `${session.id}:${turn}`;
  const position = { turn, step: 1 };
  let index = 0;
  let started = false;
  let ended = false;
  let hasBlock = false;
  let text = '';
  const emit = frame => notify?.({ ...frame, attemptId });
  function start() {
    if (started) return;
    started = true;
    emit({ type: 'start', ...position });
  }
  function push(chunk) {
    start();
    const timed = stream.push({ time: Date.now(), chunk });
    emit({ type: 'chunk', index: index++, ...timed });
  }
  function startBlock() {
    if (hasBlock) return;
    hasBlock = true;
    push({ type: 'block-start', index: 0, blockType: 'text' });
  }
  function delta(fragment) {
    if (fragment === '') return;
    startBlock();
    text += fragment;
    push({ type: 'text-delta', index: 0, text: fragment });
  }
  return {
    start,
    delta,
    finish(status, failure, finalText) {
      if (finalText !== undefined) {
        if (finalText.startsWith(text)) delta(finalText.slice(text.length));
        // Keep every emitted fragment in the stream. A terminal correction
        // replaces the open block once, when its authoritative text closes it.
        else text = finalText;
      }
      if (hasBlock) push({ type: 'block-end', index: 0, block: { type: 'text', text } });
      const reason = status === 'completed' ? { kind: 'stop' }
        : status === 'interrupted' ? { kind: 'aborted', failure: ABORTED } : { kind: 'error', failure };
      push({ type: 'finish', reason });
      const payload = { ...position, stream: stream.snapshot() };
      const event = text.length > 0 && status !== 'failed'
        ? session.append('assistant/message', {
          ...payload,
          message: llm.createAssistantMessage({ content: [{ type: 'text', text }], source: SOURCE }),
          ...(status === 'interrupted' ? { interrupted: true } : {}),
        }, SURFACE)
        : session.append('assistant/attempt', payload);
      ended = true;
      emit({ type: 'end', index, outcome: { kind: 'committed', eventType: event.type, seq: event.seq } });
    },
    abandon() {
      if (!started || ended) return;
      ended = true;
      emit({ type: 'end', index, outcome: { kind: 'abandoned' } });
    },
  };
}

function replay(llm, session, records) {
  for (const [index, record] of records.entries()) {
    const turn = index + 1;
    openTurn(session, turn, llm.createUserMessage({ content: [{ type: 'text', text: record.prompt }], source: { kind: 'user' } }));
    textAttempt(llm, session, turn).finish(record.status, FAILED, record.text);
    closeTurn(session, turn, record.status, FAILED);
  }
}

/**
 * Publish one live native Agent once the caller has initialized ACP and opened
 * or loaded its official Session. Only the caller owns that connection,
 * transcript, workspace selection, and Host request witness.
 *
 * authorizePrompt({ sessionId, message, text }) / optional
 * authorizeCancel({ sessionId, cause }) consume a one-use Host witness and
 * return literal true synchronously. RPC ids and cancel causes are metadata.
 *
 * runTurn(text, { signal, onDelta }) returns { status, text? } only after the
 * official turn settles; text, when present, is the entire final block. Abort
 * requests cancellation. Deltas remain live until the runner settles. Transport
 * failures or invalid results require reopening; this driver never auto-retries.
 */
export async function publishAgyAgent(ctx, {
  id, cwd, title = 'Gemini', history = [], authorizePrompt, authorizeCancel, runTurn,
}) {
  if (typeof id !== 'string' || id.length !== AGY_NATIVE_PREFIX.length + 36
    || !id.startsWith(AGY_NATIVE_PREFIX) || !UUID.test(id.slice(AGY_NATIVE_PREFIX.length))) {
    throw new TypeError('A namespaced agy-native UUID is required');
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof title !== 'string' || title.trim() === '') {
    throw new TypeError('The native Gemini Session requires an absolute working directory and a title');
  }
  if (typeof runTurn !== 'function' || typeof authorizePrompt !== 'function'
    || (authorizeCancel !== undefined && typeof authorizeCancel !== 'function')) {
    throw new TypeError('The native Gemini Session requires a runner and prompt authorizer');
  }
  const records = historyRows(history);
  const { llm, native, scope, protocol, sessions, agents, presets, titles } = await nativeSupport(ctx);
  checkNoProjectionCache(ctx);
  const { RemoteError } = protocol;
  const unsupported = () => {
    throw new RemoteError('session/agent-busy', 'Gemini 会话只接受从本机原生聊天框直接发送的文本，且每次只处理一轮。', {});
  };
  const inbox = Object.freeze({
    nextTurn: NO_MESSAGES, nextStep: NO_MESSAGES, clear() {},
    append: unsupported, prepend: unsupported, replace: () => false, remove: () => false,
    splice(_target, _start, _count, inserted) {
      if (inserted?.length) unsupported();
      return [];
    },
  });
  const model = Object.freeze({
    current: () => undefined,
    select() { throw new RemoteError('session/model-unavailable', 'Gemini 会话的模型由官方 Antigravity 管理。', {}); },
  });
  const session = sessions.prepare(id, { meta: { cwd, agentPreset: AGY_NATIVE_PRESET } });
  if (typeof session?.append !== 'function') throw unavailable('缺少原生 Session 日志接口。');
  const lifetime = new AbortController();
  let agentScope, dispatch, detachSession, detachAgent, announcement;
  let ready = false, admitting = false, active;
  let lastTurn = records.length, revision = 0;

  function stopActive(cause) {
    if (active === undefined || active.controller.signal.aborted) return;
    active.cause = cause;
    active.controller.abort(cause);
  }

  const agent = Object.freeze({
    id, session, model, inbox, options: NO_OPTIONS,
    get ctx() { return agentScope.ctx; },
    get status() { return active === undefined ? 'idle' : 'running'; },
    followup(message) {
      if (!ready || lifetime.signal.aborted || admitting || active !== undefined) unsupported();
      checkNoProjectionCache(ctx);
      const source = message?.source;
      if (message?.role !== 'user' || typeof message.id !== 'string' || message.id === ''
        || source?.kind !== 'user' || !Object.hasOwn(source, 'rpcId') || typeof source.rpcId !== 'string'
        || !source.rpcId || 'principal' in source || !Array.isArray(message.content) || message.content.length === 0) unsupported();
      let text = '';
      for (const part of message.content) {
        if (part?.type !== 'text' || typeof part.text !== 'string') unsupported();
        text += part.text;
      }
      if (text.trim() === '' || Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
        throw new RemoteError('gateway/bad-request', '请发送非空文本；单条消息不得超过 64 KiB（UTF-8）。', {});
      }
      admitting = true;
      try {
        if (!allows(authorizePrompt, { sessionId: id, message, text }) || !ready || lifetime.signal.aborted) unsupported();
        checkNoProjectionCache(ctx);
        const turn = lastTurn + 1;
        const running = { controller: new AbortController(), done: Promise.withResolvers(), cause: undefined };
        active = running;
        try {
          openTurn(session, turn, message);
        } catch (error) {
          active = undefined;
          running.done.resolve();
          throw error;
        }
        lastTurn = turn;
        void drive(turn, text, running).catch(() => {
          // A failed boundary append must not leave a second turn able to start.
          ready = false;
          ctx.logger.warn('Could not close the native Gemini turn.');
        }).finally(() => {
          active = undefined;
          running.done.resolve();
          try { dispatch.emit('agent/status', { status: 'idle' }); }
          catch { ctx.logger.warn('Could not publish the native Gemini idle status.'); }
        });
      } finally {
        admitting = false;
      }
    },
    send: unsupported, steer: unsupported, inject: unsupported, runMaintenance: unsupported,
    cancel(cause) {
      if (cause?.kind !== 'user' || !allows(authorizeCancel, { sessionId: id, cause: USER_STOP })) {
        throw new RemoteError('session/agent-busy', '请从本机原生聊天框停止 Gemini。', {});
      }
      stopActive(USER_STOP);
    },
    async whenIdle() { while (active !== undefined) await active.done.promise; },
  });

  async function drive(turn, prompt, running) {
    const signal = running.controller.signal;
    const attempt = textAttempt(llm, session, turn, frame => dispatch.emit('agent/assistant-stream', {
      frame: { ...frame, revision: ++revision },
    }));
    let open = true;
    let status = 'failed', failure = FAILED, finalText;
    try {
      dispatch.emit('agent/status', { status: 'running' });
      attempt.start();
      if (signal.aborted) {
        // A synchronous observer cancelled before the runner was invoked.
        status = 'interrupted';
      } else {
        const result = await agents.withInitiator(agent, () => runTurn(prompt, {
          signal,
          // ACP can continue to send text after session/cancel. The terminal
          // session/prompt response, not the Stop click, ends this attempt.
          onDelta(fragment) { if (open && typeof fragment === 'string') attempt.delta(fragment); },
        }));
        open = false;
        const { status: terminal, text } = result ?? {};
        if (!STATUSES.has(terminal) || (text !== undefined && typeof text !== 'string')) throw new Error();
        status = terminal;
        finalText = text;
      }
    } catch {
      failure = UNCONFIRMED;
      ready = false;
    } finally {
      open = false;
    }
    try {
      attempt.finish(status, failure, finalText);
    } catch {
      ready = false;
      status = 'failed';
      failure = FAILED;
      attempt.abandon();
      ctx.logger.warn('Could not publish Gemini output to the native Session.');
    } finally {
      closeTurn(session, turn, status, failure, running.cause);
    }
  }

  // One owner effect orders cancellation/drain, exact Agent removal, Session
  // removal, and then scope teardown. The private scope parent also prevents a
  // blank Agent from rebinding to an ordinary preset and losing the sentinel.
  const retired = Promise.withResolvers();
  const lifecycle = ctx.effect(function* () {
    yield () => retired.resolve();
    agentScope = scope.createScope(ctx, agent, { parent: SCOPE_PARENT });
    yield agentScope.rawDispose;
    yield () => detachSession?.();
    yield () => detachAgent?.();
    yield async () => {
      ready = false;
      lifetime.abort();
      stopActive(DISPOSE_STOP);
      await agent.whenIdle();
      try { await announcement; } catch { /* rollback detaches both entries */ }
    };
  }, 'subscriptions-enhanced: native Gemini session');
  let disposing;
  const dispose = () => disposing ??= Promise.all([lifecycle(), retired.promise]).then(() => undefined);
  try {
    if (scope.scopeParentOf(agent) !== SCOPE_PARENT || presets.presetForSession(session) !== AGY_NATIVE_PRESET) {
      throw unavailable('原生会话的模式隔离未生效。');
    }
    dispatch = native.agentEvents(agent.ctx, agent);
    const scopedSessions = service(agent.ctx, 'sessions', 'enter', 'announce');
    checkNoProjectionCache(ctx);
    detachSession = scopedSessions.enter(session);
    scopedSessions.announce(session);
    titles.rename(session, title);
    replay(llm, session, records);
    detachAgent = agents.enter(agent);
    announcement = agents.announce(agent, records.length === 0 ? 'startup' : 'resume', lifetime.signal);
    await announcement;
    lifetime.signal.throwIfAborted();
    if (agents.get(id) !== agent || sessions.get(id) !== session
      || presets.presetForSession(session) !== AGY_NATIVE_PRESET) throw unavailable('原生会话未完成发布。');
    ready = true;
    return { agent, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
