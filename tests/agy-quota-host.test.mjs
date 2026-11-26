import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Exercise the actual Host with a synthetic CLI; only its DSH imports are
// stubbed so these cancellation checks also run in the portable suite.
const hostUrl = new URL('../lib/agy-local-host.js?quota-test', import.meta.url).href;
const mcpUrl = new URL('../lib/agy-local-mcp.js', import.meta.url).href;
const stubs = new Map([
  ['@deepseek-ai/dsh-llm', 'export class LlmAdapter {}\nexport class LlmError extends Error { constructor(message, code) { super(message); this.code = code; } }\nexport const createUserMessage = null, isAgentLoopRequest = null, resolveRetryPolicy = options => options;'],
  ['@deepseek-ai/dsh-tools', 'export const projectToolSchema = null;'],
  ['@deepseek-ai/dsh-tools/pipeline', 'export const executeToolBatch = null, ToolExecutionPipeline = null;'],
]);
const hooks = registerHooks({ resolve(id, context, next) {
  if (id === './agy-local-mcp.js' && context.parentURL === hostUrl) return { url: `${mcpUrl}?quota-test`, shortCircuit: true };
  const stub = [hostUrl, `${mcpUrl}?quota-test`].includes(context.parentURL) && stubs.get(id);
  return stub ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true } : next(id, context);
} });
let mountLocalGoogle;
try { ({ mountLocalGoogle } = await import(hostUrl)); }
finally { hooks.deregister(); }

const expectedError = { code: 'AGY_QUOTA_FAILED' };
const quota = { windows: [], credits: { remaining: 0 }, fetchedAt: '2026-11-22T00:00:00Z' };

function fixture(t) {
  const effects = [], calls = [];
  const runtime = {
    fetchQuota(signal) {
      const result = Promise.withResolvers();
      calls.push({ signal, ...result });
      signal.addEventListener('abort', () => result.reject(signal.reason), { once: true });
      return result.promise;
    },
    dispose() {},
  };
  const ctx = { on() {}, effect(create) { effects.push(create()); }, llm: { registerAdapter() {} } };
  const host = mountLocalGoogle(ctx, {}, runtime);
  let disposing;
  const dispose = () => disposing ??= effects.at(-1)();
  t.after(dispose);
  return { host, calls, dispose };
}

test('concurrent Host quota callers share the in-flight query; aborting one leaves the survivor', async t => {
  const { host, calls } = fixture(t);
  const first = new AbortController(), second = new AbortController();
  const cancelled = assert.rejects(host.fetchQuota(first.signal), expectedError);
  const surviving = host.fetchQuota(second.signal);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  first.abort();
  await cancelled;
  assert.equal(calls[0].signal.aborted, false);
  const late = host.fetchQuota();
  assert.equal(calls.length, 1);
  calls[0].resolve(quota);
  assert.equal(await surviving, quota);
  assert.equal(await late, quota);
  assert.equal(calls[0].signal.aborted, false);
  const next = host.fetchQuota();
  await Promise.resolve();
  assert.equal(calls.length, 2, 'only in-flight work is shared');
  calls[1].resolve(quota);
  assert.equal(await next, quota);
});

test('the last waiter or Host disposal cancels the underlying query', async t => {
  const { host, calls, dispose } = fixture(t);
  await assert.rejects(host.fetchQuota(AbortSignal.abort()), expectedError);
  assert.equal(calls.length, 0);
  const first = new AbortController(), second = new AbortController();
  const cancelled = [first, second].map(waiter => assert.rejects(host.fetchQuota(waiter.signal), expectedError));
  await Promise.resolve();
  assert.equal(calls.length, 1);
  first.abort();
  assert.equal(calls[0].signal.aborted, false);
  second.abort();
  assert.equal(calls[0].signal.aborted, true);
  // Start the replacement before the cancelled flight's rejection settles.
  const active = assert.rejects(host.fetchQuota(), expectedError);
  await Promise.all(cancelled);
  assert.equal(calls.length, 2);
  const alsoActive = assert.rejects(host.fetchQuota(), expectedError);
  await Promise.resolve();
  assert.equal(calls.length, 2, 'old flight cannot clear the replacement');
  await dispose();
  await Promise.all([active, alsoActive]);
  assert.equal(calls[1].signal.aborted, true);
  await assert.rejects(host.fetchQuota(), expectedError);
  assert.equal(calls.length, 2);
});
