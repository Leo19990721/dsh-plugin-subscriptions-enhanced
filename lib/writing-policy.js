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

const isLocalGoogleGemini = selection => selection?.provider === 'antigravity' && isGemini(selection);
export const isRetiredSelection = (selection, localGoogle = false) => selection?.provider === 'antigravity'
  && !(localGoogle && isLocalGoogleGemini(selection));
export const isAgyNativeTurnSelection = selection => selection?.provider === 'turn:antigravity';

function assertAvailable(selection, localGoogle) {
  if (isRetiredSelection(selection, localGoogle)) {
    throw new Error('旧 Antigravity 订阅已停用。要继续此 DSH 会话，请选择已配置的模型；也可以直接使用 Google 官方 Antigravity。');
  }
}

export function matchesMode(selection, preset, localGoogle = false) {
  return !isRetiredSelection(selection, localGoogle)
    && (preset === WRITING_PRESET ? isGemini(selection) : localGoogle || !isGemini(selection));
}

export function matchingSelection(catalog, preset, current, localGoogle = false) {
  const choices = (catalog.groups ?? []).flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })));
  const allowed = choices.filter(selection => matchesMode(selection, preset, localGoogle));
  const local = localGoogle && preset === WRITING_PRESET ? allowed.filter(isLocalGoogleGemini) : [];
  const candidates = local.length ? local : allowed;
  const same = current && candidates.find(row => row.provider === current.provider && row.model === current.model);
  if (same) return { ...current };
  const preferred = catalog.default && candidates.find(row => row.provider === catalog.default.provider && row.model === catalog.default.model);
  const suggested = preset === WRITING_PRESET
    ? candidates.find(row => !row.model.startsWith('~account:'))
    : candidates.find(row => row.provider === 'codex' && !row.model.startsWith('~account:'));
  const selected = preferred ?? suggested ?? candidates[0];
  if (!selected) throw new Error(preset === WRITING_PRESET ? '没有可用的 Gemini 模型。请在「设置 → 模型」另行配置，或直接使用 Google 官方 Antigravity。' : '没有可用的非 Gemini 模型，请在「设置 → 模型」检查。');
  return { ...selected };
}

export function defaultNonWritingPreset(presets, defaultId) {
  const usable = presets.filter(row => row.id !== WRITING_PRESET && !row.broken);
  const selected = usable.find(row => row.id === defaultId) ?? usable.find(row => row.id === 'standard') ?? usable[0];
  if (!selected) throw new Error('没有可用的非写作模式，请在设置中检查模式状态。');
  return selected.id;
}

export function assertModelCategory(selection, preset, localGoogle = false) {
  assertAvailable(selection, localGoogle);
  if (matchesMode(selection, preset, localGoogle)) return;
  throw new Error(preset === WRITING_PRESET
    ? '写作模式只能选择 Gemini 模型。其他模型请在新会话中选择对应模式。'
    : '当前模式只能选择非 Gemini 模型。使用 Gemini 请新建写作模式会话。');
}
