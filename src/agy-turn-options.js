const MAX_CONFIG_OPTIONS = 32;
const MAX_GROUPS = 32;
const MAX_VALUES = 256;
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 256;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const parsedSnapshots = new WeakSet();
const readAbortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const boundedArray = (value, limit) => Array.isArray(value) && value.length > 0 && value.length <= limit;
const cleanString = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !CONTROL.test(value);
const validId = value => cleanString(value, MAX_ID_LENGTH) && value.trim() === value;
const validName = value => cleanString(value, MAX_NAME_LENGTH) && value.trim() !== '';

function parseSelect(entry) {
  const id = own(entry, 'id');
  const currentValue = own(entry, 'currentValue');
  const advertised = own(entry, 'options');
  if (own(entry, 'type') !== 'select' || !validId(id) || !validId(currentValue)
    || !validName(own(entry, 'name')) || !boundedArray(advertised, MAX_VALUES)) return;

  const options = [];
  const values = new Set();
  function append(choices) {
    if (!boundedArray(choices, MAX_VALUES - options.length)) return false;
    for (let index = 0; index < choices.length; index++) {
      const choice = own(choices, index);
      if (!record(choice) || Object.hasOwn(choice, 'group') || Object.hasOwn(choice, 'options')) return false;
      const value = own(choice, 'value');
      const name = own(choice, 'name');
      if (!validId(value) || values.has(value) || !validName(name)) return false;
      values.add(value);
      options.push(Object.freeze({ value, name }));
    }
    return true;
  }

  const first = own(advertised, 0);
  if (record(first) && Object.hasOwn(first, 'group')) {
    if (advertised.length > MAX_GROUPS) return;
    const groups = new Set();
    for (let index = 0; index < advertised.length; index++) {
      const entry = own(advertised, index);
      if (!record(entry) || Object.hasOwn(entry, 'value')) return;
      const group = own(entry, 'group');
      if (!validId(group) || groups.has(group) || !validName(own(entry, 'name')) || !append(own(entry, 'options'))) return;
      groups.add(group);
    }
  } else if (!append(advertised)) return;

  if (!values.has(currentValue)) return;
  return Object.freeze({ id, currentValue, options: Object.freeze(options) });
}

/** Map ACP v1 config options into display-safe, opaque select values. */
export function parseAgyTurnOptions(configOptions) {
  try {
    if (!boundedArray(configOptions, MAX_CONFIG_OPTIONS)) return;
    const modelEntries = [], thoughtEntries = [], ids = new Map();
    for (let index = 0; index < configOptions.length; index++) {
      const entry = own(configOptions, index);
      if (!record(entry)) continue;
      const id = own(entry, 'id');
      if (validId(id)) ids.set(id, (ids.get(id) ?? 0) + 1);
      const category = own(entry, 'category');
      if (category === 'model') modelEntries.push(entry);
      else if (category === 'thought_level') thoughtEntries.push(entry);
    }
    // One selector per role in this bridge. Category-less/ambiguous entries do
    // not justify guessing Google IDs, or switching an unrelated config field.
    const model = modelEntries.length === 1 ? parseSelect(modelEntries[0]) : undefined;
    if (!model || ids.get(model.id) !== 1) return;
    const effort = thoughtEntries.length === 1 ? parseSelect(thoughtEntries[0]) : undefined;
    const thoughtLevel = effort && ids.get(effort.id) === 1 ? effort : undefined;
    const snapshot = Object.freeze({ model, ...(thoughtLevel ? { thoughtLevel } : {}) });
    parsedSnapshots.add(snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

const ERROR_MESSAGES = Object.freeze({
  'model-unavailable': 'The selected Antigravity model is unavailable.',
  'reasoning-effort-unavailable': 'The selected Antigravity thinking level is unavailable.',
  'config-unconfirmed': 'Antigravity did not confirm the session configuration.',
  cancelled: 'Antigravity session configuration was cancelled.',
});
const fail = code => Object.assign(new Error(ERROR_MESSAGES[code]), { code });
const offers = (option, value) => option?.options.some(choice => choice.value === value) === true;

function checkAbort(signal) {
  if (signal === undefined) return;
  let aborted;
  try { aborted = readAbortState.call(signal); }
  catch { throw fail('model-unavailable'); }
  if (aborted) throw fail('cancelled');
}

async function setOption({ sessionId, send, signal }, configId, value) {
  checkAbort(signal);
  let reply, next;
  try {
    reply = await send({ sessionId, configId, value });
    next = record(reply) ? parseAgyTurnOptions(own(reply, 'configOptions')) : undefined;
  } catch {
    // A rejected callback can carry raw server data, paths, or abort reasons.
    // The request may already have applied; never retry it here.
    throw fail('config-unconfirmed');
  }
  checkAbort(signal);
  if (!next) throw fail('config-unconfirmed');
  return next;
}

/**
 * Configure one idle session before prompting. `options` is a parsed snapshot
 * for this session; `send(params)` returns the ACP v1 set_config_option result.
 * The caller serializes configuration/updates/prompts and refreshes state after
 * failures: a successful earlier setter is not rolled back by this function.
 */
export async function configureAgyTurn(input) {
  let sessionId, options, send, signal, model, reasoningEffort;
  try {
    if (record(input)) {
      sessionId = own(input, 'sessionId');
      options = own(input, 'options');
      send = own(input, 'send');
      signal = own(input, 'signal');
      const selection = own(input, 'selection');
      if (record(selection)) {
        model = own(selection, 'model');
        const effort = Object.getOwnPropertyDescriptor(selection, 'reasoningEffort');
        reasoningEffort = effort && ('value' in effort ? effort.value : null);
      }
    }
  } catch { throw fail('model-unavailable'); }
  checkAbort(signal);
  if (!validId(sessionId) || !parsedSnapshots.has(options) || typeof send !== 'function'
    || !validId(model) || !offers(options.model, model)) throw fail('model-unavailable');
  if (reasoningEffort !== undefined && !validId(reasoningEffort)) throw fail('reasoning-effort-unavailable');

  const configuration = { sessionId, send, signal };
  const modelId = options.model.id;
  let next = options;
  if (next.model.currentValue !== model) {
    next = await setOption(configuration, modelId, model);
    if (next.model.id !== modelId || next.model.currentValue !== model) throw fail('model-unavailable');
  }
  if (reasoningEffort !== undefined) {
    const effort = next.thoughtLevel;
    if (!offers(effort, reasoningEffort)) throw fail('reasoning-effort-unavailable');
    if (effort.currentValue !== reasoningEffort) {
      next = await setOption(configuration, effort.id, reasoningEffort);
      if (next.model.id !== modelId || next.model.currentValue !== model) throw fail('model-unavailable');
      if (next.thoughtLevel?.id !== effort.id || next.thoughtLevel.currentValue !== reasoningEffort) {
        throw fail('reasoning-effort-unavailable');
      }
    }
  }
  checkAbort(signal);
  return next;
}
