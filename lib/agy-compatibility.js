/** Check just the native Host interfaces. This does not establish release readiness. */
export function hasAgyNativeTurnHost(ctx) {
  return typeof ctx.get('agentLoop')?.registerTurnExecutor === 'function'
    && typeof ctx.get('sessionController')?.registerTurnProvider === 'function';
}
