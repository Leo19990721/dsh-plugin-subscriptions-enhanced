const emptyAgyDockModel = { getSnapshot: () => undefined, subscribe: () => () => {} };

function agyDockModelStore(models, sessionId) {
  try { return models()?.directoryFor(sessionId).store ?? emptyAgyDockModel; }
  catch { return emptyAgyDockModel; } // A composer without a retained model directory.
}

function agyDockRoute(model) {
  if (model?.current?.provider === 'antigravity') return model.routable === true ? 'antigravity' : 'hidden';
  if (model && !model.current && ['idle', 'loading'].includes(model.status)) return 'hidden';
  return 'legacy';
}

// The original badge remembers its last subscription for unrecognized providers.
// Do not mount it at all on Antigravity: no fallback Codex pill or legacy polling.
function ComposerSubscriptionUsage({ rpc, currentModel, t, agyT, quotaState, sessionId, useAgyDockModel }) {
  const route = useAgyDockModel(agyDockRoute);
  const legacySelection = react.useState();
  if (route === 'hidden' || (route === 'antigravity' && typeof sessionId === 'string' && sessionId.startsWith('dsh-peer:'))) return null;
  if (route === 'antigravity') return react.createElement(AgyUsageBadge, { key: sessionId, rpc, t, agyT, quotaState });
  return react.createElement(SubscriptionUsageBadge, { rpc, currentModel, t, legacySelection });
}

function agyDockSummary(quota, t, now = Date.now()) {
  if (!quota) return `${t('title')} · ${t('dockOpen')}`;
  const parts = [t('title')];
  const gemini = quota.windows.filter(row => agyQuotaGroup(row.group) === 'quotaGemini');
  for (const [kind, key, cycle] of [['fiveHour', 'dockFiveHour', 'quotaFiveHour'], ['weekly', 'dockWeekly', 'dockQuotaWeekly']]) {
    const row = gemini.find(row => agyQuotaCycle(row.label) === kind);
    if (row) parts.push(Date.parse(row.resetAt) <= now ? t('dockExpired', { cycle: t(cycle) })
      : t(key, { percent: row.remainingPercent }));
  }
  parts.push(t('dockCredits', { count: quota.credits.remaining }));
  return parts.join(' · ');
}

function agyDockTimestamp(value) {
  const date = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const agyDockCss = `
.dsh-agy-dock-refresh {
  border: 0.5px solid var(--dsw-alias-border-l2);
  padding: 1px 7px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
  font-weight: 400;
  cursor: pointer;
}
.dsh-agy-dock-refresh:hover:not([aria-disabled="true"]) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-agy-dock-refresh[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.dsh-agy-dock-refresh:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-agy-dock-meta {
  display: grid;
  gap: 2px;
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
`;

const AGY_QUOTA_DOCK_MAX_AGE_MS = 10 * 60_000;

function watchAgyDockQuota(rpc, quotaState) {
  let timer, unsubscribe;
  const options = { maxAgeMs: AGY_QUOTA_DOCK_MAX_AGE_MS };
  const clearTimer = () => clearTimeout(timer);
  const schedule = () => {
    clearTimer();
    if (document.visibilityState === 'hidden') return;
    const dueAt = quotaState.nextRefreshAt(options.maxAgeMs);
    if (dueAt === Infinity) return; // The pending result will reschedule us.
    timer = setTimeout(check, Math.max(AGY_QUOTA_MIN_RETRY_MS, dueAt - Date.now()));
  };
  function check() {
    if (document.visibilityState !== 'hidden') void quotaState.query(rpc, options);
    schedule();
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      clearTimer();
      unsubscribe?.();
      unsubscribe = undefined;
    } else {
      unsubscribe ??= quotaState.subscribe(schedule);
      check();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribe?.();
    clearTimer();
  };
}

function AgyUsageBadge({ rpc, t = fallbackTranslate, agyT = fallbackAgyTranslate, quotaState }) {
  const h = react.createElement;
  const mode = useUsageBadgeMode();
  const { quota, busy, failed } = react.useSyncExternalStore(quotaState.subscribe, quotaState.getSnapshot);
  const [open, setOpen] = react.useState(false);
  const [hover, setHover] = react.useState(false);
  const anchorRef = react.useRef(null);
  const triggerRef = react.useRef(null);
  const panelRef = react.useRef(null);
  const refreshRef = react.useRef(null);
  const panelId = react.useId();
  const visible = mode !== 'hidden' && !!rpc;
  const showPanel = visible && open;
  const pos = enhancedAnchoredPosition({ open: showPanel, anchorRef, panelRef, gap: PANEL_GAP, margin: PANEL_MARGIN });
  enhancedDismissOutside(anchorRef, showPanel, setOpen, panelRef);
  const panelPlaced = showPanel && pos !== null;
  react.useLayoutEffect(() => {
    if (panelPlaced) refreshRef.current?.focus({ preventScroll: true });
  }, [panelPlaced]);
  react.useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  react.useEffect(() => {
    if (visible) return watchAgyDockQuota(rpc, quotaState);
  }, [visible, rpc, quotaState]);
  react.useEffect(() => {
    if (!showPanel) return;
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
    };
    const onFocusIn = event => {
      if (!anchorRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [showPanel]);
  if (!visible) return null;

  const title = t('usageBadgeTitle');
  // A local reset time is enough; this badge does not need a presentation timer either.
  const now = new Date();
  const label = !quota && busy ? `${agyT('title')} · ${agyT('openingQuota')}`
    : `${agyDockSummary(quota, agyT, now.getTime())}${quota && failed ? ` · ${agyT('dockStale')}` : ''}`;
  return h('span', { ref: anchorRef, style: styles.anchor },
    h('style', null, subscriptionChromeCss + agyQuotaCss + agyDockCss),
    h('button', {
      ref: triggerRef, type: 'button', className: 'dsh-subscription-usage-pill',
      style: { ...styles.pill, ...(hover || showPanel ? styles.pillActive : {}) },
      'aria-haspopup': 'dialog', 'aria-expanded': showPanel,
      ...(showPanel ? { 'aria-controls': panelId } : {}),
      'aria-label': `${title} · ${label}`, title: `${title} · ${label}`,
      onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
      onClick: () => {
        setOpen(!showPanel);
        if (!showPanel) void quotaState.query(rpc, { maxAgeMs: AGY_QUOTA_VIEW_MAX_AGE_MS });
      },
    }, h(UsageBadgeIcon), h('span', { style: styles.label }, label)),
    showPanel && react_dom.createPortal(h('div', {
      id: panelId, role: 'dialog', 'aria-labelledby': `${panelId}-title`, ref: panelRef,
      className: 'dsh-subscription-usage-panel', style: { ...styles.panel, ...(pos ?? MEASURE_STYLE) },
    },
    h('div', { style: { ...styles.title, alignItems: 'center' } },
      h('span', { id: `${panelId}-title`, style: styles.titleLabel }, h(UsageBadgeIcon), title),
      h('button', {
        ref: refreshRef, type: 'button', className: 'dsh-agy-dock-refresh', 'aria-disabled': busy,
        onClick: () => { if (!busy) void quotaState.query(rpc, { force: true }); },
      }, agyT('dockRefresh'))),
    h('div', { style: styles.titleRule, 'aria-hidden': true }),
    h('div', { style: styles.providerRow }, h('span', { style: styles.providerName },
      agyT('title'), h('span', { style: styles.currentTag }, t('usageBadgeCurrent')))),
    (busy || failed) && h('div', {
      role: 'status', 'aria-atomic': true,
      style: { ...(failed && !busy ? styles$5.errorLine : styles$5.statusLine), marginBottom: quota ? 6 : 0 },
    }, busy ? agyT('openingQuota') : agyT(quota ? 'quotaStale' : 'quotaFailed')),
    quota && h(react.Fragment, null,
      h('div', { className: 'dsh-agy-dock-meta' },
        h('div', null, agyT('dockFetched', { time: agyDockTimestamp(quota.fetchedAt) })),
        h('div', null, agyT('dockCredits', { count: quota.credits.remaining }))),
      h(AgyQuotaWindows, { quota, t: agyT, today: now, dock: true }))), document.body));
}
