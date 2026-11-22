import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import {
  createEnhancedLoginState, enhancedProviderGroups, enhancedProviderMoves, hasEnhancedLoginPending,
  mergeEnhancedStatuses, registerEnhancedModelsSettings, startEnhancedStatusPolling,
} from '../src/models-settings-ui.js';
import { registerAgyTeamMenu } from '../src/agy-team-menu.js';

const modelSlot = 'settings.models.footer';
const status = (busy, accounts = []) => ({ busy, accounts });

test('built browser contributes a Models footer and scopes teamwork to its native menu row', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Check the shipped loader and application wiring without rendering React or a browser page.
  let descriptor;
  new Script(source).runInNewContext({ window: { __ModuleLoader__: { load(value) {
    assert.equal(descriptor, undefined, 'exactly one Client module');
    descriptor = value;
  } } } }, { timeout: 1000 });
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(descriptor.id, manifest.name);
  assert.equal(typeof descriptor.factory, 'function');
  assert.match(source, /registerEnhancedModelsSettings\(ctx, connection, t, SubscriptionsSection\);/);
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(patch, /id: ui-model-selection|id: ui-agent-preset|id: ui-settings-models/);
  assert.doesNotMatch(source, /settings\.section|settings\.models\.provider-card|@deepseek-ai\/dsh-client-ui-|document\.(?:querySelector|head\.appendChild)|conversation\.hero\.agentPreset/);
  assert.match(source, /ctx\.inject\(\["modelDirectories"\], \(scope\) => registerAgyTeamMenu\(scope, react\.createElement\)\)/);
  assert.deepEqual(source.match(/conversation\.input\.model[.\w]*/g), ['conversation.input.model.options']);
  assert.match(source, /id: "subscription-usage",/);
  assert.match(source, /id: "codex-speed",/);
  assert.match(source, /name: "fast",/);
  assert.match(source, /function enhancedAnchoredPosition\(/);
});

test('model menu hides only native teamwork for the selected Antigravity route, and restores it on unload', () => {
  const name = 'conversation.input.model.options';
  const nativeToggle = () => {};
  const selectTeamMode = () => {};
  const original = { options: { id: 'agent-team', order: 7 }, locale: 'agent-team', component: nativeToggle,
    inject: sessionId => { assert.equal(sessionId, 'session-1'); return { selectTeamMode }; } };
  const other = { options: { id: 'other', order: 2 } };
  const rows = [other];
  const listeners = new Set();
  let registered = 0;
  const store = { current: { provider: 'antigravity' }, pending: { provider: 'codex' } };
  const ctx = {
    slots: {
      inject(key, setup) { assert.equal(key, name); return setup(); },
      entries(key) { assert.equal(key, name); return rows; },
      subscribe(key, fn) { assert.equal(key, name); listeners.add(fn); return () => listeners.delete(fn); },
      register(options, component) {
        registered++;
        assert.equal(options.name, name);
        const row = { options, locale: options.locale, inject: options.inject, component };
        rows.unshift(row); // native list may enumerate the shadow winner first
        return () => rows.splice(rows.indexOf(row), 1);
      },
    },
    modelDirectories: { directoryFor(id) { assert.equal(id, 'session-1'); return { store }; } },
  };
  const off = registerAgyTeamMenu(ctx, (type, props) => ({ type, props }));
  assert.deepEqual(rows, [other], 'an absent native row stays absent');
  rows.push(original);
  const changed = () => { for (const fn of listeners) fn(); };
  changed(); changed();
  assert.equal(registered, 1, 'ignore the wrapper on subsequent slot changes');
  const wrapper = rows[0];
  assert.equal(wrapper.options.id, original.options.id);
  assert.ok(wrapper.options.priority < 0);
  assert.equal(wrapper.options.order, original.options.order);
  assert.equal(wrapper.options.locale, original.locale);
  const { hooks, ...injected } = wrapper.inject('session-1');
  assert.equal(hooks.agyTeamModel, store);
  const dismiss = () => {};
  const render = () => wrapper.component({ ...injected, locked: true, dismiss, useAgyTeamModel: select => select(store) });
  assert.equal(render(), null, 'only committed selection counts, not pending Codex');
  for (const provider of ['codex', 'deepseek', 'turn:antigravity', undefined]) {
    store.current = provider ? { provider, model: 'gemini-example' } : null;
    assert.deepEqual(render(), { type: nativeToggle, props: { selectTeamMode, locked: true, dismiss } });
  }
  rows.splice(rows.indexOf(original), 1);
  changed();
  assert.deepEqual(rows, [other]);
  rows.push(original);
  changed();
  assert.equal(registered, 2);
  off();
  assert.equal(listeners.size, 0);
  assert.deepEqual(rows, [other, original]);
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
  first.loginState.begin('claude');
  for (const cleanup of effects) cleanup();
  assert.deepEqual(first.loginState.getSnapshot(), {});
  removeAgain();
  dispose();
  assert.deepEqual(calls, [], 'registration does not call any write or read RPC');
});

const ids = rows => rows.map(({ id }) => id);
const fixtureAccount = { key: 'fixture-first' };

async function shippedProviders() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const literal = /const PROVIDERS = (\[[\s\S]*?\]);/.exec(source)?.[1];
  assert.ok(literal, 'upstream provider list is present in the built module');
  return { source, providers: [...new Script(literal).runInNewContext({}, { timeout: 1000 })] };
}

test('the shipped Client uses the same status rule for every service, including new IDs', async () => {
  const { source, providers } = await shippedProviders();
  assert.deepEqual(ids(providers), ['codex', 'claude', 'grok', 'copilot']);
  const known = [...providers, { id: 'new-service', name: 'Future subscription' }];
  const initial = enhancedProviderGroups(known, {}, {});
  assert.deepEqual(initial.connected, []);
  assert.deepEqual(initial.available, known);
  assert.deepEqual(initial.pending, []);

  for (const service of known) {
    const statuses = Object.fromEntries(known.map(({ id }) => [id, status(false, id === service.id ? [fixtureAccount] : [])]));
    const { connected, available } = enhancedProviderGroups(known, statuses, {});
    assert.deepEqual(ids(connected), [service.id]);
    assert.deepEqual(ids(available), ids(known).filter(id => id !== service.id));
  }
  const all = Object.fromEntries(known.map(({ id }) => [id, status(false, [fixtureAccount])]));
  assert.deepEqual(enhancedProviderGroups(known, all, {}).available, []);
  assert.match(source, /react\.createElement\(EnhancedSubscriptionGroups, \{\s*id: sectionId, t, statuses, attempts, errors,/);
  assert.match(source, /enhancedProviderGroups\(PROVIDERS, statuses, attempts\)/);
  assert.match(source, /dsh-enhanced-subscription-add-trigger/);
  assert.match(source, /dsh-enhanced-subscription-add-card/);
  assert.match(source, /enhancedAddSubscriptions: '添加订阅账号'/);
  assert.doesNotMatch(source, /enhancedOtherSubscriptions|renderEnhancedSubscriptionGroups/);
  assert.match(source, /react\.createElement\("summary", null, t\("enhancedOptions"\)\)/);
  assert.match(source, /jsx\)\(UsageBadgeDisplaySetting, \{ t \}\)/);
  assert.match(source, /callSubscriptionsAuth\(rpc, "proxyGet", \{\}\)/);
  assert.match(source, /busy && id !== "copilot"/);
  assert.match(source, /retainUsageAccounts\(rpc, new Set\(Object\.entries\(status\.providers\)/);
});

test('first sign-in promotes Claude only after confirmation; second sign-in and partial logout leave it in place', async t => {
  const { providers } = await shippedProviders();
  const login = createEnhancedLoginState();
  t.after(() => login.clear());
  const empty = { codex: status(false, [fixtureAccount]), claude: status(false) };
  const attempt = login.begin('claude');
  assert.deepEqual(ids(enhancedProviderGroups(providers, empty, login.getSnapshot()).pending), ['claude']);
  login.ready(attempt, { authorizeUrl: 'https://fixture.invalid/authorize' });
  // Reopening Models has no status yet; the stored challenge still puts the row in the pending list.
  assert.deepEqual(ids(enhancedProviderGroups(providers, {}, login.getSnapshot()).pending), ['claude']);
  const during = { ...empty, claude: status(true) };
  assert.deepEqual(ids(enhancedProviderGroups(providers, during, {}).connected), ['codex']);
  assert.deepEqual(ids(enhancedProviderGroups(providers, during, {}).pending), ['claude']);

  const first = { ...empty, claude: status(false, [fixtureAccount]) };
  login.reconcile(first, login.getSnapshot());
  assert.deepEqual(login.getSnapshot(), {});
  assert.deepEqual(ids(enhancedProviderGroups(providers, first, {}).connected), ['codex', 'claude']);
  assert.deepEqual(enhancedProviderMoves(providers, during, first).map(({ id, connected }) => [id, connected]), [['claude', true]]);
  assert.deepEqual(enhancedProviderMoves(providers, {}, first), [], 'the first read does not announce a new login');

  const adding = { ...first, claude: status(true, [fixtureAccount]) };
  const two = { ...first, claude: status(false, [fixtureAccount, { key: 'fixture-second' }]) };
  assert.deepEqual(ids(enhancedProviderGroups(providers, adding, {}).connected), ['codex', 'claude']);
  assert.deepEqual(enhancedProviderGroups(providers, adding, {}).pending, []);
  assert.deepEqual(enhancedProviderMoves(providers, adding, two), []);
  assert.deepEqual(enhancedProviderMoves(providers, two, first), []);
  assert.deepEqual(enhancedProviderMoves(providers, first, empty).map(({ id, connected }) => [id, connected]), [['claude', false]]);
  assert.ok(ids(enhancedProviderGroups(providers, empty, {}).available).includes('claude'));
});

test('status failure preserves the last confirmed group and authorization; failed or cancelled login stays in Add', async t => {
  const { providers } = await shippedProviders();
  const login = createEnhancedLoginState();
  t.after(() => login.clear());
  const start = login.begin('copilot');
  login.ready(start, { authorizeUrl: 'https://fixture.invalid/device', userCode: 'TEST-0000' });
  const observed = login.getSnapshot();
  const baseline = { codex: status(false, [fixtureAccount]), copilot: status(true) };
  const failure = { ...status(false), statusUnavailable: true, detail: 'fixture read error' };
  const response = { codex: failure, copilot: failure };
  const merged = mergeEnhancedStatuses(baseline, response);
  assert.deepEqual(ids(enhancedProviderGroups(providers, merged, observed).connected), ['codex']);
  assert.deepEqual(ids(enhancedProviderGroups(providers, merged, observed).pending), ['copilot']);
  assert.deepEqual(enhancedProviderMoves(providers, baseline, merged), []);
  const firstReadFailed = mergeEnhancedStatuses({}, response);
  assert.deepEqual(enhancedProviderMoves(providers, firstReadFailed, baseline), []);
  login.reconcile(response, observed);
  assert.equal(login.getSnapshot(), observed);

  const failed = { ...baseline, copilot: { ...status(false), detail: 'fixture sign-in failed' } };
  login.reconcile(failed, observed);
  assert.deepEqual(login.getSnapshot(), {});
  assert.deepEqual(enhancedProviderMoves(providers, merged, failed), []);
  const groups = enhancedProviderGroups(providers, failed, login.getSnapshot());
  assert.deepEqual(groups.pending, []);
  assert.ok(ids(groups.available).includes('copilot'));
  const retry = login.begin('copilot');
  assert.ok(retry);
  login.finish(retry);
  assert.ok(ids(enhancedProviderGroups(providers, { ...baseline, copilot: status(false) }, login.getSnapshot()).available).includes('copilot'));
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
  const waiting = state.begin('claude');
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
