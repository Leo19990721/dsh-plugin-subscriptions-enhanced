import { summarizeAgyTool } from './agy-local-tool-data.js';

const cancelled = Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) });
const ended = status => ['completed', 'failed', 'cancelled'].includes(status);
export function backgroundEvent(update) {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk': case 'agent_thought_chunk':
      if (update.content?.type === 'text' && typeof update.content.text === 'string' && update.content.text) {
        return { kind: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought', value: update.content.text };
      }
      break;
    case 'tool_call': case 'tool_call_update': {
      const value = summarizeAgyTool(update);
      if (value) return { kind: 'tool', summarized: true, value: { ...value, sessionUpdate: update.sessionUpdate } };
      break;
    }
    case 'usage_update': {
      const { used, size } = update;
      const value = { ...(Number.isSafeInteger(used) && used >= 0 ? { used } : {}), ...(Number.isSafeInteger(size) && size > 0 ? { size } : {}) };
      if (Object.keys(value).length) return { kind: 'usage', value };
    }
  }
}

export function trackAgyTool(active, update) {
  if (ended(update.status)) active.delete(update.toolCallId);
  else if (['pending', 'in_progress'].includes(update.status) || update.sessionUpdate === 'tool_call') active.add(update.toolCallId);
}

/** The ACP process may outlive a wave (daemon/long command). Its inventory is
 * for revocation, not a completion barrier for every subsequent DSH turn. */
export function backgroundWave({ token, activeTools, onSeal, onRetire, shortMs = 2000, longMs = 45000,
  claimMs = 15000, waitMs = 5000, maxBytes = 4 * 1024 * 1024, maxEvents = 65536, maxTools = 200,
  arm = setTimeout, disarm = clearTimeout }) {
  const controller = new AbortController(), toolIds = new Set(), waiters = new Set();
  const chunks = [];
  let pulse = Promise.withResolvers(), timer, attached = false, sealed = false, handler;
  let inFlight = 0, approvals = 0, foregroundApprovals = 0, answer = false, tail = false, usage, bytes = 0, events = 0;
  const notify = () => { pulse.resolve(); pulse = Promise.withResolvers(); };
  const later = (fn, ms) => { const timer = arm(fn, ms); timer?.unref?.(); return timer; };
  let claimTimer = later(() => retire('unclaimed'), claimMs);
  const clearClaim = () => { disarm(claimTimer); claimTimer = undefined; };
  function finish() {
    if (sealed) return;
    sealed = true;
    disarm(timer); handler = undefined;
    for (const resume of waiters) resume();
    controller.abort(); notify(); onSeal?.();
  }
  function retire(reason) {
    clearClaim(); finish(); onRetire?.(reason);
  }
  function activity() {
    disarm(timer);
    // AGY does not signal detachment reliably. Pending AGY tools keep their
    // process inventory, but cannot pin the DSH turn beyond its quiet window.
    if (!sealed && attached && !inFlight && !approvals && !foregroundApprovals) {
      timer = later(finish, tail ? shortMs : longMs);
    }
  }
  function waitForHandler() {
    if (handler || sealed) return handler;
    return new Promise(resolve => {
      const resume = () => { disarm(timeout); waiters.delete(resume); resolve(handler); };
      const timeout = later(resume, waitMs); waiters.add(resume);
    });
  }
  return {
    token, signal: controller.signal, chunks, get sealed() { return sealed; }, get usage() { return usage; },
    get attached() { return attached; }, wait: () => pulse.promise, wake: notify,
    attach(approve) {
      clearClaim(); if (sealed) return;
      attached = true; handler = approve; for (const resume of waiters) resume(); activity();
    },
    clearClaim, finish, dispose() { clearClaim(); finish(); },
    mcpCount(count) { inFlight = count; activity(); },
    permissionCount(count) { foregroundApprovals = count; activity(); },
    async permission(params) {
      if (sealed) return cancelled;
      approvals++; activity();
      try {
        const approve = handler ?? await waitForHandler();
        return !sealed && approve ? await approve(params) : cancelled;
      } finally { approvals--; activity(); }
    },
    push(event) {
      if (sealed) return;
      if (event.kind === 'usage') {
        usage = { ...usage, ...event.value };
        // A heartbeat carries no new work. Only the first post-answer usage
        // changes the deadline, even if another heartbeat changes accounting.
        if (answer && !tail) { tail = true; activity(); }
        return;
      }
      let cost;
      try { cost = Buffer.byteLength(event.kind === 'tool' ? JSON.stringify(event.value) : event.value); }
      catch { return retire('overflow'); }
      if (++events > maxEvents || (bytes += cost) > maxBytes) return retire('overflow');
      if (event.kind === 'tool') {
        const update = event.value, id = update.toolCallId;
        if (toolIds.add(id).size > maxTools) return retire('overflow');
        trackAgyTool(activeTools, update);
        if (activeTools.size > maxTools) return retire('overflow');
      }
      chunks.push(event);
      answer = event.kind === 'text' && (answer || Boolean(event.value.trim()));
      tail = false; activity(); notify();
    },
  };
}
