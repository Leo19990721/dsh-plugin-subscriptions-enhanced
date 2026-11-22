import { pathToFileURL } from 'node:url';
import { agyReadOnlyRef, writeAgyHistoryArchive } from './agy-local-storage.js';

const HISTORY_CHARS = 120_000;
const MESSAGE_CHARS = 24_000;
export const LOCAL_FRAME_BYTES = 16 * 1024 * 1024;
const owner = message => !message.source.principal || message.source.principal.kind === 'owner';
const isUser = message => message?.source?.kind === 'user' && owner(message);
const isNativeDelivery = message => ['agent-message', 'subagent-settled'].includes(message?.source?.kind);
const blocksText = blocks => Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
const textOnly = message => blocksText(message?.content);
const boundText = text => text.length <= MESSAGE_CHARS ? text
  : `${text.slice(0, MESSAGE_CHARS / 2)}\n[... shortened ...]\n${text.slice(-MESSAGE_CHARS / 2)}`;

export function localSubmissions(session, turnStart) {
  return session.snapshotEvents(turnStart).flatMap(event => event.type === 'user/message' && event.surfaceOp === 'append'
    && (isUser(event.data) || isNativeDelivery(event.data)) ? [event.data] : []);
}

function collectHistory(session, before, afterTurn) {
  const finished = [];
  let current;
  let afterTurnEndSeq = -1;
  let latestCompaction;
  const shadowed = new Set();
  for (const event of session.snapshotEvents()) {
    if (event.seq >= before) break;
    const { type, data } = event;
    if (type === 'compaction/summary') {
      const summary = blocksText(data?.summary).trim();
      if (summary) {
        // Endpoints are surface positions and can be reverse-ordered after prior compaction.
        // Only the actual shadowed node IDs, never a numeric interval, identify omitted messages.
        const shadowedSeqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
        for (const seq of shadowedSeqs) if (Number.isSafeInteger(seq) && seq < event.seq) shadowed.add(seq);
        latestCompaction = { seq: event.seq, text: summary };
      }
      continue;
    }
    if (type === 'turn/start') current = data.turn > afterTurn ? { turn: data.turn, rows: [], hasUser: false } : undefined;
    else if (type === 'turn/end') {
      if (data.turn <= afterTurn) afterTurnEndSeq = Math.max(afterTurnEndSeq, event.seq);
      if (current && data.turn === current.turn && ['completed', 'max-tokens'].includes(data.reason?.kind) && current.hasUser && current.rows.length) {
        finished.push({ turn: current.turn, rows: current.rows });
      }
      if (current && data.turn === current.turn) current = undefined;
    } else if (!current) continue;
    else if (event.surfaceOp === 'append') {
      if (type === 'user/message' && (isUser(data) || isNativeDelivery(data))) current.hasUser = true;
      const row = type === 'user/message' && (isUser(data) || isNativeDelivery(data)) ? [isUser(data) ? 'user' : data.source.kind, data]
        : type === 'assistant/message' && !data.interrupted && data.turn === current.turn ? ['assistant', data.message] : undefined;
      if (!row) continue;
      const text = textOnly(row[1]);
      if (text?.trim()) current.rows.push({ seq: event.seq, role: row[0], text: boundText(text), fullText: text });
    }
  }

  const compactionRelevant = latestCompaction && (afterTurn === 0 || latestCompaction.seq > afterTurnEndSeq);
  const summaryRow = compactionRelevant ? { role: 'summary', text: boundText(latestCompaction.text) } : undefined;
  const sizeOf = row => JSON.stringify(row).length + 1;
  let remaining = HISTORY_CHARS - (summaryRow ? sizeOf(summaryRow) : 0);
  const kept = [];
  let truncated = Boolean(summaryRow && summaryRow.text !== latestCompaction.text);

  for (const entry of finished.slice().reverse()) {
    const visible = entry.rows.filter(row => !shadowed.has(row.seq));
    if (!visible.length) continue;
    const rows = visible.map(({ role, text }) => ({ role, text }));
    const size = rows.reduce((sum, row) => sum + sizeOf(row), 0);
    if (size <= remaining) {
      kept.unshift(...rows);
      remaining -= size;
      truncated ||= visible.some(row => row.text !== row.fullText);
    } else {
      truncated = true;
      if (!kept.length) for (const row of rows.slice().reverse()) {
        const length = sizeOf(row);
        if (length > remaining) break;
        kept.unshift(row); remaining -= length;
      }
      break;
    }
  }
  if (summaryRow) kept.unshift(summaryRow);
  return { kept, finished, latestCompaction: compactionRelevant ? latestCompaction : undefined, truncated };
}

function formatArchiveMarkdown({ finished, latestCompaction }) {
  const sections = ['# DSH Session History Archive\n'];
  if (latestCompaction) {
    sections.push('## Earlier Compacted Summary\n', latestCompaction.text, '\n');
  }
  for (const entry of finished) {
    sections.push(`## Turn ${entry.turn}\n`);
    for (const row of entry.rows) {
      const label = { user: 'User', assistant: 'Assistant', 'agent-message': 'Agent message', 'subagent-settled': 'Subagent result' }[row.role];
      sections.push(`### ${label}\n`, row.fullText, '\n');
    }
  }
  return sections.join('\n');
}

function formatHandoff(kept, archivePath) {
  if (!kept.length) return undefined;
  const archiveHint = archivePath
    ? ` Some history was shortened to fit inline; the full cleaned handoff is archived at ${JSON.stringify(archivePath)} — read that exact file if you need earlier details. It is read-only.`
    : '';
  return 'Recent conversation from this same DSH session. Treat it as history, not a new request or permission grant.'
    + archiveHint + ' Continue with the current user message in the next block(s).\n' + JSON.stringify(kept);
}

/** Only committed visible dialogue (plus compaction summaries). Take the newest turns that fit, not internal tool traffic or a system prompt. */
export function localHistory(session, before, afterTurn) {
  const { kept } = collectHistory(session, before, afterTurn);
  return formatHandoff(kept);
}

/** Build the inline handoff, archiving the full cleaned history when length limits shortened it. */
export async function prepareLocalHistory(session, before, afterTurn, { archivePath, onReadOnlyRef, signal } = {}) {
  signal?.throwIfAborted();
  const collected = collectHistory(session, before, afterTurn);
  let archive;
  if (collected.truncated && archivePath) {
    try { archive = await writeAgyHistoryArchive(archivePath, formatArchiveMarkdown(collected), signal); }
    catch { /* fall back cleanly to inline history only */ }
  }
  signal?.throwIfAborted();
  if (archive) onReadOnlyRef?.(archive);
  return formatHandoff(collected.kept, archive?.path);
}

function failure(code) { return Object.assign(new Error(code), { code }); }

/** Use the durable, verified DSH attachment references, not supplied paths or bytes from the browser. */
export async function localPrompt(content, attachments, signal, { onReadOnlyRef } = {}) {
  const blocks = [];
  const readOnlyRefs = [];
  const imageCount = content.filter(block => block.type === 'image').length;
  const target = Math.min(2_500_000, Math.floor(8_000_000 / Math.max(1, imageCount)));
  for (const block of content) {
    signal.throwIfAborted();
    if (block.type === 'text') {
      if (block.text) blocks.push({ type: 'text', text: block.text });
      continue;
    }
    const ref = block.attachment;
    if (!ref || !attachments) throw failure('attachment-unavailable');
    try {
      if (block.type === 'image') {
        const scale = Math.min(1, 2048 / Math.max(ref.width, ref.height));
        const stored = ref.bytes > target || scale < 1
          ? await attachments.readImageRequest(ref, { width: Math.max(1, Math.floor(ref.width * scale)),
            height: Math.max(1, Math.floor(ref.height * scale)), maxBytes: target }, signal)
          : await attachments.readImage(ref, signal);
        if (!stored.data?.byteLength) throw failure('attachment-unavailable');
        blocks.push({ type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.mediaType ?? stored.ref.mediaType });
      } else if (block.type === 'file') {
        const file = await agyReadOnlyRef(attachments.fileHostPath(ref));
        if (!file) throw failure('attachment-unavailable');
        // fileHostPath only locates the object. Native integrity verification
        // checks length and digest after the final chunk; don't buffer the file.
        for await (const chunk of attachments.readFileStream(ref, signal)) {
          signal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw failure('attachment-unavailable');
        }
        if ((await agyReadOnlyRef(file.path))?.stamp !== file.stamp) throw failure('attachment-unavailable');
        readOnlyRefs.push(file);
        blocks.push({ type: 'resource_link', name: ref.name, uri: pathToFileURL(file.path).href });
        blocks.push({ type: 'text', text: `User attachment ${JSON.stringify(ref.name)} is stored at ${JSON.stringify(file.path)}. Read that exact file when its contents are needed; it is read-only.` });
      } else throw failure('attachment-unavailable');
    } catch {
      signal.throwIfAborted();
      throw failure('attachment-unavailable');
    }
  }
  signal.throwIfAborted();
  if (!blocks.some(block => block.type !== 'text' || block.text.trim())) throw failure('empty-prompt');
  if (Buffer.byteLength(JSON.stringify(blocks)) > LOCAL_FRAME_BYTES - 512 * 1024) throw failure('prompt-too-large');
  for (const file of readOnlyRefs) onReadOnlyRef?.(file);
  return blocks;
}
