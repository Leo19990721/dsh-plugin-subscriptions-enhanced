import { AGY_TOOL_RECORD, AGY_TOOL_CARD, agyToolSettled, decodeAgyTool } from './agy-local-tool-data.js';

export function agyToolDefinition() {
  return {
    target: 'chat', kind: AGY_TOOL_CARD,
    // Any snapshot can seed a paged view. The Conversation engine keeps the
    // earliest matching start and folds all later matches as updates.
    match: { [AGY_TOOL_RECORD]: event => {
      const value = decodeAgyTool(event);
      return value ? { id: value.id, role: 'start' } : null;
    } },
    start: (_context, { event }) => decodeAgyTool(event),
    update: (context, { event }) => decodeAgyTool(event) ?? context.state,
    publication: () => 'immediate',
    buildViewNode(context) {
      const anchor = context.start ?? context.matches[0];
      const state = context.state;
      if (!anchor || !state) return null;
      const location = anchor.location;
      const boundary = location.kind === 'step' ? location.step.end ?? location.turn.end
        : location.kind === 'turn' ? location.turn.end : undefined;
      const interrupted = boundary !== undefined && !agyToolSettled(state.status);
      const current = context.current.get('chat');
      if (current?.location === location && current.anchorSeq === anchor.event.seq
        && current.data.state === state && current.data.interrupted === interrupted) return current;
      return { target: 'chat', kind: AGY_TOOL_CARD, key: context.key, id: context.id, anchorSeq: anchor.event.seq,
        visibility: 'visible', location, data: { state, interrupted, end: boundary?.time } };
    },
  };
}

const agyToolGlyphs = { read: '▤', edit: '✎', write: '+', command: '›_', subagent: '♟', mcp: '◇', search: '⌕', other: '⋯' };
const agyToolCopy = {
  zh: {
    'category.read': '读取', 'category.edit': '修改', 'category.write': '写入', 'category.command': '命令',
    'category.subagent': '子代理', 'category.mcp': 'MCP', 'category.search': '搜索', 'category.other': '工具',
    'state.pending': '等待中', 'state.in_progress': '运行中', 'state.completed': '成功',
    'state.failed': '失败', 'state.cancelled': '已取消', 'state.interrupted': '结果未确认',
    output: '输出摘要', targets: '路径', target: '操作目标', diff: '文件改动', lines: '行', before: '修改前', after: '修改后',
    unknown: '—', ms: '毫秒', seconds: '秒', noDetails: '没有更多工具详情。',
  },
  en: {
    'category.read': 'Read', 'category.edit': 'Edit', 'category.write': 'Write', 'category.command': 'Command',
    'category.subagent': 'Subagent', 'category.mcp': 'MCP', 'category.search': 'Search', 'category.other': 'Tool',
    'state.pending': 'Pending', 'state.in_progress': 'Running', 'state.completed': 'Succeeded',
    'state.failed': 'Failed', 'state.cancelled': 'Cancelled', 'state.interrupted': 'Unconfirmed',
    output: 'Output summary', targets: 'Paths', target: 'Target', diff: 'File changes', lines: 'lines', before: 'Before', after: 'After',
    unknown: '—', ms: 'ms', seconds: 's', noDetails: 'No further tool details.',
  },
};
const agyToolEllipsis = { minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' };
const agyToolSecondary = 'var(--dsw-alias-label-caption, inherit)';
const agyToolMono = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 8px', fontFamily: 'monospace',
  background: 'var(--dsw-alias-bg-base)', padding: '6px 8px', borderRadius: '6px', maxHeight: '200px', overflow: 'auto' };

export function createAgyToolCard(React) {
  const h = React.createElement;
  function Running() {
    return h('svg', { width: 13, height: 13, viewBox: '0 0 14 14', 'aria-hidden': true, style: { flexShrink: 0 } },
      h('circle', { cx: 7, cy: 7, r: 5, fill: 'none', stroke: 'currentColor', opacity: 0.22 }),
      h('path', { d: 'M 7 2 A 5 5 0 0 1 12 7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
        h('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0 7 7', to: '360 7 7', dur: '0.85s', repeatCount: 'indefinite' })));
  }
  return function AgyToolCard({ node, t = key => agyToolCopy.en[key] }) {
    const { state, interrupted, end } = node.data;
    const status = interrupted ? 'interrupted' : state.status;
    const duration = Math.max(0, (state.settledAt ?? end ?? Date.now()) - state.startedAt);
    const elapsed = duration < 1000 ? `${duration} ${t('ms')}` : `${(duration / 1000).toFixed(1)} ${t('seconds')}`;
    const badge = status === 'completed' ? '✓' : status === 'failed' ? '×' : status === 'cancelled' ? '–' : '?';
    const mono = (label, value, key = label) => h('div', { key }, h('div', null, label), h('pre', { style: agyToolMono }, value));
    const detail = [];
    if (state.target) detail.push(mono(t('target'), state.target));
    const extraPaths = state.paths.filter(path => path !== state.target);
    if (extraPaths.length) detail.push(mono(t('targets'), extraPaths.join('\n')));
    if (state.output) detail.push(mono(t('output'), state.output));
    for (const [index, diff] of state.diffs.entries()) {
      detail.push(h('div', { key: `diff-${index}` },
        h('div', null, `${t('diff')}${diff.path ? ` · ${diff.path}` : ''} · ${diff.before ?? t('unknown')} → ${diff.after ?? t('unknown')} ${t('lines')}`),
        diff.oldPreview && mono(t('before'), diff.oldPreview), diff.newPreview && mono(t('after'), diff.newPreview)));
    }
    return h('details', { 'data-agy-tool-status': status, style: {
      border: '1px solid var(--dsw-alias-line-base, transparent)', borderRadius: '8px',
      color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    } },
    h('summary', { style: { cursor: 'pointer', padding: '3px 8px', minWidth: 0 } },
      h('span', { style: { display: 'inline-flex', verticalAlign: 'middle', alignItems: 'center', gap: '7px', maxWidth: 'calc(100% - 18px)' } },
        h('span', { style: { flex: 'none', color: agyToolSecondary } }, h('span', { 'aria-hidden': true }, `${agyToolGlyphs[state.category]} `), t(`category.${state.category}`)),
        h('span', { style: { ...agyToolEllipsis, fontWeight: 550 }, title: state.title }, state.title),
        state.target && !state.title.includes(state.target) && h('code', { title: state.target, style: { ...agyToolEllipsis, flex: '1 2 auto', color: agyToolSecondary } }, state.target),
        h('span', { style: { display: 'inline-flex', flex: 'none', gap: '4px', alignItems: 'center', color: agyToolSecondary }, role: 'status' },
          status === 'in_progress' || status === 'pending' ? h(Running) : h('span', { 'aria-hidden': true }, badge),
          t(`state.${status}`)),
        (state.settledAt !== undefined || interrupted) && h('span', { style: { flex: 'none', color: agyToolSecondary } }, elapsed))),
    h('div', { style: { padding: '4px 12px 2px', overflowWrap: 'anywhere' } }, detail.length ? detail : t('noDetails')));
  };
}

export function registerAgyToolCards(ctx, React) {
  const slots = ctx.slots;
  if (typeof slots?.inject !== 'function' || typeof slots.register !== 'function' || typeof ctx.inject !== 'function') return;
  return ctx.inject(['uiConversation'], scope => {
    if (typeof scope.uiConversation?.events?.register !== 'function') return;
    const slot = 'conversation.chat.node';
    const locale = `${AGY_TOOL_CARD}-card`;
    if (typeof scope.locale?.register === 'function') {
      scope.effect?.(() => scope.locale.register(locale, agyToolCopy), 'Antigravity tool cards locale');
    }
    const View = createAgyToolCard(React);
    return scope.slots.inject(slot, () => {
      const unregisterSlot = scope.slots.register({ name: slot, key: AGY_TOOL_CARD, locale }, View);
      let unregisterEvent;
      try { unregisterEvent = scope.uiConversation.events.register(agyToolDefinition()); }
      catch { unregisterSlot(); return; }
      // Only a running, mounted Chat seat advertises support. A short lease
      // recovers after an unclean browser exit without keeping server state by tab.
      const signal = new AbortController();
      const advertise = () => {
        const connection = scope.get('connection');
        if (connection?.isLoopback !== false) {
          void Promise.resolve(connection?.rpc?.call?.('/api', 'subscriptions-enhanced-gemini',
            { action: 'tool-cards-v1' }, signal.signal)).catch(() => {});
        }
      };
      const off = scope.on('connection/reset', advertise);
      const timer = setInterval(advertise, 30_000);
      queueMicrotask(() => { if (!signal.signal.aborted) advertise(); });
      return () => { signal.abort(); clearInterval(timer); off(); unregisterEvent(); unregisterSlot(); };
    });
  });
}
