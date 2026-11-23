import { AsyncLocalStorage } from 'node:async_hooks';
import { stat } from 'node:fs/promises';
import { isAgyReadOnlyRefPath, matchesAgyReadOnlyRef, withinAgyWritableRoots } from './agy-local-storage.js';
import { LlmAdapter, LlmError, createUserMessage, resolveRetryPolicy, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { backgroundSummary, isBackgroundNotice, prepareLocalHistory, localPrompt, localSubmissions } from './agy-local-context.js';
import { backgroundEvent, backgroundWave, trackAgyTool } from './agy-local-background.js';
import { agyMcpTools, openAgyMcp } from './agy-local-mcp.js';
import { resolveAgyPresetPersona } from './agy-local-persona.js';
import { agyProgress, agyUsage } from './agy-local-progress.js';
import { createLocalAgy } from './agy-local-runtime.js';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';
import { WRITING_PRESET } from './writing-policy.js';

export const GOOGLE = 'antigravity';
const NO_RETRY = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Google subscription');
const DSH_CONTEXT_BUDGET = 1_000_000;
const CATALOG_RETRY_MS = 5_000;
const RESTRICTED_SILENCE_MS = 180_000;
const gemini = value => typeof value === 'string' && /^gemini-[a-z0-9][a-z0-9.-]*$/u.test(value)
  && !value.startsWith('gemini-pro-orchestrator');
const WRITING_PERSONA = '你是一名中文写作助手，帮助用户起草、修改和整理文字材料。';
const effortOrder = ['low', 'medium', 'high', 'xhigh'];
const effortNames = ['Low', 'Medium', 'High', 'Extra'];
const fallbackCounts = new Map([
  ['gemini-4-neon', 4], ['gemini-4-hydrogen', 4], ['gemini-4-argon', 3], ['gemini-3.8-flash', 3],
]);
const fallbackReasoning = id => fallbackCounts.has(id) ? {
  efforts: effortOrder.slice(0, fallbackCounts.get(id)).map((id, index) => ({ id, name: effortNames[index] })),
  defaultEffort: 'high',
} : undefined;
function reasoningOf(thoughtLevel) {
  if (!thoughtLevel?.options.length) return undefined;
  return {
    efforts: thoughtLevel.options.map(({ value, name }) => ({ id: value, name })),
    defaultEffort: thoughtLevel.currentValue,
  };
}
function compatibleEffort(requested, efforts = []) {
  if (requested === undefined || efforts.some(({ id }) => id === requested)) return requested;
  return effortOrder.findLast(id => efforts.some(effort => effort.id === id)) ?? efforts.at(-1)?.id;
}
const modelRow = (id, name, images, reasoning) => ({ provider: GOOGLE, id, name, inputModalities: images ? ['text', 'image'] : ['text'],
  context: { contextWindow: DSH_CONTEXT_BUDGET }, ...(reasoning ? { reasoning } : {}) });
const modelRows = (options, images, reasoning) => options?.model.options.filter(model => gemini(model.value))
  .map(({ value, name }) => modelRow(value, name, images, reasoning.has(value) ? reasoning.get(value) : fallbackReasoning(value))) ?? [];
const composedPreset = (ctx, agent) => ctx.get('agentPresets')?.composedPreset(agent.ctx);
const canLoadFallback = error => ['history-unavailable', 'history-too-large', 'RPC_ERROR', 'invalid-session',
  'config-unconfirmed', 'catalog-unavailable'].includes(error?.code);
const cancelledPermission = { outcome: { outcome: 'cancelled' } };

function asLocalError(error) {
  if (error instanceof LlmError) return error;
  const code = error?.code;
  if (code === -32000 || code === 'AUTH_REQUIRED' || code === 'auth-required') {
    return new LlmError('请先在 Google 官方 Antigravity CLI 登录，然后重新检查。', 'AGY_LOGIN_REQUIRED');
  }
  if (['missing-cli', 'unsupported-cli'].includes(code)) {
    return new LlmError('找不到可用的 Google 官方 Antigravity CLI。请检查安装路径。', 'AGY_CLI_UNAVAILABLE');
  }
  if (['model-unavailable', 'reasoning-effort-unavailable', 'config-unconfirmed'].includes(code)) {
    return new LlmError('当前 Google 账号无法使用这个 Gemini 型号或档位，请重新选择。', 'AGY_MODEL_UNAVAILABLE');
  }
  if (code === 'workspace-unavailable') return new LlmError('当前 DSH 会话没有可用的本机工作目录。', 'AGY_WORKSPACE_UNAVAILABLE');
  if (code === 'attachment-unavailable') return new LlmError('Google Antigravity 无法读取这份附件，请重新添加。', 'AGY_ATTACHMENT_UNAVAILABLE');
  if (code === 'prompt-too-large' || code === 'FRAME_TOO_LARGE') {
    return new LlmError('这条消息和附件超过 ACP 单次传输大小；请分开发送，或把大段正文保存为文件。', 'AGY_PROMPT_TOO_LARGE');
  }
  if (code === 'invalid-proxy') return new LlmError('Google Antigravity 的代理配置无效，请检查 google.proxy。', 'AGY_INVALID_PROXY');
  if (code === 'skill-sync-failed') return new LlmError('无法将 DSH 技能复制到当前 Gemini 会话，请检查技能目录和文件权限。', 'AGY_SKILL_SYNC_FAILED');
  return new LlmError('Google Antigravity 连接未完成。请检查网络和本机代理；DSH 没有重发。', 'AGY_CONNECTION_FAILED');
}

function executionPolicy(agent, ctx) {
  const sandbox = (agent.ctx.get('sandboxPolicy') ?? ctx.get('sandboxPolicy'))?.resolve({ session: agent.session });
  const approval = agent.ctx.get('approval') ?? ctx.get('approval');
  const policy = approval?.overrideOf(agent.session) ?? approval?.config?.policy ?? 'ask';
  const mode = sandbox?.mode === 'danger-full-access' ? (policy === 'never' ? 'full' : 'review')
    : sandbox?.mode === 'workspace-write' ? 'workspace-write' : 'read-only';
  return { mode, approval, approvalPolicy: policy, workspaceRoot: sandbox?.workspaceRoot, additionalWritableRoots: sandbox?.additionalWritableRoots ?? [], cwd: (agent.ctx.get('workingDirectory')
    ?? ctx.get('workingDirectory'))?.get(agent.session) ?? agent.session.header.cwd ?? sandbox?.workspaceRoot };
}

async function permission(ctx, agent, params, signal, readOnlyRefs) {
  const policy = executionPolicy(agent, ctx);
  const { toolCall, options } = params;
  if (signal.aborted || !Array.isArray(options) || !options.length || options.length > 16) return cancelledPermission;
  const ids = options.map(option => option?.optionId);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return cancelledPermission;
  const choice = kind => {
    const matches = options.filter(option => option.kind === kind);
    return matches.length === 1 ? matches[0].optionId : undefined;
  };
  const allow = choice('allow_once'), always = choice('allow_always'), deny = choice('reject_once');
  const selected = optionId => optionId ? { outcome: { outcome: 'selected', optionId } } : cancelledPermission;
  if ((!allow && !always) || typeof toolCall?.toolCallId !== 'string' || !toolCall.toolCallId || !policy.approval) return selected(deny);
  const samePolicy = () => {
    const current = executionPolicy(agent, ctx);
    return current.mode === policy.mode && current.cwd === policy.cwd && current.workspaceRoot === policy.workspaceRoot
      && Boolean(current.approval) && current.approvalPolicy === policy.approvalPolicy
      && JSON.stringify(current.additionalWritableRoots) === JSON.stringify(policy.additionalWritableRoots);
  };
  const restricted = policy.mode === 'read-only' || policy.mode === 'workspace-write';
  let permittedPaths = async () => true;
  if (restricted && toolCall.kind !== 'fetch') {
    // ACP locations use the class of the operation as well as path(s). Never
    // ask the user to override the DSH sandbox for a command or unknown action.
    if (toolCall.kind !== 'read' && !(policy.mode === 'workspace-write' && ['edit', 'delete'].includes(toolCall.kind))) return selected(deny);
    const locations = toolCall.locations;
    if (locations !== undefined && !Array.isArray(locations)) return selected(deny);
    const reported = locations?.map(location => location?.path) ?? [];
    const rawPaths = [toolCall.rawInput?.Path, toolCall.rawInput?.path].filter(value => value !== undefined);
    const paths = [...new Set([...reported, ...rawPaths])];
    if (!paths.length || paths.length > 32) return selected(deny);
    permittedPaths = async () => {
      for (const subject of paths) {
        const grant = readOnlyRefs.find(ref => isAgyReadOnlyRefPath(subject, policy.cwd, ref));
        if (grant) {
          if (toolCall.kind !== 'read' || !await matchesAgyReadOnlyRef(subject, policy.cwd, grant)) return false;
        } else if (!await withinAgyWritableRoots(subject, policy.cwd, policy.workspaceRoot,
          policy.mode === 'workspace-write' ? policy.additionalWritableRoots : [])) return false;
      }
      return true;
    };
    if (!await permittedPaths()) return selected(deny);
  } else if (!restricted && policy.mode !== 'review') return selected(deny);
  if (signal.aborted) return cancelledPermission;
  if (!samePolicy()) return selected(deny);
  // Never grants only an already in-scope operation; it never escalates the
  // sandbox or persists a broader ACP permission. DSH 'never' rejects asks.
  if (restricted && policy.approvalPolicy === 'never') return selected(allow);
  const reason = String(toolCall.title ?? toolCall.kind ?? '工具操作').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1000);
  const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const outcome = await policy.approval.request({ agent, toolName: 'Google Antigravity', reason, signal: approvalSignal });
  if (signal.aborted) return cancelledPermission;
  if (approvalSignal.aborted || !samePolicy() || !await permittedPaths()) return selected(deny);
  if (approvalSignal.aborted || !samePolicy()) return selected(deny);
  // Current Desktop only returns allowed-once. Never promote a one-shot
  // decision to a persistent ACP grant merely because the peer offers it.
  if (outcome === 'allowed-always') return selected(restricted ? allow : always ?? allow);
  return selected(outcome === 'allowed-once' ? allow ?? deny : deny);
}

/** Install an ordinary DSH adapter; it owns the ACP process, not the chat surface. */
export function mountLocalGoogle(ctx, config = {}, runtime = createLocalAgy(config, { logger: ctx.logger }), authorize = () => true) {
  const lifetime = new AbortController();
  const nativeCall = new AsyncLocalStorage();
  // DSH may clone the marked request while projecting durable file/image blocks.
  // Retain the native witness around iteration, not just generator construction.
  ctx.on('llm/stream', (request, next) => {
    if (request.provider !== GOOGLE || !isAgentLoopRequest(request)) return next();
    return (async function* () {
      const iterator = nativeCall.run(request, () => next()[Symbol.asyncIterator]());
      try {
        for (;;) {
          const next = await nativeCall.run(request, () => iterator.next());
          if (next.done) break;
          yield next.value;
        }
      } finally { await nativeCall.run(request, () => iterator.return?.()); }
    })();
  }, { global: true });
  const chats = new Map();
  const allowedMcp = config.mcp;
  let catalog, images = false, loading, authInFlight;
  let status = 'unchecked';
  let failedAt = -Infinity;

  function refresh(options, imageSupport = false, notify = true, reasoning = new Map(), emptyStatus = 'unavailable') {
    const next = modelRows(options, imageSupport, reasoning);
    const nextStatus = next.length ? 'ready' : emptyStatus;
    // The native send controller checks listModels before stream(). Retain
    // the last verified IDs across a transient outage for that admission;
    // stream() still probes again before dispatching to an available model.
    const rows = nextStatus === 'unavailable' && catalog?.length ? catalog : next;
    const changed = status !== nextStatus || JSON.stringify(catalog) !== JSON.stringify(rows);
    if (rows === next) images = imageSupport;
    catalog = rows;
    status = nextStatus;
    failedAt = status === 'unavailable' ? Date.now() : -Infinity;
    if (notify && changed && !lifetime.signal.aborted) ctx.emit('llm/models-updated', GOOGLE);
  }

  async function inspect(force = false, forSend = false) {
    const retry = status === 'unavailable' && Date.now() - failedAt >= CATALOG_RETRY_MS;
    const sendRetry = forSend && (status === 'unavailable' || !catalog?.length)
      && status !== 'signed-out' && status !== 'missing-cli';
    if (!loading && (force || sendRetry || retry || !catalog) && !lifetime.signal.aborted) {
      const notify = force || status !== 'unchecked';
      loading = (async () => {
        let session;
        try {
          session = await runtime.open(lifetime.signal);
          const initial = session.options;
          const reasoning = new Map([[initial.model.currentValue, reasoningOf(initial.thoughtLevel)]]);
          const probe = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]);
          // The catalog uses an isolated session. Model setters only, no inference.
          for (const { value } of initial.model.options) {
            if (probe.aborted) break;
            if (!gemini(value) || reasoning.has(value)) continue;
            try {
              const selected = await session.prepare({ model: value }, probe);
              reasoning.set(value, reasoningOf(selected.thoughtLevel));
            } catch {
              // Real failures fence this session. Preserve the initial catalog
              // and use the known fallback for unconfirmed models.
              if (!session.options) break;
            }
          }
          refresh(initial, session.capabilities?.promptCapabilities?.image === true, notify, reasoning);
        } catch (error) {
          const { code } = asLocalError(error);
          refresh(undefined, false, notify, undefined,
            code === 'AGY_LOGIN_REQUIRED' ? 'signed-out' : code === 'AGY_CLI_UNAVAILABLE' ? 'missing-cli' : 'unavailable');
        } finally { await session?.close().catch(() => {}); }
      })().finally(() => { loading = undefined; });
    }
    await loading;
    return { status, modelCount: catalog?.length ?? 0 };
  }

  function sameOwner(chat) {
    const agent = chat.agent;
    const selected = agent.model?.current?.();
    return !lifetime.signal.aborted && chats.get(agent.id) === chat && ctx.agents.get(agent.id) === agent
      && selected?.provider === GOOGLE && selected.model === chat.armedModel;
  }
  function matchesBackground(agent, message) {
    const chat = chats.get(agent.id), bg = chat?.bg;
    return Boolean(bg && !bg.claimed && chat.agent === agent && sameOwner(chat) && bg.token === message.id && isBackgroundNotice(message));
  }
  function ensureBackgroundWave(chat, epoch, event) {
    if (chat.epoch !== epoch || !chat.armed || !chat.session?.options) return;
    if (!sameOwner(chat) || !chat.policy?.()) { abandon(chat); return; }
    if (authorize.mayWake && !authorize.mayWake(chat.agent)) {
      if (chat.bg) abandon(chat);
      return;
    }
    let bg = chat.bg;
    if (!bg) {
      if (event?.kind === 'usage') return;
      const message = createUserMessage({ source: { kind: 'tool-jobs', form: 'notice', summary: backgroundSummary },
        content: [] });
      // createUserMessage supplies a fresh cryptographic UUID. Only this live
      // chat/process generation can redeem it; the durable row is not authority.
      bg = chat.bg = backgroundWave({ ...config.backgroundTiming, token: message.id, activeTools: chat.activeTools,
        onSeal() { if (bg.claimed && chat.bg === bg) chat.bg = undefined; },
        onRetire() { if (chat.epoch === epoch && (!chat.bg || chat.bg === bg)) abandon(chat); },
      });
      bg.permissionCount(epoch.approvals);
      chat.bridge?.beginWave(bg);
      if (event) bg.push(event);
      if (chat.bg !== bg || bg.sealed) return;
      try { chat.agent.followup(message); }
      catch { abandon(chat); return; }
    } else if (event) bg.push(event);
    return chat.bg === bg && !bg.sealed ? bg : undefined;
  }
  async function closeChat(chat, confirm = false) {
    const { session, bridge, bg } = chat;
    chat.epoch = chat.bg = chat.policy = chat.activeTools = chat.refs = chat.armedModel = undefined;
    chat.armed = false;
    bg?.dispose();
    chat.session = chat.bridge = undefined;
    bridge?.setTurn(undefined);
    // Session rejects a nested durable append while publishing model/selection.
    // Revoke authority now; splice only our UUID after that publication returns.
    if (bg && !bg.claimed) queueMicrotask(() => {
      try { chat.agent.inbox.remove(bg.token); } catch { /* disposed inbox */ }
    });
    const [closed] = await Promise.allSettled([session?.close(), bridge?.close()]);
    if (confirm && closed.status === 'rejected') {
      chat.retirementFailed = true;
      throw closed.reason;
    }
  }

  // There is no cancel acknowledgement for an unsolicited generation. Queue
  // session/cancel then reap the process before a new prompt can use the ID.
  function retireBackground(chat) {
    if (chat.retiring) return chat.retiring;
    const session = chat.session;
    chat.armed = false;
    const cancelled = Promise.resolve(session?.cancelBackground?.()).catch(() => {});
    const closed = closeChat(chat, true);
    chat.retiring = Promise.all([cancelled, closed]).finally(() => { chat.retiring = undefined; });
    return chat.retiring;
  }

  async function checkpoint(chat, start, turn, signal) {
    signal.throwIfAborted();
    const previous = chat.binding, next = { ...previous, throughTurn: turn };
    if (next.officialId && runtime.writeBinding) {
      try { await runtime.writeBinding(chat.agent.id, next, signal); }
      catch { if (!signal.aborted) ctx.logger.warn('Could not update the Antigravity conversation checkpoint.'); }
      // Stop can win after the OS accepted the atomic rename. Restore the
      // last confirmed cursor before releasing this chat to another stream.
      if (signal.aborted) await runtime.writeBinding(chat.agent.id, previous);
    }
    signal.throwIfAborted();
    // Preserve the synchronous stream checkpoint expected by existing hosts,
    // but it is provisional until the same native turn commits successfully.
    // Multiple steps in one turn share the original rollback cursor.
    if (chat.provisional?.turn !== turn) chat.provisional = { turn, throughTurn: previous.throughTurn, completed: chat.completedInTurn };
    chat.binding = next; chat.completedInTurn = start;
  }

  function confirmCheckpoint(chat, end) {
    const saved = chat.provisional;
    if (!saved || saved.turn !== end.turn) return;
    chat.provisional = undefined;
    if (['completed', 'max-tokens'].includes(end.reason?.kind)) return;
    const binding = chat.binding = { ...chat.binding, throughTurn: saved.throughTurn };
    chat.completedInTurn = saved.completed;
    if (binding.officialId && runtime.writeBinding) {
      chat.rollback = runtime.writeBinding(chat.agent.id, binding).catch(() => {
        ctx.logger.warn('Could not restore the last completed Antigravity checkpoint.');
      });
    }
  }

  async function login(requestSignal) {
    if (authInFlight) throw new LlmError('Google 登录或退出操作正在进行中，请稍候。', 'AGY_AUTH_BUSY');
    if (typeof runtime.authenticate !== 'function') throw new LlmError('当前环境不支持在 DSH 内发起 Google 登录。', 'AGY_AUTH_UNSUPPORTED');
    const signal = requestSignal ? AbortSignal.any([requestSignal, lifetime.signal]) : lifetime.signal;
    authInFlight = (async () => {
      await runtime.authenticate(signal);
      return inspect(true);
    })().finally(() => { authInFlight = undefined; });
    try { return await authInFlight; }
    catch (error) {
      if (signal.aborted) throw new LlmError('已取消 Google 登录。', 'AGY_AUTH_CANCELLED');
      throw asLocalError(error);
    }
  }

  async function logout(requestSignal) {
    if (authInFlight) throw new LlmError('Google 登录或退出操作正在进行中，请稍候。', 'AGY_AUTH_BUSY');
    if ([...chats.values()].some(chat => chat.running || chat.bg || chat.retiring)) {
      throw new LlmError('当前有正在进行的 Gemini 对话，请等本轮回复完成后再退出登录。', 'AGY_BUSY');
    }
    if (typeof runtime.logout !== 'function') throw new LlmError('当前环境不支持在 DSH 内退出 Google 登录。', 'AGY_AUTH_UNSUPPORTED');
    const signal = requestSignal ? AbortSignal.any([requestSignal, lifetime.signal]) : lifetime.signal;
    authInFlight = (async () => {
      await Promise.allSettled([...chats.values()].map(closeChat));
      chats.clear();
      await runtime.logout(signal);
      return inspect(true);
    })().finally(() => { authInFlight = undefined; });
    try { return await authInFlight; }
    catch (error) {
      if (signal.aborted) throw new LlmError('已取消退出登录。', 'AGY_AUTH_CANCELLED');
      throw asLocalError(error);
    }
  }

  async function fetchQuota(requestSignal) {
    const signal = requestSignal ? AbortSignal.any([requestSignal, lifetime.signal]) : lifetime.signal;
    try { return await runtime.fetchQuota(signal); }
    catch { throw new LlmError('暂时查不到 Google 额度，请检查官方 CLI 登录和网络代理后重试。', 'AGY_QUOTA_FAILED'); }
  }

  class LocalGoogle extends LlmAdapter {
    providerInfo() { return { id: GOOGLE, name: 'Google Antigravity' }; }
    providerRetryPolicy() { return NO_RETRY; }
    async listModels() { await inspect(); return catalog ?? []; }
    async resolveModel(provider, id) {
      if (provider !== GOOGLE || !gemini(id)) throw new LlmError('请选择官方目录中的 Gemini 型号。', 'AGY_MODEL_UNAVAILABLE');
      await inspect();
      return catalog?.find(model => model.id === id) ?? modelRow(id, id, images);
    }

    async prepareCall(provider, id, signal) {
      const call = await super.prepareCall(provider, id, signal);
      // The stock AgentLoop validates stored controls before it reaches stream().
      // Keep the picker exact (resolveModel), but let known stale levels reach
      // the live ACP snapshot, which decides what can actually be sent.
      const model = call.model;
      const efforts = new Map((model.reasoning?.efforts ?? []).map(row => [row.id, row]));
      for (const row of catalog ?? []) {
        for (const effort of row.reasoning?.efforts ?? []) if (!efforts.has(effort.id)) efforts.set(effort.id, effort);
      }
      for (const [index, id] of effortOrder.entries()) if (!efforts.has(id)) efforts.set(id, { id, name: effortNames[index] });
      return { ...call, model: { ...model, reasoning: { ...model.reasoning, efforts: [...efforts.values()] } } };
    }

    async *stream(request) {
      const id = request.sessionId;
      const agent = id && ctx.agents.get(id);
      if (['compaction', 'session-title'].includes(request.purpose)) {
        if (!id || (!agent && !ctx.get('sessions')?.get(id))) {
          throw new LlmError('Google 订阅只用于当前 DSH 会话。', 'AGY_CHAT_ONLY');
        }
        const signal = AbortSignal.any([lifetime.signal, ...(request.signal ? [request.signal] : [])]);
        await inspect(false, true);
        if (status !== 'ready' || !catalog?.some(model => model.id === request.model)) {
          throw asLocalError({ code: status === 'signed-out' ? 'auth-required' : status === 'missing-cli' ? 'missing-cli' : 'connection-failed' });
        }
        const parts = [];
        const sys = typeof request.system === 'string' ? request.system.trim()
          : Array.isArray(request.system) ? request.system.map(b => (typeof b === 'string' ? b : b?.text ?? '')).join('\n').trim() : '';
        if (sys) parts.push(`System instructions:\n${sys}`);
        for (const msg of Array.isArray(request.messages) ? request.messages : []) {
          if (isBackgroundNotice(msg)) continue;
          const body = Array.isArray(msg?.content)
            ? msg.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
            : typeof msg?.content === 'string' ? msg.content.trim() : '';
          if (body) parts.push(`[${msg.role ?? 'user'}]\n${body}`);
        }
        const raw = parts.join('\n\n').trim();
        const promptText = raw.length <= 120_000 ? raw : `${raw.slice(0, 58_000)}\n\n[... truncated ...]\n\n${raw.slice(-58_000)}`;
        if (!promptText) throw new LlmError('缺少可用于生成的对话内容。', 'AGY_EMPTY_RESPONSE');
        const session = await runtime.open(signal, { ephemeral: true });
        try {
          const liveEfforts = reasoningOf(session.options?.thoughtLevel)?.efforts;
          await session.prepare({ model: request.model, reasoningEffort: compatibleEffort(request.reasoningEffort, liveEfforts) }, signal);
          const chunks = [];
          let pulse = Promise.withResolvers(), finished = false, failure, outcome, answer = '';
          const task = session.runTurn([{ type: 'text', text: promptText }], {
            signal,
            onDelta: delta => { answer += delta; chunks.push(delta); pulse.resolve(); },
          }).then(value => { outcome = value; }, error => { failure = error; }).finally(() => { finished = true; pulse.resolve(); });
          yield { type: 'block-start', index: 0, blockType: 'text' };
          while (!finished || chunks.length) {
            signal.throwIfAborted();
            if (!chunks.length) { await pulse.promise; pulse = Promise.withResolvers(); continue; }
            yield { type: 'text-delta', index: 0, text: chunks.shift() };
          }
          await task;
          if (failure) throw asLocalError(failure);
          yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } };
          const usage = agyUsage(outcome?.usage, outcome?.contextUsage);
          if (usage) yield { type: 'usage', usage };
          yield { type: 'finish', reason: { kind: outcome?.stopReason === 'max_tokens' ? 'max-tokens' : 'stop' } };
          return;
        } finally { await session.close().catch(() => {}); }
      }
      const native = nativeCall.getStore();
      if (!agent || request.purpose || (!isAgentLoopRequest(request) && !(native && native.sessionId === id
        && native.provider === request.provider && native.model === request.model && native.signal === request.signal))) {
        throw new LlmError('Google 订阅只用于本机普通聊天。', 'AGY_CHAT_ONLY');
      }
      const { openTurnStartSeq: start, lastStepStartSeq: step, lastTurn: turn } = ctx.agents.turnBoundaryOf(agent.session);
      const match = message => matchesBackground(agent, message);
      const messages = start === null || step === null || step < start ? [] : localSubmissions(agent.session, step, match);
      if (!messages.length || !authorize(agent, messages, { step, turn })) {
        throw new LlmError('请从本机发起聊天；Gemini 子代理只接受该聊天树中的原生消息。', 'AGY_CHAT_ONLY');
      }
      const chat = chats.get(id) ?? { agent, running: false };
      const inputs = messages.filter(message => !match(message));
      const admittedWave = inputs.length ? undefined : chat.bg;
      if (chat.running) throw new LlmError('请等本轮 Google 回复完成。', 'AGY_BUSY');
      if (chat.retirementFailed) throw new LlmError('旧的 Google Antigravity 进程未确认退出，请另开会话。', 'AGY_CLI_STILL_RUNNING');
      if (chat.attemptedStep === step) throw new LlmError('这条消息已交给 Gemini，DSH 不会重复发送。', 'AGY_NO_RESEND');
      chat.running = true;
      chats.set(id, chat);
      const cancellation = new AbortController();
      chat.cancel = () => cancellation.abort();
      const signal = AbortSignal.any([cancellation.signal, lifetime.signal, ...(request.signal ? [request.signal] : [])]);
      const steer = new AbortController();
      const turnSignal = AbortSignal.any([signal, steer.signal]);
      const pendingSteer = message => message?.source?.kind === 'user' && typeof message.source.rpcId === 'string'
        && authorize(agent, [message], { step, turn, steer: true }) && agent.inbox.nextStep.includes(message);
      let progress = agyProgress();
      const stall = new AbortController();
      const acpSignal = AbortSignal.any([turnSignal, stall.signal]);
      let task, toolSet, silenceTimer, finished = false, failure, outcome, syncing;
      // A queued owner input can win the inbox claim ahead of our notice (or
      // be claimed alongside it). Drain only wire output, retire the old writer,
      // and send the committed owner blocks once, never the synthetic notice.
      function claim(bg) {
        bg.claimed = true;
        if (bg.sealed) bg.clearClaim();
        if (bg.sealed && chat.bg === bg) chat.bg = undefined;
        agent.inbox.remove(bg.token); // no-op if already claimed with this step
      }
      async function* preempt(bg) {
        claim(bg);
        await retireBackground(chat);
        for (const event of bg.chunks.splice(0)) yield* progress.push(event);
        yield* progress.close();
        progress = agyProgress(progress.nextIndex); // new prompt, not an answer/receipt from the cancelled wave
      }
      const chunks = [];
      let pulse = Promise.withResolvers();
      const stopWaiting = () => { pulse.resolve(); syncing?.wake(); };
      const stopSteer = agent.ctx.on('agent/inbox/inserted', ({ agent: owner, message }) => {
        if (owner === agent && !finished && pendingSteer(message)) steer.abort();
      });
      if (agent.inbox.nextStep.some(pendingSteer)) steer.abort();
      acpSignal.addEventListener('abort', stopWaiting, { once: true });
      let watchSilence = false;
      const activity = () => {
        if (!watchSilence || acpSignal.aborted) return;
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => stall.abort(), RESTRICTED_SILENCE_MS).unref();
      };
      const push = (kind, value) => {
        if (!acpSignal.aborted) { activity(); chunks.push({ kind, value }); pulse.resolve(); }
      };
      async function settleSteer() {
        // A cancel acknowledgement preserves this ACP session. On failure the
        // old child must be reaped before a later DSH step can reopen it.
        await task;
        signal.throwIfAborted();
        if (failure || !chat.session?.options) {
          if (task && chat.binding?.officialId) chat.resumeSteeredId = chat.binding.officialId;
          await closeChat(chat, true);
        }
      }
      try {
        await chat.retiring;
        await chat.rollback;
        signal.throwIfAborted();
        if (!inputs.length) {
          syncing = admittedWave;
          claim(syncing);
          chat.attemptedStep = step;
          const current = () => sameOwner(chat) && (!authorize.mayWake || authorize.mayWake(agent))
            && chat.policy?.() && !syncing.sealed && !acpSignal.aborted;
          if (!syncing.sealed && !current()) await retireBackground(chat);
          if (!syncing.sealed && chat.bridge) {
            const control = AbortSignal.any([acpSignal, syncing.signal]);
            try { toolSet = await ctx.tools.resolve({ agent, signal: control, modelSelection: agent.model.current() }); }
            catch (error) { if (!control.aborted) throw error; }
            if (current()) {
              const subagents = agent.ctx.get('subagents') ?? ctx.get('subagents');
              const tools = agyMcpTools(ctx, agent, toolSet, allowedMcp, Boolean(subagents));
              chat.bridge.setTurn({ wave: syncing, tools, toolSet, agent, signal: control, canCall: current });
            }
          }
          if (current()) {
            const control = AbortSignal.any([acpSignal, syncing.signal]);
            syncing.attach(params => current() ? permission(ctx, agent, params, control, chat.refs) : cancelledPermission);
          }
          while (!syncing.sealed || syncing.chunks.length) {
            signal.throwIfAborted();
            if (!syncing.sealed && !current()) await retireBackground(chat);
            if (syncing.chunks.length) yield* progress.push(syncing.chunks.shift());
            else if (!syncing.sealed) await syncing.wait();
          }
          if (!progress.hasAnswer && progress.receipt()) yield* progress.push({ kind: 'text', value: progress.receipt() });
          yield* progress.close();
          await checkpoint(chat, start, turn, signal);
          const usage = agyUsage(undefined, syncing.usage);
          if (usage) yield { type: 'usage', usage };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        if (chat.bg) yield* preempt(chat.bg);
        turnSignal.throwIfAborted();
        await inspect(false, true);
        turnSignal.throwIfAborted();
        if (status !== 'ready' || !catalog?.some(model => model.id === request.model)) {
          const code = status === 'signed-out' ? 'auth-required' : status === 'missing-cli' ? 'missing-cli'
            : status === 'ready' ? 'model-unavailable' : 'connection-failed';
          throw asLocalError({ code });
        }
        const { cwd, mode, approvalPolicy, workspaceRoot, additionalWritableRoots } = executionPolicy(agent, ctx);
        watchSilence = mode !== 'full';
        chat.permissionActivity = activity;
        chat.readOnlyRefs = [];
        const preset = composedPreset(ctx, agent);
        const currentPersona = selectedPreset => resolveAgyPresetPersona(agent.ctx, { provider: GOOGLE, model: request.model })
          ?? (selectedPreset === WRITING_PRESET ? WRITING_PERSONA : undefined);
        const persona = currentPersona(preset);
        if (!isLocalAgyPath(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) throw Object.assign(new Error('Invalid cwd'), { code: 'workspace-unavailable' });
        const samePolicy = () => {
          const current = executionPolicy(agent, ctx);
          return current.mode === mode && current.approvalPolicy === approvalPolicy && current.workspaceRoot === workspaceRoot
            && JSON.stringify(current.additionalWritableRoots) === JSON.stringify(additionalWritableRoots)
            && current.cwd === cwd && composedPreset(ctx, agent) === preset && currentPersona(preset) === persona;
        };
        const blocks = await localPrompt(inputs.flatMap(message => message.content), ctx.get('attachments'), turnSignal,
          { onReadOnlyRef: ref => chat.readOnlyRefs.push(ref) });
        const toolsService = ctx.get('tools');
        // Native tools keep their own policies; sandbox mode isn't a tool allowlist.
        const subagents = agent.ctx.get('subagents') ?? ctx.get('subagents');
        const useMcp = toolsService && (allowedMcp?.length !== 0 || subagents);
        if (useMcp) toolSet = await toolsService.resolve({ agent, signal: turnSignal, modelSelection: {
          provider: GOOGLE, model: request.model, reasoningEffort: request.reasoningEffort,
        } });
        const tools = useMcp ? agyMcpTools(ctx, agent, toolSet, allowedMcp, Boolean(subagents)) : new Map();
        let dispatched = false, wireOpen = false;
        const lease = new AbortController();
        const mcpTurn = { agent, tools, toolSet, signal: AbortSignal.any([acpSignal, lease.signal]),
          canCall: () => wireOpen && sameOwner(chat) && samePolicy() };
        const [workspaceFingerprint, proxyFingerprint] = await Promise.all([
          runtime.workspaceFingerprint?.(cwd, turnSignal), runtime.proxyFingerprint?.(turnSignal),
        ]);
        const compaction = agent.session.snapshotEvents().findLast(event => event.type === 'compaction/summary' && event.seq < step)?.seq ?? -1;
        const routeKey = (workspace, proxy) => JSON.stringify([mode, approvalPolicy, workspaceRoot, additionalWritableRoots,
          preset, persona, workspace, proxy, compaction, [...tools.keys()].sort()]);
        const createdAt = agent.session.header.createdAt;
        const stored = chat.binding ?? await runtime.readBinding?.(id);
        const binding = stored?.createdAt === createdAt ? stored : undefined;
        const fresh = binding && ((binding.compaction ?? -1) !== compaction
          || (binding.throughTurn >= turn && chat.completedInTurn !== start));
        for (;;) {
          if (chat.bg) yield* preempt(chat.bg);
          if (chat.session && (fresh || !chat.session.options || chat.routeKey !== routeKey(workspaceFingerprint, proxyFingerprint)
            || !sameAgyPath(chat.cwd, cwd))) await closeChat(chat, true);
          if (!chat.session) {
            if (tools.size) chat.bridge = await openAgyMcp(ctx, { waitMs: config.backgroundTiming?.waitMs });
            chat.bridge?.setTurn(mcpTurn);
            const open = officialId => {
              const epoch = chat.epoch = { approvals: 0 };
              return runtime.open(turnSignal, { id, cwd, mode, officialId, persona,
                onBackgroundUpdate(update) {
                  const event = backgroundEvent(update);
                  if (event) ensureBackgroundWave(chat, epoch, event);
                },
                onBackgroundPermission: params => ensureBackgroundWave(chat, epoch)?.permission(params) ?? cancelledPermission,
                onDisconnect() { if (chat.epoch === epoch) { chat.armed = false; chat.bg?.finish(); } },
                nativeSubagents: tools.has('subagent'), mcpServers: chat.bridge?.servers,
                async onPermission(params, control) {
                  epoch.approvals++; chat.permissionActivity?.();
                  try { return await permission(ctx, agent, params, control, chat.readOnlyRefs ?? []); }
                  finally {
                    epoch.approvals--;
                    if (chat.epoch === epoch) { chat.bg?.permissionCount(epoch.approvals); chat.permissionActivity?.(); }
                  }
                },
              });
            };
            let throughTurn = 0;
            if (!fresh && binding?.officialId && binding.persona === persona && sameAgyPath(binding.cwd, cwd)) {
              try { chat.session = await open(binding.officialId); throughTurn = binding.throughTurn; }
              catch (error) {
                turnSignal.throwIfAborted();
                if (chat.resumeSteeredId === binding.officialId || !canLoadFallback(error)) throw error;
              }
            }
            chat.session ??= await open();
            chat.resumeSteeredId = undefined;
            chat.cwd = cwd;
            chat.routeKey = routeKey(chat.session.workspaceFingerprint ?? workspaceFingerprint, chat.session.proxyFingerprint ?? proxyFingerprint);
            chat.binding = { createdAt, cwd, officialId: chat.session.id, throughTurn, compaction, ...(persona ? { persona } : {}) };
            if (chat.session.id) await runtime.writeBinding?.(id, chat.binding);
          } else chat.bridge?.setTurn(mcpTurn);
          const { model, reasoningEffort } = request;
          if (reasoningEffort !== undefined && chat.session.options.model.currentValue !== model) {
            // Switch the model first: the previous model's levels are not authoritative.
            await chat.session.prepare({ model }, turnSignal);
          }
          const liveEfforts = reasoningOf(chat.session.options?.thoughtLevel)?.efforts;
          await chat.session.prepare({ model, reasoningEffort: compatibleEffort(reasoningEffort, liveEfforts) }, turnSignal);
          const contextText = await prepareLocalHistory(agent.session, step, chat.binding.throughTurn, {
            archivePath: runtime.historyArchivePath?.(id), signal: turnSignal, onReadOnlyRef: ref => chat.readOnlyRefs.push(ref),
          });
          turnSignal.throwIfAborted();
          if (chat.bg) continue;
          const writeStarted = Promise.withResolvers();
          let collision = false;
          chat.attemptedStep = step;
          task = chat.session.runTurn(blocks, { contextText, signal: acpSignal, onDelta: value => push('text', value),
            beforeDispatch() {
              collision = Boolean(chat.bg);
              if (collision || !samePolicy()) throw new Error('DSH execution context changed');
            },
            onDispatch() {
              writeStarted.resolve();
              dispatched = wireOpen = chat.armed = true;
              chat.armedModel = model;
              chat.activeTools ??= new Set();
              chat.policy = samePolicy; chat.refs = chat.readOnlyRefs;
              activity();
            },
            onTerminal() { wireOpen = false; lease.abort(); chat.bridge?.clearTurn(mcpTurn); },
            onThought: value => push('thought', value), onTool: value => {
              if (chat.activeTools) trackAgyTool(chat.activeTools, value);
              push('tool', value);
            },
          }).then(value => { outcome = value; }, error => { failure = error; }).finally(() => {
            finished = true;
            watchSilence = false;
            clearTimeout(silenceTimer);
            pulse.resolve();
          });
          // A previous HTTP permission reply may have occupied the pipe. Only
          // retry a rejected pre-write guard, never an attempted prompt write.
          await Promise.race([writeStarted.promise, task]);
          if (collision && !dispatched) {
            await task;
            if (chat.bg) yield* preempt(chat.bg);
            finished = false; failure = undefined; watchSilence = mode !== 'full';
            continue;
          }
          break;
        }
        while (!finished || chunks.length) {
          acpSignal.throwIfAborted();
          if (!chunks.length) { await pulse.promise; pulse = Promise.withResolvers(); continue; }
          yield* progress.push(chunks.shift());
        }
        acpSignal.throwIfAborted();
        if (failure) throw failure;
        if (outcome?.status === 'interrupted') throw new LlmError('Google Antigravity 中止了这轮回复。', 'AGY_INTERRUPTED');
        if (!progress.hasAnswer) {
          const receipt = progress.receipt();
          if (!receipt) throw new LlmError('Google Antigravity 没有返回正文。', 'AGY_EMPTY_RESPONSE');
          yield* progress.push({ kind: 'text', value: receipt });
        }
        yield* progress.close();
        await checkpoint(chat, start, turn, signal);
        const usage = agyUsage(outcome?.usage, outcome?.contextUsage);
        if (usage) yield { type: 'usage', usage };
        yield { type: 'finish', reason: { kind: outcome?.stopReason === 'max_tokens' ? 'max-tokens' : 'stop' } };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (stall.signal.aborted && !steer.signal.aborted) {
          await settleSteer();
          throw new LlmError('Google Antigravity 长时间没有进展，本轮已取消。若任务需要 Gemini 直接执行终端命令，请切到「完全权限 + 需确认」。', 'AGY_NO_PROGRESS');
        }
        if (!steer.signal.aborted) {
          await closeChat(chat);
          const fault = asLocalError(error);
          if (fault.code === 'AGY_CONNECTION_FAILED') refresh(undefined);
          else if (fault.code === 'AGY_LOGIN_REQUIRED') refresh(undefined, false, true, undefined, 'signed-out');
          throw fault;
        }
        // Finish the native DSH step normally so it can claim nextStep. An
        // abort finish would discard the running step instead of advancing it.
        try { await settleSteer(); }
        catch (error) { if (signal.aborted) throw signal.reason; throw asLocalError(error); }
        yield* progress.close();
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        stopSteer();
        let retirementError;
        if (syncing && !syncing.sealed) await retireBackground(chat).catch(error => { retirementError = error; });
        if (!syncing && (signal.aborted || steer.signal.aborted)) {
          chat.armed = false;
          if (chat.bg) await retireBackground(chat).catch(error => { retirementError = error; });
        }
        chat.permissionActivity = undefined;
        chat.readOnlyRefs = undefined;
        clearTimeout(silenceTimer);
        cancellation.abort();
        acpSignal.removeEventListener('abort', stopWaiting);
        await task;
        chat.bridge?.setTurn(undefined);
        toolSet?.dispose();
        if (failure || (!chat.session?.options && !chat.bg)) await closeChat(chat);
        chat.running = false;
        chat.cancel = undefined;
        if (retirementError) throw asLocalError(retirementError);
      }
    }
  }

  ctx.effect(() => ctx.llm.registerAdapter([GOOGLE], new LocalGoogle()));
  function disposeChat(id) {
    const chat = chats.get(id);
    if (chat) { chats.delete(id); chat.cancel?.(); return Promise.allSettled([chat.rollback, closeChat(chat)]); }
  }
  function abandon(chat) { void retireBackground(chat).catch(() => ctx.logger.warn('Antigravity background process did not close cleanly.')); }
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const chat = chats.get(agent.id);
    if (chat?.bg?.token === message.id && !chat.bg.claimed) abandon(chat);
  }, { global: true });
  ctx.on('agent/status', ({ agent, status }) => {
    const chat = chats.get(agent.id), bg = chat?.bg;
    if (status !== 'idle' || chat?.agent !== agent || !bg || bg.claimed) return;
    queueMicrotask(() => {
      // A failed/rejected preceding step may leave next-turn work undrained.
      if (agent.status === 'idle' && chat.bg === bg && !bg.claimed) abandon(chat);
    });
  }, { global: true });
  ctx.on('session/event', (session, event) => {
    const chat = chats.get(session.id);
    if (!chat || chat.agent.session !== session) return;
    if (event.type === 'turn/end') confirmCheckpoint(chat, event.data);
    if (event.type === 'model/selection' && chat.armed
      && (event.data.provider !== GOOGLE || event.data.model !== chat.armedModel)) {
      chat.armed = false;
      if (chat.bg || chat.activeTools?.size) abandon(chat);
    } else if (chat.armed && ['sandbox/mode', 'approval/policy', 'permission/preset', 'working-directory/change'].includes(event.type)) {
      const epoch = chat.epoch;
      queueMicrotask(() => { if (chat.epoch === epoch && chat.armed && !chat.policy?.()) abandon(chat); });
    } else if (event.type === 'turn/end' && chat.bg && !chat.bg.claimed
      && !chat.agent.inbox.nextTurn.some(message => message.id === chat.bg.token)) {
      // Stop/pre-step rejection can occur after the inbox claim but before stream().
      abandon(chat);
    }
  }, { global: true });
  ctx.on('session/disposed', session => { void disposeChat(session.id); }, { global: true });
  ctx.on('agent/disposed', ({ agent }) => { void disposeChat(agent.id); }, { global: true });
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.allSettled([...chats.values()].map(closeChat));
    await runtime.dispose();
    chats.clear();
  }, 'Google subscription ACP');
  return { inspect, login, logout, fetchQuota, matchesBackground };
}
