import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Check the generated Host, not a copy of the source patch.
const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
const probe = source.replace(/"\.\/(?:writing-host|agy-local-plugin)\.js"/g, match =>
  JSON.stringify(new URL(`../lib/${JSON.parse(match).slice(2)}`, import.meta.url).href));
const exports = '\nexport { classifyPoolFailure, LlmError };\n';
const { classifyPoolFailure, LlmError } = await import(`data:text/javascript;base64,${Buffer.from(probe + exports).toString('base64')}`);

test('generated subscription pool retains upstream classifications on remaining providers', () => {
  const failure = new LlmError('fixture quota', 'RATE_LIMIT', { status: 429 });
  assert.equal(classifyPoolFailure(failure, 'codex').cooldownMs, 300000);
  assert.equal(classifyPoolFailure(failure, 'claude').cooldownMs, 300000);
  assert.equal(classifyPoolFailure(failure, 'grok').scope, 'account');
});

test('build mounts Google ACP and retains other subscriptions without old Google endpoints', () => {
  assert.match(source, /ctx\.plugin\(writing, \{ localGoogle: true \}\);\s*ctx\.plugin\(agy, config\.google\);/);
  assert.doesNotMatch(source, /agentPresets\.select\(|AntigravityAdapter|cloudcode-pa|googleusercontent\.com|accounts\.google\.com|generateContent|enhancedRetryPolicy|geminiSystemPrompt|node:tls|proxy-account\.json/);
  assert.match(source, /new AccountTokenManager/);
});
