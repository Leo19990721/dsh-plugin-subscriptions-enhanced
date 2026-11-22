import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { AgySession } from '../src/agy-session.js';
import { AgyAcpError, AgyAcpErrorCode as ACP } from '../src/agy-acp-client.js';
import { agyWindowsEnv, isLocalAgyPath } from '../src/agy-launch.js';

const cwd = path.resolve('fixture-project');
const localFile = path.join(cwd, 'synthetic.txt');
const id = 'synthetic-session';
const otherId = 'not-our-session';
const cancelled = { outcome: { outcome: 'cancelled' } };
const capabilities = { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} } };
const choices = [
  { kind: 'allow_once', optionId: 'fixture-review-allow' },
  { kind: 'reject_once', optionId: 'fixture-review-reject' },
  { kind: 'allow_always', optionId: 'fixture-never-use' },
];
const code = expected => error => error?.code === expected;

function fixture({ timeLimits, customize, agentCapabilities = capabilities } = {}) {
  const sent = [];
  const terminal = Promise.withResolvers();
  let ended = false;
  let events;
  const session = new AgySession({ cwd, timeLimits, makeClient(hooks) {
    events = hooks;
    return {
      async start() { return { agentCapabilities }; },
      async request(method, params) {
        sent.push([method, params]);
        const fallback = () => {
          if (method === 'session/list') return { sessions: [{ sessionId: id, cwd, title: '试验\u202e标题' }, { sessionId: '', cwd }] };
          if (method === 'session/new') return { sessionId: id };
          if (method === 'session/load') return {};
          if (method === 'session/prompt') return terminal.promise;
          if (method === 'session/close') return {};
          assert.fail(`Unexpected method: ${method}`);
        };
        return customize ? customize(method, params, hooks, fallback) : fallback();
      },
      async notify(method, params) { sent.push([method, params]); },
      async close() {
        if (ended) return;
        ended = true;
        sent.push(['close-transport']);
        events.onClosed();
        terminal.reject(new AgyAcpError(ACP.CLOSED));
      },
    };
  } });
  // A fixture used only for list/load may close without having sent a prompt.
  void terminal.promise.catch(() => {});
  const update = (update, sessionId = id) => events.onUpdate({ sessionId, update });
  return { session, sent, terminal, update,
    ask: (call, options = choices, sessionId = id) => events.onPermission({ sessionId, toolCall: call, options }),
    delta: (text, sessionId = id) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, sessionId),
  };
}

function start(f, signal = new AbortController().signal) {
  const fragments = [];
  const turn = f.session.runTurn('用户原文：测试 🌱', { signal, onDelta: text => fragments.push(text) });
  void turn.catch(() => {});
  return { turn, fragments };
}

function readCall(pathname = localFile) {
  return { toolCallId: 'file-read', kind: 'read', title: '读取合成文件', rawInput: { path: pathname }, locations: [{ path: pathname }] };
}

test('uses ACP list and bounded per-session text replay; no login, MCP or DSH context', async () => {
  const f = fixture({ customize(method, _params, hooks, fallback) {
    if (method === 'session/load') {
      const chunk = (who, text, messageId, sessionId = id) => hooks.onUpdate({ sessionId, update: {
        sessionUpdate: `${who}_message_chunk`, messageId, content: { type: 'text', text },
      } });
      chunk('user', '你好', 'u-1'); chunk('user', ' 🌱', 'u-1');
      chunk('agent', '同一', 'a-1'); chunk('agent', '对话', 'a-1');
      chunk('agent', 'not our history', 'a-2', otherId);
      chunk('user', '第二轮', 'u-2'); chunk('agent', '继续', 'a-3');
    }
    return fallback();
  } });
  try {
    assert.deepEqual(await f.session.list(), [{ id, cwd, title: '试验 标题' }]);
    assert.deepEqual(await f.session.open(id), { title: '', history: [
      { status: 'completed', prompt: '你好 🌱', text: '同一对话' },
      { status: 'completed', prompt: '第二轮', text: '继续' },
    ] });
    assert.equal(f.session.usable, true);
    assert.deepEqual(f.sent, [['session/list', { cwd }], ['session/load', { cwd, mcpServers: [], sessionId: id }]]);
  } finally { await f.session.close(); }
  assert.deepEqual(f.sent.slice(-2), [['session/close', { sessionId: id }], ['close-transport']]);
});

test('missing history capabilities and official auth-required fail before a prompt', async () => {
  const noHistory = fixture({ agentCapabilities: {} });
  try {
    await assert.rejects(noHistory.session.list(), code('history-unavailable'));
    await assert.rejects(noHistory.session.open(id), code('history-unavailable'));
    assert.deepEqual(noHistory.sent, []);
  } finally { await noHistory.session.close(); }
  const auth = fixture({ customize(method) {
    assert.equal(method, 'session/new');
    throw new AgyAcpError(ACP.AUTH_REQUIRED);
  } });
  try {
    await assert.rejects(auth.session.open(), code(ACP.AUTH_REQUIRED));
    assert.deepEqual(auth.sent, [['session/new', { cwd, mcpServers: [] }]]);
  } finally { await auth.session.close(); }
});

test('does not partially publish oversized official replay or accept a different identity', async () => {
  const large = fixture({ customize(method, _params, hooks) {
    assert.equal(method, 'session/load');
    hooks.onUpdate({ sessionId: id, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '汉'.repeat(710_000) } } });
    return {};
  } });
  await assert.rejects(large.session.open(id), code('history-too-large'));
  assert.equal(large.session.usable, false);
  await large.session.close();
  const wrong = fixture({ customize() { return { sessionId: otherId }; } });
  await assert.rejects(wrong.session.open(id), code('invalid-session'));
  await wrong.session.close();
});

test('explicit one-time decision matches the official option; opaque, stale and out-of-workspace requests cannot be allowed', async () => {
  const f = fixture();
  try {
    await f.session.open();
    assert.deepEqual(await f.ask(readCall()), cancelled, 'no out-of-turn approvals');
    const { turn } = start(f);
    assert.deepEqual(await f.ask(readCall(), choices, otherId), cancelled, 'no cross-session approvals');
    const pending = f.ask(readCall());
    const first = f.session.read().permissions[0];
    assert.equal(first.canAllow, true);
    assert.match(first.detail, /synthetic\.txt/);
    assert.equal(first.choices, undefined);
    assert.equal(first.toolCallId, undefined);
    const duplicate = f.ask(readCall());
    assert.deepEqual(await pending, cancelled);
    assert.throws(() => f.session.decide(first.nonce, true), code('permission-unavailable'));
    const updated = f.session.read().permissions[0];
    f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'file-read', locations: [{ path: path.join(cwd, 'changed.txt') }] });
    assert.deepEqual(await duplicate, cancelled);
    assert.throws(() => f.session.decide(updated.nonce, true), code('permission-unavailable'));
    const approved = f.ask(readCall());
    const visible = f.session.read().permissions[0];
    f.session.decide(visible.nonce, true);
    assert.deepEqual(await approved, { outcome: { outcome: 'selected', optionId: 'fixture-review-allow' } });
    assert.throws(() => f.session.decide(visible.nonce, true), code('permission-unavailable'));
    for (const unreviewable of [
      { ...readCall(), kind: 'execute', rawInput: {} }, { ...readCall(), kind: 'edit' },
      readCall(path.join(cwd, '..', 'elsewhere.txt')), { ...readCall(), rawInput: { path: localFile, opaque: 'other' } },
      { ...readCall(), rawInput: { path: localFile }, locations: [{ path: path.join(cwd, 'other.txt') }] },
    ]) {
      const asked = f.ask(unreviewable);
      const current = f.session.read().permissions[0];
      assert.equal(current.canAllow, false);
      assert.throws(() => f.session.decide(current.nonce, true), code('permission-unavailable'));
      f.session.decide(current.nonce, false);
      assert.deepEqual(await asked, { outcome: { outcome: 'selected', optionId: 'fixture-review-reject' } });
    }
    const ambiguous = f.ask(readCall(), [...choices, choices[0]]);
    const current = f.session.read().permissions[0];
    assert.equal(current.canAllow, false);
    f.session.decide(current.nonce, false);
    await ambiguous;
    f.terminal.resolve({ stopReason: 'end_turn' });
    assert.deepEqual(await turn, { status: 'completed' });
  } finally { await f.session.close(); }
});

test('permission replacements at capacity invalidate the old approval even with invalid options', async () => {
  const f = fixture();
  try {
    await f.session.open();
    const { turn } = start(f);
    const call = readCall();
    const first = f.ask(call);
    const original = f.session.read().permissions[0];
    const others = Array.from({ length: 5 }, (_, index) => f.ask({ ...call, toolCallId: `other-${index}` }));
    assert.equal(f.session.read().permissions.length, 6);
    const changed = f.ask(readCall(path.join(cwd, 'changed.txt')));
    assert.throws(() => f.session.decide(original.nonce, true), code('permission-unavailable'));
    assert.deepEqual(await first, cancelled);
    assert.equal(f.session.read().permissions.length, 6);
    const current = f.session.read().permissions.at(-1);
    assert.match(current.detail, /changed\.txt/);
    assert.notEqual(current.nonce, original.nonce);
    assert.deepEqual(await f.ask(call, null), cancelled);
    assert.throws(() => f.session.decide(current.nonce, true), code('permission-unavailable'));
    assert.deepEqual(await changed, cancelled);
    assert.equal(f.session.read().permissions.length, 5);
    f.terminal.resolve({ stopReason: 'end_turn' });
    assert.deepEqual(await turn, { status: 'completed' });
    assert.deepEqual(await Promise.all(others), others.map(() => cancelled));
  } finally { await f.session.close(); }
});

for (const stopReason of ['cancelled', 'end_turn']) {
  test(`Stop drains updates and preserves official tool and terminal status (${stopReason})`, async () => {
    const f = fixture();
    try {
      await f.session.open();
      const controller = new AbortController();
      const { turn, fragments } = start(f, controller.signal);
      f.delta('其他会话', otherId);
      f.delta('前半段');
      f.update({ sessionUpdate: 'tool_call', toolCallId: 'file-read', status: 'in_progress', title: 'Reading' });
      const approval = f.ask(readCall());
      controller.abort();
      assert.deepEqual(await approval, cancelled);
      assert.deepEqual(f.sent.slice(1), [['session/prompt', { sessionId: id, prompt: [{ type: 'text', text: '用户原文：测试 🌱' }] }],
        ['session/cancel', { sessionId: id }]]);
      assert.equal(f.session.read().running, true);
      assert.equal(f.session.read().stopping, true);
      assert.equal(f.session.read().tools[0].status, 'in_progress');
      f.delta('尾片');
      f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'file-read', status: 'completed' });
      f.terminal.resolve({ stopReason });
      assert.deepEqual(await turn, { status: stopReason === 'cancelled' ? 'interrupted' : 'completed' });
      f.delta('turn already ended');
      assert.deepEqual(fragments, ['前半段', '尾片']);
      assert.equal(f.session.read().stopping, false);
      assert.equal(f.session.read().tools[0].status, 'completed');
    } finally { await f.session.close(); }
  });
}

test('shutdown, deadline and repeated send do not invent a cancelled terminal or retry', async () => {
  const f = fixture({ timeLimits: { cancel: 15, permission: 5 } });
  // Deadline timers are unref'ed in production. Keep the fixture alive while waiting.
  const keepAlive = setTimeout(() => {}, 400);
  try {
    await f.session.open();
    const controller = new AbortController();
    const { turn } = start(f, controller.signal);
    const pending = f.ask(readCall());
    assert.deepEqual(await pending, cancelled);
    assert.deepEqual(f.session.read().permissions, []);
    await assert.rejects(f.session.runTurn('second', { signal: controller.signal, onDelta() {} }), code('turn-unavailable'));
    controller.abort();
    await assert.rejects(turn, code('turn-unconfirmed'));
    assert.equal(f.session.usable, false);
    const retry = start(f);
    await assert.rejects(retry.turn, code('turn-unavailable'));
    assert.equal(f.sent.filter(([method]) => method === 'session/prompt').length, 1);
    assert.deepEqual(f.sent.at(-1), ['close-transport']);
  } finally { clearTimeout(keepAlive); await f.session.close(); }
});

test('CLI environment is a narrow allowlist and rejects relative directories', () => {
  const sections = { home: path.join(cwd, 'home'), local: path.join(cwd, 'local'), roaming: path.join(cwd, 'roaming'), scratch: path.join(cwd, 'tmp') };
  const environment = agyWindowsEnv(sections, { SystemRoot: path.join(cwd, 'os'), DSH_HOME: 'synthetic', GOOGLE_API_KEY: 'synthetic',
    HTTPS_PROXY: 'synthetic', ELECTRON_RUN_AS_NODE: '1', PATH: 'synthetic', USERPROFILE: 'synthetic' });
  assert.deepEqual(Object.keys(environment).sort(), ['SYSTEMROOT','WINDIR','COMSPEC','PATH','PATHEXT','PROCESSOR_ARCHITECTURE',
    'USERPROFILE','HOME','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','TEMP','TMP'].sort());
  assert.equal(environment.USERPROFILE, sections.home);
  assert.equal(environment.LOCALAPPDATA, sections.local);
  assert.doesNotMatch(JSON.stringify(environment), /synthetic/);
  assert.throws(() => agyWindowsEnv({ ...sections, home: '..' }, { SystemRoot: cwd }), code('invalid-environment'));
  assert.equal(isLocalAgyPath('session\0id'), false);
});

test('an explicit unauthenticated loopback proxy is passed only to the agy child environment', () => {
  const sections = { home: path.join(cwd, 'home'), local: path.join(cwd, 'local'), roaming: path.join(cwd, 'roam'), scratch: path.join(cwd, 'tmp') };
  const parent = Object.freeze({ SystemRoot: path.join(cwd, 'os'), HTTP_PROXY: 'synthetic-parent', http_proxy: 'synthetic-parent',
    HTTPS_PROXY: 'synthetic-parent', NO_PROXY: '*', ALL_PROXY: 'synthetic-parent', GOOGLE_API_KEY: 'synthetic-parent' });
  const loopback = 'http://127.0.0.1:45678';
  const expected = { ...agyWindowsEnv(sections, parent), HTTP_PROXY: loopback, HTTPS_PROXY: loopback, NO_PROXY: 'localhost,127.0.0.1,::1' };
  assert.deepEqual(agyWindowsEnv(sections, parent, loopback), expected);
  assert.equal(parent.NO_PROXY, '*');
  assert.doesNotMatch(JSON.stringify(expected), /synthetic-parent/u);
  for (const invalid of [null, '', 'https://127.0.0.1:80', 'http://localhost:80', 'http://127.1:80', 'http://203.0.113.10:80',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:080', `${loopback}/`,
    `${loopback}?q=1`, `${loopback}\n`, 'http://synthetic-user:synthetic-password@127.0.0.1:80']) {
    assert.throws(() => agyWindowsEnv(sections, parent, invalid), { name: 'Error', message: 'Antigravity launch: invalid-proxy', code: 'invalid-proxy' });
  }
});
