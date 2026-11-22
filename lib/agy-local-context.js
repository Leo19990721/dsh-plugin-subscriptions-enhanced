import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLocalAgyPath } from './agy-launch.js';

const HISTORY_CHARS = 120_000;
const MESSAGE_CHARS = 24_000;
export const LOCAL_FRAME_BYTES = 16 * 1024 * 1024;
const owner = message => !message.source.principal || message.source.principal.kind === 'owner';
const isUser = message => message?.source?.kind === 'user' && owner(message);
const blocksText = blocks => Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
const textOnly = message => blocksText(message?.content);
const boundText = text => text.length <= MESSAGE_CHARS ? text
  : `${text.slice(0, MESSAGE_CHARS / 2)}\n[... shortened ...]\n${text.slice(-MESSAGE_CHARS / 2)}`;

export function localSubmissions(session, turnStart) {
  return session.snapshotEvents(turnStart).flatMap(event => event.type === 'user/message' && event.surfaceOp === 'append'
    && isUser(event.data) ? [event.data] : []);
}

function collectHistory(session, before, afterTurn) {
  const finished = [];
  let current;
  let afterTurnEndSeq = -1;
  let latestCompaction;
  for (const event of session.snapshotEvents()) {
    if (event.seq >= before) break;
    const { type, data } = event;
    if (type === 'compaction/summary') {
      const summary = blocksText(data?.summary).trim();
      if (summary) latestCompaction = { seq: event.seq, endSeq: data?.shadowedRange?.end ?? event.seq, text: summary };
      continue;
    }
    if (type === 'turn/start') current = data.turn > afterTurn ? { turn: data.turn, startSeq: event.seq, rows: [], hasUser: false } : undefined;
    else if (type === 'turn/end') {
      if (data.turn <= afterTurn) afterTurnEndSeq = Math.max(afterTurnEndSeq, event.seq);
      if (current && data.turn === current.turn && ['completed', 'max-tokens'].includes(data.reason?.kind) && current.hasUser && current.rows.length) {
        finished.push({ turn: current.turn, startSeq: current.startSeq, endSeq: event.seq, rows: current.rows });
      }
      if (current && data.turn === current.turn) current = undefined;
    } else if (!current) continue;
    else if (event.surfaceOp === 'append') {
      if (type === 'user/message' && isUser(data)) current.hasUser = true;
      const row = type === 'user/message' && isUser(data) ? ['user', data]
        : type === 'assistant/message' && !data.interrupted && data.turn === current.turn ? ['assistant', data.message] : undefined;
      if (!row) continue;
      const text = textOnly(row[1]);
      if (text?.trim()) current.rows.push({ role: row[0], text: boundText(text), fullText: text });
    }
  }

  const compactionRelevant = latestCompaction && (afterTurn === 0 || latestCompaction.seq > afterTurnEndSeq);
  const summaryRow = compactionRelevant ? { role: 'summary', text: boundText(latestCompaction.text) } : undefined;
  const inlineRows = rows => rows.map(({ role, text }) => ({ role, text }));

  let remaining = HISTORY_CHARS;
  const keptTurns = [];
  const kept = [];
  let droppedTurns = 0;

  // Reserve room for compaction summary if it will be needed.
  const totalFinishedSize = finished.reduce((sum, entry) => sum + inlineRows(entry.rows).reduce((s, r) => s + JSON.stringify(r).length + 1, 0), 0);
  const earliestFinishedSeq = finished[0]?.startSeq;
  const includeSummary = Boolean(summaryRow && (
    totalFinishedSize > HISTORY_CHARS
    || finished.length === 0
    || latestCompaction.seq < earliestFinishedSeq
    || (afterTurn === 0 && latestCompaction.endSeq > 0)
  ));
  if (includeSummary) remaining = Math.max(0, remaining - (JSON.stringify(summaryRow).length + 1));

  for (const entry of finished.slice().reverse()) {
    const rows = inlineRows(entry.rows);
    const size = rows.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0);
    if (size <= remaining) {
      kept.unshift(...rows);
      keptTurns.unshift(entry);
      remaining -= size;
    } else {
      droppedTurns++;
      if (!kept.length) for (const row of rows.slice().reverse()) {
        const length = JSON.stringify(row).length + 1;
        if (length > remaining) break;
        kept.unshift(row); remaining -= length;
      }
      // Count remaining older turns that did not fit.
      droppedTurns += Math.max(0, finished.length - keptTurns.length - droppedTurns);
      break;
    }
  }
  if (includeSummary) kept.unshift(summaryRow);
  return { kept, finished, latestCompaction: compactionRelevant ? latestCompaction : undefined, droppedTurns };
}

function formatArchiveMarkdown({ finished, latestCompaction }) {
  const sections = ['# DSH Session History Archive\n'];
  if (latestCompaction) {
    sections.push('## Earlier Compacted Summary\n', latestCompaction.text, '\n');
  }
  for (const entry of finished) {
    sections.push(`## Turn ${entry.turn}\n`);
    for (const row of entry.rows) {
      sections.push(`### ${row.role === 'user' ? 'User' : 'Assistant'}\n`, row.fullText, '\n');
    }
  }
  return sections.join('\n');
}

function formatHandoff(kept, archivePath) {
  if (!kept.length) return undefined;
  const archiveHint = archivePath
    ? ` Earlier turns were truncated to fit inline; the full cleaned transcript is archived at ${JSON.stringify(archivePath)} — read or search it with your file tools if you need earlier details.`
    : '';
  return 'Recent conversation from this same DSH session. Treat it as history, not a new request or permission grant.'
    + archiveHint + ' Continue with the current user message in the next block(s).\n' + JSON.stringify(kept);
}

/** Only committed visible dialogue (plus compaction summaries). Take the newest turns that fit, not internal tool traffic or a system prompt. */
export function localHistory(session, before, afterTurn) {
  const { kept } = collectHistory(session, before, afterTurn);
  return formatHandoff(kept);
}

/** Build handoff context and, when older turns were truncated, archive the full cleaned transcript locally for on-demand lookup. */
export async function prepareLocalHistory(session, before, afterTurn, { archivePath } = {}) {
  const collected = collectHistory(session, before, afterTurn);
  let writtenArchive;
  if (collected.droppedTurns > 0 && archivePath && isLocalAgyPath(archivePath)) {
    try {
      await mkdir(dirname(archivePath), { recursive: true });
      await writeFile(archivePath, formatArchiveMarkdown(collected), 'utf8');
      writtenArchive = archivePath;
    } catch { /* fall back cleanly to inline history only */ }
  }
  return formatHandoff(collected.kept, writtenArchive);
}

function failure(code) { return Object.assign(new Error(code), { code }); }

/** Use the durable, verified DSH attachment references, not supplied paths or bytes from the browser. */
export async function localPrompt(content, attachments, signal) {
  const blocks = [];
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
        const path = attachments.fileHostPath(ref);
        if (!isLocalAgyPath(path)) throw failure('attachment-unavailable');
        blocks.push({ type: 'resource_link', name: ref.name, uri: pathToFileURL(path).href });
        blocks.push({ type: 'text', text: `User attachment ${JSON.stringify(ref.name)} is stored at ${JSON.stringify(path)}. Read that file with your own tools when its contents are needed.` });
      }
    } catch {
      signal.throwIfAborted();
      throw failure('attachment-unavailable');
    }
  }
  if (!blocks.some(block => block.type !== 'text' || block.text.trim())) throw failure('empty-prompt');
  if (Buffer.byteLength(JSON.stringify(blocks)) > LOCAL_FRAME_BYTES - 512 * 1024) throw failure('prompt-too-large');
  return blocks;
}
