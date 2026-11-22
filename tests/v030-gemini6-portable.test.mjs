import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localHistory, prepareLocalHistory } from '../src/agy-local-context.js';
import { createLocalAgy } from '../src/agy-local-runtime.js';

const textBlock = text => ({ type: 'text', text });

test('Upgrade 3: built Host & Client support Codex ultrafast tier, catalog discovery, wire format, and /speed command', async () => {
  const hostSource = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

  assert.match(clientSource, /speedUltrafast: "Ultrafast"/);
  assert.match(clientSource, /speedUltrafast: "超快"/);
  assert.match(clientSource, /state\.ultrafastModels/);
  assert.match(clientSource, /value: "ultrafast"/);

  assert.match(hostSource, /CODEX_ULTRAFAST_SERVICE_TIER = "ultrafast"/);
  assert.match(hostSource, /name: "speed"/);
  assert.match(hostSource, /ultrafastModels/);

  const readFn = (name) => {
    const start = hostSource.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing ${name}`);
    let depth = 0, i = hostSource.indexOf('{', start);
    for (; i < hostSource.length; i++) {
      if (hostSource[i] === '{') depth++;
      else if (hostSource[i] === '}' && --depth === 0) return hostSource.slice(start, i + 1);
    }
    throw new Error(`unclosed ${name}`);
  };
  const evalCode = `
    const CODEX_FAST_SERVICE_TIER = "priority";
    const CODEX_FAST_SPEED_TIER = "fast";
    const CODEX_ULTRAFAST_SERVICE_TIER = "ultrafast";
    const CODEX_ULTRAFAST_SPEED_TIER = "ultrafast";
    const DEFAULT_CODEX_INSTRUCTIONS = "default";
    const normalizeCodexCallIds = x => x;
    const reconcileResponsesToolCalls = x => x;
    const codexWireEffort = x => x;
    const toResponsesTools = x => x;
    class BadRequest extends Error {}
    ${readFn('supportsFastTier')}
    ${readFn('supportsUltrafastTier')}
    ${readFn('readSpeedTier')}
    ${readFn('codexRequestBody')}
    return { supportsFastTier, supportsUltrafastTier, readSpeedTier, codexRequestBody };
  `;
  const { supportsFastTier, supportsUltrafastTier, readSpeedTier, codexRequestBody } = new Function(evalCode)();

  assert.equal(supportsUltrafastTier({ service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] }), true);
  assert.equal(supportsUltrafastTier({ additional_speed_tiers: ['fast', 'ultrafast'] }), true);
  assert.equal(supportsUltrafastTier({ service_tiers: [{ id: 'priority' }], additional_speed_tiers: ['fast'] }), false);
  assert.equal(supportsFastTier({ service_tiers: [{ id: 'priority' }] }), true);

  assert.equal(readSpeedTier({ tier: 'standard' }), 'standard');
  assert.equal(readSpeedTier({ tier: 'fast' }), 'fast');
  assert.equal(readSpeedTier({ tier: 'ultrafast' }), 'ultrafast');
  assert.throws(() => readSpeedTier({ tier: 'warp' }));

  const reqOpts = { model: 'gpt-6.2-sol' };
  const resolved = { input: [], instructions: 'hi' };
  assert.equal(codexRequestBody(reqOpts, resolved, 'standard').service_tier, undefined);
  assert.equal(codexRequestBody(reqOpts, resolved, 'fast').service_tier, 'priority');
  assert.equal(codexRequestBody(reqOpts, resolved, true).service_tier, 'priority');
  assert.equal(codexRequestBody(reqOpts, resolved, 'ultrafast').service_tier, 'ultrafast');
});

test('Upgrade 5: localHistory preserves compaction summaries and prepareLocalHistory writes an archive only when truncated', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-history-archive-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  const compactedEvents = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock('早期决策 A')] } },
    { seq: 3, surfaceOp: 'append', type: 'assistant/message', data: { turn: 1, message: { content: [textBlock('确认决策 A')] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 5, type: 'compaction/summary', data: { summary: [textBlock('压缩摘要：项目采用插件式双模型架构，核心结论是决策 A。')], shadowedRange: { start: 1, end: 4 } } },
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock('第二轮问题')] } },
    { seq: 8, surfaceOp: 'append', type: 'assistant/message', data: { turn: 2, message: { content: [textBlock('第二轮答复')] } } },
    { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { seq: 10, type: 'turn/start', data: { turn: 3 } },
    { seq: 11, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock('最新问题')] } },
    { seq: 12, surfaceOp: 'append', type: 'assistant/message', data: { turn: 3, message: { content: [textBlock('最新答复')] } } },
    { seq: 13, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ];
  const shortArchive = join(root, 'short-archive.md');
  const withSummary = await prepareLocalHistory({ snapshotEvents: () => compactedEvents }, 14, 0, { archivePath: shortArchive });
  assert.match(withSummary, /"role":"summary".*压缩摘要：项目采用插件式双模型架构/);
  assert.match(withSummary, /最新问题.*最新答复/);
  assert.doesNotMatch(withSummary, /archived at/, 'short history does not write an archive');

  // If afterTurn already passed turn 2 (after compaction at seq 5), do not re-inject the old compaction summary
  const incremental = localHistory({ snapshotEvents: () => compactedEvents }, 14, 2);
  assert.doesNotMatch(incremental, /"role":"summary"/);
  assert.match(incremental, /最新问题/);

  const hugeEvents = [];
  let seq = 0;
  for (let turn = 1; turn <= 12; turn++) {
    hugeEvents.push({ seq: ++seq, type: 'turn/start', data: { turn } });
    hugeEvents.push({ seq: ++seq, surfaceOp: 'append', type: 'user/message', data: { source: { kind: 'user' }, content: [textBlock(`TURN-${turn}-MARKER ` + 'A'.repeat(12_000))] } });
    hugeEvents.push({ seq: ++seq, surfaceOp: 'append', type: 'assistant/message', data: { turn, message: { content: [textBlock(`REPLY-${turn}-MARKER ` + 'B'.repeat(12_000))] } } });
    hugeEvents.push({ seq: ++seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
  const bigArchive = join(root, 'dsh-history-archive.md');
  const handoff = await prepareLocalHistory({ snapshotEvents: () => hugeEvents }, seq + 1, 0, { archivePath: bigArchive });
  assert.match(handoff, /TURN-12-MARKER/);
  assert.doesNotMatch(handoff, /TURN-1-MARKER/, 'oldest turns dropped from inline handoff');
  assert.ok(handoff.includes(JSON.stringify(bigArchive)), 'handoff points Gemini to the archive path');
  const archivedText = await readFile(bigArchive, 'utf8');
  assert.match(archivedText, /TURN-1-MARKER/);
  assert.match(archivedText, /REPLY-1-MARKER/);
  assert.match(archivedText, /TURN-12-MARKER/);
});

test('Upgrade 6 (0.3.0-gemini.7): createLocalAgy supports official ACP authenticate and logout without touching credentials', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-auth-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const runtime = createLocalAgy({ dataDir: join(root, 'data') }, {
    verify: async () => join(root, 'agy.exe'),
    resolveProxy: async () => ({}),
    makeTransport(options) {
      events.push({ event: 'spawn', allowAuthentication: options.allowAuthentication, permissionMode: options.permissionMode });
      return {
        async start() {
          events.push({ event: 'start' });
          return { agentInfo: { version: '1.5.13' }, agentCapabilities: { auth: { logout: {} } }, authMethods: [{ id: 'oauth-personal' }] };
        },
        async authenticate(methodId) { events.push({ event: 'authenticate', methodId }); },
        async logout() { events.push({ event: 'logout' }); },
        async close() { events.push({ event: 'close' }); },
      };
    },
  });
  const signal = new AbortController().signal;
  await runtime.authenticate(signal);
  await runtime.logout(signal);
  await runtime.dispose();
  assert.deepEqual(events, [
    { event: 'spawn', allowAuthentication: true, permissionMode: 'sandbox' },
    { event: 'start' },
    { event: 'authenticate', methodId: 'oauth-personal' },
    { event: 'close' },
    { event: 'spawn', allowAuthentication: true, permissionMode: 'sandbox' },
    { event: 'start' },
    { event: 'logout' },
    { event: 'close' },
  ]);
});
