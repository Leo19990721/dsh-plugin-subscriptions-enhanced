const statusLabels = {
  pending: '等候', in_progress: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消',
};

const cleanLine = (value, limit) => typeof value === 'string'
  ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, limit) : '';

const driveFileUri = /^file:\/{2,3}(?=[a-z]:\/)/i;
const escapable = /[!-/:-@\[-`{-~]/;

function localDestination(destination) {
  if (!driveFileUri.test(destination)) return destination;
  const path = destination.replace(driveFileUri, '');
  const file = path.split('#', 1)[0];
  // DSH separates the line fragment, then decodes the path once. Keep percent
  // escapes on the wire, including escapes for literal %, #, and parentheses.
  try {
    if (file.includes('?') || /[\u0000-\u001f\u007f]/.test(decodeURIComponent(file))) return destination;
  } catch (_error) { return destination; } // Ambiguous escapes cannot name a local file.
  return path.replace(/ /g, '%20');
}

function localLink(raw) {
  const match = /^(\([ \t]*)(<[^>]*>|.*?)([ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?([ \t]*\))$/.exec(raw);
  if (!match) return raw;
  const [, opening, target, title = '', closing] = match;
  const destination = target.startsWith('<') && target.endsWith('>')
    ? `<${localDestination(target.slice(1, -1))}>` : localDestination(target);
  return opening + destination + title + closing;
}

/** Adapt inline links only, retaining unresolved Markdown across ACP deltas. */
function answerLinks() {
  let pending = '', lineStart = true, inline = 0, fence, label, bang = false, link;
  const labels = [];
  return (value, end = false) => {
    pending += value;
    let i = 0, start = 0, out = '';
    while (i < pending.length) {
      const c = pending[i];
      if (link) {
        // Track a destination's own delimiters so an ordinary URL or a link
        // title cannot contain a nested candidate that we accidentally rewrite.
        let j = i + link.next;
        for (; j < pending.length; j++) {
          const ch = pending[j];
          if (ch === '\r' || ch === '\n') break;
          if (ch === '\\') {
            if (j + 1 === pending.length && !end) break;
            if (escapable.test(pending[j + 1] ?? '')) { j++; continue; }
          }
          if (link.quote) {
            if (ch === link.quote) link.quote = undefined;
            continue;
          }
          if (!link.started && ch !== ' ' && ch !== '\t') {
            link.started = true;
            if (ch === '<') { link.quote = '>'; continue; }
          }
          if (link.depth === 1 && (ch === '"' || ch === "'") && /[ \t]/.test(pending[j - 1])) {
            link.quote = ch;
          } else if (ch === '(') link.depth++;
          else if (ch === ')' && --link.depth === 0) {
            const raw = pending.slice(i, ++j);
            out += pending.slice(start, i) + (link.image ? raw : localLink(raw));
            start = j;
            break;
          }
        }
        if (!end && link.depth && (j === pending.length || pending[j] === '\\')) {
          link.next = j - i;
          break;
        }
        i = j;
        link = undefined;
        continue;
      }
      if (lineStart) {
        // A fence may start in a block quote or after up to three spaces.
        const prefix = /^(?: {0,3}>[ \t]?)* {0,3}/.exec(pending.slice(i))[0].length;
        const at = i + prefix;
        if (at === pending.length && !end) break;
        const mark = pending[at];
        if ((mark === '`' || mark === '~') && (!fence || fence.mark === mark)) {
          let after = at + 1;
          while (pending[after] === mark) after++;
          if (after === pending.length && !end) break;
          const width = after - at;
          if (width >= (fence?.width ?? 3)) {
            const tail = /^[^\r\n]*/.exec(pending.slice(after))[0];
            if (after + tail.length === pending.length && !end) break;
            if (fence ? /^[ \t]*$/.test(tail) : mark !== '`' || !tail.includes('`')) {
              fence = fence ? undefined : { mark, width };
              inline = labels.length = 0;
              label = undefined;
              bang = false;
              i = after + tail.length;
              lineStart = false;
              continue;
            }
          }
        }
        if (mark === '\r' || mark === '\n') {
          inline = labels.length = 0;
          label = undefined;
          bang = false;
        }
        lineStart = false;
      }
      if (c === '\n' || c === '\r') {
        // In CRLF, only LF begins the next physical line.
        if (c === '\r' && i + 1 === pending.length && !end) break;
        if (c === '\n' || pending[i + 1] !== '\n') lineStart = true;
        label = undefined;
        bang = false;
      } else if (!fence) {
        if (c === '`') {
          let after = i + 1;
          while (pending[after] === '`') after++;
          if (after === pending.length && !end) break;
          const width = after - i;
          if (!inline || width === inline) inline = inline ? 0 : width;
          i = after;
          label = undefined;
          bang = false;
          continue;
        }
        if (!inline) {
          if (c === '\\') {
            if (i + 1 === pending.length && !end) break;
            if (escapable.test(pending[i + 1] ?? '')) i++;
          } else if (c === '[') labels.push(bang ? 'image' : 'link');
          else if (c === ']') { label = labels.pop(); bang = false; i++; continue; }
          else if (c === '(' && label) {
            link = { depth: 1, next: 1 };
            if (label === 'image') link.image = true;
            label = undefined;
            continue;
          }
          label = undefined;
          bang = c === '!';
        }
      }
      i++;
    }
    out += pending.slice(start, i);
    pending = pending.slice(i);
    return out;
  };
}

/** Native reasoning stream; tool progress stays display-only and never runs again in DSH. */
export function agyProgress() {
  const tools = new Map();
  let open, nextIndex = 0;
  let hasAnswer = false;
  const close = () => {
    if (!open) return [];
    const { index, type, text, latest, normalize } = open;
    open = undefined;
    const tail = normalize?.('', true) ?? '';
    return [...(tail ? [{ type: 'text-delta', index, text: tail }] : []),
      { type: 'block-end', index, block: { type, text: latest ? `${latest}\n\n${text}` : text + tail } }];
  };
  function append(type, key, text) {
    const chunks = [];
    if (open?.key !== key) {
      chunks.push(...close());
      open = { index: nextIndex++, type, key, text: '', normalize: key === 'answer' ? answerLinks() : undefined };
      chunks.push({ type: 'block-start', index: open.index, blockType: type });
    }
    text = open.normalize ? open.normalize(text) : text;
    open.text += text;
    if (text) chunks.push({ type: `${type}-delta`, index: open.index, text });
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

export function agyUsage(usage, contextUsage) {
  const number = (source, key) => Number.isSafeInteger(source?.[key]) && source[key] >= 0 ? source[key] : undefined;
  const rawInput = number(usage, 'inputTokens'), outputTokens = number(usage, 'outputTokens');
  const liveUsed = number(contextUsage, 'used');
  if (rawInput === undefined && liveUsed === undefined) return;
  const read = number(usage, 'cachedReadTokens') ?? 0;
  const write = number(usage, 'cachedWriteTokens') ?? 0;
  const out = outputTokens ?? 0;
  // DSH computes prompt pressure as inputTokens + cacheReadTokens + cacheWriteTokens.
  // ACP inputTokens already includes cachedReadTokens (and sums across tool loops).
  const uncachedRaw = rawInput !== undefined ? (read <= rawInput ? rawInput - read : rawInput) : 0;
  const totalPromptRaw = uncachedRaw + read + write;
  let inputTokens = uncachedRaw;
  let cacheReadTokens = read;
  let cacheWriteTokens = write;
  if (liveUsed !== undefined) {
    if (totalPromptRaw > 0 && liveUsed < totalPromptRaw) {
      const ratio = liveUsed / totalPromptRaw;
      cacheReadTokens = Math.min(liveUsed, Math.round(read * ratio));
      cacheWriteTokens = Math.min(liveUsed - cacheReadTokens, Math.round(write * ratio));
      inputTokens = Math.max(0, liveUsed - cacheReadTokens - cacheWriteTokens);
    } else if (totalPromptRaw === 0) {
      inputTokens = liveUsed;
    }
  }
  const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + out;
  return {
    inputTokens, outputTokens: out,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(totalTokens >= inputTokens + out ? { totalTokens } : {}),
  };
}
