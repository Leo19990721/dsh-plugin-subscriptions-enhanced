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
.dsh-enhanced-subscription-more > summary { cursor: pointer; }
.dsh-enhanced-subscription-more > .dsh-enhanced-subscription-list { margin-top: 8px; }
.dsh-enhanced-subscription-options { margin-top: 8px; }
`;

function EnhancedSubscriptionRow({ id, name, status, open, titleId, starting, unavailable, error, t, toggle, connect, cancel, children }) {
  const h = react.createElement;
  const title = status?.displayName || name;
  const busy = status?.busy === true;
  const connected = !busy && (status?.accounts?.length ?? 0) > 0;
  const state = busy || starting ? 'busy' : connected ? 'connected' : 'idle';
  return h('li', { className: 'dsh-enhanced-subscription-row', 'data-subscription-provider': id, 'aria-labelledby': titleId },
    h('div', { className: 'dsh-enhanced-subscription-head' },
      h('div', { className: 'dsh-enhanced-subscription-identity' },
        h('span', { id: titleId, style: styles$5.name }, title),
        title !== name && h('small', null, name),
        h('span', { role: 'status', className: 'dsh-enhanced-subscription-state', 'data-state': state },
          status && h('span', { 'aria-hidden': true, style: { ...styles$5.dot,
            background: starting ? 'var(--dsw-alias-state-warn-label)' : dotColor(status) } }),
          starting ? t('enhancedStarting') : unavailable && !status ? t('enhancedStatusUnavailable') : statusText(t, status))),
      h('div', { className: 'dsh-enhanced-subscription-actions' },
        busy && h('button', { type: 'button', onClick: cancel,
          'aria-label': t('enhancedCancelLabel', { name: title }) }, t('cancel')),
        status && !busy && !connected && h('button', { type: 'button', onClick: connect, disabled: starting,
          'aria-label': t('enhancedLoginLabel', { name: title }) }, t(starting ? 'enhancedStarting' : 'login')),
        !busy && !starting && h('button', { type: 'button', onClick: toggle, 'aria-expanded': open, disabled: !status,
          ...(open ? { 'aria-controls': `${titleId}-body` } : {}),
          'aria-label': t(open ? 'enhancedCollapseLabel' : 'enhancedManageLabel', { name: title }) },
        t(open ? 'enhancedCollapse' : 'enhancedManage')))),
    error && h('p', { role: 'alert', style: { ...styles$5.errorLine, overflowWrap: 'anywhere' } }, error),
    open && h('div', { id: `${titleId}-body`, className: 'dsh-enhanced-subscription-body' }, children));
}

export function enhancedProviderGroups(providers) {
  const main = ['codex', 'antigravity'];
  return {
    featured: main.map(id => providers.find(provider => provider.id === id)).filter(Boolean),
    other: providers.filter(provider => !main.includes(provider.id)),
  };
}

function renderEnhancedSubscriptionGroups(t, render) {
  const h = react.createElement;
  const { featured, other } = enhancedProviderGroups(PROVIDERS);
  return h(react.Fragment, null,
    h('ul', { className: 'dsh-enhanced-subscription-list' }, featured.map(render)),
    h('details', { className: 'dsh-enhanced-subscription-more' },
      h('summary', null, t('enhancedOtherSubscriptions')),
      h('ul', { className: 'dsh-enhanced-subscription-list' }, other.map(render))));
}

export function registerEnhancedModelsSettings(ctx, connection, t, component) {
  const loginState = createEnhancedLoginState();
  ctx.on('connection/reset', loginState.clear);
  ctx.effect(() => loginState.clear, 'subscriptions-enhanced: pending authorization cleanup');
  return ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'subscriptions-enhanced-accounts',
    order: 10,
    inject: () => ({ rpc: connection.rpc, t, loginState }),
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
        if (!attempt.starting && providers[attempt.provider]?.busy === false) finish(attempt);
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
    enhancedOtherSubscriptions: 'Other subscriptions',
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
    enhancedOtherSubscriptions: '其他订阅',
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
