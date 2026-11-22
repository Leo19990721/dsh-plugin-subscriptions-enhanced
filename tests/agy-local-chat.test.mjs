import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mountLocalGoogle } from '../src/agy-local-host.js';
import { Config } from '../lib/index.js';
import { apply as applyGoogle } from '../lib/agy-local-plugin.js';
import * as writing from '../src/writing-host.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

const selection = { provider: 'antigravity', model: 'gemini-3-flash' };
const ok = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const calls = h => h.acpCalls.filter(row => row.method === 'session/prompt');
const end = (h, id) => h.events(id).findLast(e => e.type === 'turn/end')?.data.reason;

async function fixture(t, options) {
  const { bindings = new Map(), opened = [], catalogProbe, workspaceFingerprint, proxyFingerprint, archive, rawConfig, ...settings } = options;
  let google;
  const h = await createTurnHost(t, { releasedReader: true, withCompaction: true, withRetry: true, desktopRequests: true,
    ...settings, async mountSubscription({ scope, makeSession, root }) {
      const sessions = new Set();
      const runtime = {
        workspaceFingerprint, proxyFingerprint,
        historyArchivePath: archive ? () => join(root, 'dsh-history-archive.md') : undefined,
        async open(signal, { cwd, officialId, mode, persona, mcpServers, onPermission } = {}) {
          opened.push({ officialId, mode, persona });
          if (!mode) await catalogProbe?.();
          if (mode && !settings.localPermissions) assert.equal(mode, 'read-only');
          const session = makeSession({ signal, cwd, mcpServers, onPermission });
          try { await session.open(officialId); }
          catch (error) { await session.close(); throw error; }
          sessions.add(session);
          return { id: session.id, get options() { return session.options; }, get capabilities() { return session.capabilities; },
            prepare: session.prepare, runTurn: session.runTurn,
            async close() { try { await session.close(); } finally { sessions.delete(session); } } };
        },
        readBinding: id => bindings.get(id),
        async writeBinding(id, row) { bindings.set(id, row); },
        async dispose() { await Promise.all([...sessions].map(session => session.close())); },
      };
      if (rawConfig !== undefined) applyGoogle(scope, Config(rawConfig).google, () => runtime);
      else google = mountLocalGoogle(scope, {}, runtime);
    },
  });
  const fiber = h.ctx.plugin(writing, { localGoogle: true });
  await fiber.await();
  assert.equal(fiber.state, 2);
  t.after(() => fiber.dispose());
  return Object.assign(h, { google });
}

test('built Google schema preserves the non-MCP defaults', () => {
  const { executable, proxy, dataDir, agentsFile, mcp } = Config({}).google;
  assert.deepEqual({ executable, proxy, dataDir, agentsFile, mcp }, {
    executable: undefined, proxy: 'auto', dataDir: undefined, agentsFile: undefined, mcp: ['*'],
  });
  assert.equal(Config({ google: { agentsFile: '', proxy: '' } }).google.agentsFile, '');
  assert.equal(Config({ google: { agentsFile: '', proxy: '' } }).google.proxy, '');
});

for (const [label, rawConfig, expected] of [
  ['omitted', {}, ['mcp__custom-server__fixture', 'mcp__knowledge__dsh_integration_marker', 'remote_list_hosts', 'remote_workspaces']],
  ['empty', { google: { mcp: [] } }, []],
  ['allowlist', { google: { mcp: ['remote', 'playwright'] } }, ['remote_list_hosts', 'remote_workspaces']],
]) {
  test(`built Config and Google plugin expose the correct MCP tools when ${label}`, { timeout: 10_000 }, async t => {
    const prompted = Promise.withResolvers();
    const h = await fixture(t, { rawConfig, localMcpMarker: 'synthetic MCP', acpPrompt: prompted.resolve });
    const id = await h.create();
    ok(await h.select(id, selection));
    ok(await h.prompt(id, 'check advertised tools'));
    const turn = await Promise.race([prompted.promise, h.idle(id).then(() => assert.fail(JSON.stringify(end(h, id))))]);
    try {
      const server = h.acpCalls.findLast(row => row.method === 'session/new').params.mcpServers[0];
      if (expected.length === 0) { assert.equal(server, undefined); return; }
      const response = await fetch(server.url, { method: 'POST', signal: t.signal,
        headers: { authorization: server.headers[0].value }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      assert.equal(response.status, 200);
      const names = (await response.json()).result.tools.map(tool => tool.name);
      assert.deepEqual(names.filter(name => /^(?:mcp__|remote_)/.test(name)).sort(), expected);
    } finally { turn.update('checked'); turn.reply(); }
    await h.idle(id);
  });
}

test('catalog retries transient failures after cooldown and broadcasts recovery', async t => {
  let probes = 0;
  const h = await fixture(t, { catalogProbe() { if (++probes === 1) throw new Error('network down'); } });
  const clock = t.mock.method(Date, 'now', () => 1000);
  const updates = [];
  h.ctx.on('llm/models-updated', provider => updates.push(provider), { global: true });
  assert.deepEqual(await h.google.inspect(), { status: 'unavailable', modelCount: 0 });
  assert.deepEqual(await h.google.inspect(), { status: 'unavailable', modelCount: 0 });
  assert.equal(probes, 1);
  clock.mock.mockImplementation(() => 6000);
  assert.ok((await h.google.inspect()).modelCount > 0);
  assert.equal(probes, 2);
  assert.deepEqual(updates, ['antigravity']);
});

for (const [name, code, status] of [['signed out', 'auth-required', 'signed-out'], ['missing CLI', 'missing-cli', 'missing-cli']]) {
  test(`catalog does not repeatedly spawn while ${name}`, async t => {
    const opened = [];
    const h = await fixture(t, { opened, catalogProbe() { throw Object.assign(new Error('unavailable'), { code }); } });
    assert.equal((await h.google.inspect()).status, status);
    assert.equal((await h.google.inspect(false, true)).status, status);
    assert.equal(opened.length, 1);
    assert.equal((await h.google.inspect(true)).status, status);
    assert.equal(opened.length, 2);
  });
}

test('native send retains last-known model admission and reprobes within the cooldown', async t => {
  let probes = 0;
  const h = await fixture(t, { catalogProbe() { if (++probes === 2) throw new Error('network down'); } });
  const id = await h.create();
  ok(await h.select(id, selection));
  assert.equal((await h.google.inspect(true)).status, 'unavailable');
  ok(await h.prompt(id, 'after reconnect'));
  await h.idle(id);
  assert.equal(probes, 3);
  assert.equal(calls(h).length, 1);
});

for (const [mode, kind, relativePaths, decision, expected, approval = 'ask', native = true, offerAlways = true] of [
  ['workspace-write', 'edit', ['note.txt'], 'allowed-once', 'allow'],
  ['workspace-write', 'edit', ['note.txt'], 'rejected', 'deny'],
  ['workspace-write', 'edit', ['note.txt', '../outside.txt'], undefined, 'deny'],
  ['workspace-write', 'execute', [], undefined, 'deny'],
  ['workspace-write', 'edit', ['note.txt'], undefined, 'allow', 'never'],
  ['workspace-write', 'edit', ['../outside.txt'], undefined, 'deny', 'never'],
  ['workspace-write', 'fetch', [], undefined, 'allow', 'never'],
  ['read-only', 'read', ['note.txt'], undefined, 'allow', 'never'],
  ['read-only', 'edit', ['note.txt'], undefined, 'deny', 'never'],
  ['danger-full-access', 'execute', [], 'allowed-always', 'always', 'ask', false],
  ['danger-full-access', 'execute', [], 'allowed-always', 'allow', 'ask', false, false],
  ['read-only', 'edit', ['note.txt'], undefined, 'deny'],
  ['read-only', 'read', ['note.txt'], 'allowed-once', 'allow'],
  ['danger-full-access', 'execute', [], 'rejected', 'deny'],
]) {
  test(`ACP ${mode} ${kind} ${relativePaths.join(', ')} ${decision ?? 'is blocked'}`, { timeout: 10_000 }, async t => {
    const requests = [], replies = [];
    let current;
    const h = await fixture(t, { localPermissions: { mode, approval, native, request(input) {
      requests.push(input);
      return decision ?? 'rejected';
    } }, apis: { onPermissionReply(id, response) {
      replies.push({ id, response });
      current.update('权限已处理'); current.reply();
    } }, acpPrompt(turn) {
      current = turn;
      turn.ask('peer-permission', { toolCallId: 'fixture-tool', kind, title: 'Synthetic permission request',
        locations: relativePaths.map(path => ({ path })) }, [
        { kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'deny' },
        ...(offerAlways ? [{ kind: 'allow_always', optionId: 'always' }] : []),
      ]);
    } });
    const id = await h.create();
    ok(await h.select(id, selection));
    ok(await h.prompt(id, 'process synthetic approval'));
    await h.idle(id);
    const approvals = h.events(id).filter(row => row.type.startsWith('approval/'));
    assert.deepEqual(replies, [{ id: 'peer-permission', response: { outcome: { outcome: 'selected', optionId: expected } } }], JSON.stringify(approvals.map(row => row.data)));
    assert.equal(requests.length, decision ? 1 : 0, JSON.stringify(approvals.map(row => row.data)));
    assert.deepEqual(approvals.map(row => row.type), native && decision ? ['approval/asked', 'approval/decided'] : []);
    if (decision) {
      assert.equal(requests[0].agent, h.agent(id));
      assert.equal(requests[0].toolName, 'Google Antigravity');
      if (native) assert.equal(approvals.at(-1).data.outcome, decision);
    }
  });
}

test('proxy changes reopen the connection; a native compaction starts fresh with only the summary', async t => {
  let proxy = 'first';
  const h = await fixture(t, { proxyFingerprint: async () => proxy });
  const id = await h.create();
  ok(await h.select(id, selection));
  ok(await h.prompt(id, 'outdated raw context'));
  await h.idle(id);
  const seqs = h.events(id).filter(e => e.surfaceOp === 'append' && ['user/message', 'assistant/message'].includes(e.type)).map(e => e.seq);
  proxy = 'changed';
  ok(await h.prompt(id, 'post-proxy'));
  await h.idle(id);
  assert.equal(h.acpCalls.filter(row => row.method === 'session/load').length, 1);
  assert.equal(calls(h)[0].params.sessionId, calls(h)[1].params.sessionId);
  h.agent(id).session.append('compaction/summary', { compactionId: 'fixture-compact', summary: [{ type: 'text', text: 'clean compacted context' }],
    provider: selection.provider, model: selection.model, shadowedRange: { start: seqs[0], end: seqs.at(-1) }, shadowedSeqs: seqs, shadowedTokenCount: 40 });
  ok(await h.prompt(id, 'post-compact'));
  await h.idle(id);
  const prompt = calls(h).at(-1).params;
  assert.notEqual(prompt.sessionId, calls(h)[0].params.sessionId);
  assert.match(JSON.stringify(prompt.prompt), /clean compacted context/);
  assert.doesNotMatch(JSON.stringify(prompt.prompt), /outdated raw context/);
});

test('workspace-write admits the exact uploaded document and archive only for reading', { timeout: 15_000 }, async t => {
  const extraRoots = [], replies = [];
  let active, targets;
  const issue = () => {
    if (!targets.length) { active.update('file permissions checked'); active.reply(); return; }
    const [kind, path] = targets.shift();
    active.ask(`permission-${replies.length}`, { toolCallId: 'file-operation', kind, locations: [{ path }] });
  };
  const h = await fixture(t, { archive: true, localAttachments: true, localPermissions: {
    mode: 'workspace-write', approval: 'never', additionalWritableRoots: extraRoots,
  }, apis: { onPermissionReply(_id, result) { replies.push(result.outcome.optionId); issue(); } }, acpPrompt(turn) {
    const file = turn.params.prompt.find(block => block.type === 'resource_link');
    if (!file) { turn.update('initial answer'); turn.reply(); return; }
    active = turn;
    const path = fileURLToPath(file.uri);
    const archive = join(h.root, 'dsh-history-archive.md');
    targets = [['read', path], ['edit', path], ['read', archive], ['delete', archive], ['edit', join(extraRoots[0], 'allowed.txt')]];
    assert.match(turn.params.prompt[0].text, /dsh-history-archive\.md/);
    issue();
  } });
  extraRoots.push(join(h.root, 'additional'));
  await mkdir(extraRoots[0]);
  const id = await h.create();
  ok(await h.prompt(id, 'archive marker '.repeat(1800)));
  await h.idle(id);
  ok(await h.select(id, selection));
  const uploaded = await h.uploadBinary(id, { bytes: Buffer.from('%PDF-1.4\n% test fixture\n%%EOF\n'), name: 'example.pdf' });
  const receiptId = uploaded.value?.receiptId ?? uploaded.receiptId;
  assert.equal(typeof receiptId, 'string', JSON.stringify(uploaded));
  ok(await h.prompt(id, [{ type: 'text', text: 'inspect attachment' }, { type: 'file', receiptId }]));
  await h.idle(id);
  assert.deepEqual(replies, ['allow', 'deny', 'allow', 'deny', 'allow'], JSON.stringify(end(h, id)));
});

test('workspace context changes reopen the same official conversation on the next message', async t => {
  let fingerprint = 'first';
  const h = await fixture(t, { workspaceFingerprint: async () => fingerprint });
  const id = await h.create();
  ok(await h.select(id, selection));
  for (const text of ['before change', 'no change']) { ok(await h.prompt(id, text)); await h.idle(id); }
  assert.equal(h.acpCalls.filter(row => row.method === 'session/load').length, 0);
  fingerprint = 'changed';
  ok(await h.prompt(id, 'after change'));
  await h.idle(id);
  assert.equal(h.acpCalls.filter(row => row.method === 'session/load').length, 1);
  assert.equal(new Set(calls(h).map(row => row.params.sessionId)).size, 1);
  assert.equal(calls(h).length, 3);
});

for (const mode of ['workspace-write', 'read-only']) {
  test(`${mode} bridges custom MCP through the native tool guard`, async t => {
    const prompt = Promise.withResolvers();
    const h = await fixture(t, { localPermissions: { mode, approval: 'never' }, localMcpMarker: 'DSH allowed this tool',
      acpPrompt(turn) { prompt.resolve(turn); } });
    const remove = h.ctx.tools.guard(exec => exec.name === 'mcp__custom-server__fixture' ? 'synthetic native restriction' : undefined);
    t.after(remove);
    const id = await h.create();
    ok(await h.select(id, selection));
    ok(await h.prompt(id, 'synthetic MCP checks'));
    const turn = await prompt.promise;
    const server = h.acpCalls.findLast(row => row.method === 'session/new').params.mcpServers[0];
    const rpc = async (method, params) => (await fetch(server.url, { method: 'POST', signal: t.signal,
      headers: { authorization: server.headers[0].value }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    const { result } = await rpc('tools/list');
    assert.ok(result.tools.some(tool => tool.name === 'mcp__custom-server__fixture'));
    const denied = await rpc('tools/call', { name: 'mcp__custom-server__fixture' });
    assert.match(JSON.stringify(denied), /synthetic native restriction/);
    const allowed = await rpc('tools/call', { name: 'mcp__knowledge__dsh_integration_marker' });
    assert.equal(allowed.result.content[0].text, 'DSH allowed this tool');
    turn.update('checked'); turn.reply();
    await h.idle(id);
  });
}

test('a silent restricted ACP prompt is cancelled instead of hanging', { timeout: 10_000 }, async t => {
  const prompt = Promise.withResolvers(), timer = Promise.withResolvers();
  const originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => ms === 180_000
    ? (timer.resolve(fn), originalTimer(() => {}, ms)) : originalTimer(fn, ms, ...args));
  let held, cancels = 0;
  const h = await fixture(t, { apis: { onCancel() { cancels++; held.reply('cancelled'); } }, acpPrompt(turn) {
    held = turn;
    prompt.resolve();
  } });
  const id = await h.create();
  ok(await h.select(id, selection));
  ok(await h.prompt(id, 'hold without progress'));
  await prompt.promise;
  (await timer.promise)();
  await h.idle(id);
  assert.equal(cancels, 1);
  assert.equal(end(h, id).error.code, 'AGY_NO_PROGRESS');
});

for (const mode of ['queue', 'steer', 'steer-without-ack']) {
  test(`DSH ${mode} dispatches the second prompt exactly once`, { timeout: 10_000 }, async t => {
    const first = Promise.withResolvers();
    let current, seen = 0, cancels = 0;
    const h = await fixture(t, { apis: { onCancel() {
      cancels++;
      if (mode === 'steer') current.reply('cancelled');
    } }, acpPrompt(turn) {
      if (++seen === 1) { current = turn; first.resolve(); }
      else { turn.update('第二轮回复'); turn.reply(); }
    } });
    const id = await h.create();
    ok(await h.select(id, selection));
    ok(await h.prompt(id, 'first native prompt'));
    await first.promise;
    ok(await h.prompt(id, 'second native prompt', { mode: mode === 'queue' ? 'queue' : 'steer' }));
    if (mode === 'queue') {
      assert.equal(calls(h).length, 1);
      assert.equal(cancels, 0);
      current.update('第一轮答完'); current.reply();
    }
    await h.idle(id);
    assert.deepEqual(end(h, id), { kind: 'completed' });
    assert.deepEqual(calls(h).map(({ params }) => params.prompt.at(-1).text), ['first native prompt', 'second native prompt']);
    assert.equal(cancels, mode === 'queue' ? 0 : 1);
    assert.equal(h.events(id).filter(row => row.type === 'turn/start').length, mode === 'queue' ? 2 : 1);
    assert.equal(h.acpCalls.filter(row => row.method === 'session/load').length, mode === 'steer-without-ack' ? 1 : 0);
  });
}

test('stock DSH chat switches to Gemini and streams two turns in the same ACP conversation', { timeout: 25_000 }, async t => {
  let first;
  const h = await fixture(t, { acpPrompt(turn) {
    if (!first) {
      first = turn;
      turn.delta({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在检查工作区' } });
      turn.delta({ sessionUpdate: 'tool_call', toolCallId: 'fixture-read', title: 'Read fixture.txt', kind: 'read', status: 'in_progress' });
      turn.update('第一段');
    } else {
      assert.equal(turn.sessionId, first.sessionId);
      turn.update('接着聊。');
      turn.reply();
    }
  } });
  const id = await h.create();
  const session = h.agent(id).session;
  const catalog = ok(await h.post('session', 'modelCatalog', {}));
  const group = catalog.groups.find(row => row.id === selection.provider);
  assert.equal(group.name, 'Google Antigravity');
  assert.ok(group.models.some(row => row.id === selection.model));
  assert.ok(!catalog.groups.some(row => row.id === 'turn:antigravity'));

  ok(await h.prompt(id, '之前在普通模型聊的话'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  assert.equal(h.ordinaryCalls.length, 1);
  assert.deepEqual(ok(await h.select(id, selection)), { selected: selection });
  const feed = await h.follow(id);
  try {
    assert.equal((await feed.next()).value.header.id, id);
    const firstText = '本轮发送给 Gemini';
    assert.deepEqual(ok(await h.prompt(id, firstText)), { accepted: true });
    const live = [];
    for (;;) {
      const { value, done } = await feed.next();
      assert.equal(done, false);
      if (value.type === 'event' && value.event.type === 'turn/end') assert.fail(JSON.stringify(value.event.data.reason));
      if (value.type !== 'assistant-stream') continue;
      if (value.frame.chunk?.type === 'reasoning-delta') live.push(value.frame.chunk.text);
      if (value.frame.chunk?.type === 'text-delta') {
        assert.equal(value.frame.chunk.text, '第一段');
        break;
      }
    }
    assert.deepEqual(live, ['正在检查工作区', '工具执行中：Read fixture.txt\n\n']);
    assert.equal(h.agent(id).status, 'running', 'the first fragment arrives before ACP finishes');
    first.update('，第二段。');
    first.delta({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-read', status: 'completed' });
    first.reply();
    await h.idle(id);
    assert.deepEqual(end(h, id), { kind: 'completed' });
    const secondText = '同一聊天的下一轮';
    ok(await h.prompt(id, secondText));
    await h.idle(id);
    assert.deepEqual(end(h, id), { kind: 'completed' });
    const [firstCall, secondCall] = calls(h).map(row => row.params);
    assert.equal(firstCall.sessionId, first.sessionId);
    assert.match(firstCall.prompt[0].text, /之前在普通模型聊的话.*合成 DSH 回复 1/);
    assert.deepEqual(firstCall.prompt.slice(1), [{ type: 'text', text: firstText }]);
    assert.deepEqual(secondCall, { sessionId: first.sessionId, prompt: [{ type: 'text', text: secondText }] });
    assert.equal(h.acpCalls.filter(row => row.method === 'session/new').length, 2, 'one catalog check and one reusable chat');
    assert.equal(h.agent(id).session, session);
    const replies = h.events(id).filter(e => e.type === 'assistant/message').slice(-2).map(e => e.data.message);
    assert.deepEqual(replies.map(row => row.content.filter(block => block.type === 'text').map(block => block.text).join('')), ['第一段，第二段。', '接着聊。']);
    assert.ok(replies[0].content.some(block => block.type === 'reasoning' && block.text.startsWith('工具已完成')));
    assert.equal(h.events(id).filter(event => event.type === 'tool/call').length, 0, 'ACP tools are never run again by DSH');
    assert.deepEqual(replies.map(row => row.source.provider), ['antigravity', 'antigravity']);
  } finally { await feed.return(); }

  ok(await h.select(id, ORDINARY_SELECTION));
  ok(await h.prompt(id, '切回原来的普通模型'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  assert.equal(h.ordinaryCalls.length, 2);
  assert.equal(calls(h).length, 2);
  ok(await h.select(id, selection));
  ok(await h.prompt(id, '第二次切入 Gemini'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  assert.match(calls(h)[2].params.prompt[0].text, /切回原来的普通模型.*合成 DSH 回复 2/);
  assert.doesNotMatch(calls(h)[2].params.prompt[0].text, /之前在普通模型聊的话|同一聊天的下一轮/);
});

test('native model catalog advertises exact ACP efforts; a stored xhigh downgrades before the prompt', async t => {
  const neon = { provider: 'antigravity', model: 'gemini-4-neon' };
  const flash = { provider: 'antigravity', model: 'gemini-3.8-flash' };
  const effortRows = (...values) => values.map(value => ({ value, name: value }));
  const h = await fixture(t, { acpConfig: [
    { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: neon.model,
      options: [{ value: neon.model, name: 'Neon' }, { value: flash.model, name: 'Flash' }] },
    { type: 'select', id: 'effort', category: 'thought_level', name: 'Thinking', currentValue: 'low',
      options: effortRows('low', 'medium', 'high', 'xhigh') },
  ], apis: { onConfig(config, changed) {
    if (changed.category !== 'model') return;
    config[1].currentValue = 'medium';
    config[1].options = changed.currentValue === flash.model ? effortRows('low', 'medium', 'high') : effortRows('low', 'medium', 'high', 'xhigh');
  } } });
  const id = await h.create();
  const catalog = ok(await h.post('session', 'modelCatalog', {})).groups.find(row => row.id === 'antigravity').models;
  assert.deepEqual(catalog.find(row => row.id === neon.model).reasoning,
    { efforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, name: id })), defaultEffort: 'low' });
  assert.deepEqual(catalog.find(row => row.id === flash.model).reasoning,
    { efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })), defaultEffort: 'medium' });
  assert.equal(calls(h).length, 0, 'catalog only sends configuration requests');
  ok(await h.select(id, { ...neon, reasoningEffort: 'xhigh' }));
  ok(await h.prompt(id, 'use the explicit effort'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  h.agent(id).model.select({ ...flash, reasoningEffort: 'xhigh' }); // a stale saved selection
  ok(await h.prompt(id, 'continue on the three-level model'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  const wire = h.acpCalls.filter(row => row.params?.sessionId === calls(h)[0].params.sessionId);
  assert.deepEqual(wire.filter(row => row.method === 'session/set_config_option').map(row => row.params.value), ['xhigh', flash.model, 'high']);
  assert.equal(calls(h).length, 2);
});

test('writing mode passes a Chinese writing persona only to its local Gemini session', async t => {
  const opened = [];
  const h = await fixture(t, { opened });
  const writingId = await h.create({ agentPreset: 'writing' });
  assert.equal(h.agent(writingId).model.current()?.provider, 'antigravity');
  ok(await h.prompt(writingId, '起草一段文字'));
  await h.idle(writingId);
  assert.deepEqual(end(h, writingId), { kind: 'completed' });
  const ordinaryId = await h.create();
  ok(await h.select(ordinaryId, selection));
  ok(await h.prompt(ordinaryId, '用普通模式继续'));
  await h.idle(ordinaryId);
  assert.deepEqual(end(h, ordinaryId), { kind: 'completed' });
  assert.deepEqual(opened.filter(row => row.mode).map(row => row.persona), ['你是一名中文写作助手，帮助用户起草、修改和整理文字材料。', undefined]);
});

test('an invalid saved official ID falls back once and sends recent DSH text to the new conversation', { timeout: 25_000 }, async t => {
  const bindings = new Map();
  const h = await fixture(t, { bindings });
  const id = await h.create();
  ok(await h.select(id, selection));
  ok(await h.prompt(id, '内容应从 DSH 回退'));
  await h.idle(id);
  assert.deepEqual(end(h, id), { kind: 'completed' });
  const old = bindings.get(id).officialId;
  await h.dispose();
  const reopened = await fixture(t, { root: h.root, bindings, apis: { failLoad: true } });
  ok(await reopened.prompt(id, '重开之后继续'));
  await reopened.idle(id);
  assert.deepEqual(end(reopened, id), { kind: 'completed' });
  assert.deepEqual(reopened.acpCalls.filter(row => row.method === 'session/load').map(row => row.params.sessionId), [old]);
  assert.notEqual(bindings.get(id).officialId, old);
  assert.equal(calls(reopened).length, 1);
  assert.match(calls(reopened)[0].params.prompt[0].text, /内容应从 DSH 回退.*合成 Antigravity 回复/);
  assert.deepEqual(calls(reopened)[0].params.prompt.at(-1), { type: 'text', text: '重开之后继续' });
});
