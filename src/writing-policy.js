/** Session model categories; the native UI remains their only selector. */
export const WRITING_PRESET = 'writing';

export function baseModelId(model) {
  if (typeof model !== 'string') return '';
  if (!model.startsWith('~account:')) return model;
  try { return decodeURIComponent(model.split(':')[2] ?? ''); } catch { return ''; }
}

export function isGemini(selection) {
  return /^(?:antigravity-)?gemini(?:-|$)/i.test(baseModelId(selection?.model));
}

export function matchesMode(selection, preset) {
  return isGemini(selection) === (preset === WRITING_PRESET);
}

export function matchingSelection(catalog, preset, current) {
  const choices = (catalog.groups ?? []).flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })));
  const allowed = choices.filter(selection => matchesMode(selection, preset));
  const same = current && allowed.find(row => row.provider === current.provider && row.model === current.model);
  if (same) return { ...current };
  const preferred = catalog.default && allowed.find(row => row.provider === catalog.default.provider && row.model === catalog.default.model);
  const selected = preferred ?? allowed.find(row => row.provider === (preset === WRITING_PRESET ? 'antigravity' : 'codex') && !row.model.startsWith('~account:')) ?? allowed[0];
  if (!selected) throw new Error(preset === WRITING_PRESET ? '没有可用的 Gemini 模型，请在订阅设置中检查登录和模型列表。' : '没有可用的非 Gemini 模型，请在订阅设置中检查模型列表。');
  return { ...selected };
}

export function defaultNonWritingPreset(presets, defaultId) {
  const usable = presets.filter(row => row.id !== WRITING_PRESET && !row.broken);
  const selected = usable.find(row => row.id === defaultId) ?? usable.find(row => row.id === 'standard') ?? usable[0];
  if (!selected) throw new Error('没有可用的非写作模式，请在设置中检查模式状态。');
  return selected.id;
}

export function assertModelCategory(selection, preset) {
  if (matchesMode(selection, preset)) return;
  throw new Error(preset === WRITING_PRESET
    ? '写作模式只能选择 Gemini 模型。其他模型请在新会话中选择对应模式。'
    : '当前模式只能选择非 Gemini 模型。使用 Gemini 请新建写作模式会话。');
}
