import { assertModelCategory, defaultNonWritingPreset, isGemini, matchesMode, matchingSelection, WRITING_PRESET } from './writing-policy.js';

export const inject = ['agents', 'agentPresets', 'llm', 'sessionController'];
export const name = 'subscriptions-enhanced-writing';

/** Host-only policy: no Client service, Slot, endpoint replacement or default write. */
export class WritingController {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Set();
    this.normalizing = new WeakSet();
    this.modelAdmissions = new WeakMap();
    this.stopped = false;
  }

  blank(agent) {
    const turn = this.ctx.agents.turnBoundaryOf(agent.session);
    return turn.openTurnStartSeq === null && turn.lastTurn === 0;
  }

  ordinary(agent) { return agent.session.header.origin !== 'subagent'; }

  async normalize(agent, signal) {
    if (this.stopped || !this.ordinary(agent) || !this.blank(agent)) return;
    const preset = this.ctx.agentPresets.composedPreset(agent.ctx);
    if (matchesMode(agent.model.current(), preset)) return;
    signal?.throwIfAborted();
    const catalog = await this.ctx.sessionController.modelCatalog();
    const selection = matchingSelection(catalog, preset, agent.model.current());
    await this.ctx.llm.resolveCallConfig(selection, signal);
    signal?.throwIfAborted();
    if (this.stopped || !this.blank(agent) || this.ctx.agentPresets.composedPreset(agent.ctx) !== preset) return;
    agent.model.select(selection);
  }

  async initialize(agent, signal) {
    if (this.normalizing.has(agent)) return;
    this.normalizing.add(agent);
    try { await this.normalize(agent, signal); }
    finally { this.normalizing.delete(agent); }
  }

  onPresetSelected(agent) {
    if (this.stopped || this.normalizing.has(agent) || !this.ordinary(agent) || !this.blank(agent)) return;
    this.normalizing.add(agent);
    // Claim idle synchronously before a prompt can wake. The first await lets
    // the native preset append finish before recording its matching model.
    const operation = agent.runMaintenance(async signal => {
      await Promise.resolve();
      await this.normalize(agent, signal);
    });
    this.pending.add(operation);
    void operation.catch(error => this.ctx.logger.warn(`Writing model selection: ${error instanceof Error ? error.message : 'unavailable'}`))
      .finally(() => { this.pending.delete(operation); this.normalizing.delete(agent); });
  }

  onModelSelection(agent, event) {
    if (this.stopped || this.normalizing.has(agent)) throw new Error('模式正在切换，请稍后再试。');
    const admission = { event, committed: false };
    this.normalizing.add(agent);
    this.modelAdmissions.set(agent, admission);
    let operation;
    try {
      // Hold idle BEFORE native model append, but defer recompose until the
      // exact candidate is committed and the append publication has returned.
      operation = agent.runMaintenance(async signal => {
        await Promise.resolve();
        signal.throwIfAborted();
        if (this.stopped || !admission.committed || !this.blank(agent)) return;
        const writing = isGemini(event.data);
        if (isGemini(agent.model.current()) !== writing) return;
        const targetPreset = writing ? WRITING_PRESET : defaultNonWritingPreset(
          await this.ctx.agentPresets.list(), this.ctx.agentPresets.defaultId);
        signal.throwIfAborted();
        if (this.stopped || !this.blank(agent) || isGemini(agent.model.current()) !== writing) return;
        if (this.ctx.agentPresets.composedPreset(agent.ctx) !== targetPreset) {
          await this.ctx.agentPresets.select(agent, targetPreset);
        }
      });
    } catch (error) {
      this.modelAdmissions.delete(agent);
      this.normalizing.delete(agent);
      throw error;
    }
    this.pending.add(operation);
    void operation.catch(error => this.ctx.logger.warn(`Writing mode selection: ${error instanceof Error ? error.message : 'unavailable'}`))
      .finally(() => { this.pending.delete(operation); this.modelAdmissions.delete(agent); this.normalizing.delete(agent); });
  }

  onModelCommitted(session, event) {
    const agent = this.ctx.agents.get(session.id);
    if (!agent || agent.session !== session) return;
    const admission = this.modelAdmissions.get(agent);
    if (admission?.event === event) admission.committed = true;
  }

  async close() {
    this.stopped = true;
    await Promise.allSettled(this.pending);
  }
}

export function apply(ctx) {
  const controller = new WritingController(ctx);
  const inheritedTurns = new WeakMap();
  for (const agent of ctx.agents.list()) {
    const turn = ctx.agents.turnBoundaryOf(agent.session);
    if (turn.openTurnStartSeq !== null) inheritedTurns.set(agent, turn.openTurnStartSeq);
  }
  ctx.effect(() => () => controller.close(), 'subscriptions-enhanced: writing lifecycle');

  // Pinned Cordis/Session acceptance contract: internal/dispatch synchronously
  // enumerates session/event listeners BEFORE log.push. Veto model candidates
  // only; never veto preset events after their composition has already changed.
  // Native selectModel then returns its existing error and skips saving defaults.
  ctx.on('internal/dispatch', (mode, name, args) => {
    if (mode !== 'emit' || name !== 'session/event') return;
    const [session, event] = args;
    if (event?.type !== 'model/selection') return;
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session !== session || !controller.ordinary(agent)) return;
    const preset = ctx.agentPresets.composedPreset(agent.ctx);
    if (controller.blank(agent) && !matchesMode(event.data, preset)) {
      controller.onModelSelection(agent, event);
      return;
    }
    assertModelCategory(event.data, preset);
  }, { prepend: true });

  ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection') controller.onModelCommitted(session, event);
  });
  ctx.on('agent/created', async ({ agent, signal }) => {
    // The native factory already holds maintenance; do not acquire it again.
    try { await controller.initialize(agent, signal); }
    catch (error) { ctx.logger.warn(`Writing initialization: ${error instanceof Error ? error.message : 'unavailable'}`); }
  });
  ctx.on('agent-preset/selected', sessionId => {
    const agent = ctx.agents.get(sessionId);
    if (agent) controller.onPresetSelected(agent);
  });
  ctx.on('agent/pre-step', ({ agent, modelSelection }, next) => {
    if (!controller.ordinary(agent)) return next();
    const inherited = inheritedTurns.get(agent);
    if (inherited !== undefined) {
      if (ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq === inherited) return next();
      inheritedTurns.delete(agent);
    }
    assertModelCategory(modelSelection, ctx.agentPresets.composedPreset(agent.ctx));
    return next();
  });
}
