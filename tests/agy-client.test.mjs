import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Script } from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const endpoint = 'subscriptions-enhanced-gemini';
const accountsSlot = 'subscriptions-enhanced-accounts';
const footer = 'settings.models.footer';
const nextTick = () => new Promise(resolve => setImmediate(resolve));

function activate(lang, now = Date.now()) {
  let module;
  const timers = [];
  const docEvents = new Map();
  const document = {
    body: {},
    addEventListener(name, listener) { docEvents.set(name, listener); },
    removeEventListener(name, listener) { if (docEvents.get(name) === listener) docEvents.delete(name); },
  };
  new Script(source).runInNewContext({
    document,
    AbortController,
    DOMException,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setInterval(fn, ms) { return timers.push({ fn, ms }); },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    window: {
      localStorage: { getItem: () => null, setItem() {} },
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load(value) { module = value; } },
    },
  }, { timeout: 1000 });
  const slots = [], locales = new Map(), events = new Map(), calls = [], models = new Map();
  const pageHooks = { state: [], refs: [] };
  const dockHooks = { state: [], refs: [] };
  const dockRouteHooks = { state: [], refs: [] };
  let hooks = pageHooks;
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  let renderStarted = false;
  const React = {
    Fragment: Symbol.for('react.fragment'),
    forwardRef: render => render,
    createElement(type, props, ...children) {
      assert.ok(renderStarted, 'module registration must not render');
      return { type, props, children };
    },
    useId: () => 'sec-1',
    useState(initial) {
      const { state } = hooks;
      const at = stateIndex++;
      if (!Object.hasOwn(state, at)) state[at] = typeof initial === 'function' ? initial() : initial;
      return [state[at], change => { state[at] = typeof change === 'function' ? change(state[at]) : change; }];
    },
    useReducer(reducer, initial) {
      const [val, setVal] = React.useState(initial);
      return [val, action => setVal(prev => reducer(prev, action))];
    },
    useRef(initial) {
      const { refs } = hooks;
      const at = refIndex++;
      if (!Object.hasOwn(refs, at)) refs[at] = { current: initial };
      return refs[at];
    },
    useCallback(fn) { return fn; },
    useSyncExternalStore(_sub, getSnapshot) { return getSnapshot(); },
    useEffect(create, deps) {
      const at = effectIndex++;
      effects[at] = { create, deps };
    },
    useLayoutEffect() {},
  };
  const exports = module.factory(id => id === 'react' ? React : id === 'react/jsx-runtime' ? {
    jsx: (type, props) => React.createElement(type, props, ...(Array.isArray(props?.children) ? props.children : props?.children !== undefined ? [props.children] : [])),
    jsxs: (type, props) => React.createElement(type, props, ...(Array.isArray(props?.children) ? props.children : props?.children !== undefined ? [props.children] : [])),
    Fragment: Symbol.for('react.fragment'),
  } : id === 'react-dom' ? { createPortal: (element, target) => {
    assert.equal(target, document.body);
    return element;
  } } : {});
  const connection = { rpc: { call(...args) {
    assert.ok(renderStarted, 'registration must not issue requests');
    const reply = Promise.withResolvers();
    calls.push({ args, ...reply });
    return reply.promise;
  } } };
  exports.apply({
    get(name) {
      if (name === 'modelDirectories') return { directoryFor: id => ({ store: { getSnapshot: () => models.get(id) } }) };
      assert.equal(name, 'connection'); return connection;
    },
    effect(factory) { factory(); },
    on(name, fn) { events.set(name, [...(events.get(name) ?? []), fn]); }, inject() {},
    locale: { register(name, dictionary) { locales.set(name, dictionary); }, bind: ns => key => `${ns}:${key}` },
    slots: { inject(_slot, create) { return create(); }, register(definition, view) { slots.push({ ...definition, view }); return () => {}; } },
  });
  const entry = slots.find(item => item.id === accountsSlot);
  const injected = entry.inject();
  let cleanups = [];
  function renderComponent(el) {
    if (!el || typeof el !== 'object') return el;
    if (Array.isArray(el)) return el.map(renderComponent);
    if (typeof el.type === 'function') {
      return renderComponent(el.type({ ...(el.props ?? {}), children: el.children }));
    }
    return { ...el, children: (el.children ?? []).flatMap(child => {
      const out = renderComponent(child);
      return Array.isArray(out) ? out : [out];
    }) };
  }
  return {
    slots, locales, calls, models, timers, events, docEvents,
    dock(id) {
      const dock = slots.find(item => item.id === 'subscription-usage');
      const props = dock.inject(id);
      renderStarted = true;
      hooks = dockRouteHooks;
      stateIndex = 0;
      return dock.view({ ...props, useAgyDockModel: select => select(props.hooks.agyDockModel.getSnapshot()) });
    },
    renderBadge(dock) {
      return this.render(({ t, agyT }) => ({ ...dock, props: { ...dock.props, t, agyT } }));
    },
    runRenderedEffects() {
      const off = effects.map(item => item?.create?.()).filter(fn => typeof fn === 'function');
      return () => { for (const fn of off) fn(); };
    },
    render(view) {
      hooks = view ? dockHooks : pageHooks;
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      effects.length = 0;
      renderStarted = true;
      const dictionary = locales.get(endpoint)?.[lang];
      const agyT = (key, args) => (dictionary?.[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => args?.[name]);
      return renderComponent(view ? view({ t: key => key, agyT }) : entry.view({ ...injected, t: key => key, agyT }));
    },
    mount() {
      cleanups = effects.map(item => item?.create?.()).filter(fn => typeof fn === 'function');
      return () => { for (const fn of cleanups) fn(); cleanups = []; };
    },
    runAgyEffect() {
      // Run the Google status effect specifically when attempt changes.
      const prev = cleanups;
      for (const fn of prev) fn();
      cleanups = effects.map(item => item?.create?.()).filter(fn => typeof fn === 'function');
      return () => { for (const fn of cleanups) fn(); cleanups = []; };
    },
  };
}

const nodes = tree => tree && typeof tree === 'object' && tree.type
  ? [tree, ...(tree.children ?? []).flatMap(nodes)]
  : [];
const available = status => ({ ok: true, value: { status, modelCount: status === 'ready' ? 2 : 0 } });
const agyCalls = f => f.calls.filter(c => c.args[1] === endpoint);

const quotaCalls = f => agyCalls(f).filter(c => c.args[2].action === 'quota');
const dockPill = tree => nodes(tree).find(n => n.props?.className === 'dsh-subscription-usage-pill');
const dockDialog = tree => nodes(tree).find(n => n.props?.role === 'dialog');
const dockRefresh = tree => nodes(tree).find(n => n.props?.className === 'dsh-agy-dock-refresh');
const selected = (provider = 'antigravity', routable = true) => ({ current: { provider }, routable });
const localTime = (day, hour, minute, second = 0) => new Date(2026, 10, day, hour, minute, second).toISOString();
const quotaFixture = (weekly = 63) => ({ ok: true, value: {
  windows: [
    { group: 'Claude and GPT models', label: 'Weekly Limit', remainingPercent: 12, resetAt: localTime(28, 15, 50) },
    { group: 'Gemini Models', label: 'Weekly Limit Remaining', remainingPercent: weekly, resetAt: localTime(28, 15, 50) },
    { group: 'Gemini Models', label: 'Five Hour Limit Remaining', remainingPercent: 55, resetAt: localTime(22, 17, 20) },
  ],
  credits: { remaining: 0 }, fetchedAt: localTime(22, 13, 40, 9),
} });

test('the single dock entry swaps out the original badge only for Antigravity; unavailable saved route is hidden', () => {
  const f = activate('zh');
  assert.equal(f.slots.filter(entry => entry.name === 'conversation.composer.dock').length, 1);
  f.models.set('s', { current: null, status: 'loading' });
  assert.equal(f.dock('s'), null);
  for (const provider of ['codex', 'claude', 'grok', 'copilot', 'deepseek']) {
    f.models.set('s', selected(provider));
    const entry = f.dock('s');
    assert.equal(entry.type.name, 'SubscriptionUsageBadge');
    assert.deepEqual(Object.keys(entry.props), ['rpc', 'currentModel', 't', 'legacySelection']);
  }
  f.models.set('s', { ...selected('codex'), pending: { provider: 'antigravity' } });
  assert.equal(f.dock('s').type.name, 'SubscriptionUsageBadge');
  f.models.set('s', selected('antigravity', false));
  assert.equal(f.dock('s'), null);
  f.models.set('s', selected('codex'));
  const remembered = selected('codex').current;
  f.dock('s').props.legacySelection[1](remembered);
  f.models.set('s', selected());
  assert.equal(f.dock('s').type.name, 'AgyUsageBadge');
  assert.equal(f.dock('s').props.key, 's');
  f.models.set('s', selected('deepseek'));
  assert.equal(f.dock('s').props.legacySelection[0], remembered);
  assert.equal(f.calls.length, 0);
});

test('Antigravity opens on demand, shares the last result across sessions, and cleans up dismiss handlers', async () => {
  const f = activate('zh', Date.parse(localTime(22, 13, 40, 9)));
  f.models.set('one', selected());
  f.models.set('two', selected());
  const render = id => f.renderBadge(f.dock(id ?? 'one'));
  let tree = render();
  const closed = f.runRenderedEffects();
  assert.match(dockPill(tree).props['aria-label'], /Google Antigravity · 点击查看用量/);
  assert.equal(dockDialog(tree), undefined);
  assert.equal(f.calls.length, 0, 'mount makes no RPC');
  assert.equal(f.timers.length, 0, 'mount starts no timers');
  closed();
  render('two');
  assert.equal(f.calls.length, 0, 'changing sessions makes no RPC');
  const open = dockPill(render()).props.onClick;
  open(); open();
  assert.equal(quotaCalls(f).length, 1, 'double clicks deduplicate');
  tree = render();
  const unmount = f.runRenderedEffects();
  assert.equal(dockRefresh(tree).props['aria-disabled'], true);
  assert.ok(nodes(tree).some(n => n.props?.role === 'status' && n.children.includes('正在查询额度…')));
  quotaCalls(f)[0].resolve(quotaFixture());
  await nextTick();
  tree = render();
  assert.match(dockPill(tree).props['aria-label'], /5h 剩 55% · 每周剩 63% · 剩余 credits: 0/);
  assert.deepEqual(nodes(tree).filter(n => n.props?.role === 'group').map(n => n.props['aria-label']), ['Gemini 模型', 'Claude / GPT 模型']);
  assert.ok(nodes(dockDialog(tree)).some(n => n.children.includes('获取时间：2026/11/22 13:40:09')));
  assert.ok(nodes(dockDialog(tree)).some(n => n.children.includes('今天 17:20 重置')));
  assert.equal(dockRefresh(tree).props['aria-disabled'], false);
  f.docEvents.get('keydown')({ key: 'Escape' });
  assert.equal(dockDialog(render()), undefined);
  unmount();
  assert.equal(f.docEvents.size, 0);
  dockPill(render('two')).props.onClick();
  tree = render('two');
  const unmountTwo = f.runRenderedEffects();
  assert.equal(quotaCalls(f).length, 1, 'reopening via another session reads cache');
  assert.equal(f.timers.length, 0, 'opening and rendering cached quota start no timers');
  f.docEvents.get('pointerdown')({ target: {} });
  assert.equal(dockDialog(render('two')), undefined);
  unmountTwo();
});

test('after the first query fails, reopening shows the error and only Refresh retries', async () => {
  const f = activate('zh');
  f.models.set('one', selected());
  const render = () => f.renderBadge(f.dock('one'));
  dockPill(render()).props.onClick();
  quotaCalls(f)[0].resolve({ ok: false });
  await nextTick();
  dockPill(render()).props.onClick();
  dockPill(render()).props.onClick();
  assert.equal(quotaCalls(f).length, 1);
  const tree = render();
  assert.ok(nodes(tree).some(n => n.children.includes('暂时查不到 Google 额度，请检查官方 CLI 登录和网络代理后重试。')));
  dockRefresh(tree).props.onClick();
  assert.equal(quotaCalls(f).length, 2);
  quotaCalls(f)[1].resolve(quotaFixture());
  await nextTick();
});

test('settings and dock share quota, one in-flight refresh, and reset invalidates stale replies', async t => {
  const f = activate('zh', Date.parse(localTime(22, 13, 40, 9)));
  f.models.set('one', selected());
  f.render();
  t.after(f.mount());
  await nextTick();
  agyCalls(f)[0].resolve(available('ready'));
  await nextTick();
  const page = () => nodes(f.render());
  const settingsButton = text => page().find(n => n.type === 'button' && n.children.includes(text));
  const dock = () => f.renderBadge(f.dock('one'));
  page().find(n => n.props?.id?.endsWith('-manage')).props.onClick();
  settingsButton('查看额度').props.onClick();
  dockPill(dock()).props.onClick();
  assert.equal(quotaCalls(f).length, 1, 'settings and composer join the same request');
  quotaCalls(f)[0].resolve(quotaFixture());
  await nextTick();
  assert.match(dockPill(dock()).props['aria-label'], /每周剩 63%/);
  assert.ok(settingsButton('刷新额度'));
  dockRefresh(dock()).props.onClick();
  assert.equal(quotaCalls(f).length, 2);
  assert.ok(page().some(n => n.props?.['aria-valuenow'] === 63));
  quotaCalls(f)[1].reject(new Error('fixture network failure'));
  await nextTick();
  assert.ok(nodes(dock()).some(n => n.children.includes('刷新失败，下面是上次查到的额度。')));
  assert.ok(page().some(n => n.children.includes('刷新失败，下面是上次查到的额度。')));
  dockRefresh(dock()).props.onClick();
  quotaCalls(f)[2].resolve(quotaFixture(72));
  await nextTick();
  assert.ok(page().some(n => n.props?.['aria-valuenow'] === 72));
  assert.match(dockPill(dock()).props['aria-label'], /每周剩 72%/);
  dockRefresh(dock()).props.onClick();
  for (const reset of f.events.get('connection/reset')) reset();
  assert.equal(quotaCalls(f)[3].args[3].aborted, true);
  quotaCalls(f)[3].resolve(quotaFixture(99));
  await nextTick();
  assert.match(dockPill(dock()).props['aria-label'], /点击查看用量/);
  assert.equal(page().some(n => n.props?.role === 'progressbar'), false);
  assert.equal(quotaCalls(f).length, 4, 'reset does not refetch');
});

test('the shipped Client merges Google Antigravity into the single native Models footer and retains chat add-ons', () => {
  const { slots, locales } = activate();
  assert.deepEqual(slots.filter(entry => entry.name === footer).map(({ id, order }) => ({ id, order })), [
    { id: accountsSlot, order: 10 },
  ], 'no separate order-20 Google Antigravity card exists');
  assert.ok(slots.some(({ name, id }) => name === 'conversation.composer.dock' && id === 'subscription-usage'));
  assert.ok(slots.some(({ name, id }) => name === 'conversation.input.right' && id === 'codex-speed'));
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|window\.open\([^\n]*antigravity|accounts\.google\.com|useStandaloneAgyComposer/);
  const copy = locales.get(endpoint);
  assert.deepEqual(Object.keys(copy.zh).sort(), Object.keys(copy.en).sort());
  assert.equal(copy.zh.title, 'Google Antigravity');
  assert.equal(copy.en.title, 'Google Antigravity');
  assert.match(copy.zh.ready, /聊天模型菜单/);
  assert.match(copy.zh['signed-out'], /官方 Antigravity CLI/);
  assert.equal(copy.zh.login, '登录');
  assert.equal(copy.zh.logout, '退出登录');
  assert.equal(copy.zh.openQuota, '查看额度');
  assert.equal(copy.en.openQuota, 'Check quota');
  assert.equal(copy.zh.refreshQuota, '刷新额度');
  assert.equal(copy.en.refreshQuota, 'Refresh quota');
});

test('Google Antigravity appears in outer connected list when ready and inside Add card when not ready', async () => {
  const f = activate();
  let view = f.render();
  assert.equal(agyCalls(f).length, 0);
  // Initially not ready: Add button is visible, no connected row for antigravity yet.
  assert.ok(nodes(view).some(n => n.type === 'button' && n.props?.className === 'dsh-enhanced-subscription-add-trigger'));
  assert.equal(nodes(view).some(n => n.props?.['data-subscription-provider'] === 'antigravity'), false);

  const unmount = f.mount();
  await nextTick();
  const statusCall = agyCalls(f)[0];
  assert.ok(statusCall, 'mount queries Google Antigravity status');
  const [channel, method, request, signal] = statusCall.args;
  assert.equal(channel, '/api');
  assert.equal(method, endpoint);
  assert.equal(JSON.stringify(request), '{"action":"status"}');

  // Resolve as ready: Google Antigravity moves straight into the outer connected list.
  statusCall.resolve(available('ready'));
  await nextTick();
  view = f.render();
  const connectedRow = nodes(view).find(n => n.props?.['data-subscription-provider'] === 'antigravity');
  assert.ok(connectedRow, 'ready Google Antigravity renders in outer connected list');
  const statusPill = nodes(connectedRow).find(n => n.props?.className === 'dsh-enhanced-subscription-state');
  assert.equal(statusPill.props['data-state'], 'connected');
  assert.ok(statusPill.children.includes('readyShort'));

  // Clicking Manage expands the inline details + Recheck + Logout buttons.
  const manageBtn = nodes(connectedRow).find(n => n.type === 'button' && n.props?.id?.endsWith('-manage'));
  manageBtn.props.onClick();
  view = f.render();
  const expandedRow = nodes(view).find(n => n.props?.['data-subscription-provider'] === 'antigravity');
  const body = nodes(expandedRow).find(n => n.props?.className === 'dsh-enhanced-subscription-body');
  assert.ok(body);
  assert.ok(nodes(body).some(n => n.type === 'button' && n.children.includes('retry')));
  const logoutBtn = nodes(body).find(n => n.type === 'button' && n.children.includes('logout'));
  assert.ok(logoutBtn, 'connected Google Antigravity exposes official Logout button');

  // Clicking Logout issues { action: "logout" } and transitions back to signed-out.
  logoutBtn.props.onClick();
  await nextTick();
  const logoutCall = agyCalls(f).at(-1);
  assert.equal(JSON.stringify(logoutCall.args[2]), '{"action":"logout"}');
  logoutCall.resolve(available('signed-out'));
  await nextTick();
  view = f.render();
  assert.equal(nodes(view).some(n => n.props?.['data-subscription-provider'] === 'antigravity'), false, 'signed-out row moves out of connected list');

  unmount();
  assert.equal(signal.aborted, true);
});

test('Check quota is a connected Manage action and never replaces availability on success or failure', async t => {
  const f = activate();
  f.render();
  t.after(f.mount());
  await nextTick();
  agyCalls(f)[0].resolve(available('ready'));
  await nextTick();
  const row = () => nodes(f.render()).find(n => n.props?.['data-subscription-provider'] === 'antigravity');
  const button = (tree, label) => nodes(tree).find(n => n.type === 'button' && n.children.includes(label));
  const feedback = (tree, role, key) => nodes(tree).some(n => n.type === 'p' && n.props.role === role && n.children.includes(key));
  assert.equal(button(row(), 'openQuota'), undefined);
  nodes(row()).find(n => n.props?.id?.endsWith('-manage')).props.onClick();
  let view = row();
  const body = nodes(view).find(n => n.props?.className === 'dsh-enhanced-subscription-body');
  const openQuota = button(body, 'openQuota');
  assert.equal(agyCalls(f).length, 1, 'opening Manage does not query quota');
  assert.equal(openQuota.props['aria-disabled'], false);
  openQuota.props.onClick();
  openQuota.props.onClick();
  assert.equal(agyCalls(f).length, 2, 'only one query while busy');
  assert.equal(JSON.stringify(agyCalls(f)[1].args.slice(0, 3)), JSON.stringify(['/api', endpoint, { action: 'quota' }]));
  const pending = button(row(), 'openQuota');
  assert.equal(pending.props['aria-disabled'], true);
  assert.ok(feedback(row(), 'status', 'openingQuota'));
  assert.ok(nodes(row()).some(n => n.props?.id?.endsWith('-manage')), 'query leaves the disclosure available');
  agyCalls(f)[1].resolve({ ok: true, value: {
    windows: [{ group: 'Gemini', label: 'Weekly', remainingPercent: 63, resetAt: '2026-11-28T15:02:14Z' }],
    credits: { remaining: 0, upgradeUrl: 'https://antigravity.google/g1-upgrade' }, fetchedAt: '2026-11-22T00:00:00Z',
  } });
  await nextTick();
  view = row();
  assert.ok(nodes(view).some(n => n.props?.role === 'progressbar' && n.props['aria-valuenow'] === 63));
  assert.ok(feedback(view, 'status', 'quotaUpdated'));
  assert.ok(nodes(view).some(n => n.type === 'small' && n.children.includes('quotaCredits') && n.children.includes(0)));
  assert.ok(nodes(view).some(n => n.props?.['data-state'] === 'connected' && n.children.includes('readyShort')));
  assert.equal(agyCalls(f).length, 2, 'quota never rechecks connection status or auto-refreshes');

  button(view, 'refreshQuota').props.onClick();
  const refreshing = row();
  assert.ok(feedback(refreshing, 'status', 'openingQuota'));
  assert.ok(nodes(refreshing).some(n => n.props?.role === 'progressbar' && n.props['aria-valuenow'] === 63), 'keep the last result visible during refresh');
  assert.equal(button(refreshing, 'refreshQuota').props['aria-disabled'], true);
  agyCalls(f)[2].resolve({ ok: false, error: { code: 'AGY_QUOTA_FAILED', message: 'synthetic' } });
  await nextTick();
  view = row();
  assert.ok(feedback(view, 'status', 'quotaStale'));
  assert.ok(nodes(view).some(n => n.props?.role === 'progressbar'));
  assert.equal(button(view, 'refreshQuota').props['aria-disabled'], false);
  assert.ok(nodes(view).some(n => n.props?.['data-state'] === 'connected'));
});

test('quota groups, cycle names, local time and threshold colors render in both languages', async t => {
  const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute).toISOString();
  for (const lang of ['zh', 'en']) {
    const f = activate(lang, Date.parse(at(22, 13, 47)));
    f.render();
    t.after(f.mount());
    await nextTick();
    agyCalls(f)[0].resolve(available('ready'));
    await nextTick();
    const page = () => nodes(f.render());
    page().find(n => n.props?.id?.endsWith('-manage')).props.onClick();
    page().find(n => n.type === 'button' && n.children.includes(lang === 'zh' ? '查看额度' : 'Check quota')).props.onClick();
    agyCalls(f)[1].resolve({ ok: true, value: { windows: [
      { group: 'Claude and GPT models', label: 'Weekly Limit Remaining', remainingPercent: 30, resetAt: at(28, 23, 2) },
      { group: 'Gemini Models', label: 'Five Hour Limit Remaining', remainingPercent: 55, resetAt: at(22, 16, 53) },
      { group: 'Gemini 4 Argon', label: 'Gemini 4 Argon Weekly Limit', remainingPercent: 10, resetAt: at(22, 12, 0) },
    ], credits: { remaining: 0 }, fetchedAt: at(22, 13, 47) } });
    await nextTick();
    const rendered = page();
    assert.deepEqual(rendered.filter(n => n.props?.className === 'dsh-agy-quota-group').map(n => n.props['aria-label']),
      lang === 'zh' ? ['Gemini 模型', 'Claude / GPT 模型', 'Gemini 4 Argon'] : ['Gemini models', 'Claude / GPT models', 'Gemini 4 Argon']);
    assert.deepEqual(rendered.filter(n => n.props?.className === 'dsh-agy-quota-percent').map(n => [n.children[0], n.props.style.color]), [
      ['55%', 'var(--dsw-alias-state-success-primary)'], ['30%', 'var(--dsw-alias-state-warn-label)'], ['10%', 'var(--dsw-alias-state-error-primary)'],
    ]);
    const labels = rendered.flatMap(n => n.children.filter(child => typeof child === 'string'));
    for (const label of lang === 'zh'
      ? ['周额度', '5 小时额度', '今天 16:53 重置', '11/28 23:02 重置', '13:47 更新', 'G1 积分余额', '重置时间已过，请刷新']
      : ['Weekly quota', '5-hour quota', 'Resets today at 16:53', 'Resets 11/28 23:02', 'Updated 13:47', 'G1 Credits balance', 'Reset time passed; refresh to check']) {
      assert.ok(labels.includes(label), label);
    }
    assert.equal(agyCalls(f).length, 2);
  }
});

test('expanding Add subscription account replaces the dashed button with a native addCard containing unconnected Google Antigravity', async () => {
  const f = activate();
  f.render();
  const unmount = f.mount();
  await nextTick();
  agyCalls(f)[0].resolve(available('signed-out'));
  await nextTick();

  let view = f.render();
  const addTrigger = nodes(view).find(n => n.type === 'button' && n.props?.className === 'dsh-enhanced-subscription-add-trigger');
  assert.ok(addTrigger, 'dashed Add trigger visible when collapsed');
  assert.equal(nodes(view).some(n => n.props?.className === 'dsh-enhanced-subscription-add-card'), false);

  // Click "+ Add subscription account"
  addTrigger.props.onClick();
  view = f.render();
  assert.equal(nodes(view).some(n => n.props?.className === 'dsh-enhanced-subscription-add-trigger'), false, 'dashed trigger hides when add card is open');
  const addCard = nodes(view).find(n => n.props?.className === 'dsh-enhanced-subscription-add-card');
  assert.ok(addCard, 'native addCard container renders in place');
  const googleRow = nodes(addCard).find(n => n.props?.['data-subscription-provider'] === 'antigravity');
  assert.ok(googleRow, 'signed-out Google Antigravity appears inside the Add card');
  assert.equal(nodes(googleRow).some(n => n.type === 'button' && n.children.includes('openQuota')), false);

  // Click Login inside signed-out Google row triggers { action: "login" }
  const loginBtn = nodes(googleRow).find(n => n.type === 'button' && n.children.includes('login'));
  assert.ok(loginBtn, 'signed-out Google row shows Login button');
  loginBtn.props.onClick();
  await nextTick();
  const loginCall = agyCalls(f).at(-1);
  assert.equal(JSON.stringify(loginCall.args[2]), '{"action":"login"}');
  loginCall.resolve(available('ready'));
  await nextTick();

  // After login resolves ready, Google Antigravity moves into the outer connected list!
  view = f.render();
  const cancelBtn = nodes(view).find(n => n.type === 'button' && n.props?.className === 'dsh-enhanced-subscription-cancel');
  assert.ok(cancelBtn);
  cancelBtn.props.onClick();
  view = f.render();
  assert.ok(nodes(view).some(n => n.type === 'button' && n.props?.className === 'dsh-enhanced-subscription-add-trigger'));
  assert.equal(nodes(view).some(n => n.props?.className === 'dsh-enhanced-subscription-add-card'), false);
  assert.ok(nodes(view).some(n => n.props?.['data-subscription-provider'] === 'antigravity'), 'logged-in Google Antigravity stays in outer connected list');

  unmount();
});
