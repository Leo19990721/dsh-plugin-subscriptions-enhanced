const statusLabels = {
  pending: '等候', in_progress: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消',
};

const cleanLine = (value, limit) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, limit) : '';

/** Native reasoning stream; tool progress stays display-only and never runs again in DSH. */
export function agyProgress() {
  const tools = new Map();
  let open, nextIndex = 0;
  let hasAnswer = false;
  const close = () => {
    if (!open) return [];
    const { index, type, text, latest } = open;
    open = undefined;
    return [{ type: 'block-end', index, block: { type, text: latest ? `${latest}\n\n${text}` : text } }];
  };
  function append(type, key, text) {
    const chunks = [];
    if (open?.key !== key) {
      chunks.push(...close());
      open = { index: nextIndex++, type, key, text: '' };
      chunks.push({ type: 'block-start', index: open.index, blockType: type });
    }
    open.text += text;
    chunks.push({ type: `${type}-delta`, index: open.index, text });
    return chunks;
  }
  function tool(update) {
    const previous = tools.get(update.toolCallId) ?? {};
    const title = cleanLine(update.title, 520) || previous.title || cleanLine(update.kind, 40) || 'Antigravity';
    const path = cleanLine(update.locations?.[0]?.path, 520) || previous.path;
    const status = Object.hasOwn(statusLabels, update.status) ? update.status : previous.status ?? 'pending';
    const detail = (Array.isArray(update.content) ? update.content : []).flatMap(item => {
      if (item?.type === 'content' && item.content?.type === 'text') return [cleanLine(item.content.text, 500)];
      if (item?.type === 'diff') return ['文件改动'];
      return [];
    }).filter(Boolean).join(' · ').slice(0, 500);
    if (previous.title === title && previous.path === path && previous.status === status && previous.detail === detail) return [];
    tools.set(update.toolCallId, { title, path, status, detail });
    const target = path && !title.includes(path) ? ` · ${path}` : '';
    // Escape the first-line Markdown as this text is displayed in the native disclosure.
    const literal = value => value.replace(/[\\`*_\[\]<>]/gu, char => `\\${char}`);
    const summary = `工具${statusLabels[status]}：${literal(title + target)}`;
    const chunks = append('reasoning', 'tools', `${summary}\n${detail ? `${literal(detail)}\n` : ''}\n`);
    open.latest = summary;
    return chunks;
  }
  return {
    push({ kind, value }) {
      if (kind === 'tool') return tool(value);
      if (kind === 'thought') return append('reasoning', 'thought', value);
      if (value.trim()) hasAnswer = true;
      return append('text', 'answer', value);
    },
    get hasAnswer() { return hasAnswer; },
    receipt() {
      if (!tools.size) return;
      const statuses = [...tools.values()].map(tool => tool.status);
      const counts = [['已完成', statuses.filter(status => status === 'completed').length],
        ['失败', statuses.filter(status => status === 'failed').length],
        ['已取消', statuses.filter(status => status === 'cancelled').length],
        ['结果未确认', statuses.filter(status => status === 'pending' || status === 'in_progress').length]];
      return `Antigravity 未返回正文。工具：${counts.filter(([, count]) => count).map(([label, count]) => `${label} ${count} 项`).join('，')}。`;
    }, close,
  };
}

export function agyUsage(usage) {
  const number = key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0 ? usage[key] : undefined;
  const inputTokens = number('inputTokens'), outputTokens = number('outputTokens');
  if (inputTokens === undefined || outputTokens === undefined) return;
  const read = number('cachedReadTokens'), write = number('cachedWriteTokens'), total = number('totalTokens');
  // ACP input/output include the observed thought cost; keep it separate only when Google totals reconcile.
  return { inputTokens, outputTokens, ...(read ? { cacheReadTokens: read } : {}), ...(write ? { cacheWriteTokens: write } : {}),
    ...(total !== undefined && total >= inputTokens + outputTokens ? { totalTokens: total } : {}) };
}
