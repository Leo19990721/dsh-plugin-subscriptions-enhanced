// The native list slot supports shadowing an individual row by id. Delegate
// to its original component and callbacks rather than recreating the switch.
export function registerAgyTeamMenu(ctx, createElement) {
  if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return;
  const name = 'conversation.input.model.options';
  const id = 'agent-team';
  return ctx.slots.inject(name, () => {
    let native, remove;
    function AgyTeamMenuRow({ NativeToggle, useAgyTeamModel, ...props }) {
      return useAgyTeamModel(state => state.current?.provider) === 'antigravity'
        ? null : createElement(NativeToggle, props);
    }
    const sync = () => {
      const entry = ctx.slots.entries(name).find(row => row.options.id === id && row.locale === id
        && row.component !== AgyTeamMenuRow && typeof row.component === 'function' && typeof row.inject === 'function');
      if (entry === native) return;
      remove?.();
      remove = undefined;
      native = entry;
      if (!entry) return;
      remove = ctx.slots.register({
        name, id, priority: -100, order: entry.options.order, locale: entry.locale,
        inject: sessionId => ({
          ...entry.inject(sessionId), NativeToggle: entry.component,
          hooks: { agyTeamModel: ctx.modelDirectories.directoryFor(sessionId).store },
        }),
      }, AgyTeamMenuRow);
    };
    // The native Team UI is optional and can appear/disappear independently.
    const unsubscribe = ctx.slots.subscribe(name, sync);
    try { sync(); }
    catch (error) { unsubscribe(); throw error; }
    return () => { unsubscribe(); remove?.(); };
  });
}
