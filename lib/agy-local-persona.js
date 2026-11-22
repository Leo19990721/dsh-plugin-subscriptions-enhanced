const PERSONA_MODULE = '@deepseek-ai/dsh-persona';

// Match the native {{name}} syntax, but never resolve arbitrary prompt variables:
// only the current route's provider and model are safe to substitute here.
function renderRouteTemplate(text, selection) {
  let rendered = '';
  let last = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = /^\{\{([^{}]*)\}\}/u.exec(text.slice(open));
    if (!group) {
      if (text.indexOf('}}', open + 2) !== -1) return undefined;
      rendered += text.slice(last, open + 2);
      last = open + 2;
      continue;
    }
    const key = group[1];
    if (key !== 'model' && key !== 'provider') return undefined;
    const value = selection?.[key];
    if (typeof value !== 'string' || !value) return undefined;
    rendered += text.slice(last, open) + value;
    last = open + group[0].length;
  }
  return rendered + text.slice(last);
}

/** Optional installed-Host capability: copy only the active preset's explicit native persona. */
export function resolveAgyPresetPersona(agentCtx, selection) {
  // readDocument(id) looks up the roster, not this Agent's retained revision.
  // assemble() merges deployment defaults and all other prompt providers.
  // Until DSH offers a narrow getter, use only this exact revision's active rows.
  try {
    const presets = agentCtx?.get('agentPresets');
    const preset = presets?.composedPreset?.(agentCtx);
    if (!preset) return undefined;
    const mount = presets.generationFor?.(agentCtx)?.mount;
    if (mount?.presetId !== preset || typeof mount.tree?.entries !== 'function') return undefined;
    let persona;
    for (const entry of mount.tree.entries()) {
      if (entry.options?.name !== PERSONA_MODULE || entry.options.group || entry.fiber?.state !== 2) continue;
      // Do not call entry.disabled: its getter can re-evaluate a !!js condition.
      if (persona) return undefined;
      persona = entry.fiber;
    }
    if (!persona) return undefined;
    const raw = persona.rawConfig;
    const active = persona.effectiveConfig;
    // A computed config (e.g. !!js) can resolve host-local values. Only copy
    // declared strings that the native persona plugin actually received.
    if (typeof raw?.prefix !== 'string' || raw.prefix !== active?.prefix || typeof active.complete !== 'boolean') return undefined;
    const prefix = renderRouteTemplate(active.prefix, selection);
    if (prefix === undefined) return undefined;
    if (active.complete) return prefix || undefined;
    const declaredSuffix = Object.hasOwn(raw, 'suffix') ? raw.suffix : '';
    if (typeof declaredSuffix !== 'string' || declaredSuffix !== active.suffix) return undefined;
    const suffix = renderRouteTemplate(active.suffix, selection);
    if (suffix === undefined) return undefined;
    return [prefix, suffix].filter(Boolean).join('\n\n') || undefined;
  } catch {
    // Unsupported Host shape: no persona, never fall back to another prompt source.
    return undefined;
  }
}
