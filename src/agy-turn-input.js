// Shared selection identity for the native turn runner and the isolated
// composer boundary. No credentials, draft state, or upload I/O live here.
export const AGY_TURN_PROVIDER = 'antigravity-cli';

export const isAgyTurnSelection = selection => selection?.provider === AGY_TURN_PROVIDER;

export function canTakeAgyTurnAttachments(selection) {
  return !isAgyTurnSelection(selection);
}

/** Apply after deciding which selection will own the next submission. */
export function agyTurnDraftProblem(selection, { attachmentIds = [], references = [] } = {}) {
  if (canTakeAgyTurnAttachments(selection)) return undefined;
  if (attachmentIds.length !== 0) return 'attachments-unsupported';
  // Semantic reference codecs can expand data or paths. Literal text and the
  // user-visible text of a quote remain ordinary prompt text.
  if (references.length !== 0) return 'references-unsupported';
  return undefined;
}
