import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { markAgentLoopRequest, createUserMessage } from '@deepseek-ai/dsh-llm';
import { mountAgySubscription } from '../src/agy-subscription-host.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

const GOOGLE = { provider: 'antigravity', model: 'gemini-3.1-pro-high' };
const FLASH = { provider: 'antigravity', model: 'gemini-3-flash' };
const prompts = h => h.acpCalls.filter(call => call.method === 'session/prompt');
const answers = (h, id) => h.events(id).filter(event => event.type === 'assistant/message');
const turns = (h, id) => h.events(id).filter(event => event.type === 'turn/end');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const rejected = result => assert.equal(result.ok, false, JSON.stringify(result));
const testOptions = { timeout: 25000 };

async function setup(t, opts = {}) {
  let mounted;
  let owner;
  const host = await createTurnHost(t, { releasedReader: true, desktopRequests: true, withCheckpoint: true,
    withRetry: true, withWorkingDirectory: true, ...opts,
    mountSubscription: async ({ scope, makeSession, probe, ...fixture }) => {
      owner = scope;
      const cli = { makeSession, probe, ...opts.fakeCli?.({ makeSession, probe, ...fixture }) };
      mounted = await mountAgySubscription(scope, { cli });
    },
  });
  return Object.assign(host, { mounted, owner,
    modelCatalog: () => host.post('session', 'modelCatalog', {}),
    editQueue: (sessionId, itemId, action, who) => host.post('session', 'updateQueue', { request: { sessionId, itemId, action } }, who),
  });
}

async function selectGoogle(h, id, selection = GOOGLE) {
  assert.equal((await h.mounted.inspect()).status, 'ready');
  assert.deepEqual(ok(await h.select(id, selection)), { selected: selection });
}

test('stock switch compaction refuses a one-shot model without history capacity', testOptions, async t => {
  const h = await setup(t, { withCompaction: true });
  const id = await h.create();
  ok(await h.prompt(id, 'synthetic ordinary before switching'));
  await h.idle(id);
  assert.equal(h.agent(id).session.requestHeader().config.provider, ORDINARY_SELECTION.provider);
  await selectGoogle(h, id);
  const text = 'synthetic Google draft under stock compaction';
  assert.deepEqual(ok(await h.prompt(id, text)), { accepted: true });
  await h.idle(id);
  assert.equal(turns(h, id).at(-1).data.reason.error.code, 'MODEL_SWITCH_COMPACTION_FAILED');
  assert.equal(prompts(h).length, 0);
  assert.equal(h.ordinaryCalls.length, 1);
  assert.equal(h.agent(id).inbox.hasPending, false);
  assert.equal(h.events(id).some(e => e.type === 'user/message' && e.data.content[0]?.text === text), false);
  assert.equal(h.agent(id).session.requestHeader().config.provider, ORDINARY_SELECTION.provider);
});

test('native same-Session dispatch without switch compaction sends one literal prompt to Google only', testOptions, async t => {
  const h = await setup(t, { toolStep: async () => {} });
  const id = await h.create();
  const original = h.agent(id);
  assert.deepEqual(original.model.current(), ORDINARY_SELECTION);
  assert.deepEqual(h.mounted.getStatus(), { status: 'unchecked', modelCount: 0 });
  assert.ok(!ok(await h.modelCatalog()).groups.some(group => group.id === GOOGLE.provider));
  assert.deepEqual(h.acpCalls, []);
  ok(await h.prompt(id, 'synthetic earlier user text'));
  await h.idle(id);
  assert.ok(h.ordinaryCalls.length >= 2);
  const ordinaryBefore = h.ordinaryCalls.length;
  await selectGoogle(h, id);
  const google = ok(await h.modelCatalog()).groups.find(group => group.id === GOOGLE.provider);
  assert.equal(google.name, 'Google Antigravity');
  assert.deepEqual(google.models.map(row => row.id), [FLASH.model, GOOGLE.model]);
  assert.equal(h.agent(id), original);
  assert.deepEqual(h.selects.at(-1), GOOGLE, 'keeps the ordinary native selection save behavior');
  assert.ok(!ok(await h.modelCatalog()).groups.some(group => group.id === 'turn:antigravity'));
  const text = '合成本轮正文，不带先前记录。\n第二行。';
  const requestId = randomUUID();
  ok(await h.prompt(id, text, { requestId }));
  await h.idle(id);
  assert.deepEqual(prompts(h).map(call => call.params.prompt), [[{ type: 'text', text }]]);
  assert.equal(h.ordinaryCalls.length, ordinaryBefore);
  assert.equal(h.agent(id), original);
  assert.deepEqual(answers(h, id).at(-1).data.message.content, [{ type: 'text', text: '合成 Antigravity 回复' }]);
  assert.equal(answers(h, id).at(-1).data.message.source.provider, GOOGLE.provider);
  assert.deepEqual(turns(h, id).at(-1).data.reason, { kind: 'completed' });
  ok(await h.prompt(id, 'dedup retry should not be admitted', { requestId }));
  await h.idle(id);
  assert.equal(prompts(h).length, 1);
  assert.equal(h.acpCalls.filter(item => item.method === 'session/load').length, 0);
  assert.equal(h.acpExits.length, 2, 'both the model check and the live turn are reaped');
  ok(await h.select(id, ORDINARY_SELECTION));
  ok(await h.prompt(id, 'synthetic ordinary again'));
  await h.idle(id);
  assert.equal(h.ordinaryCalls.length, ordinaryBefore + 1);
  assert.equal(prompts(h).length, 1);
  assert.equal(h.agent(id), original);
  ok(await h.post('workspace', 'pinSession', { request: { sessionId: id } }));
  assert.ok(ok(await h.post('session', 'search', { request: { query: '合成 Antigravity 回复' } })).items.some(item => item.sessionId === id));
  ok(await h.post('workspace', 'archiveSession', { request: { sessionId: id } }));
  ok(await h.post('workspace', 'unarchiveSession', { request: { sessionId: id } }));
});

test('unsupported inputs and callers cannot put a Google draft into the native inbox', testOptions, async t => {
  const h = await setup(t);
  const id = await h.create();
  await selectGoogle(h, id);
  rejected(await h.prompt(id, 'synthetic remote owner', { who: 'owner' }));
  rejected(await h.prompt(id, 'synthetic remote socket', { who: { remoteAddress: '203.0.113.1' } }));
  rejected(await h.prompt(id, 'synthetic steer', { mode: 'steer' }));
  rejected(await h.prompt(id, [{ type: 'text', text: 'text' }, { type: 'text', text: 'second block' }]));
  rejected(await h.prompt(id, 'dsh-session:synthetic-reference'));
  rejected(await h.prompt(id, '/synthetic-command'));
  rejected(await h.prompt(id, 'x'.repeat(66 * 1024)));
  rejected(await h.prompt(id, []));
  await assert.rejects(h.invoke('session', 'prompt', { request: { sessionId: id, requestId: randomUUID(),
    mode: 'queue', content: [{ type: 'text', text: 'synthetic direct' }] } }, 'browser'));
  assert.throws(() => h.agent(id).followup(createUserMessage({ content: [{ type: 'text', text: 'scheduled synthetic' }], source: { kind: 'user' } })), /当前 DSH 窗口/);
  const input = { ...GOOGLE, sessionId: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic auxiliary' }] }] };
  for (const request of [input, { ...input, purpose: 'session-title' }, { ...input, purpose: 'compaction' }, markAgentLoopRequest({ ...input })]) {
    const chunks = [];
    for await (const chunk of h.ctx.llm.stream(request)) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.failure.code, 'AGY_INPUT_UNAVAILABLE');
  }
  rejected(await h.select(id, { ...GOOGLE, model: '~account:synthetic:gemini-3.1-pro-high' }));
  rejected(await h.select(id, { ...GOOGLE, model: 'claude-opus-4-6-thinking' }));
  h.apis.workingDirectory = () => `${h.cwd}-unverified`;
  rejected(await h.prompt(id, 'must match its Session workspace'));
  assert.equal(prompts(h).length, 0);
  assert.equal(h.agent(id).inbox.hasPending, false);
  assert.deepEqual(turns(h, id), []);
});

test('Stop targets only the active ACP turn; queue/edit/remove stay native', testOptions, async t => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let calls = 0;
  const h = await setup(t, { acpPrompt(call) {
    calls++;
    if (calls === 1) { call.update('已收到前段'); first.resolve(call); }
    else { call.update('排队文本回复'); call.reply(); second.resolve(call); }
  } });
  const id = await h.create();
  await selectGoogle(h, id);
  const cancels = [];
  h.apis.onCancel = who => { cancels.push(who); };
  ok(await h.prompt(id, 'synthetic active Google'));
  const live = await first.promise;
  await tick();
  ok(await h.prompt(id, 'synthetic queued original'));
  ok(await h.prompt(id, 'synthetic remove me'));
  const [edit, remove] = h.agent(id).inbox.nextTurn;
  rejected(await h.editQueue(id, edit.id, { kind: 'edit', content: [{ type: 'text', text: 'unauthorized edit' }] }, 'owner'));
  for (const who of ['browser', 'owner']) {
    rejected(await h.editQueue(id, edit.id, { kind: 'steer' }, who));
    assert.ok(h.agent(id).inbox.nextTurn.some(item => item.id === edit.id), 'refuse HTTP steer before stock removes the item');
  }
  ok(await h.editQueue(id, edit.id, { kind: 'edit', content: [{ type: 'text', text: 'synthetic queued edit' }] }));
  ok(await h.editQueue(id, remove.id, { kind: 'remove' }));
  rejected(await h.select(id, ORDINARY_SELECTION));
  rejected(await h.select(id, FLASH));
  ok(await h.cancel(id));
  live.update('停止之后的文本不得入库');
  live.reply('cancelled');
  await h.idle(id);
  assert.deepEqual(cancels, [live.sessionId]);
  assert.equal(prompts(h).length, 1);
  assert.deepEqual(h.agent(id).inbox.nextTurn.map(item => item.id), [edit.id]);
  assert.equal(turns(h, id).at(-1).data.reason.kind, 'aborted');
  assert.ok(!JSON.stringify(answers(h, id)).includes('停止之后的文本不得入库'));
  ok(await h.prompt(id, 'synthetic wake after stop'));
  await second.promise;
  await h.idle(id);
  assert.deepEqual(prompts(h).map(call => call.params.prompt[0].text), ['synthetic active Google', 'synthetic queued edit', 'synthetic wake after stop']);
});

test('switching to Google while an ordinary tool is active leaves the ordinary turn intact', testOptions, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await setup(t, { toolStep: async () => { entered.resolve(); await release.promise; } });
  const id = await h.create();
  assert.equal((await h.mounted.inspect()).status, 'ready');
  try {
    ok(await h.prompt(id, 'synthetic ordinary with a tool'));
    await entered.promise;
    assert.equal(h.agent(id).inbox.hasPending, false);
    rejected(await h.select(id, GOOGLE));
    assert.deepEqual(h.agent(id).model.current(), ORDINARY_SELECTION);
    assert.deepEqual(h.selects, []);
  } finally { release.resolve(); }
  await h.idle(id);
  assert.equal(h.ordinaryCalls.length, 2);
  assert.deepEqual(turns(h, id).at(-1).data.reason, { kind: 'completed' });
  assert.equal(prompts(h).length, 0);
});

test('a native prompt crossing a Google route change is refused before the inbox commit', testOptions, async t => {
  const h = await setup(t);
  const id = await h.create();
  await selectGoogle(h, id);
  for (const next of [ORDINARY_SELECTION, GOOGLE, FLASH]) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    h.apis.beforePromptAdmission = async () => { entered.resolve(); await release.promise; };
    const draft = h.prompt(id, 'synthetic draft concurrent with a model change');
    try {
      await entered.promise;
      ok(await h.select(id, next));
    } finally { release.resolve(); }
    rejected(await draft);
    assert.equal(h.agent(id).inbox.hasPending, false);
  }
  assert.equal(h.ordinaryCalls.length, 0);
  assert.equal(prompts(h).length, 0);
});

test('readiness notifies the native catalog and a second Session cannot take a reserved CLI turn', testOptions, async t => {
  const entered = Promise.withResolvers();
  const h = await setup(t, { acpPrompt: entered.resolve });
  const a = await h.create(), b = await h.create();
  const catalogEvents = [];
  h.ctx.on('llm/models-updated', provider => { catalogEvents.push(provider); });
  assert.ok(!ok(await h.modelCatalog()).groups.some(group => group.id === GOOGLE.provider));
  await selectGoogle(h, a);
  assert.deepEqual(catalogEvents, [GOOGLE.provider]);
  await selectGoogle(h, b);
  assert.deepEqual(catalogEvents, [GOOGLE.provider], 'rechecking an identical menu does not invalidate it');
  ok(await h.prompt(a, 'synthetic first ongoing turn'));
  const call = await entered.promise;
  try {
    rejected(await h.prompt(b, 'synthetic competing draft retained by the composer'));
    assert.equal(h.agent(b).inbox.hasPending, false);
    assert.deepEqual(turns(h, b), []);
    assert.equal((await h.mounted.inspect()).status, 'busy');
  } finally { call.update('synthetic reply'); call.reply(); }
  await h.idle(a);
  h.apis.setupError = -32000;
  assert.equal((await h.mounted.inspect()).status, 'signed-out');
  assert.deepEqual(catalogEvents, [GOOGLE.provider, GOOGLE.provider]);
  assert.ok(!ok(await h.modelCatalog()).groups.some(group => group.id === GOOGLE.provider));
  rejected(await h.prompt(b, 'synthetic draft with an unavailable saved Google route'));
  assert.equal(prompts(h).length, 1);
});

test('unknown result fences that occurrence and never auto-retries or falls back', testOptions, async t => {
  const h = await setup(t, { acpPrompt(call) { call.disconnect(); } });
  const id = await h.create();
  await selectGoogle(h, id);
  const requestId = randomUUID();
  ok(await h.prompt(id, 'synthetic disconnect scenario', { requestId }));
  await h.idle(id);
  assert.equal(turns(h, id).at(-1).data.reason.error.code, 'AGY_OUTCOME_UNKNOWN');
  assert.equal(prompts(h).length, 1);
  assert.equal(h.ordinaryCalls.length, 0);
  assert.ok(!h.events(id).some(event => event.type === 'llm/retry'));
  ok(await h.prompt(id, 'repeat exact ID', { requestId }));
  rejected(await h.prompt(id, []));
  await h.idle(id);
  assert.equal(prompts(h).length, 1);
});

test('Stop after claim but before the ACP write prevents a prompt and reaps setup', testOptions, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await setup(t, { fakeCli: ({ makeSession }) => ({ async makeSession(options) {
    const real = makeSession(options);
    return {
      get options() { return real.options; },
      open: () => real.open(),
      async prepare(selection, signal) { await real.prepare(selection, signal); entered.resolve(); await release.promise; },
      runTurn: (...args) => real.runTurn(...args), close: () => real.close(),
    };
  } }) });
  const id = await h.create();
  await selectGoogle(h, id);
  try {
    ok(await h.prompt(id, 'synthetic stop before write'));
    await entered.promise;
    ok(await h.cancel(id));
  } finally { release.resolve(); }
  await h.idle(id);
  assert.equal(prompts(h).length, 0);
  assert.equal(h.acpExits.length, 2, 'catalog child and stopped setup child both closed');
  assert.equal(turns(h, id).at(-1).data.reason.kind, 'aborted');
  assert.equal(answers(h, id).length, 0);
});

test('subscription unload removes its still-queued input and reaps the active child before stock reuse', testOptions, async t => {
  const first = Promise.withResolvers();
  const h = await setup(t, { acpPrompt: first.resolve });
  const id = await h.create();
  await selectGoogle(h, id);
  ok(await h.prompt(id, 'synthetic settled before uninstall'));
  const live = await first.promise;
  ok(await h.prompt(id, 'synthetic queued before uninstall'));
  const off = h.owner.fiber.dispose();
  live.reply();
  await off;
  await h.idle(id);
  assert.equal(h.agent(id).inbox.hasPending, false);
  assert.ok(!h.ctx.llm.listProviders().some(p => p.id === GOOGLE.provider));
  ok(await h.select(id, ORDINARY_SELECTION));
  ok(await h.prompt(id, 'ordinary after unload'));
  await h.idle(id);
  assert.equal(h.ordinaryCalls.length, 1);
  assert.ok(!JSON.stringify(h.ordinaryCalls[0].messages).includes('synthetic queued before uninstall'));
  assert.equal(prompts(h).length, 1);
});
