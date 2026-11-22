import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Script } from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const endpoint = 'subscriptions-enhanced-gemini';
const accountsSlot = 'subscriptions-enhanced-accounts';
const footer = 'settings.models.footer';
const nextTick = () => new Promise(resolve => setImmediate(resolve));

function activate() {
  let module;
  new Script(source).runInNewContext({
    AbortController,
    DOMException,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window: {
      localStorage: { getItem: () => null, setItem() {} },
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: { load(value) { module = value; } },
    },
  }, { timeout: 1000 });
  const slots = [], locales = new Map(), calls = [];
  const state = [];
  const refs = [];
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  let renderStarted = false;
  const React = {
    forwardRef: render => render,
    createElement(type, props, ...children) {
      assert.ok(renderStarted, 'module registration must not render');
      return { type, props, children };
    },
    useId: () => 'sec-1',
    useState(initial) {
      const at = stateIndex++;
      if (!Object.hasOwn(state, at)) state[at] = typeof initial === 'function' ? initial() : initial;
      return [state[at], change => { state[at] = typeof change === 'function' ? change(state[at]) : change; }];
    },
    useReducer(reducer, initial) {
      const [val, setVal] = React.useState(initial);
      return [val, action => setVal(prev => reducer(prev, action))];
    },
    useRef(initial) {
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
  } : {});
  const connection = { rpc: { call(...args) {
    assert.ok(renderStarted, 'registration must not issue requests');
    const reply = Promise.withResolvers();
    calls.push({ args, ...reply });
    return reply.promise;
  } } };
  exports.apply({
    get(name) { assert.equal(name, 'connection'); return connection; },
    effect(factory) { factory(); },
    on() {}, inject() {},
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
    slots, locales, calls,
    render() {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      effects.length = 0;
      renderStarted = true;
      return renderComponent(entry.view({ ...injected, t: key => key, agyT: key => key }));
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
  assert.ok(nodes(view).some(n => n.type === 'p' && n.children.includes('quotaCredits') && n.children.includes(0)));
  assert.ok(nodes(view).some(n => n.props?.['data-state'] === 'connected' && n.children.includes('readyShort')));
  assert.equal(agyCalls(f).length, 2, 'quota never rechecks connection status or auto-refreshes');

  button(view, 'refreshQuota').props.onClick();
  agyCalls(f)[2].resolve({ ok: false, error: { code: 'AGY_QUOTA_FAILED', message: 'synthetic' } });
  await nextTick();
  view = row();
  assert.ok(feedback(view, 'alert', 'quotaStale'));
  assert.ok(nodes(view).some(n => n.props?.role === 'progressbar'));
  assert.equal(button(view, 'refreshQuota').props['aria-disabled'], false);
  assert.ok(nodes(view).some(n => n.props?.['data-state'] === 'connected'));
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
