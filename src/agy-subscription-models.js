export const AGY_SUBSCRIPTION_PROVIDER = 'antigravity';

// Exact Google model IDs only. Never infer that a newer model is an alias for
// an old saved choice, or use the CLI's unrelated default when a choice is gone.
const MODELS = new Map([
  ['gemini-3-flash', 'Gemini 3 Flash'],
  ['gemini-3.1-pro-high', 'Gemini 3.1 Pro High'],
  ['gemini-3.1-pro', 'Gemini 3.1 Pro'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash High'],
  ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash Medium'],
  ['gemini-3.7-flash-low', 'Gemini 3.7 Flash Low'],
]);

export function isAgySubscriptionModel(selection) {
  return selection?.provider === AGY_SUBSCRIPTION_PROVIDER && MODELS.has(selection.model);
}

export function agySubscriptionModels(options) {
  const offered = new Set(options?.model?.options.map(item => item.value));
  return [...MODELS].filter(([id]) => offered.has(id)).map(([id, name]) => Object.freeze({
    provider: AGY_SUBSCRIPTION_PROVIDER, id, name, inputModalities: Object.freeze(['text']),
  }));
}
