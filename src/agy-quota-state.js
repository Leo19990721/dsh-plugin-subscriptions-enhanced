const AGY_QUOTA_VIEW_MAX_AGE_MS = 5 * 60_000;
const AGY_QUOTA_MIN_RETRY_MS = 1_000;
const AGY_QUOTA_FAILURE_RETRY_MS = 60_000;

function agyQuotaDueAt(quota, maxAgeMs) {
  if (!quota) return -Infinity;
  const fetchedAt = Date.parse(quota.fetchedAt);
  let dueAt = fetchedAt + maxAgeMs;
  for (const row of quota.windows) {
    const resetAt = Date.parse(row?.resetAt);
    // An already-past reset in a new response isn't a new reset to catch up on.
    if (resetAt > fetchedAt) dueAt = Math.min(dueAt, resetAt);
  }
  return dueAt;
}

// One official local account per connection. The quota belongs to the account,
// so all conversations and Models settings share this in-memory snapshot.
export function createAgyQuotaState(endpoint) {
  const empty = Object.freeze({ quota: undefined, busy: false, failed: false });
  let snapshot = empty;
  let pending;
  let retryAt = -Infinity;
  const listeners = new Set();
  const publish = next => {
    if (snapshot === next) return;
    snapshot = next;
    for (const notify of listeners) notify();
  };
  const nextRefreshAt = (maxAgeMs = Infinity) => pending ? Infinity
    : Math.max(agyQuotaDueAt(snapshot.quota, maxAgeMs), retryAt);
  return {
    getSnapshot: () => snapshot,
    nextRefreshAt,
    subscribe(notify) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    clear() {
      pending?.abort();
      pending = undefined;
      retryAt = -Infinity;
      publish(empty);
    },
    async query(rpc, { force = false, maxAgeMs } = {}) {
      if (!rpc || pending || (!force && Date.now() < nextRefreshAt(maxAgeMs))) return;
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
      retryAt = Date.now() + (quota ? AGY_QUOTA_MIN_RETRY_MS : AGY_QUOTA_FAILURE_RETRY_MS);
      publish({ quota: quota ?? snapshot.quota, busy: false, failed: !quota });
    },
  };
}
