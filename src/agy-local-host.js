import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { prepareLocalHistory, localPrompt, localSubmissions } from './agy-local-context.js';
import { agyGptBridgeTools, createGptReturns, GPT_RETURN_PREFIX } from './agy-local-gpt-bridge.js';
import { agyMcpTools, openAgyMcp } from './agy-local-mcp.js';
import { agyProgress, agyUsage } from './agy-local-progress.js';
import { createLocalAgy } from './agy-local-runtime.js';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';
import { WRITING_PRESET } from './writing-policy.js';

export const GOOGLE = 'antigravity';
const NO_RETRY = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'Google subscription');
const DSH_CONTEXT_BUDGET = 512_000;
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
  if (['missing-cli', 'unsupported-cli', 'cli-version-mismatch', 'unverified-cli'].includes(code)) {
    return new LlmError('找不到受支持的 Google 官方 Antigravity CLI。请检查安装位置和版本。', 'AGY_CLI_UNAVAILABLE');
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
  return new LlmError('Google Antigravity 连接未完成。请检查网络和本机代理；DSH 没有重发。', 'AGY_CONNECTION_FAILED');
}

function executionPolicy(agent, ctx) {
  const sandbox = (agent.ctx.get('sandboxPolicy') ?? ctx.get('sandboxPolicy'))?.resolve({ session: agent.session });
  const approval = agent.ctx.get('approval') ?? ctx.get('approval');
  const policy = approval?.overrideOf(agent.session) ?? approval?.config?.policy ?? 'ask';
  const mode = sandbox?.mode === 'danger-full-access' ? (policy === 'never' ? 'full' : 'review')
    : sandbox?.mode === 'workspace-write' ? 'workspace-write' : 'read-only';
  return { mode, approval, workspaceRoot: sandbox?.workspaceRoot, cwd: (agent.ctx.get('workingDirectory')
    ?? ctx.get('workingDirectory'))?.get(agent.session) ?? agent.session.header.cwd ?? sandbox?.workspaceRoot };
}

async function withinWorkspace(value, cwd, root) {
  if (typeof value !== 'string' || !root) return false;
  try {
    let target = resolve(cwd, process.platform === 'win32' ? value.replace(/^\/(?=[a-z]:)/iu, '') : value);
    // New files do not exist yet. Resolve their closest existing parent, too,
    // so junctions cannot turn an in-workspace approval into an external write.
    const ancestors = [];
    for (;;) {
      try { target = resolve(await realpath(target), ...ancestors); break; }
      catch (error) {
        const parent = dirname(target);
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code) || parent === target) return false;
        ancestors.unshift(relative(parent, target));
        target = parent;
      }
    }
    const result = relative(await realpath(root), target);
    return result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result);
  } catch { return false; }
}

async function permission(ctx, agent, params, signal) {
  const policy = executionPolicy(agent, ctx);
  const { toolCall, options } = params;
  const choice = kind => options?.find?.(option => option?.kind === kind && typeof option.optionId === 'string')?.optionId;
  const allow = choice('allow_once'), deny = choice('reject_once');
  const selected = optionId => optionId ? { outcome: { outcome: 'selected', optionId } } : cancelledPermission;
  if (!allow || !toolCall || signal.aborted || !['review', 'workspace-write'].includes(policy.mode) || !policy.approval) return selected(deny);
  if (policy.mode === 'workspace-write') {
    const subject = toolCall.rawInput?.Path ?? toolCall.rawInput?.path ?? toolCall.locations?.[0]?.path;
    if (toolCall.kind !== 'edit' || !await withinWorkspace(subject, policy.cwd, policy.workspaceRoot)) return selected(deny);
  }
  const reason = String(toolCall.title ?? toolCall.kind ?? '工具操作').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1000);
  const outcome = await policy.approval.request({ agent, toolName: 'Google Antigravity', reason, signal });
  if (signal.aborted || outcome === 'cancelled') return cancelledPermission;
  return selected(outcome === 'allowed-once' ? allow : deny);
}

/** Install an ordinary DSH adapter; it owns the ACP process, not the chat surface. */
export function mountLocalGoogle(ctx, config = {}, runtime = createLocalAgy(config), authorize = () => true) {
  const lifetime = new AbortController();
  const chats = new Map();
  const returnTickets = new Map();
  const returnIdOf = message => typeof message.source?.rpcId === 'string' && message.source.rpcId.startsWith(GPT_RETURN_PREFIX)
    ? message.source.rpcId : undefined;
  function validReturn(agent, message) {
    const ticket = returnTickets.get(returnIdOf(message));
    return ticket?.agent === agent && !ticket.signal.aborted && ticket.deadline > Date.now()
      && message.content.length === 1 && message.content[0].type === 'text' && message.content[0].text === ticket.text
      && authorize(agent, [message]);
  }
  const returns = createGptReturns(ctx, lifetime.signal, async (agent, text, signal, childId) => {
    if (signal.aborted || authInFlight || ctx.agents.get(agent.id) !== agent || agent.model.current()?.provider !== GOOGLE) return;
    for (const [id, ticket] of returnTickets) if (ticket.deadline <= Date.now() || ticket.signal.aborted) revokeReturn(id, ticket);
    if (returnTickets.size >= 32) return;
    const requestId = `${GPT_RETURN_PREFIX}${randomUUID()}`;
    const ticket = { agent, text, signal, childId, deadline: Date.now() + 30 * 60_000 };
    ticket.timer = setTimeout(() => revokeReturn(requestId, ticket), 30 * 60_000).unref();
    returnTickets.set(requestId, ticket);
    try {
      const result = await ctx.get('sessionController').prompt({ sessionId: agent.id, requestId, mode: 'queue',
        content: [{ type: 'text', text }] }, signal);
      if (result?.accepted !== true || returnTickets.get(requestId) !== ticket) revokeReturn(requestId, ticket);
    } catch { revokeReturn(requestId, ticket); }
  });
  function forgetReturn(id) {
    clearTimeout(returnTickets.get(id)?.timer);
    returnTickets.delete(id);
  }
  function revokeReturn(id, ticket) {
    forgetReturn(id);
    const inbox = ticket.agent.inbox;
    try {
      for (const message of [...inbox.nextTurn, ...inbox.nextStep]) {
        if (returnIdOf(message) === id) inbox.remove(message.id);
      }
    } catch { /* Agent already disposed. */ }
  }
  function cancelReturns(id) {
    returns.cancel(id);
    for (const [key, ticket] of returnTickets) if (ticket.agent.id === id || ticket.childId === id) revokeReturn(key, ticket);
  }
  const allowedMcp = config.mcp ?? ['knowledge', 'windows', 'playwright'];
  let catalog, images = false, loading, authInFlight;
  let status = 'unchecked';

  function refresh(options, imageSupport = false, notify = true, reasoning = new Map()) {
    const next = modelRows(options, imageSupport, reasoning);
    const changed = JSON.stringify(catalog) !== JSON.stringify(next);
    catalog = next;
    images = imageSupport;
    status = next.length ? 'ready' : 'unavailable';
    if (notify && changed && !lifetime.signal.aborted) ctx.emit('llm/models-updated', GOOGLE);
  }

  async function inspect(force = false) {
    if (!loading && (force || !catalog) && !lifetime.signal.aborted) {
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
              // and use only the known 1.5.12 fallback for unconfirmed models.
              if (!session.options) break;
            }
          }
          refresh(initial, session.capabilities?.promptCapabilities?.image === true, force, reasoning);
        } catch (error) {
          refresh(undefined, false, force);
          const { code } = asLocalError(error);
          status = code === 'AGY_LOGIN_REQUIRED' ? 'signed-out' : code === 'AGY_CLI_UNAVAILABLE' ? 'missing-cli' : 'unavailable';
        } finally { await session?.close().catch(() => {}); }
      })().finally(() => { loading = undefined; });
    }
    await loading;
    return { status, modelCount: catalog?.length ?? 0 };
  }

  async function closeChat(chat) {
    const { session, bridge } = chat;
    chat.session = chat.bridge = undefined;
    bridge?.setTurn(undefined);
    await Promise.allSettled([session?.close(), bridge?.close()]);
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
    if ([...chats.values()].some(chat => chat.running)) {
      throw new LlmError('当前有正在进行的 Gemini 对话，请等本轮回复完成后再退出登录。', 'AGY_BUSY');
    }
    if (typeof runtime.logout !== 'function') throw new LlmError('当前环境不支持在 DSH 内退出 Google 登录。', 'AGY_AUTH_UNSUPPORTED');
    const signal = requestSignal ? AbortSignal.any([requestSignal, lifetime.signal]) : lifetime.signal;
    authInFlight = (async () => {
      returns.cancelAll();
      returnTickets.clear();
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
      if (!agent || request.purpose || agent.session.header.origin === 'subagent') {
        throw new LlmError('Google 订阅只用于本机普通聊天。', 'AGY_CHAT_ONLY');
      }
      const { openTurnStartSeq: start, lastStepStartSeq: step, lastTurn: turn } = ctx.agents.turnBoundaryOf(agent.session);
      const messages = start === null || step === null || step < start ? [] : localSubmissions(agent.session, step);
      const callbackMessages = messages.filter(returnIdOf);
      if (!messages.length || !authorize(agent, messages) || !callbackMessages.every(message => validReturn(agent, message))) {
        throw new LlmError('请由本人发起新的聊天消息后再使用 Gemini。', 'AGY_CHAT_ONLY');
      }
      // Consume before the first await. Even a failed or retried ACP step cannot replay it.
      for (const message of callbackMessages) forgetReturn(returnIdOf(message));
      const reviewOnly = callbackMessages.length > 0;
      const chat = chats.get(id) ?? { running: false };
      if (chat.running) throw new LlmError('请等本轮 Google 回复完成。', 'AGY_BUSY');
      if (chat.attemptedStep === step) throw new LlmError('这条消息已交给 Gemini，DSH 不会重复发送。', 'AGY_NO_RESEND');
      chat.running = true;
      chats.set(id, chat);
      const cancellation = new AbortController();
      chat.cancel = () => cancellation.abort();
      const signal = AbortSignal.any([cancellation.signal, lifetime.signal, ...(request.signal ? [request.signal] : [])]);
      let task, toolSet, finished = false, failure, outcome;
      const chunks = [];
      let pulse = Promise.withResolvers();
      const stopWaiting = () => pulse.resolve();
      signal.addEventListener('abort', stopWaiting, { once: true });
      const push = (kind, value) => { if (!signal.aborted) { chunks.push({ kind, value }); pulse.resolve(); } };
      try {
        signal.throwIfAborted();
        await inspect();
        if (!catalog?.some(model => model.id === request.model)) {
          const code = status === 'signed-out' ? 'auth-required' : status === 'missing-cli' ? 'missing-cli'
            : status === 'ready' ? 'model-unavailable' : 'connection-failed';
          throw asLocalError({ code });
        }
        const { cwd, mode: grantedMode } = executionPolicy(agent, ctx);
        const mode = reviewOnly ? 'read-only' : grantedMode;
        const preset = composedPreset(ctx, agent);
        const persona = preset === WRITING_PRESET ? WRITING_PERSONA : undefined;
        if (!isLocalAgyPath(cwd) || !(await stat(cwd).catch(() => undefined))?.isDirectory()) throw Object.assign(new Error('Invalid cwd'), { code: 'workspace-unavailable' });
        const samePolicy = () => {
          const current = executionPolicy(agent, ctx);
          return current.mode === grantedMode && current.cwd === cwd && composedPreset(ctx, agent) === preset;
        };
        const blocks = await localPrompt(messages.flatMap(message => message.content), ctx.get('attachments'), signal);
        const toolsService = ctx.get('tools');
        const allowBridge = ['full', 'review'].includes(mode);
        // Child output is data to review, not authorization for another action.
        const useMcp = !reviewOnly && toolsService && allowedMcp.length && allowBridge;
        if (useMcp) toolSet = await toolsService.resolve({ agent, signal, modelSelection: {
          provider: GOOGLE, model: request.model, reasoningEffort: request.reasoningEffort,
        } });
        const tools = useMcp ? agyMcpTools(ctx, agent, toolSet, allowedMcp) : new Map();
        const fromOwnerPrompt = messages.some(message => typeof message.source?.rpcId === 'string' && !returnIdOf(message));
        const builtinTools = !reviewOnly && allowBridge && config.gptBridge !== false
          ? agyGptBridgeTools(ctx, { notify: fromOwnerPrompt ? returns.watch : undefined, cancelReturns }) : new Map();
        let dispatched = false;
        const mcpTurn = { agent, tools, builtinTools, toolSet, signal, canCall: () => dispatched && samePolicy() };
        const routeKey = JSON.stringify([mode, preset, persona, [...tools.keys(), ...builtinTools.keys()].sort()]);
        if (chat.session && (!chat.session.options || chat.routeKey !== routeKey || !sameAgyPath(chat.cwd, cwd))) await closeChat(chat);
        const createdAt = agent.session.header.createdAt;
        const stored = chat.binding ?? await runtime.readBinding?.(id);
        const binding = stored?.createdAt === createdAt ? stored : undefined;
        if (!chat.session) {
          if (tools.size || builtinTools.size) chat.bridge = await openAgyMcp(ctx);
          chat.bridge?.setTurn(mcpTurn);
          const open = officialId => runtime.open(signal, { id, cwd, mode, officialId, persona, mcpServers: chat.bridge?.servers,
            onPermission: (params, control) => permission(ctx, agent, params, control) });
          let throughTurn = 0;
          if (binding?.officialId && binding.persona === persona && sameAgyPath(binding.cwd, cwd)) {
            try { chat.session = await open(binding.officialId); throughTurn = binding.throughTurn; }
            catch (error) { signal.throwIfAborted(); if (!canLoadFallback(error)) throw error; }
          }
          chat.session ??= await open();
          chat.cwd = cwd;
          chat.routeKey = routeKey;
          chat.binding = { createdAt, cwd, officialId: chat.session.id, throughTurn, ...(persona ? { persona } : {}) };
          if (chat.session.id) await runtime.writeBinding?.(id, chat.binding);
        } else chat.bridge?.setTurn(mcpTurn);
        const { model, reasoningEffort } = request;
        if (reasoningEffort !== undefined && chat.session.options.model.currentValue !== model) {
          // Switch the model first: the previous model's levels are not authoritative.
          await chat.session.prepare({ model }, signal);
        }
        const liveEfforts = reasoningOf(chat.session.options?.thoughtLevel)?.efforts;
        await chat.session.prepare({ model, reasoningEffort: compatibleEffort(reasoningEffort, liveEfforts) }, signal);
        const contextText = await prepareLocalHistory(agent.session, start, chat.binding.throughTurn, {
          archivePath: runtime.historyArchivePath?.(id),
        });
        chat.attemptedStep = step;
        task = chat.session.runTurn(blocks, { contextText, signal, onDelta: value => push('text', value),
          beforeDispatch() { if (!samePolicy()) throw new Error('DSH execution policy changed'); },
          onDispatch() { dispatched = true; },
          onThought: value => push('thought', value), onTool: value => push('tool', value),
        }).then(value => { outcome = value; }, error => { failure = error; }).finally(() => { finished = true; pulse.resolve(); });
        const progress = agyProgress();
        while (!finished || chunks.length) {
          signal.throwIfAborted();
          if (!chunks.length) { await pulse.promise; pulse = Promise.withResolvers(); continue; }
          yield* progress.push(chunks.shift());
        }
        signal.throwIfAborted();
        if (failure) throw failure;
        if (outcome?.status === 'interrupted') throw new LlmError('Google Antigravity 中止了这轮回复。', 'AGY_INTERRUPTED');
        if (!progress.hasAnswer) {
          const receipt = progress.receipt();
          if (!receipt) throw new LlmError('Google Antigravity 没有返回正文。', 'AGY_EMPTY_RESPONSE');
          yield* progress.push({ kind: 'text', value: receipt });
        }
        yield* progress.close();
        chat.binding = { ...chat.binding, throughTurn: turn };
        if (chat.binding.officialId) await runtime.writeBinding?.(id, chat.binding).catch(() => {
          ctx.logger.warn('Could not update the Antigravity conversation checkpoint.');
        });
        const usage = agyUsage(outcome?.usage);
        if (usage) yield { type: 'usage', usage };
        yield { type: 'finish', reason: { kind: outcome?.stopReason === 'max_tokens' ? 'max-tokens' : 'stop' } };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        await closeChat(chat);
        throw asLocalError(error);
      } finally {
        cancellation.abort();
        signal.removeEventListener('abort', stopWaiting);
        await task;
        chat.bridge?.setTurn(undefined);
        toolSet?.dispose();
        if (failure || !chat.session?.options) await closeChat(chat);
        chat.running = false;
        chat.cancel = undefined;
      }
    }
  }

  ctx.effect(() => ctx.llm.registerAdapter([GOOGLE], new LocalGoogle()));
  // A queued callback must not turn into an ordinary prompt if the user
  // changes models before it is claimed, nor wake Gemini after a restart.
  ctx.on('agent/pre-step', ({ agent, messages, modelSelection }, next) => {
    const invalid = messages.filter(message => returnIdOf(message)
      && (modelSelection.provider !== GOOGLE || !validReturn(agent, message)));
    if (!invalid.length) return next();
    for (const message of invalid) {
      const id = returnIdOf(message);
      if (returnTickets.get(id)?.agent === agent) forgetReturn(id);
    }
    if (invalid.length === messages.length) return Promise.resolve({ kind: 'reject' });
    return Promise.resolve(next()).then(decision => decision.kind === 'reject' ? decision : {
      ...decision, messages: decision.messages.filter(message => !invalid.some(row => row.id === message.id)),
    });
  }, { global: true, prepend: true });
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    const id = returnIdOf(message);
    if (returnTickets.get(id)?.agent === agent) forgetReturn(id);
  }, { global: true });
  ctx.on('session/disposed', session => cancelReturns(session.id), { global: true });
  ctx.on('agent/disposed', ({ agent }) => {
    cancelReturns(agent.id);
    const chat = chats.get(agent.id);
    if (chat) { chats.delete(agent.id); chat.cancel?.(); void closeChat(chat); }
  }, { global: true });
  ctx.effect(() => async () => {
    lifetime.abort();
    await returns.drain();
    // Withdraw any queued callbacks before the one-time gate is unloaded.
    for (const [id, ticket] of returnTickets) revokeReturn(id, ticket);
    await Promise.allSettled([...chats.values()].map(closeChat));
    await runtime.dispose();
    chats.clear();
  }, 'Google subscription ACP');
  return { inspect, login, logout, fetchQuota };
}
