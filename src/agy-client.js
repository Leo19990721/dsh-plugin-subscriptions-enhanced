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
    'missing-cli': '未找到可用的 agy.exe，请安装官方 CLI 或检查安装路径。',
    'missing-cliShort': '未安装 CLI',
    unavailable: '无法连接 Google Antigravity，请检查本机代理后重试。',
    unavailableShort: '连接失败',
    permissionHint: '「工作区内」仅允许在工作区内审批修改；「只读」禁止修改。两种模式都不提供终端或 MCP。需要这些工具时，请切到「完全权限 + 需确认」或「完全权限」。',
    retry: '重新检查',
    openQuota: '查看额度',
    refreshQuota: '刷新额度',
    openingQuota: '正在查询额度…',
    quotaUpdated: '额度已更新',
    quotaFailed: '暂时查不到 Google 额度，请检查官方 CLI 登录和网络代理后重试。',
    quotaStale: '刷新失败，下面是上次查到的额度。',
    quotaGemini: 'Gemini 模型',
    quotaClaudeGpt: 'Claude / GPT 模型',
    quotaWeekly: '周额度',
    quotaFiveHour: '5 小时额度',
    quotaRemaining: '剩余 {percent}%',
    quotaToday: '今天 {time}',
    quotaReset: '{time} 重置',
    quotaCredits: 'G1 积分余额',
    quotaFetched: '{time} 更新',
    quotaResetPassed: '重置时间已过，请刷新',
    quotaUpgrade: '查看升级选项',
    dockOpen: '点击查看用量',
    dockRefresh: '刷新',
    dockFiveHour: '5h 剩 {percent}%',
    dockWeekly: '每周剩 {percent}%',
    dockCredits: '剩余 credits: {count}',
    dockFetched: '获取时间：{time}',
    dockExpired: '{cycle}待刷新',
    dockStale: '上次结果',
    dockQuotaWeekly: '每周额度',
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
    'missing-cli': 'No usable agy.exe was found. Install the official CLI or check its path.',
    'missing-cliShort': 'CLI not found',
    unavailable: 'Could not connect to Google Antigravity. Check your local proxy and try again.',
    unavailableShort: 'Unavailable',
    permissionHint: 'Workspace mode only allows approved edits inside the workspace. Read-only mode blocks edits. Neither mode offers terminal or MCP tools. For those tools, choose Full Access with approval or Full Access.',
    retry: 'Check again',
    openQuota: 'Check quota',
    refreshQuota: 'Refresh quota',
    openingQuota: 'Checking quota…',
    quotaUpdated: 'Quota updated',
    quotaFailed: 'Could not check Google quota. Check CLI sign-in and proxy settings, then retry.',
    quotaStale: 'Refresh failed. Showing the last successful check.',
    quotaGemini: 'Gemini models',
    quotaClaudeGpt: 'Claude / GPT models',
    quotaWeekly: 'Weekly quota',
    quotaFiveHour: '5-hour quota',
    quotaRemaining: '{percent}% remaining',
    quotaToday: 'today at {time}',
    quotaReset: 'Resets {time}',
    quotaCredits: 'G1 Credits balance',
    quotaFetched: 'Updated {time}',
    quotaResetPassed: 'Reset time passed; refresh to check',
    quotaUpgrade: 'See upgrade options',
    dockOpen: 'Check usage',
    dockRefresh: 'Refresh',
    dockFiveHour: '5h: {percent}% left',
    dockWeekly: 'Weekly: {percent}% left',
    dockCredits: 'Remaining credits: {count}',
    dockFetched: 'Fetched at: {time}',
    dockExpired: '{cycle}: refresh to check',
    dockStale: 'Last result',
    dockQuotaWeekly: 'Weekly quota',
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
  const quotaState = createAgyQuotaState(agySection);
  ctx.effect(() => ctx.locale.register(agySection, agyCopy), 'Antigravity status texts');
  ctx.on('connection/reset', quotaState.clear);
  ctx.effect(() => quotaState.clear, 'Antigravity quota cleanup');
  return quotaState;
}

function fallbackAgyTranslate(key, params) {
  return (agyCopy.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));
}

function normalizeAgyResult(result) {
  const status = result?.value?.status;
  const modelCount = typeof result?.value?.modelCount === 'number' ? result.value.modelCount : 0;
  const valid = result?.ok === true && ['ready', 'signed-out', 'missing-cli', 'unavailable'].includes(status);
  return valid ? { status, modelCount } : { status: 'unavailable', modelCount: 0 };
}

function useEnhancedGoogleStatus(rpc, quotaState) {
  const [attempt, setAttempt] = react.useState(0);
  const [state, setState] = react.useState();
  const [busy, setBusy] = react.useState();
  const [error, setError] = react.useState();
  const quota = react.useSyncExternalStore(quotaState.subscribe, quotaState.getSnapshot);
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
      const next = normalizeAgyResult(result);
      if (next.status === 'signed-out' || next.status === 'missing-cli') quotaState.clear();
      setState(next);
    }, () => {
      if (!signal.aborted) setState({ status: 'unavailable', modelCount: 0 });
    });
    return () => controller.abort();
  }, [rpc, attempt, quotaState]);

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
    const controller = new AbortController();
    actionAbort.current = controller;
    setBusy(action);
    setError(undefined);
    try {
      const result = await rpc.call('/api', agySection, { action }, controller.signal);
      if (controller.signal.aborted) return;
      if (result?.ok === true) {
        quotaState.clear();
        setState(normalizeAgyResult(result));
      } else {
        setError(result?.error?.message || true);
      }
    } catch (err) {
      if (!controller.signal.aborted) setError((err instanceof Error && err.message) || true);
    } finally {
      if (actionAbort.current === controller) {
        actionAbort.current = null;
        setBusy(undefined);
      }
    }
  }, [rpc, quotaState]);

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
    busy: busy ?? (quota.busy ? 'quota' : undefined),
    error,
    quota: quota.quota,
    quotaFailed: quota.failed,
    recheck,
    login: () => runAction('login'),
    logout: () => runAction('logout'),
    openQuota: () => {
      if (!actionAbort.current && state?.status === 'ready') void quotaState.query(rpc, { force: true });
    },
    cancelAuth,
  };
}

const agyQuotaCss = `
.dsh-agy-quota, .dsh-agy-quota-group { display: grid; gap: 6px; min-width: 0; }
.dsh-agy-quota { gap: 10px; }
.dsh-agy-quota-group + .dsh-agy-quota-group {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  padding-top: 10px;
}
.dsh-agy-quota-heading {
  font-size: 11.5px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.dsh-agy-quota-window { display: grid; gap: 4px; }
.dsh-agy-quota-line, .dsh-agy-quota-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 2px 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-agy-quota-summary {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0;
  margin-inline-start: auto;
  text-align: right;
}
.dsh-agy-quota-percent {
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.dsh-agy-quota-sep {
  margin: 0 4px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-agy-quota-summary small, .dsh-agy-quota-footer small {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-agy-quota-track {
  height: 4px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--dsw-alias-border-l2);
}
.dsh-agy-quota-fill {
  height: 100%;
  border-radius: 2px;
}
.dsh-agy-quota-footer { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 8px; }
.dsh-agy-quota-feedback { min-height: 18px; font-size: 12px; line-height: 18px; }
`;

function agyQuotaTime(value, today, t, reset = false) {
  const date = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() !== today.toDateString()) return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  return reset ? t('quotaToday', { time }) : time;
}

function agyQuotaCycle(label) {
  return /\bweekly limit(?: remaining)?$/iu.test(label) ? 'weekly'
    : /\bfive hour limit(?: remaining)?$/iu.test(label) ? 'fiveHour' : undefined;
}

function agyQuotaGroup(group) {
  return /^gemini models$/i.test(group) ? 'quotaGemini'
    : /^claude and gpt models$/i.test(group) ? 'quotaClaudeGpt' : group;
}

function AgyQuotaWindows({ quota, t, today, dock = false }) {
  const h = react.createElement;
  const groups = new Map();
  for (const row of quota.windows) {
    const key = agyQuotaGroup(row.group);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [...groups].sort(([a], [b]) => Number(b === 'quotaGemini') - Number(a === 'quotaGemini'));
  return h('div', { className: 'dsh-agy-quota' },
    ...ordered.map(([group, rows]) => {
      const heading = group === 'quotaGemini' || group === 'quotaClaudeGpt' ? t(group) : group;
      const priority = row => agyQuotaCycle(row.label) === 'fiveHour' ? 0 : agyQuotaCycle(row.label) === 'weekly' ? 1 : 2;
      const visibleRows = dock ? [...rows].sort((a, b) => priority(a) - priority(b)) : rows;
      return h('div', { key: group, className: 'dsh-agy-quota-group', role: 'group', 'aria-label': heading },
        h('div', { className: 'dsh-agy-quota-heading' }, heading),
        ...visibleRows.map(({ label, remainingPercent, resetAt }) => {
          const kind = agyQuotaCycle(label);
          const cycle = kind === 'weekly' ? t(dock ? 'dockQuotaWeekly' : 'quotaWeekly') : kind === 'fiveHour' ? t('quotaFiveHour') : label;
          const color = remainingPercent <= 10 ? 'var(--dsw-alias-state-error-primary)'
            : remainingPercent <= 30 ? 'var(--dsw-alias-state-warn-label)' : 'var(--dsw-alias-state-success-primary)';
          return h('div', { key: label + resetAt, className: 'dsh-agy-quota-window' },
            h('div', { className: 'dsh-agy-quota-line' },
              h('span', null, cycle),
              h('span', { className: 'dsh-agy-quota-summary' },
                h('span', { className: 'dsh-agy-quota-percent', style: { color } }, dock ? t('quotaRemaining', { percent: remainingPercent }) : `${remainingPercent}%`),
                h('span', { className: 'dsh-agy-quota-sep', 'aria-hidden': true }, '·'),
                h('small', null, Date.parse(resetAt) <= today.getTime() ? t('quotaResetPassed')
                  : t('quotaReset', { time: agyQuotaTime(resetAt, today, t, true) })))),
            h('div', { role: 'progressbar', 'aria-label': `${heading} · ${cycle}`, 'aria-valuenow': remainingPercent,
              'aria-valuetext': t('quotaRemaining', { percent: remainingPercent }),
              className: 'dsh-agy-quota-track' },
              h('div', { className: 'dsh-agy-quota-fill', style: { width: `${remainingPercent}%`, background: color } })));
        }));
    }));
}

function AgyQuotaCard({ quota, t }) {
  const h = react.createElement;
  const today = new Date();
  return h('div', { className: 'dsh-agy-quota' },
    h(AgyQuotaWindows, { quota, t, today }),
    h('div', { className: 'dsh-agy-quota-footer' },
      h('small', null, t('quotaFetched', { time: agyQuotaTime(quota.fetchedAt, today, t) })),
      h('small', null, t('quotaCredits'), ' ', quota.credits.remaining,
        quota.credits.upgradeUrl === 'https://antigravity.google/g1-upgrade' && h('a', {
          href: quota.credits.upgradeUrl, target: '_blank', rel: 'noreferrer noopener', style: { marginInlineStart: 8 },
        }, t('quotaUpgrade')))));
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
    connected && h('p', { style: styles$5.statusLine }, agyT('permissionHint')),
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
    connected && h('p', { role: 'status', 'aria-atomic': true,
      className: 'dsh-agy-quota-feedback', style: busy !== 'quota' && state.quotaFailed ? styles$5.errorLine : styles$5.statusLine },
      busy === 'quota' ? agyT('openingQuota') : state.quotaFailed ? agyT(state.quota ? 'quotaStale' : 'quotaFailed')
        : state.quota ? agyT('quotaUpdated') : null),
    connected && state.quota && h(AgyQuotaCard, { quota: state.quota, t: agyT })));
}
