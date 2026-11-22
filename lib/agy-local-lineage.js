// Authority is tied to an exact live DSH Agent and a committed inbox occurrence,
// never to a caller-supplied session ID or a user-shaped durable message alone.
export function installAgyLineage(ctx, isLocalSubmission) {
  const ownerInput = new WeakMap();
  const authorizedRoots = new WeakSet();
  const trees = new WeakMap();
  const admissions = new WeakMap();
  const agents = () => ctx.get('agents');
  const subagents = agent => agent.ctx.get('subagents') ?? ctx.get('subagents');
  const isOwner = source => source?.kind === 'user' && typeof source.rpcId === 'string'
    && (!source.principal || source.principal.kind === 'owner');
  function rootOf(agent) {
    try {
      const child = agent.session.header.origin === 'subagent';
      const root = child ? subagents(agent)?.rootOf(agent) : agent;
      if (!root || agents()?.get(root.id) !== root || root.session.header.origin === 'subagent') return;
      return root;
    } catch { /* Detached or unowned native child. */ }
  }
  function carriesOwner(agent, message) {
    return isOwner(message.source) && ownerInput.get(agent)?.has(message.id) === true;
  }
  function accepts(agent, messages, { step } = {}) {
    const root = rootOf(agent);
    if (!root || !messages.length) return false;
    const entries = trees.get(root);
    const member = agent !== root && entries?.get(agent.id);
    if (agent !== root && member?.agent !== agent) return false;
    return messages.every(message => {
      if (carriesOwner(agent, message) || admissions.get(agent)?.ownerIds?.has(message.id)) return true;
      if (!authorizedRoots.has(root)) return false;
      const { source } = message;
      if (source?.kind === 'user' && !source.rpcId && !source.principal && member) {
        // Only the manager's first initial task has a plain user source. A
        // restored child can continue through a witnessed owner or native relay.
        return member.initial === message.id || (member.initial === undefined && typeof step === 'number'
          && !agent.session.snapshotEvents(agent.session.inheritedEventCount ?? 0).some(event =>
            event.seq < step && event.type === 'user/message' && event.data.source?.kind === 'user'));
      }
      const sender = entries?.get(source?.senderSessionId);
      if (source?.kind === 'subagent-settled' && source.form === 'notice') return Boolean(sender && sender.parent === agent.id);
      if (source?.kind === 'agent-message' && source.form === 'relay') return source.senderSessionId === root.id || Boolean(sender);
      return false;
    });
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!isLocalSubmission() || !isOwner(message.source)) return;
    const ids = ownerInput.get(agent) ?? new Set();
    ids.add(message.id);
    ownerInput.set(agent, ids);
  }, { global: true });
  ctx.on('agent/inbox/discarded', ({ agent, message }) => ownerInput.get(agent)?.delete(message.id), { global: true });
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const admitted = await next();
    if (admitted.kind !== 'enter') return admitted;
    const actual = admitted.messages ?? messages;
    const inbound = actual.filter(message => ['user', 'agent-message', 'subagent-settled'].includes(message.source?.kind));
    const root = rootOf(agent);
    const automation = actual.some(message => ['schedule', 'webhook', 'goal'].includes(message.source?.kind));
    const trusted = !automation && root && (inbound.some(message => carriesOwner(agent, message))
      || (inbound.length ? accepts(agent, inbound) : admissions.get(agent)?.signal === signal && admissions.get(agent)?.trusted));
    if (trusted && root === agent) authorizedRoots.add(root);
    admissions.set(agent, { signal, trusted: Boolean(trusted) });
    const ownerIds = new Set(inbound.filter(message => carriesOwner(agent, message)).map(message => message.id));
    admissions.get(agent).ownerIds = ownerIds;
    for (const message of inbound) ownerInput.get(agent)?.delete(message.id);
    return admitted;
  }, { global: true });
  ctx.on('subagent/start', ({ id, parentSessionId, local }) => {
    const parent = agents()?.get(parentSessionId);
    if (!parent || !admissions.get(parent)?.trusted || parent.status !== 'running') return;
    const root = rootOf(parent);
    if (!root || !authorizedRoots.has(root)) return;
    const child = local ? agents()?.get(id) : undefined;
    if (local && (!child || rootOf(child) !== root || !(child.session.header.delegationDepth > 0))) return;
    const entries = trees.get(root) ?? new Map();
    entries.set(id, { agent: child, parent: parentSessionId, initial: child?.inbox.nextTurn.find(row => row.source?.kind === 'user')?.id });
    trees.set(root, entries);
  }, { global: true });
  return (agent, messages, boundary) => {
    const admission = admissions.get(agent);
    const root = rootOf(agent);
    if (root === agent && !admission?.trusted) return false;
    if (agent !== root && root?.status === 'running' && !admissions.get(root)?.trusted) return false;
    if (boundary?.steer) return messages.every(message => carriesOwner(agent, message));
    const accepted = accepts(agent, messages, boundary);
    if (accepted) {
      const entry = trees.get(root)?.get(agent.id);
      if (entry && entry.initial === undefined) entry.initial = messages.find(row => row.source?.kind === 'user' && !row.source.rpcId)?.id;
    }
    return accepted;
  };
}
