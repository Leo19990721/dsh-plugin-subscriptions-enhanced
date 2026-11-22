// One official local account per connection. The quota belongs to the account,
// so all conversations and Models settings share this in-memory snapshot.
export function createAgyQuotaState(endpoint) {
  const empty = Object.freeze({ quota: undefined, busy: false, failed: false });
  let snapshot = empty;
  let pending;
  const listeners = new Set();
  const publish = next => {
    if (snapshot === next) return;
    snapshot = next;
    for (const notify of listeners) notify();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(notify) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    clear() {
      pending?.abort();
      pending = undefined;
      publish(empty);
    },
    async query(rpc, { force = false } = {}) {
      if (!rpc || pending || (!force && (snapshot.quota || snapshot.failed))) return;
      const request = new AbortController();
      pending = request;
      publish({ ...snapshot, busy: true, failed: false });
      let quota;
      try {
        const result = await rpc.call('/api', endpoint, { action: 'quota' }, request.signal);
        const value = result?.value;
        if (result?.ok === true && Array.isArray(value?.windows) && value.windows.length > 0
          && Number.isFinite(value.credits?.remaining) && Number.isFinite(Date.parse(value.fetchedAt))) quota = value;
      } catch { /* Keep the previous successful result and show a localized error. */ }
      if (pending !== request) return;
      pending = undefined;
      publish({ quota: quota ?? snapshot.quota, busy: false, failed: !quota });
    },
  };
}
