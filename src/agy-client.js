const agySection = 'subscriptions-enhanced-gemini';
const agyCopy = {
  zh: {
    title: 'Google Antigravity',
    loading: '正在检查本机 Google 订阅…',
    loadingShort: '检查中…',
    ready: '已连接。在聊天模型菜单中选择 Google Antigravity 下的 Gemini 即可。',
    readyWithCount: '已连接（{count} 个 Gemini 模型）。在聊天模型菜单中选择 Google Antigravity 下的 Gemini 即可。',
    readyShort: '已连接',
    'signed-out': '未登录。点「登录」会由 Google 官方 Antigravity CLI 拉起浏览器授权（DSH 不接触凭据）。',
    'signed-outShort': '未登录',
    'missing-cli': '未找到受支持的 agy 1.5.12，请先安装官方 CLI。',
    'missing-cliShort': '未安装 CLI',
    unavailable: '无法连接 Google Antigravity，请检查本机代理后重试。',
    unavailableShort: '连接失败',
    retry: '重新检查',
    openQuota: '查看额度',
    refreshQuota: '刷新额度',
    openingQuota: '正在查询额度…',
    quotaFailed: '暂时查不到 Google 额度，请检查官方 CLI 登录和网络代理后重试。',
    quotaStale: '刷新失败，下面是上次查到的额度。',
    quotaRemaining: '剩余 {percent}%',
    quotaReset: '{time} 重置',
    quotaCredits: 'G1 Credits 余额',
    quotaFetched: '查询于 {time}',
    quotaResetPassed: '重置时间已过，请刷新',
    quotaUpgrade: '查看升级选项',
    login: '登录',
    loggingInShort: '登录中…',
    loggingInDetail: '正在通过 Google 官方 Antigravity CLI 发起登录，请在浏览器完成授权；完成后会自动连接。',
    logout: '退出登录',
    loggingOutShort: '退出中…',
    logoutConfirm: '确定退出 Google Antigravity 登录吗？这会同时退出本机官方 agy / Antigravity 的登录态。',
    cancel: '取消',
    authFailed: '操作未完成，请重试。',
  },
  en: {
    title: 'Google Antigravity',
    loading: 'Checking your local Google subscription…',
    loadingShort: 'Checking…',
    ready: 'Connected. Choose a Gemini model under Google Antigravity in the chat model menu.',
    readyWithCount: 'Connected ({count} Gemini model(s)). Choose a Gemini model under Google Antigravity in the chat model menu.',
    readyShort: 'Connected',
    'signed-out': 'Not signed in. Click Log in to launch Google’s official Antigravity CLI browser sign-in (DSH never reads credentials).',
    'signed-outShort': 'Not signed in',
    'missing-cli': 'The supported agy 1.5.12 was not found. Install the official CLI first.',
    'missing-cliShort': 'CLI not found',
    unavailable: 'Could not connect to Google Antigravity. Check your local proxy and try again.',
    unavailableShort: 'Unavailable',
    retry: 'Check again',
    openQuota: 'Check quota',
    refreshQuota: 'Refresh quota',
    openingQuota: 'Checking quota…',
    quotaFailed: 'Could not check Google quota. Check CLI sign-in and proxy settings, then retry.',
    quotaStale: 'Refresh failed. Showing the last successful check.',
    quotaRemaining: '{percent}% remaining',
    quotaReset: 'Resets {time}',
    quotaCredits: 'G1 Credits balance',
    quotaFetched: 'Checked {time}',
    quotaResetPassed: 'Reset time passed; refresh to check',
    quotaUpgrade: 'See upgrade options',
    login: 'Log in',
    loggingInShort: 'Signing in…',
    loggingInDetail: 'Signing in via Google’s official Antigravity CLI. Complete authorization in your browser to connect.',
    logout: 'Log out',
    loggingOutShort: 'Signing out…',
    logoutConfirm: 'Log out of Google Antigravity? This also signs out the official local agy / Antigravity CLI session.',
    cancel: 'Cancel',
    authFailed: 'Operation did not complete. Please try again.',
  },
};

function installAgyClient(ctx) {
  ctx.effect(() => ctx.locale.register(agySection, agyCopy), 'Antigravity status texts');
}

function normalizeAgyResult(result) {
  const status = result?.value?.status;
  const modelCount = typeof result?.value?.modelCount === 'number' ? result.value.modelCount : 0;
  const valid = result?.ok === true && ['ready', 'signed-out', 'missing-cli', 'unavailable'].includes(status);
  return valid ? { status, modelCount } : { status: 'unavailable', modelCount: 0 };
}

function useEnhancedGoogleStatus(rpc) {
  const [attempt, setAttempt] = react.useState(0);
  const [state, setState] = react.useState();
  const [busy, setBusy] = react.useState();
  const [error, setError] = react.useState();
  const [quota, setQuota] = react.useState();
  const [quotaFailed, setQuotaFailed] = react.useState(false);
  const actionAbort = react.useRef(null);

  react.useEffect(() => {
    if (!rpc) return;
    const controller = new AbortController();
    const { signal } = controller;
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return rpc.call('/api', agySection, { action: attempt === 0 ? 'status' : 'inspect' }, signal);
    }).then(result => {
      if (signal.aborted) return;
      setState(normalizeAgyResult(result));
    }, () => {
      if (!signal.aborted) setState({ status: 'unavailable', modelCount: 0 });
    });
    return () => controller.abort();
  }, [rpc, attempt]);

  react.useEffect(() => () => {
    actionAbort.current?.abort();
    actionAbort.current = null;
  }, []);

  const recheck = react.useCallback(() => {
    setError(undefined);
    setState(undefined);
    setAttempt(value => value + 1);
  }, []);

  const runAction = react.useCallback(async (action) => {
    if (!rpc || actionAbort.current) return;
    const checkingQuota = action === 'quota';
    const controller = new AbortController();
    actionAbort.current = controller;
    setBusy(action);
    setError(undefined);
    setQuotaFailed(false);
    if (!checkingQuota) setQuota(undefined);
    try {
      const result = await rpc.call('/api', agySection, { action }, controller.signal);
      if (controller.signal.aborted) return;
      if (checkingQuota) {
        if (result?.ok === true && Array.isArray(result.value?.windows) && Number.isFinite(result.value?.credits?.remaining)) setQuota(result.value);
        else setQuotaFailed(true);
      } else if (result?.ok === true) {
        setState(normalizeAgyResult(result));
      } else {
        setError(result?.error?.message || true);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        if (checkingQuota) setQuotaFailed(true);
        else setError((err instanceof Error && err.message) || true);
      }
    } finally {
      if (actionAbort.current === controller) {
        actionAbort.current = null;
        setBusy(undefined);
      }
    }
  }, [rpc]);

  const cancelAuth = react.useCallback(() => {
    actionAbort.current?.abort();
    actionAbort.current = null;
    setBusy(undefined);
  }, []);

  return {
    status: state?.status,
    modelCount: state?.modelCount ?? 0,
    checking: state === undefined,
    connected: state?.status === 'ready',
    busy,
    error,
    quota,
    quotaFailed,
    recheck,
    login: () => runAction('login'),
    logout: () => runAction('logout'),
    openQuota: () => runAction('quota'),
    cancelAuth,
  };
}

function agyLocalReset(value) {
  const date = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function AgyQuotaCard({ quota, t }) {
  const h = react.createElement;
  return h('div', { 'aria-label': t('refreshQuota'), style: { display: 'grid', gap: 8 } },
    ...quota.windows.map(({ group, label, remainingPercent, resetAt }) => {
      const title = `${group} · ${label}`;
      const color = usageBarColor(100 - remainingPercent);
      return h('div', { key: title },
        h('div', { style: styles$5.statusLine }, title),
        h('div', { style: { ...styles$5.statusLine, color } },
          t('quotaRemaining', { percent: remainingPercent }), ' · ',
          Date.parse(resetAt) <= Date.now() ? t('quotaResetPassed') : t('quotaReset', { time: agyLocalReset(resetAt) })),
        h('div', { role: 'progressbar', 'aria-label': title, 'aria-valuenow': remainingPercent, style: styles$5.usageTrack },
          h('div', { style: { ...styles$5.usageFill, width: `${remainingPercent}%`, background: color } })));
    }),
    h('p', { style: styles$5.statusLine }, t('quotaCredits'), ': ', quota.credits.remaining,
      quota.credits.upgradeUrl === 'https://antigravity.google/g1-upgrade' && h('a', {
        href: quota.credits.upgradeUrl, target: '_blank', rel: 'noreferrer noopener', style: { marginInlineStart: 8 },
      }, t('quotaUpgrade'))),
    h('small', { style: styles$5.statusLine }, t('quotaFetched', { time: agyLocalReset(quota.fetchedAt) })));
}

function EnhancedGoogleRow({ sectionId, state, open, toggle, t, agyT }) {
  const h = react.createElement;
  const titleId = `${sectionId}-antigravity`;
  const title = agyT('title');
  const status = state.status;
  const connected = status === 'ready';
  const checking = state.checking;
  const busy = state.busy;
  const accountBusy = busy && busy !== 'quota';
  const rowState = checking || accountBusy ? 'busy' : connected ? 'connected' : 'idle';
  const dotBg = checking || accountBusy
    ? 'var(--dsw-alias-state-warn-label)'
    : connected
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-label-dimmed)';
  const shortStatus = busy === 'login'
    ? agyT('loggingInShort')
    : busy === 'logout'
      ? agyT('loggingOutShort')
      : checking
        ? agyT('loadingShort')
        : agyT(`${status}Short`);
  const detailText = busy === 'login'
    ? agyT('loggingInDetail')
    : checking
      ? agyT('loading')
      : connected && state.modelCount > 0
        ? agyT('readyWithCount', { count: state.modelCount })
        : agyT(status);
  const expanded = open || busy === 'login';
  const quotaEnabled = connected && !checking && !busy;
  const errorText = state.error === true ? agyT('authFailed') : state.error;

  const onLogout = () => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(agyT('logoutConfirm'))) return;
    void state.logout();
  };

  return h('li', {
    id: `${titleId}-row`,
    tabIndex: -1,
    className: 'dsh-enhanced-subscription-row',
    'data-subscription-provider': 'antigravity',
    'aria-labelledby': titleId,
  },
  h('div', { className: 'dsh-enhanced-subscription-head' },
    h('div', { className: 'dsh-enhanced-subscription-identity' },
      h('span', { id: titleId, className: 'dsh-enhanced-subscription-name' }, title),
      h('span', { role: 'status', className: 'dsh-enhanced-subscription-state', 'data-state': rowState },
        h('span', { 'aria-hidden': true, style: { ...styles$5.dot, background: dotBg } }),
        shortStatus)),
    h('div', { className: 'dsh-enhanced-subscription-actions' },
      busy === 'login' && h('button', {
        type: 'button',
        onClick: state.cancelAuth,
      }, agyT('cancel')),
      !busy && !checking && status === 'signed-out' && h('button', {
        type: 'button',
        onClick: state.login,
      }, agyT('login')),
      !busy && !connected && status !== 'signed-out' && h('button', {
        type: 'button',
        disabled: checking,
        onClick: state.recheck,
      }, agyT('retry')),
      !accountBusy && h('button', {
        id: `${titleId}-manage`,
        type: 'button',
        onClick: toggle,
        'aria-expanded': expanded,
        ...(expanded ? { 'aria-controls': `${titleId}-body` } : {}),
        'aria-label': t(expanded ? 'enhancedCollapseLabel' : 'enhancedManageLabel', { name: title }),
      }, t(expanded ? 'enhancedCollapse' : 'enhancedManage')))),
  errorText && h('p', { role: 'alert', style: { ...styles$5.errorLine, overflowWrap: 'anywhere' } }, errorText),
  expanded && h('div', { id: `${titleId}-body`, className: 'dsh-enhanced-subscription-body' },
    h('p', { role: status === 'unavailable' ? 'alert' : 'status', style: styles$5.statusLine }, detailText),
    h('div', { style: styles$5.actions },
      status === 'signed-out' && !busy && h('button', {
        type: 'button',
        onClick: state.login,
      }, agyT('login')),
      h('button', {
        type: 'button',
        disabled: checking || Boolean(busy),
        onClick: state.recheck,
      }, agyT('retry')),
      connected && h('button', {
        type: 'button',
        'aria-disabled': !quotaEnabled,
        style: quotaEnabled ? undefined : { opacity: 0.4, cursor: 'default' },
        onClick: () => { if (quotaEnabled) void state.openQuota(); },
      }, agyT(state.quota ? 'refreshQuota' : 'openQuota')),
      connected && h('button', {
        type: 'button',
        disabled: checking || Boolean(busy),
        onClick: onLogout,
      }, agyT('logout'))),
    busy === 'quota' && h('p', { role: 'status', style: styles$5.statusLine }, agyT('openingQuota')),
    connected && state.quotaFailed && h('p', { role: 'alert', style: styles$5.errorLine }, agyT(state.quota ? 'quotaStale' : 'quotaFailed')),
    connected && state.quota && h(AgyQuotaCard, { quota: state.quota, t: agyT })));
}
