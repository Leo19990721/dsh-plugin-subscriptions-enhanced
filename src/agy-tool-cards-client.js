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

const agyToolStyles = {
  root: { display: 'flex', flexDirection: 'column' },
  sep: { background: 'var(--dsw-alias-label-caption)', borderRadius: '1px', flex: 'none', width: '2px', height: '2px', margin: '0 8px' },
  summary: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))', flex: 'auto', overflow: 'hidden' },
  errorText: { color: 'var(--dsw-alias-state-error-primary)' },
  warnText: { color: 'var(--dsw-alias-state-warn-label)' },
  suffix: { whiteSpace: 'nowrap', fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))', flex: 'none', marginLeft: '6px' },
  diffStat: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)',
    marginLeft: '8px', flex: 'none', whiteSpace: 'nowrap' },
  diffAdd: { color: 'var(--dsw-alias-state-success-primary)' },
  diffDel: { color: 'var(--dsw-alias-state-error-primary)' },
  fileLink: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, font: 'inherit', textAlign: 'left',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
    color: 'inherit', background: 'none', border: 'none', flex: '0 auto', margin: 0, padding: 0, overflow: 'hidden',
    cursor: 'pointer', textUnderlineOffset: '3px', textDecoration: 'underline 1px dotted' },
  fallbackRow: { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', minWidth: 0, padding: '2px 4px',
    border: 'none', background: 'none', color: 'var(--dsw-alias-label-secondary, inherit)', font: 'inherit',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
    textAlign: 'left', borderRadius: 'var(--dsw-radius-sm, 6px)' },
  bodyWrap: { display: 'flex', flexDirection: 'column' },
  terminalWrap: { margin: '4px 0 4px 4px', border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-lg, 10px)', overflow: 'hidden' },
  ioCard: { border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-lg, 10px)',
    background: 'var(--dsw-alias-markdown-code-block)', font: 'var(--dsw-font-markdown-code-block-small, 12px/18px monospace)',
    display: 'flex', flexDirection: 'column', margin: '4px 0 4px 4px', overflow: 'hidden' },
  ioSection: { display: 'grid', gridTemplateColumns: 'max-content 1fr', alignItems: 'baseline', columnGap: '14px',
    maxHeight: '180px', padding: '10px 14px', overflowY: 'auto' },
  ioLabel: { color: 'var(--dsw-alias-label-caption)', alignSelf: 'start', position: 'sticky', top: 0,
    fontFamily: 'var(--ds-font-family-sans, inherit)', fontSize: '12px' },
  ioDivider: { background: 'var(--dsw-alias-border-l2)', flex: 'none', height: '0.5px' },
  ioText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0, color: 'var(--dsw-alias-label-secondary)', margin: 0, font: 'inherit' },
  diffWrap: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  diffHead: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  diffPre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, padding: '6px 8px', borderRadius: '6px',
    font: 'inherit', maxHeight: '140px', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' },
  diffDelBg: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d93025) 8%, transparent)' },
  diffAddBg: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #1e8e3e) 8%, transparent)' },
  metaFoot: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 14px',
    fontFamily: 'var(--ds-font-family-sans, inherit)', fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
};

const agyToolCopy = {
  zh: {
    'category.read': '读取', 'category.edit': '修改', 'category.write': '写入', 'category.command': '执行命令',
    'category.subagent': '子代理', 'category.mcp': 'MCP', 'category.search': '搜索', 'category.other': '工具',
    'server.remote': '远程主机', 'server.playwright': '浏览器', 'server.knowledge': '知识库', 'server.windows': '桌面控制',
    'state.pending': '等待中', 'state.in_progress': '运行中', 'state.completed': '已完成',
    'state.failed': '失败', 'state.cancelled': '已取消', 'state.interrupted': '结果未确认',
    output: '输出', targets: '路径', target: '输入', command: '命令', diff: '改动',
    lines: '行', before: '修改前', after: '修改后', unknown: '—', ms: '毫秒', seconds: '秒',
    copy: '复制', copied: '已复制', collapse: '收起', noOutput: '无输出', expandRest: '展开其余 {n} 行',
    commandLine: '第 {n} 行', exitCode: '退出码 {code}', noExitCode: '已退出',
  },
  en: {
    'category.read': 'Read', 'category.edit': 'Edit', 'category.write': 'Write', 'category.command': 'Run command',
    'category.subagent': 'Subagent', 'category.mcp': 'MCP', 'category.search': 'Search', 'category.other': 'Tool',
    'server.remote': 'Remote', 'server.playwright': 'Browser', 'server.knowledge': 'Knowledge', 'server.windows': 'Desktop',
    'state.pending': 'Pending', 'state.in_progress': 'Running', 'state.completed': 'Completed',
    'state.failed': 'Failed', 'state.cancelled': 'Cancelled', 'state.interrupted': 'Unconfirmed',
    output: 'Output', targets: 'Paths', target: 'Input', command: 'Command', diff: 'Changes',
    lines: 'lines', before: 'Before', after: 'After', unknown: '—', ms: 'ms', seconds: 's',
    copy: 'Copy', copied: 'Copied', collapse: 'Collapse', noOutput: 'No output', expandRest: 'Show {n} more lines',
    commandLine: 'Line {n}', exitCode: 'Exit {code}', noExitCode: 'Exited',
  },
};

function normalizeToolPath(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim().replace(/^file:\/{2,3}(?=[a-z]:[\\/])/iu, '');
  if (/^\/[a-z]:[\\/]/iu.test(value)) value = value.slice(1);
  return value;
}

function splitPathAndLine(raw) {
  const normalized = normalizeToolPath(raw);
  const match = /^(.+?):(\d+)$/u.exec(normalized);
  if (match && !/^[a-z]$/iu.test(match[1])) return { path: match[1], line: Number(match[2]) };
  return { path: normalized, line: undefined };
}

function shortenToolPath(raw, cwd) {
  const { path, line } = splitPathAndLine(raw);
  if (!path) return '';
  const slashPath = path.replace(/\\/gu, '/');
  let label = slashPath;
  if (typeof cwd === 'string' && cwd) {
    const base = normalizeToolPath(cwd).replace(/\\/gu, '/').replace(/\/+$/u, '');
    if (base && slashPath.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      label = slashPath.slice(base.length + 1);
    }
  }
  if (label === slashPath) {
    const parts = slashPath.split('/').filter(Boolean);
    if (parts.length > 2) label = parts.slice(-2).join('/');
  }
  return line !== undefined ? `${label}:${line}` : label;
}

function looksLikePath(value) {
  return typeof value === 'string' && (/^(?:\/)?[a-z]:[\\/]/iu.test(value) || value.startsWith('\\\\') || value.startsWith('/'));
}

function formatAgyToolHeader(state, t, cwd) {
  const rawTitle = (state.title || '').trim();
  const rawTarget = (state.target || '').trim();
  const cleanTitle = rawTitle.replace(/^Run\s+/iu, '').trim();

  // MCP bridged tools: mcp_dsh_mcp__<server>__<tool>, mcp_dsh_remote_<op>, mcp_dsh_<tool>
  const mcpServerMatch = /^mcp_dsh_mcp__([a-z0-9_-]+?)__(.+)$/iu.exec(cleanTitle);
  if (mcpServerMatch) {
    const serverKey = mcpServerMatch[1].toLowerCase();
    const serverLabel = agyToolCopy.en[`server.${serverKey}`] ? t(`server.${serverKey}`) : mcpServerMatch[1];
    return { title: serverLabel, summary: mcpServerMatch[2], tooltip: cleanTitle, filePath: undefined, fileLine: undefined };
  }
  const remoteMatch = /^mcp_dsh_remote_(.+)$/iu.exec(cleanTitle);
  if (remoteMatch) {
    return { title: t('server.remote'), summary: remoteMatch[1], tooltip: cleanTitle, filePath: undefined, fileLine: undefined };
  }
  const dshBridgeMatch = /^mcp_dsh_(.+)$/iu.exec(cleanTitle);
  if (dshBridgeMatch) {
    const verb = state.category === 'subagent' ? t('category.subagent') : t('category.mcp');
    const summary = rawTarget && rawTarget !== rawTitle ? rawTarget : dshBridgeMatch[1];
    return { title: verb, summary, tooltip: summary, filePath: undefined, fileLine: undefined };
  }

  // File operations: strip noisy "File /C:/..." or "Read /C:/..." prefixes
  if (state.category === 'read' || state.category === 'edit' || state.category === 'write') {
    const stripped = rawTitle.replace(/^(?:File|Read|View|Edit|Write|Create|Save)\s+/iu, '').trim();
    const candidate = rawTarget || state.paths?.[0] || (looksLikePath(stripped) ? stripped : '');
    if (candidate) {
      const { path: fullPath, line } = splitPathAndLine(candidate);
      return {
        title: t(`category.${state.category}`),
        summary: shortenToolPath(candidate, cwd),
        tooltip: line !== undefined ? `${fullPath}:${line}` : fullPath,
        filePath: fullPath,
        fileLine: line,
      };
    }
    return {
      title: t(`category.${state.category}`),
      summary: stripped || rawTitle,
      tooltip: stripped || rawTitle,
      filePath: undefined,
      fileLine: undefined,
    };
  }

  if (state.category === 'command') {
    const cmd = (rawTarget || rawTitle).replace(/\s+/gu, ' ').trim();
    return { title: t('category.command'), summary: cmd, tooltip: rawTarget || rawTitle, filePath: undefined, fileLine: undefined };
  }

  const summary = rawTarget && rawTarget !== rawTitle ? rawTarget : cleanTitle || rawTitle;
  return {
    title: t(`category.${state.category}`),
    summary: summary === t(`category.${state.category}`) ? '' : summary,
    tooltip: rawTarget || rawTitle,
    filePath: undefined,
    fileLine: undefined,
  };
}

function agyDiffTotals(diffs) {
  if (!Array.isArray(diffs) || !diffs.length) return null;
  let added = 0, removed = 0, valid = false;
  for (const diff of diffs) {
    if (typeof diff.before === 'number' && typeof diff.after === 'number') {
      valid = true;
      if (diff.after >= diff.before) added += diff.after - diff.before;
      else removed += diff.before - diff.after;
    }
  }
  if (!valid || (added === 0 && removed === 0)) return null;
  return { added, removed };
}

function fallbackIcon(h, category) {
  const props = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } };
  if (category === 'read') return h('svg', props, h('path', { d: 'M3 2.5h6.5L13 6v7.5H3z' }), h('path', { d: 'M9.5 2.5V6H13' }));
  if (category === 'edit' || category === 'write') return h('svg', props, h('path', { d: 'M11.5 2.5l2 2-7.5 7.5-2.5.5.5-2.5z' }));
  if (category === 'command') return h('svg', props, h('path', { d: 'M3.5 5l3 3-3 3' }), h('path', { d: 'M8 11h4.5' }));
  if (category === 'search') return h('svg', props, h('circle', { cx: 7, cy: 7, r: 4 }), h('path', { d: 'M10.2 10.2L13.5 13.5' }));
  if (category === 'subagent') return h('svg', props, h('circle', { cx: 6, cy: 5.5, r: 2 }), h('path', { d: 'M2.5 13c.4-2 1.8-3 3.5-3s3.1 1 3.5 3' }), h('circle', { cx: 11, cy: 6.5, r: 1.5 }), h('path', { d: 'M11 9.5c1.3 0 2.3.7 2.6 2.2' }));
  return h('svg', props, h('path', { d: 'M8 2.5l1.3 3.7L13 7.5l-3.7 1.3L8 12.5l-1.3-3.7L3 7.5l3.7-1.3z' }));
}

function nativeIcon(h, primitives, category) {
  if (!primitives) return fallbackIcon(h, category);
  const Pick = category === 'read' ? primitives.IconBrowseOutlineRegular
    : category === 'edit' || category === 'write' ? primitives.IconEditOutlineRegular
    : category === 'command' ? primitives.IconApiOutlineRegular
    : category === 'search' ? primitives.IconSearchOutlineRegular
    : category === 'subagent' ? primitives.IconUsersOutlineRegular
    : category === 'mcp' ? primitives.IconSparkleRegular
    : primitives.IconCodeOutlineRegular;
  return Pick ? h(Pick, { size: 14 }) : fallbackIcon(h, category);
}

function terminalLabelsFor(t) {
  return {
    commandLine: n => t('commandLine').replace('{n}', String(n)),
    signal: s => String(s),
    exitCode: code => t('exitCode').replace('{code}', String(code)),
    noExitCode: t('noExitCode'),
    running: t('state.in_progress'),
    failed: t('state.failed'),
    done: t('state.completed'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t('noOutput'),
    collapseAria: t('collapse'),
    collapse: t('collapse'),
    expandAria: n => t('expandRest').replace('{n}', String(n)),
    expand: n => t('expandRest').replace('{n}', String(n)),
  };
}

export function createAgyToolCard(React, primitives) {
  const h = React.createElement;
  const DisclosureRow = primitives?.DisclosureRow;
  const TextShimmer = primitives?.TextShimmer;
  const TerminalBlock = primitives?.TerminalBlock;

  return function AgyToolCard({ node, t = key => agyToolCopy.en[key], useDisclosure, cwd, openFile }) {
    const localState = React.useState ? React.useState(false) : [false, () => {}];
    const disclosure = typeof useDisclosure === 'function' ? useDisclosure() : {
      expanded: localState[0],
      toggle: () => localState[1](value => !value),
    };
    const { state, interrupted, end } = node.data;
    const status = interrupted ? 'interrupted' : state.status;
    const running = status === 'in_progress' || status === 'pending';
    const isError = status === 'failed';
    const isWarn = status === 'cancelled' || status === 'interrupted';
    const duration = Math.max(0, (state.settledAt ?? end ?? Date.now()) - state.startedAt);
    const elapsed = duration < 1000 ? `${duration} ${t('ms')}` : `${(duration / 1000).toFixed(1)} ${t('seconds')}`;

    const header = formatAgyToolHeader(state, t, cwd);
    const diffStat = !isError && !isWarn ? agyDiffTotals(state.diffs) : null;
    const normalizedPaths = (state.paths ?? []).map(normalizeToolPath).filter(Boolean);
    const normalizedTarget = state.category === 'read' || state.category === 'edit' || state.category === 'write'
      ? normalizeToolPath(state.target) : state.target;
    const hasDetails = Boolean(normalizedTarget || normalizedPaths.length || state.output || state.diffs?.length);
    const expandable = hasDetails;
    const open = Boolean(disclosure.expanded && expandable);
    const icon = nativeIcon(h, primitives, state.category);

    const wrapShimmer = children => TextShimmer ? h(TextShimmer, null, children) : children;

    const onOpenFile = header.filePath && typeof openFile === 'function' && !isError && !isWarn
      ? event => {
        event.stopPropagation();
        if (header.fileLine !== undefined) openFile(header.filePath, { line: header.fileLine });
        else openFile(header.filePath);
      }
      : undefined;

    const summaryStyle = isError ? { ...agyToolStyles.summary, ...agyToolStyles.errorText }
      : isWarn ? { ...agyToolStyles.summary, ...agyToolStyles.warnText } : agyToolStyles.summary;

    const summaryEl = header.summary ? (
      onOpenFile
        ? h('button', { type: 'button', style: agyToolStyles.fileLink, title: header.tooltip, onClick: onOpenFile }, wrapShimmer(header.summary))
        : h('span', { style: summaryStyle, title: header.tooltip }, wrapShimmer(header.summary))
    ) : null;

    const statusCue = isError
      ? h('span', { style: { ...agyToolStyles.suffix, ...agyToolStyles.errorText }, role: 'status' }, t('state.failed'))
      : isWarn
        ? h('span', { style: { ...agyToolStyles.suffix, ...agyToolStyles.warnText }, role: 'status' }, t(`state.${status}`))
        : null;

    const diffCue = diffStat
      ? h('span', { style: agyToolStyles.diffStat },
        diffStat.added > 0 && h('span', { style: agyToolStyles.diffAdd }, `+${diffStat.added}`),
        diffStat.added > 0 && diffStat.removed > 0 && ' ',
        diffStat.removed > 0 && h('span', { style: agyToolStyles.diffDel }, `-${diffStat.removed}`))
      : null;

    const collapsedContent = (summaryEl || statusCue || diffCue)
      ? h(React.Fragment ?? 'span', null,
        h('span', { style: agyToolStyles.sep, 'data-shimmer-decoration': true, 'aria-hidden': true }),
        summaryEl,
        statusCue,
        diffCue)
      : null;

    let expandedContent = null;
    if (open) {
      if (state.category === 'command' && TerminalBlock && normalizedTarget) {
        expandedContent = h('div', { style: agyToolStyles.bodyWrap },
          h('div', { style: agyToolStyles.terminalWrap },
            h(TerminalBlock, {
              command: normalizedTarget,
              output: state.output || '',
              running,
              exitCode: isError ? 1 : status === 'completed' ? 0 : undefined,
              maxLines: 20,
              labels: terminalLabelsFor(t),
            })));
      } else {
        const sections = [];
        const pushSection = (key, label, content) => {
          if (sections.length) sections.push(h('span', { key: `div-${key}`, style: agyToolStyles.ioDivider, 'aria-hidden': true }));
          sections.push(h('div', { key, style: agyToolStyles.ioSection },
            h('span', { style: agyToolStyles.ioLabel }, label),
            content));
        };
        if (normalizedTarget) {
          pushSection('target', state.category === 'command' ? t('command') : t('target'),
            h('pre', { style: agyToolStyles.ioText }, normalizedTarget));
        }
        const extraPaths = normalizedPaths.filter(path => path !== normalizedTarget);
        if (extraPaths.length) {
          pushSection('paths', t('targets'), h('pre', { style: agyToolStyles.ioText }, extraPaths.join('\n')));
        }
        if (state.output) {
          pushSection('output', t('output'), h('pre', {
            style: isError ? { ...agyToolStyles.ioText, ...agyToolStyles.errorText } : agyToolStyles.ioText,
          }, state.output));
        }
        if (state.diffs?.length) {
          pushSection('diffs', t('diff'), h('div', { style: agyToolStyles.diffWrap },
            ...state.diffs.map((diff, index) => h('div', { key: `d-${index}`, style: agyToolStyles.diffWrap },
              h('div', { style: agyToolStyles.diffHead },
                `${normalizeToolPath(diff.path) || t('diff')} · ${diff.before ?? t('unknown')} → ${diff.after ?? t('unknown')} ${t('lines')}`),
              diff.oldPreview && h('pre', { style: { ...agyToolStyles.diffPre, ...agyToolStyles.diffDelBg } }, diff.oldPreview),
              diff.newPreview && h('pre', { style: { ...agyToolStyles.diffPre, ...agyToolStyles.diffAddBg } }, diff.newPreview)))));
        }
        if (state.settledAt !== undefined || interrupted) {
          sections.push(h('span', { key: 'div-meta', style: agyToolStyles.ioDivider, 'aria-hidden': true }));
          sections.push(h('div', { key: 'meta', style: agyToolStyles.metaFoot },
            h('span', null, t(`state.${status}`)),
            h('span', null, elapsed)));
        }
        expandedContent = h('div', { style: agyToolStyles.bodyWrap },
          h('div', { style: agyToolStyles.ioCard }, ...sections));
      }
    }

    if (DisclosureRow) {
      return h('div', { style: agyToolStyles.root, 'data-agy-tool-status': status, 'data-agy-tool-category': state.category },
        h(DisclosureRow, {
          icon,
          title: header.title,
          running,
          open,
          expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: disclosure.toggle,
          collapsedContent,
        }, expandedContent));
    }

    // Fallback when @deepseek-ai/dsh-client-ui-primitives is unavailable (e.g., portable unit tests)
    const chevron = h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      style: { flexShrink: 0, transform: open ? 'rotate(90deg)' : undefined, opacity: 0.65 } },
    h('path', { d: 'M4.5 2.5L8 6l-3.5 3.5' }));
    return h('div', { style: agyToolStyles.root, 'data-agy-tool-status': status, 'data-agy-tool-category': state.category },
      h('button', {
        type: 'button',
        style: expandable ? { ...agyToolStyles.fallbackRow, cursor: 'pointer' } : agyToolStyles.fallbackRow,
        'data-expandable': expandable ? 'true' : undefined,
        'aria-expanded': expandable ? open : undefined,
        onClick: expandable ? disclosure.toggle : undefined,
      },
      expandable && chevron,
      icon,
      h('span', { style: { fontWeight: 400 } }, header.title),
      collapsedContent),
      expandedContent);
  };
}

export function loadAgyPrimitives(req) {
  try { return req?.('@deepseek-ai/dsh-client-ui-primitives'); }
  catch { return undefined; }
}

export function registerAgyToolCards(ctx, React, primitives) {
  const slots = ctx.slots;
  if (typeof slots?.inject !== 'function' || typeof slots.register !== 'function' || typeof ctx.inject !== 'function') return;
  return ctx.inject(['uiConversation'], scope => {
    if (typeof scope.uiConversation?.events?.register !== 'function') return;
    const slot = 'conversation.chat.node';
    const locale = `${AGY_TOOL_CARD}-card`;
    if (typeof scope.locale?.register === 'function') {
      scope.effect?.(() => scope.locale.register(locale, agyToolCopy), 'Antigravity tool cards locale');
    }
    const View = createAgyToolCard(React, primitives);
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
