/** Only Antigravity changes; all other providers keep the upstream classifier. */
export function enhancedRetryPolicy() {
  return {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    backoff: { initialDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0.1 },
  };
}

export function antigravityPoolFailure(error, provider) {
  if (provider !== 'antigravity') return undefined;
  if (['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'].includes(error.code)) {
    const delay = error.failure.providerRetryAfterMs;
    // Preserve a real upstream retry-after, including 503; never guess a wait.
    return delay === undefined ? { action: 'switch' } : {
      action: 'switch', cooldownMs: delay, reason: error.code, scope: 'member',
    };
  }
  return undefined;
}
