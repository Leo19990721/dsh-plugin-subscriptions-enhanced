// Inlined in the upstream client factory, sharing its React and locale bindings.
// Row geometry follows DSH 0.2.2-rc.3 ModelsSection (MIT; see LICENSE-DSH).
const enhancedModelsCss = `
.dsh-subscriptions-settings .dsh-enhanced-subscription-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}
.dsh-enhanced-subscription-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-enhanced-subscription-row {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dsh-enhanced-subscription-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.dsh-enhanced-subscription-identity {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dsh-enhanced-subscription-name {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-subscriptions-settings .dsh-enhanced-subscription-state[role="status"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-subscriptions-settings .dsh-enhanced-subscription-state[role="status"][data-state="connected"] { color: var(--dsw-alias-state-success-primary); }
.dsh-subscriptions-settings .dsh-enhanced-subscription-state[role="status"][data-state="busy"] { color: var(--dsw-alias-state-warn-label); }
.dsh-enhanced-subscription-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.dsh-enhanced-subscription-head .dsh-enhanced-subscription-actions button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}
.dsh-enhanced-subscription-body {
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dsh-agy-quota, .dsh-agy-quota-group { display: grid; gap: 10px; min-width: 0; }
.dsh-agy-quota { gap: 14px; }
.dsh-agy-quota-group + .dsh-agy-quota-group {
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-top: 12px;
}
.dsh-agy-quota-heading { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-agy-quota-window { display: grid; gap: 5px; }
.dsh-agy-quota-line, .dsh-agy-quota-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 4px 12px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-agy-quota-summary { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 3px 8px; margin-inline-start: auto; }
.dsh-agy-quota-percent { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-agy-quota-summary small, .dsh-agy-quota-footer small { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dsh-agy-quota-footer { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 8px; }
.dsh-agy-quota-feedback { min-height: 20px; }
.dsh-enhanced-subscription-more {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-enhanced-subscription-more > summary {
  cursor: pointer;
  user-select: none;
}
.dsh-enhanced-subscription-options { margin-top: 8px; }
.dsh-enhanced-subscription-add {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* Match DSH native ModelsSection .addButton pixel-for-pixel. */
.dsh-subscriptions-settings button.dsh-enhanced-subscription-add-trigger {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 44px;
  min-height: 44px;
  padding: 0 14px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  font-weight: 400;
  cursor: pointer;
}
.dsh-subscriptions-settings button.dsh-enhanced-subscription-add-trigger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* Match DSH native ModelsSection .addCard when expanded. */
.dsh-enhanced-subscription-add-card {
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dsh-enhanced-subscription-add-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.dsh-enhanced-subscription-add-title {
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-enhanced-subscription-add-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsh-subscriptions-settings button.dsh-enhanced-subscription-cancel {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  min-height: 36px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.dsh-subscriptions-settings button.dsh-enhanced-subscription-cancel:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}
.dsh-enhanced-subscription-notice:empty { position: absolute; }
`;

function enhancedPlusIcon() {
  return react.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
  }, react.createElement('path', { d: 'M8 3.25v9.5M3.25 8h9.5' }));
}

function EnhancedSubscriptionRow({ id, name, status, open, titleId, busy, starting, unavailable, error, t, toggle, connect, cancel, retry, children }) {
  const h = react.createElement;
  const title = status?.displayName || name;
  const connected = hasEnhancedAccounts(status);
  const known = status !== undefined && !unavailable;
  const state = busy || starting ? 'busy' : connected && known ? 'connected' : 'idle';
  return h('li', { id: `${titleId}-row`, tabIndex: -1, className: 'dsh-enhanced-subscription-row', 'data-subscription-provider': id, 'aria-labelledby': titleId },
    h('div', { className: 'dsh-enhanced-subscription-head' },
      h('div', { className: 'dsh-enhanced-subscription-identity' },
        h('span', { id: titleId, className: 'dsh-enhanced-subscription-name' }, title),
        title !== name && h('small', null, name),
        h('span', { role: 'status', className: 'dsh-enhanced-subscription-state', 'data-state': state },
          (starting || busy || known) && h('span', { 'aria-hidden': true, style: { ...styles$5.dot,
            background: starting || busy ? 'var(--dsw-alias-state-warn-label)' : dotColor(status) } }),
          starting ? t('enhancedStarting') : busy ? t('loginInProgress') : unavailable ? t('enhancedStatusUnavailable') : statusText(t, status))),
      h('div', { className: 'dsh-enhanced-subscription-actions' },
        busy && h('button', { type: 'button', onClick: cancel,
          'aria-label': t('enhancedCancelLabel', { name: title }) }, t('cancel')),
        known && !busy && !connected && h('button', { type: 'button', onClick: connect, disabled: starting,
          'aria-label': t('enhancedLoginLabel', { name: title }) }, t(starting ? 'enhancedStarting' : 'login')),
        retry && h('button', { type: 'button', onClick: retry }, t('modelDefaultsRetry')),
        known && !busy && !starting && h('button', { id: `${titleId}-manage`, type: 'button', onClick: toggle, 'aria-expanded': open,
          ...(open ? { 'aria-controls': `${titleId}-body` } : {}),
          'aria-label': t(open ? 'enhancedCollapseLabel' : 'enhancedManageLabel', { name: title }) },
        t(open ? 'enhancedCollapse' : 'enhancedManage')))),
    error && h('p', { role: 'alert', style: { ...styles$5.errorLine, overflowWrap: 'anywhere' } }, error),
    open && h('div', { id: `${titleId}-body`, className: 'dsh-enhanced-subscription-body' }, children));
}

function hasEnhancedAccounts(status) {
  return (status?.accounts?.length ?? 0) > 0;
}

// A read failure is not a logout. Keep the last confirmed account count and
// busy state until we can read that service again, while showing the error.
export function mergeEnhancedStatuses(previous, incoming) {
  return Object.fromEntries(Object.entries(incoming).map(([id, status]) => {
    if (!status.statusUnavailable) return [id, status];
    const prior = previous[id];
    return [id, {
      ...status,
      accounts: prior?.accounts ?? [],
      busy: prior?.busy === true,
      lastStatusKnown: prior !== undefined && (!prior.statusUnavailable || prior.lastStatusKnown === true),
    }];
  }));
}

export function enhancedProviderGroups(providers, statuses, attempts) {
  const connected = [];
  const available = [];
  const pending = [];
  for (const provider of providers) {
    const status = statuses[provider.id];
    if (hasEnhancedAccounts(status)) connected.push(provider);
    else {
      available.push(provider);
      if (attempts[provider.id] || status?.busy) pending.push(provider);
    }
  }
  return { connected, available, pending };
}

export function enhancedProviderMoves(providers, previous, current) {
  return providers.flatMap(provider => {
    const before = previous[provider.id];
    const after = current[provider.id];
    if (!before || (before.statusUnavailable && !before.lastStatusKnown) || !after || after.statusUnavailable) return [];
    const connected = hasEnhancedAccounts(after);
    return connected === hasEnhancedAccounts(before) ? [] : [{ ...provider, connected }];
  });
}

function EnhancedSubscriptionGroups({ id, t, statuses, attempts, errors, render, extraConnected = [], extraAvailable = [] }) {
  const h = react.createElement;
  const { connected, available, pending } = enhancedProviderGroups(PROVIDERS, statuses, attempts);
  const [addOpen, setAddOpen] = react.useState();
  const [notice, setNotice] = react.useState([]);
  const addButton = react.useRef(null);
  const focused = react.useRef();
  const previous = react.useRef({});
  const hasPending = pending.length > 0;
  const expanded = addOpen ?? hasPending;
  react.useEffect(() => {
    if (hasPending) setAddOpen(open => open ?? true);
  }, [hasPending]);
  react.useLayoutEffect(() => {
    const moves = enhancedProviderMoves(PROVIDERS, previous.current, statuses);
    previous.current = statuses;
    if (!moves.length) return;
    setNotice(moves);
    const last = focused.current;
    const moved = last && moves.find(provider => provider.id === last.id);
    if (!moved || last.element.isConnected) return;
    focused.current = undefined;
    const doc = last.element.ownerDocument;
    if (doc.activeElement !== doc.body || !doc.hasFocus()) return;
    const titleId = `${id}-${moved.id}`;
    const target = moved.connected
      ? doc.getElementById(`${titleId}-manage`) ?? doc.getElementById(`${titleId}-row`)
      : addButton.current;
    target?.focus();
  }, [id, statuses]);
  const nameOf = provider => statuses[provider.id]?.displayName || provider.name;
  const attention = available.filter(({ id }) => !attempts[id] && !statuses[id]?.busy && (errors[id] || statuses[id]?.detail));
  const description = `${id}-add-hint`;
  const connectedItems = [...connected.map(render), ...extraConnected];
  const availableItems = [...available.map(render), ...extraAvailable];
  return h('div', {
    className: 'dsh-enhanced-subscription-add',
    onFocus: event => {
      const row = event.target.closest('[data-subscription-provider]');
      focused.current = row ? { id: row.dataset.subscriptionProvider, element: event.target } : undefined;
    },
    onBlur: () => { focused.current = undefined; },
  },
  connectedItems.length > 0 && h('ul', { className: 'dsh-enhanced-subscription-list' }, connectedItems),
  h('p', { role: 'status', className: 'dsh-enhanced-subscription-notice', style: styles$5.statusLine },
    notice.map(provider => t(provider.connected ? 'enhancedSubscriptionAdded' : 'enhancedSubscriptionRemoved', { name: nameOf(provider) })).join(' ')),
  !expanded && h('button', {
    type: 'button',
    ref: addButton,
    className: 'dsh-enhanced-subscription-add-trigger',
    onClick: () => setAddOpen(true),
    'aria-expanded': false,
    'aria-controls': `${id}-add-list`,
    'aria-describedby': description,
  }, enhancedPlusIcon(), t('enhancedAddSubscriptions')),
  h('p', { id: description, role: 'status', className: 'dsh-enhanced-subscription-notice', style: styles$5.statusLine },
    !expanded && (hasPending ? t('enhancedAddPending', { names: pending.map(nameOf).join(', ') })
      : attention.length ? t('enhancedAddAttention', { names: attention.map(nameOf).join(', ') }) : '')),
  expanded && h('div', { id: `${id}-add-list`, className: 'dsh-enhanced-subscription-add-card' },
    h('div', { className: 'dsh-enhanced-subscription-add-header' },
      h('span', { className: 'dsh-enhanced-subscription-add-title' }, t('enhancedAddSubscriptions'))),
    availableItems.length > 0
      ? h('ul', { className: 'dsh-enhanced-subscription-list' }, availableItems)
      : h('p', { style: styles$5.statusLine }, t('enhancedAllConnected')),
    h('div', { className: 'dsh-enhanced-subscription-add-footer' },
      h('button', {
        type: 'button',
        className: 'dsh-enhanced-subscription-cancel',
        onClick: () => setAddOpen(false),
      }, t('cancel')))));
}

export function registerEnhancedModelsSettings(ctx, connection, t, component) {
  const loginState = createEnhancedLoginState();
  const agyT = ctx.locale?.bind ? ctx.locale.bind('subscriptions-enhanced-gemini') : void 0;
  ctx.on('connection/reset', loginState.clear);
  ctx.effect(() => loginState.clear, 'subscriptions-enhanced: pending authorization cleanup');
  return ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'subscriptions-enhanced-accounts',
    order: 10,
    inject: () => ({ rpc: connection.rpc, t, ...(agyT ? { agyT } : {}), loginState }),
  }, component));
}

export function hasEnhancedLoginPending(statuses, attempts) {
  return Object.values(statuses).some(status => status?.busy === true)
    || Object.values(attempts).some(attempt => !attempt.starting);
}

export function startEnhancedStatusPolling(refresh, interval) {
  let active = true;
  let timer = setTimeout(tick, interval);
  async function tick() {
    try { await refresh(); }
    finally { if (active) timer = setTimeout(tick, interval); }
  }
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

// Only the pending challenge survives leaving Models. Nothing is written to
// browser storage; a settled, expired, or disconnected challenge is dropped.
export function createEnhancedLoginState(ttlMs = 15 * 60_000) {
  const listeners = new Set();
  const timers = new Map();
  let snapshot = {};
  function publish(next) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function finish(attempt) {
    if (snapshot[attempt.provider] !== attempt) return;
    clearTimeout(timers.get(attempt.provider));
    timers.delete(attempt.provider);
    const next = { ...snapshot };
    delete next[attempt.provider];
    publish(next);
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin(provider) {
      if (snapshot[provider]) return;
      const attempt = { provider, starting: true };
      publish({ ...snapshot, [provider]: attempt });
      return attempt;
    },
    ready(attempt, { authorizeUrl, userCode }) {
      if (snapshot[attempt.provider] !== attempt) return false;
      const challenge = {
        provider: attempt.provider,
        ...(userCode ? { deviceCode: { userCode, verificationUrl: authorizeUrl } } : { authorizeUrl }),
      };
      timers.set(attempt.provider, setTimeout(() => finish(challenge), ttlMs));
      publish({ ...snapshot, [attempt.provider]: challenge });
      return true;
    },
    reconcile(providers, observed) {
      for (const attempt of Object.values(observed)) {
        const status = providers[attempt.provider];
        if (!attempt.starting && status?.busy === false && !status.statusUnavailable) finish(attempt);
      }
    },
    finish,
    clear() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (Object.keys(snapshot).length) publish({});
    },
  };
}

const enhancedSettingsCopy = {
  en: {
    enhancedAccountsTitle: 'Subscription accounts',
    enhancedAddSubscriptions: 'Add subscription account',
    enhancedAddPending: 'Sign-in in progress: {names}',
    enhancedAddAttention: 'Check sign-in or status for {names}.',
    enhancedAllConnected: 'All subscription services are connected. Use Manage to add another account.',
    enhancedSubscriptionAdded: '{name} is now in your connected subscriptions.',
    enhancedSubscriptionRemoved: '{name} is back under Add subscription account.',
    enhancedOptions: 'Subscription options',
    enhancedManage: 'Manage',
    enhancedCollapse: 'Collapse',
    enhancedManageLabel: 'Manage {name}',
    enhancedCollapseLabel: 'Collapse {name}',
    enhancedLoginLabel: 'Log in to {name}',
    enhancedCancelLabel: 'Cancel {name} sign-in',
    enhancedAccountSettings: 'Account and models',
    enhancedOpenAuthorization: 'Open authorization page',
    enhancedDeviceRestart: 'This page has no verification code for the current attempt. Cancel and start again to get a code.',
    enhancedStarting: 'Starting sign-in…',
    enhancedStatusUnavailable: 'Status unavailable',
    enhancedStatusError: 'Could not load subscription status: {message}',
  },
  zh: {
    enhancedAccountsTitle: '订阅账号',
    enhancedAddSubscriptions: '添加订阅账号',
    enhancedAddPending: '正在登录：{names}',
    enhancedAddAttention: '请查看以下服务的登录或连接状态：{names}',
    enhancedAllConnected: '所有订阅服务均已连接。点对应服务的「管理」可以再加一个账号。',
    enhancedSubscriptionAdded: '{name} 已连接，可在上方管理。',
    enhancedSubscriptionRemoved: '{name} 已移回「添加订阅账号」。',
    enhancedOptions: '订阅选项',
    enhancedManage: '管理',
    enhancedCollapse: '收起',
    enhancedManageLabel: '管理 {name}',
    enhancedCollapseLabel: '收起 {name}',
    enhancedLoginLabel: '登录 {name}',
    enhancedCancelLabel: '取消 {name} 登录',
    enhancedAccountSettings: '账号和模型设置',
    enhancedOpenAuthorization: '打开授权页面',
    enhancedDeviceRestart: '当前页面没有这次登录的验证码。请取消后重新登录以获取验证码。',
    enhancedStarting: '正在发起登录…',
    enhancedStatusUnavailable: '状态加载失败',
    enhancedStatusError: '无法读取订阅状态：{message}',
  },
};

// Decorative inline glyphs so the copied Client does not need Host UI modules.
function enhancedSparkleIcon({ size = 16 } = {}) {
  return react.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true },
    react.createElement('path', { fill: 'currentColor', d: 'M8 1c.8 4 2.2 5.4 6.2 6.2-4 .8-5.4 2.2-6.2 6.2-.8-4-2.2-5.4-6.2-6.2C5.8 6.4 7.2 5 8 1Zm5.5 10.5.6 1.8 1.9.7-1.9.6-.6 1.9-.7-1.9-1.8-.6 1.8-.7.7-1.8Z' }));
}

function enhancedUsageIcon() {
  return react.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': true },
  react.createElement('path', { d: 'M2.3 13.5h11.4M4 11V8m4 3V3m4 8V5.5' }));
}
