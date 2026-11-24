export const AGY_TOOL_RECORD = 'plugin:subscriptions-enhanced/agy-tool';
export const AGY_TOOL_CARD = 'subscriptions-enhanced-agy-tool';
export const AGY_MAX_TOOL_CALLS = 200;
export const AGY_TOOL_STATUSES = Object.freeze({
  pending: '等候', in_progress: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const control = /[\p{Cc}\p{Cf}]/u;
const kinds = new Set(['read', 'edit', 'write', 'command', 'subagent', 'mcp', 'search', 'other']);
export const agyToolSettled = status => status === 'completed' || status === 'failed' || status === 'cancelled';

// Cap the substring before applying regexes or encoding, then enforce actual
// UTF-8 bytes without splitting a codepoint. Newlines survive only in details.
function agyToolText(value, budget, multiline = false) {
  if (typeof value !== 'string' || !value) return '';
  let result = '', bytes = 0;
  const input = value.slice(0, budget + 1).replace(/\r\n?/g, '\n');
  for (const char of input) {
    const next = control.test(char) && !(multiline && (char === '\n' || char === '\t')) ? ' ' : char;
    const code = next.codePointAt(0);
    const length = code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    if (bytes + length > budget - 3) return result.trim() + '…';
    result += code >= 0xd800 && code <= 0xdfff ? '�' : next;
    bytes += length;
  }
  return result.trim();
}

const field = (value, keys, limit) => {
  for (const key of keys) if (Object.hasOwn(value, key)) {
    const text = agyToolText(value[key], limit);
    if (text) return text;
  }
  return '';
};

function agyToolKind(kind, title, name) {
  const operation = `${name} ${title}`;
  if (/\bmcp_dsh_(?:subagent|send_message|list_agents|wait_agent|list_subagent_models)\b/i.test(operation)
    || /^(?:subagent|invoke_subagent|spawn|agent)$/i.test(kind)) return 'subagent';
  if (/\bmcp[_:]/i.test(operation) || kind === 'mcp') return 'mcp';
  if (kind !== 'other' && kinds.has(kind)) return kind;
  if (['terminal', 'execute', 'run'].includes(kind)) return 'command';
  if (['fetch', 'web_search', 'lookup', 'grep', 'glob'].includes(kind)) return 'search';
  if (['delete', 'move'].includes(kind)) return 'edit';
  if (kind === 'create') return 'write';
  if (/^(?:create|write|save)\b/i.test(title)) return 'write';
  return 'other';
}

function agyDiffLines(value) {
  // Count a bounded prefix, not matching or retaining unbounded file contents.
  if (typeof value !== 'string' || !value) return 0;
  if (value.length > 65_536) return null;
  let count = 1;
  for (let i = 0; i < value.length; i++) if (value[i] === '\n') count++;
  return value.endsWith('\n') ? count - 1 : count;
}

export function summarizeAgyTool(update) {
  if (!record(update) || typeof update.toolCallId !== 'string' || !update.toolCallId
    || update.toolCallId.length > 512 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(update.toolCallId)) return;
  let title = agyToolText(update.title, 540);
  const raw = record(update.rawInput) ? update.rawInput : {};
  const outer = agyToolText(update.name ?? update.toolName, 104);
  let name = field(raw, ['toolName', 'tool', 'name'], 104) || outer;
  // Agy's on-demand invocation wraps the original name in rawInput. Only
  // project the validated identifier, never the serialized arguments.
  const gateway = outer === 'mcp_dsh_tool_call' || /^(?:Run )?mcp_dsh_tool_call$/u.test(title);
  const projectedGatewayName = gateway && typeof raw.name === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(raw.name)
    && !['tool_catalog', 'tool_call'].includes(raw.name);
  if (projectedGatewayName) {
    name = `mcp_dsh_${raw.name}`;
    title = `Run ${name}`;
  }
  const nativePanel = /\bmcp_dsh_(?:todo_write|ask_user_question|present|subagent)\b/i.test(`${name} ${title}`);
  const kind = agyToolText(update.kind, 40).toLowerCase();
  // A partial ACP update may repeat only the gateway name. Do not erase
  // the previously projected identity or native-panel classification.
  const hasIdentity = !gateway || projectedGatewayName;
  const category = hasIdentity && (kind || title || name) ? agyToolKind(kind, title, name) : undefined;
  const status = Object.hasOwn(AGY_TOOL_STATUSES, update.status) ? update.status : undefined;
  const command = field(raw, ['CommandLine', 'commandLine', 'command', 'cmd', 'Command'], 760);
  const path = field(raw, ['TargetFile', 'AbsolutePath', 'FilePath', 'filePath', 'path', 'Path', 'DirectoryPath', 'directory', 'input'], 480);
  const query = field(raw, ['query', 'Query', 'pattern', 'Pattern', 'url', 'URL'], 400);
  const targets = new Set();
  if (Array.isArray(update.locations)) for (const location of update.locations.slice(0, 6)) {
    const path = agyToolText(location?.path, 480);
    if (path) targets.add(Number.isSafeInteger(location.line) && location.line >= 0 ? `${path}:${location.line + 1}` : path);
  }
  if (!targets.size && path) targets.add(path);
  const outputs = [], diffs = [];
  if (Array.isArray(update.content)) for (const item of update.content.slice(0, 8)) {
    if (item?.type === 'diff' && diffs.length < 3) {
      const path = agyToolText(item.path, 360);
      const oldText = item.oldText, newText = item.newText;
      diffs.push({ path, before: agyDiffLines(oldText), after: agyDiffLines(newText),
        oldPreview: agyToolText(oldText, 350, true), newPreview: agyToolText(newText, 350, true) });
    } else if (outputs.length < 3) {
      const text = agyToolText(item?.type === 'content' && item.content?.type === 'text' ? item.content.text
        : item?.type === 'text' ? item.text : '', 700, true);
      if (text) outputs.push(text);
    }
  }
  const target = command || targets.values().next().value || query;
  return { toolCallId: update.toolCallId,
    ...(hasIdentity && (title || name) ? { title: title || name } : {}), ...(category ? { category } : {}), ...(status ? { status } : {}),
    ...(nativePanel ? { nativePanel: true } : {}), ...(target ? { target } : {}), ...(targets.size ? { paths: [...targets].slice(0, 4) } : {}),
    ...(outputs.length ? { output: outputs.join('\n\n') } : {}), ...(diffs.length ? { diffs } : {}),
  };
}

/** Select only the durable display fields even when receiving an opaque replay record. */
export function decodeAgyTool(event) {
  const data = event?.data;
  if (event?.type !== AGY_TOOL_RECORD || event.ignorable !== true || !record(data) || data.version !== 1
    || typeof data.id !== 'string' || data.id.length > 560 || !data.id || control.test(data.id)
    || !Object.hasOwn(AGY_TOOL_STATUSES, data.status) || !kinds.has(data.category)) return;
  const paths = Array.isArray(data.paths) ? data.paths.slice(0, 4).map(path => agyToolText(path, 490)).filter(Boolean) : [];
  const diffs = Array.isArray(data.diffs) ? data.diffs.slice(0, 3).filter(record).map(item => ({
    path: agyToolText(item.path, 360), before: Number.isSafeInteger(item.before) && item.before >= 0 ? item.before : null,
    after: Number.isSafeInteger(item.after) && item.after >= 0 ? item.after : null,
    oldPreview: agyToolText(item.oldPreview, 350, true), newPreview: agyToolText(item.newPreview, 350, true),
  })) : [];
  return { id: data.id, category: data.category, status: data.status, title: agyToolText(data.title, 540) || 'Antigravity',
    target: agyToolText(data.target, 760), output: agyToolText(data.output, 2120, true), paths, diffs,
    startedAt: Number.isSafeInteger(data.startedAt) && data.startedAt >= 0 ? data.startedAt : event.time,
    ...(typeof data.settledAt === 'number' && Number.isSafeInteger(data.settledAt) && data.settledAt >= 0 ? { settledAt: data.settledAt } : {}),
  };
}

export const agyToolSize = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const AGY_TOOL_BYTES = 512 * 1024;
export const AGY_TOOL_UPDATES = 800;
