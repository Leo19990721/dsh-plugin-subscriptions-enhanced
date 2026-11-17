import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancedRetryPolicy, antigravityPoolFailure } from '../src/policy.js';

const error = (code, providerRetryAfterMs) => ({ code, failure: { code, ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }) } });

test('Antigravity retries only transient failures twice with a five-second ceiling', () => {
  const policy = enhancedRetryPolicy();
  assert.equal(policy.mode, 'normal');
  assert.equal(policy.maxRetries, 2);
  assert.equal(policy.backoff.maxDelayMs, 5000);
  assert.deepEqual(policy.retryableCodes, ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']);
});

test('a bare Antigravity 429 creates no guessed five-minute cooldown', () => {
  assert.deepEqual(antigravityPoolFailure(error('RATE_LIMIT'), 'antigravity'), { action: 'switch' });
});

test('an explicit upstream wait remains model-scoped and is never shortened', () => {
  assert.deepEqual(antigravityPoolFailure(error('RATE_LIMIT', 400000), 'antigravity'), {
    action: 'switch', cooldownMs: 400000, reason: 'RATE_LIMIT', scope: 'member',
  });
});

test('transient Antigravity failures do not poison the next manual request', () => {
  for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) {
    assert.deepEqual(antigravityPoolFailure(error(code), 'antigravity'), { action: 'switch' });
  }
});

test('an explicit transient server backoff is preserved as well', () => {
  assert.equal(antigravityPoolFailure(error('SERVER', 45000), 'antigravity').cooldownMs, 45000);
});

test('authentication, cancellation, context errors and other subscriptions retain upstream handling', () => {
  for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'ABORTED', 'CONTEXT_WINDOW_EXCEEDED']) {
    assert.equal(antigravityPoolFailure(error(code), 'antigravity'), undefined);
  }
  for (const provider of ['codex', 'claude', 'grok', 'copilot']) {
    assert.equal(antigravityPoolFailure(error('RATE_LIMIT'), provider), undefined);
  }
});
