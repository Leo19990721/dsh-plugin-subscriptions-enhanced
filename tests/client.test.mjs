import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import {
  createEnhancedLoginState, enhancedProviderGroups, hasEnhancedLoginPending,
  registerEnhancedModelsSettings, startEnhancedStatusPolling,
} from '../src/models-settings-ui.js';

const modelSlot = 'settings.models.footer';
const status = (busy, accounts = []) => ({ busy, accounts });

test('built browser contributes only a Models footer and keeps native selection and chat add-ons', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Check the shipped loader and application wiring without rendering React or a browser page.
  let descriptor;
  new Script(source).runInNewContext({ window: { __ModuleLoader__: { load(value) {
    assert.equal(descriptor, undefined, 'exactly one Client module');
    descriptor = value;
  } } } }, { timeout: 1000 });
  assert.equal(descriptor.id, 'dsh-plugin-subscriptions-enhanced');
  assert.equal(typeof descriptor.factory, 'function');
  assert.match(source, /registerEnhancedModelsSettings\(ctx, connection, t, SubscriptionsSection\);/);
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(patch, /id: ui-model-selection|id: ui-agent-preset|id: ui-settings-models/);
  assert.doesNotMatch(source, /settings\.section|settings\.models\.provider-card|@deepseek-ai\/dsh-client-ui-|document\.(?:querySelector|head\.appendChild)|conversation\.hero\.agentPreset|conversation\.input\.model/);
  assert.match(source, /id: "subscription-usage",/);
  assert.match(source, /id: "codex-speed",/);
  assert.match(source, /name: "fast",/);
  assert.match(source, /function enhancedAnchoredPosition\(/);
});

test('Models footer waits for its native declaration and exposes existing RPC without invoking it', () => {
  const calls = [];
  const effects = [];
  const events = new Map();
  const slot = {};
  const ctx = {
    on(name, fn) { events.set(name, fn); },
    effect(create) { effects.push(create()); },
    slots: {
      inject(name, factory) {
        assert.equal(name, modelSlot);
        assert.equal(slot.factory, undefined);
        slot.factory = factory;
        return () => { delete slot.factory; };
      },
      register(definition, component) {
        assert.equal(slot.current, undefined);
        slot.current = { definition, component };
        return () => { delete slot.current; };
      },
    },
  };
  const connection = { rpc: { call(...args) { calls.push(args); } } };
  const t = key => key;
  const component = () => assert.fail('registration never renders a component');
  const dispose = registerEnhancedModelsSettings(ctx, connection, t, component);
  assert.equal(slot.current, undefined);
  const remove = slot.factory();
  const { definition } = slot.current;
  assert.equal(definition.name, modelSlot);
  assert.equal(definition.id, 'subscriptions-enhanced-accounts');
  assert.equal(slot.current.component, component);
  const first = definition.inject();
  assert.equal(first.rpc, connection.rpc);
  assert.equal(first.t, t);
  remove();
  assert.equal(slot.current, undefined);
  const removeAgain = slot.factory();
  assert.equal(slot.current.definition.inject().loginState, first.loginState);
  first.loginState.begin('codex');
  events.get('connection/reset')();
  assert.deepEqual(first.loginState.getSnapshot(), {});
  first.loginState.begin('antigravity');
  for (const cleanup of effects) cleanup();
  assert.deepEqual(first.loginState.getSnapshot(), {});
  removeAgain();
  dispose();
  assert.deepEqual(calls, [], 'registration does not call any write or read RPC');
});

test('Codex and Gemini are featured first and the remaining providers are retained exactly once', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const literal = /const PROVIDERS = (\[[\s\S]*?\]);/.exec(source)?.[1];
  assert.ok(literal, 'upstream provider list is present in the built module');
  const providers = new Script(literal).runInNewContext({}, { timeout: 1000 });
  const { featured, other } = enhancedProviderGroups([...providers]);
  assert.deepEqual(featured.map(({ id }) => id), ['codex', 'antigravity']);
  assert.equal(featured[1].name, 'Gemini (Google Antigravity)');
  assert.deepEqual(other.map(({ id }) => id), ['claude', 'grok', 'copilot']);
  assert.equal(new Set([...featured, ...other].map(({ id }) => id)).size, providers.length);
  assert.match(source, /enhancedProviderGroups\(PROVIDERS\)/);
  assert.match(source, /react\.createElement\("summary", null, t\("enhancedOptions"\)\)/);
  assert.match(source, /jsx\)\(UsageBadgeDisplaySetting, \{ t \}\)/);
  assert.match(source, /callSubscriptionsAuth\(rpc, "proxyGet", \{\}\)/);
  assert.match(source, /busy && id !== "copilot"/);
  assert.match(source, /retainUsageAccounts\(rpc, new Set\(Object\.entries\(status\.providers\)/);
});

test('pending second-account OAuth survives a view remount and follows busy, not account count', (t) => {
  const state = createEnhancedLoginState();
  t.after(() => state.clear());
  const priorAccounts = [{ key: 'fixture-first' }];
  let updates = 0;
  const unsubscribe = state.subscribe(() => { updates++; });
  const attempt = state.begin('codex');
  assert.equal(state.begin('codex'), undefined, 'double-click is ignored');
  const beforeReady = state.getSnapshot();
  assert.equal(hasEnhancedLoginPending({ codex: status(false, priorAccounts) }, beforeReady), false);
  assert.equal(state.ready(attempt, { authorizeUrl: 'https://fixture.invalid/authorize' }), true);
  state.finish(attempt);
  state.reconcile({ codex: status(false, priorAccounts) }, beforeReady);
  assert.equal(updates, 2, 'an earlier status reply does not discard the new challenge');
  unsubscribe();
  const onReopen = state.getSnapshot();
  assert.equal(onReopen.codex.authorizeUrl, 'https://fixture.invalid/authorize');
  const signingIn = { codex: status(true, priorAccounts) };
  state.reconcile(signingIn, onReopen);
  assert.equal(hasEnhancedLoginPending(signingIn, state.getSnapshot()), true);
  assert.equal(hasEnhancedLoginPending(signingIn, {}), true, 'remote-only attempt is still polled');
  const done = { codex: status(false, [...priorAccounts, { key: 'fixture-new' }]) };
  state.reconcile(done, onReopen);
  assert.equal(hasEnhancedLoginPending(done, state.getSnapshot()), false);
  assert.deepEqual(state.getSnapshot(), {});
  assert.equal(updates, 2, 'unmounted listeners do not receive updates');
});

test('device challenges expire and late or cancelled attempts cannot overwrite another attempt', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = createEnhancedLoginState(300);
  t.after(() => state.clear());
  const cancelled = state.begin('copilot');
  state.finish(cancelled);
  const current = state.begin('copilot');
  const result = { authorizeUrl: 'https://fixture.invalid/device', userCode: 'TEST-0000' };
  assert.equal(state.ready(cancelled, result), false);
  assert.equal(state.ready(current, result), true);
  assert.deepEqual(state.getSnapshot().copilot.deviceCode,
    { userCode: result.userCode, verificationUrl: result.authorizeUrl });
  t.mock.timers.tick(300);
  assert.deepEqual(state.getSnapshot(), {});
  const waiting = state.begin('antigravity');
  state.clear();
  assert.equal(state.ready(waiting, { authorizeUrl: 'https://fixture.invalid/late' }), false);
});

test('status poll has no overlapping requests and disposes cleanly during an in-flight request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  let resolve;
  const stop = startEnhancedStatusPolling(() => {
    count++;
    return new Promise(done => { resolve = done; });
  }, 50);
  t.after(stop);
  t.mock.timers.tick(50);
  assert.equal(count, 1);
  t.mock.timers.tick(500);
  assert.equal(count, 1);
  resolve();
  await Promise.resolve();
  t.mock.timers.tick(50);
  assert.equal(count, 2);
  stop();
  resolve();
  await Promise.resolve();
  t.mock.timers.tick(500);
  assert.equal(count, 2);
});
