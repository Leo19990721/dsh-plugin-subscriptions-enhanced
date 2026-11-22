import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';

const DEFAULT_PROVIDER = 'codex';
const DEFAULT_MODEL = 'gpt-6.2-sol';
const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 300;
const MAX_REPLY_CHARS = 40_000;
const MAX_LIST_LIMIT = 50;

export function isForbiddenGptProvider(provider) {
  if (typeof provider !== 'string') return false;
  const normalized = provider.trim().toLowerCase();
  return normalized === 'antigravity' || normalized.startsWith('turn:antigravity');
}

function clampTimeoutMs(timeoutSec) {
  const sec = typeof timeoutSec === 'number' && Number.isFinite(timeoutSec)
    ? Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(timeoutSec)))
    : DEFAULT_TIMEOUT_SEC;
  return sec * 1000;
}

function trimReply(text, max = MAX_REPLY_CHARS) {
  if (!text || text.length <= max) return text;
  const head = Math.floor(max * 0.45);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[... truncated ${text.length - max} chars ...]\n\n${text.slice(-tail)}`;
}

function extractTextBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}

export function extractAssistantReplies(records) {
  if (!Array.isArray(records) || !records.length) return { reply: '', messageCount: 0, interrupted: false };
  const sorted = records
    .map(record => record?.event ?? record)
    .filter(event => event?.type === 'assistant/message')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (!sorted.length) return { reply: '', messageCount: 0, interrupted: false };
  const parts = [];
  let interrupted = false;
  for (const event of sorted) {
    const data = event.data ?? {};
    if (data.interrupted) interrupted = true;
    const text = extractTextBlocks(data.message?.content);
    if (text) parts.push(text);
  }
  return {
    reply: trimReply(parts.join('\n\n')),
    messageCount: sorted.length,
    interrupted,
  };
}

function titleModelLabel(id) {
  const name = id?.split('/').at(-1)?.toLowerCase() ?? '';
  if (/^(?:gpt|codex|openai)(?:$|[-.\s\d])/u.test(name)) return 'GPT';
  if (/^(?:claude|anthropic)(?:$|[-.\s\d])/u.test(name)) return 'Claude';
  if (/^deepseek(?:$|[-.\s\d])/u.test(name)) return 'DeepSeek';
  if (/^gemini(?:$|[-.\s\d])/u.test(name)) return 'Gemini';
  if (/^(?:grok|xai)(?:$|[-.\s\d])/u.test(name)) return 'Grok';
  if (/^qwen(?:$|[-.\s\d])/u.test(name)) return 'Qwen';
}

function formatTitle(requestedTitle, prompt, { provider, model }, inGptWorkspace) {
  const label = titleModelLabel(model) ?? titleModelLabel(provider) ?? model ?? provider;
  const stripModelMarkers = value => {
    let base = value.trim().replace(/^(?:\[GPT\]\s*)+/iu, '');
    while (true) {
      const suffix = /(?:（([^（）]+)）|\(([^()]+)\))$/u.exec(base);
      if (!suffix) break;
      const marker = (suffix[1] ?? suffix[2]).trim();
      if (!titleModelLabel(marker) && ![label, model, provider].some(id => id?.toLowerCase() === marker.toLowerCase())) break;
      base = base.slice(0, suffix.index).trimEnd();
    }
    return base;
  };
  const base = stripModelMarkers(typeof requestedTitle === 'string' ? requestedTitle : '')
    || stripModelMarkers(prompt.replace(/\s+/gu, ' ')).slice(0, 42).trimEnd()
    || 'Parallel Task';
  const suffix = inGptWorkspace ? '' : `（${label}）`;
  return `${base.slice(0, Math.max(0, 80 - suffix.length)).trimEnd()}${suffix}`;
}

async function resolveTargetSelection(ctx, { provider, model, reasoningEffort }) {
  const requestedProvider = typeof provider === 'string' && provider.trim() ? provider.trim() : undefined;
  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : undefined;
  const effort = typeof reasoningEffort === 'string' && reasoningEffort.trim() ? reasoningEffort.trim() : undefined;
  if (isForbiddenGptProvider(requestedProvider)) {
    throw new Error('Delegation to Google Antigravity is forbidden. Use a non-Google provider such as "codex".');
  }

  const llm = ctx.get('llm');
  const providers = (llm?.listProviders?.() ?? []).map(p => p.id).filter(id => !isForbiddenGptProvider(id));

  let chosenProvider = requestedProvider;
  let chosenModel = requestedModel;

  if (!chosenProvider && !chosenModel) {
    if (providers.includes(DEFAULT_PROVIDER)) {
      chosenProvider = DEFAULT_PROVIDER;
      const models = await llm.listModels(DEFAULT_PROVIDER).catch(() => []);
      chosenModel = models.some(m => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.id ?? DEFAULT_MODEL;
    } else {
      for (const candidate of providers) {
        const models = await llm.listModels(candidate).catch(() => []);
        if (models.length) {
          chosenProvider = candidate;
          chosenModel = models[0].id;
          break;
        }
      }
    }
  } else if (chosenProvider && !chosenModel) {
    const models = await llm?.listModels?.(chosenProvider).catch(() => []) ?? [];
    if (!models.length) throw new Error(`Provider "${chosenProvider}" has no available models.`);
    chosenModel = chosenProvider === DEFAULT_PROVIDER && models.some(m => m.id === DEFAULT_MODEL)
      ? DEFAULT_MODEL : models[0].id;
  } else if (!chosenProvider && chosenModel) {
    if (providers.includes(DEFAULT_PROVIDER)) {
      const codexModels = await llm.listModels(DEFAULT_PROVIDER).catch(() => []);
      if (codexModels.some(m => m.id === chosenModel)) chosenProvider = DEFAULT_PROVIDER;
    }
    if (!chosenProvider) {
      for (const candidate of providers) {
        const models = await llm.listModels(candidate).catch(() => []);
        if (models.some(m => m.id === chosenModel)) {
          chosenProvider = candidate;
          break;
        }
      }
    }
    chosenProvider ??= DEFAULT_PROVIDER;
  }

  if (!chosenProvider || !chosenModel) {
    throw new Error('No non-Google DSH model provider is currently available.');
  }
  if (isForbiddenGptProvider(chosenProvider)) {
    throw new Error('Delegation to Google Antigravity is forbidden.');
  }
  return {
    provider: chosenProvider,
    model: chosenModel,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

async function applySessionModel(ctx, controller, sessionId, selection) {
  if (typeof controller.resolveAgent === 'function') {
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved && 'error' in resolved) throw resolved.error;
    const agent = resolved?.agent ?? resolved;
    if (agent?.model?.select) {
      if (ctx.get('llm')?.resolveCallConfig) await ctx.get('llm').resolveCallConfig(selection);
      agent.model.select(selection);
      return selection;
    }
  }
  const result = await controller.selectModel({ sessionId, ...selection });
  return result?.selected ?? selection;
}

async function readSessionSummary(ctx, controller, sessionId, signal) {
  const [state, page, projections] = await Promise.all([
    controller.state({ sessionId }, signal),
    (controller.events ?? controller.page).call(controller, { address: { kind: 'session', sessionId }, maxMessages: 8 }, signal).catch(() => undefined),
    controller.projections?.({ sessionId }, signal).catch(() => undefined),
  ]);
  const liveAgent = ctx.get('agents')?.get(sessionId);
  const model = liveAgent?.model?.current?.();
  const title = projections?.values?.title ?? null;
  const extracted = extractAssistantReplies(page?.records ?? []);
  const latest = extracted.reply ? trimReply(extracted.reply, 6000) : '';
  return {
    sessionId,
    title,
    status: state.running ? 'running' : state.pendingInput?.length ? 'input-required' : 'idle',
    running: state.running,
    active: state.active,
    cursor: state.cursor,
    pendingInput: state.pendingInput ?? [],
    queueLength: state.queue?.length ?? 0,
    ...(model ? { model } : {}),
    latestReplyPreview: latest,
  };
}

async function waitForSession(controller, sessionId, afterSeq, timeoutMs, signal) {
  const waited = await controller.wait({
    sessionId,
    timeoutMs,
    ...(typeof afterSeq === 'number' && Number.isSafeInteger(afterSeq) && afterSeq >= -1 ? { afterSeq } : {}),
    maxMessages: 12,
  }, signal);
  let extracted = extractAssistantReplies(waited?.output?.records ?? []);
  if (!extracted.reply && waited?.reason === 'idle') {
    const fallbackPage = await (controller.events ?? controller.page)
      .call(controller, { address: { kind: 'session', sessionId }, maxMessages: 6 }, signal)
      .catch(() => undefined);
    extracted = extractAssistantReplies(fallbackPage?.records ?? []);
  }
  return {
    sessionId,
    reason: waited.reason,
    status: waited.state?.running ? 'running' : waited.reason === 'input-required' ? 'input-required' : 'idle',
    cursor: waited.state?.cursor,
    pendingInput: waited.state?.pendingInput ?? [],
    reply: extracted.reply,
    interrupted: extracted.interrupted,
    truncated: Boolean(waited?.output?.truncated),
  };
}

async function workspaceForDelegation(ctx, parentSessionId, requestedCwd) {
  const registry = ctx.get('workspaceRegistry');
  if (requestedCwd) {
    // The installed registry canonicalizes its lookup; it never matches ancestors.
    const explicit = await registry?.resolveByPath(requestedCwd);
    if (explicit?.id) return explicit;
  }

  // Retained workspace membership can outlive a missing directory. Verify both
  // directory availability and identity before choosing a listed workspace.
  const usable = async workspace => workspace?.id
    && (await stat(workspace.path).catch(() => undefined))?.isDirectory()
    && (await registry.resolveByPath(workspace.path).catch(() => undefined))?.id === workspace.id;
  for (const workspace of registry?.list() ?? []) {
    if (workspace.title === 'GPT' && await usable(workspace)) return workspace;
  }

  let cause;
  try {
    const home = homedir();
    if (!isLocalAgyPath(home) || typeof registry?.create !== 'function') throw new Error('GPT workspace registration is unavailable.');
    const gptPath = join(home, '.dsh', 'workspaces', 'GPT');
    await mkdir(gptPath, { recursive: true });
    const workspace = await registry.resolveByPath(gptPath) ?? await registry.create(gptPath, 'GPT');
    if (!workspace?.id) throw new Error('GPT workspace registration returned no workspace ID.');
    return workspace;
  } catch (error) {
    cause = error;
  }

  const parent = registry?.list().find(ws => ws.sessionIds.includes(parentSessionId));
  if (await usable(parent)) return parent;
  throw new Error('Unable to prepare the GPT workspace and no usable parent workspace is available; no session was created.', { cause });
}

/** Built-in MCP tools mounted inside the local agy bridge so Gemini can orchestrate parallel DSH GPT sessions. */
export function agyGptBridgeTools(ctx) {
  const controller = ctx.get('sessionController');
  if (!controller) return new Map();

  const tools = [
    {
      name: 'dsh_delegate_gpt',
      description: 'Create or continue a parallel DSH session powered by GPT/Codex (or another non-Google DSH model; Google Antigravity is strictly forbidden). The session appears in the DSH sidebar and DSH Go. Use this to run heavy coding, debugging, or research tasks in parallel.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', description: 'The task or follow-up message to send to the parallel GPT session.' },
          sessionId: { type: 'string', description: 'Existing parallel DSH session ID to continue. Omit to create a new session.' },
          title: { type: 'string', description: 'Short title for a new session. Legacy model markers are removed. A model suffix (e.g. Task（GPT）) is added unless the workspace directory is named GPT.' },
          cwd: { type: 'string', description: 'Absolute local directory for a new session. Used only if it exactly matches a registered DSH workspace. Otherwise the session runs in the GPT workspace, or the parent workspace if GPT setup fails.' },
          provider: { type: 'string', description: 'DSH model provider (default "codex"). "antigravity" is forbidden.' },
          model: { type: 'string', description: 'Model ID (default "gpt-6.2-sol" when Codex is available).' },
          reasoningEffort: { type: 'string', description: 'Optional reasoning effort such as "medium", "high", or "xhigh".' },
          wait: { type: 'boolean', description: 'If true, wait for the turn to settle (up to timeoutSec) before returning. Default false for parallel execution.' },
          timeoutSec: { type: 'number', description: 'Wait timeout in seconds when wait is true (5-300, default 120).' },
        },
      },
      async execute(args, turn, signal) {
        const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) throw new Error('prompt must be a non-empty string.');
        if (isForbiddenGptProvider(args?.provider)) {
          throw new Error('Delegation to Google Antigravity is forbidden. Use a non-Google provider such as "codex".');
        }
        const existingId = typeof args?.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : undefined;
        if (existingId && existingId === turn.agent.id) {
          throw new Error('Cannot delegate to the current Gemini session itself. Omit sessionId to create a new parallel session.');
        }

        let sessionId = existingId;
        let title;
        let selection;
        let afterSeq = -1;

        if (!sessionId) {
          const requestedCwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
          if (requestedCwd) {
            if (!isLocalAgyPath(requestedCwd) || !(await stat(requestedCwd).catch(() => undefined))?.isDirectory()) {
              throw new Error(`Invalid or unavailable working directory: ${requestedCwd}`);
            }
          }
          selection = await resolveTargetSelection(ctx, args);
          const workspace = await workspaceForDelegation(ctx, turn.agent.id, requestedCwd);
          const inGptWorkspace = sameAgyPath(basename(workspace.path), 'GPT');
          // DSH derives the new session cwd from workspace.path and attaches it
          // to that workspace. A cwd-only request would not attach it.
          const created = await controller.create({ sessionId: `session-${randomUUID()}`, workspaceId: workspace.id });
          sessionId = created.sessionId;
          selection = await applySessionModel(ctx, controller, sessionId, selection);
          title = formatTitle(args?.title, prompt, selection, inGptWorkspace);
          await controller.rename?.({ sessionId, title }).catch(() => {});
        } else {
          const stateBefore = await controller.state({ sessionId }, signal);
          afterSeq = stateBefore?.cursor ?? -1;
          const liveAgent = ctx.get('agents')?.get(sessionId);
          const currentModel = liveAgent?.model?.current?.();
          if (args?.provider || args?.model || args?.reasoningEffort) {
            selection = await resolveTargetSelection(ctx, {
              provider: args?.provider ?? (isForbiddenGptProvider(currentModel?.provider) ? undefined : currentModel?.provider),
              model: args?.model ?? (isForbiddenGptProvider(currentModel?.provider) ? undefined : currentModel?.model),
              reasoningEffort: args?.reasoningEffort,
            });
            selection = await applySessionModel(ctx, controller, sessionId, selection);
          } else {
            if (isForbiddenGptProvider(currentModel?.provider)) {
              throw new Error('Target session is currently set to Google Antigravity. Specify a non-Google provider/model or create a new session.');
            }
            if (typeof controller.resolveAgent === 'function' && !currentModel) {
              const resolved = await controller.resolveAgent(sessionId);
              const targetAgent = resolved && !('error' in resolved) ? (resolved.agent ?? resolved) : undefined;
              const targetModel = targetAgent?.model?.current?.();
              if (isForbiddenGptProvider(targetModel?.provider)) {
                throw new Error('Target session is currently set to Google Antigravity. Specify a non-Google provider/model or create a new session.');
              }
              selection = targetModel;
            } else {
              selection = currentModel;
            }
          }
        }

        await controller.prompt({
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, signal);

        if (args?.wait === true) {
          const waited = await waitForSession(controller, sessionId, afterSeq, clampTimeoutMs(args?.timeoutSec), signal);
          return {
            ...waited,
            ...(title ? { title } : {}),
            ...(selection ? { selection } : {}),
            afterSeq,
          };
        }

        return {
          sessionId,
          ...(title ? { title } : {}),
          ...(selection ? { selection } : {}),
          afterSeq,
          status: 'started',
          note: 'Parallel session started and visible in the DSH sidebar. Use dsh_gpt_wait or dsh_gpt_status with this sessionId.',
        };
      },
    },
    {
      name: 'dsh_gpt_wait',
      description: 'Wait for a parallel DSH session to finish its current turn (become idle), need user input, or reach timeoutSec, returning its assistant reply.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', description: 'The parallel DSH session ID returned by dsh_delegate_gpt or dsh_gpt_list.' },
          afterSeq: { type: 'number', description: 'Optional cursor returned by dsh_delegate_gpt to capture only newer assistant messages.' },
          timeoutSec: { type: 'number', description: 'Maximum seconds to wait (5-300, default 120).' },
        },
      },
      async execute(args, turn, signal) {
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) throw new Error('sessionId is required.');
        if (sessionId === turn.agent.id) throw new Error('Cannot wait on the current Gemini session itself.');
        return waitForSession(controller, sessionId, args?.afterSeq, clampTimeoutMs(args?.timeoutSec), signal);
      },
    },
    {
      name: 'dsh_gpt_status',
      description: 'Check the current status (running/idle, pending input, model, title, and latest reply preview) of a parallel DSH session without waiting.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', description: 'The DSH session ID to inspect.' },
        },
      },
      async execute(args, _turn, signal) {
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) throw new Error('sessionId is required.');
        return readSessionSummary(ctx, controller, sessionId, signal);
      },
    },
    {
      name: 'dsh_gpt_list',
      description: 'List recent non-archived DSH sessions (ID, title, cwd, running state, updatedAt) to inspect or continue parallel work.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'number', description: 'Maximum sessions to return (1-50, default 20).' },
          cwd: { type: 'string', description: 'Optional working directory filter.' },
        },
      },
      async execute(args, turn, signal) {
        const limit = typeof args?.limit === 'number' && Number.isFinite(args.limit)
          ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.round(args.limit)))
          : 20;
        const filterCwd = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
        const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? []);
        const listed = await controller.list({}, signal);
        const items = (listed?.items ?? [])
          .filter(item => item.origin !== 'subagent' && !archived.has(item.sessionId))
          .filter(item => !filterCwd || (item.cwd && sameAgyPath(item.cwd, filterCwd)))
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, limit)
          .map(item => ({
            sessionId: item.sessionId,
            title: item.projections?.values?.title ?? null,
            cwd: item.cwd ?? null,
            running: Boolean(item.running),
            updatedAt: item.updatedAt,
            isCurrentSession: item.sessionId === turn.agent.id,
          }));
        return { sessions: items, totalShown: items.length };
      },
    },
    {
      name: 'dsh_gpt_stop',
      description: 'Cancel the active turn of a running parallel DSH session.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string', description: 'The parallel DSH session ID to cancel.' },
        },
      },
      async execute(args, turn) {
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) throw new Error('sessionId is required.');
        if (sessionId === turn.agent.id) throw new Error('Cannot stop the current Gemini session itself.');
        const result = await controller.cancel({ sessionId });
        return { sessionId, accepted: Boolean(result?.accepted ?? true) };
      },
    },
  ];

  return new Map(tools.map(tool => [tool.name, tool]));
}
