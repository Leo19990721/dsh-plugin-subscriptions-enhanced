import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Exercise the actual generated bundle, including its original pool classes.
let source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
source = source.replace('"./policy.js"', JSON.stringify(new URL('../lib/policy.js', import.meta.url).href));
source = source.replace('"./gemini-prompt.js"', JSON.stringify(new URL('../lib/gemini-prompt.js', import.meta.url).href));
source += '\nexport { AntigravityAdapter, classifyPoolFailure, PoolHealthRegistry, PoolAdapter, memberKey, LlmError, toAntigravityRequest };\n';
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('generated Antigravity route captures the short policy', () => {
  const adapter = new module.AntigravityAdapter({});
  const policy = adapter.providerRetryPolicy('antigravity');
  assert.equal(policy.maxRetries, 2);
  assert.equal(policy.maxDelayMs, 5000);
  assert.equal(policy.retryableCodes.includes('RATE_LIMIT'), false);
});

test('generated upstream pool classification retains other subscription policies', () => {
  const failure = new module.LlmError('quota', 'RATE_LIMIT', { status: 429 });
  assert.deepEqual(module.classifyPoolFailure(failure, 'antigravity'), { action: 'switch' });
  assert.equal(module.classifyPoolFailure(failure, 'codex').cooldownMs, 300000);
  assert.equal(module.classifyPoolFailure(failure, 'claude').cooldownMs, 300000);
  assert.equal(module.classifyPoolFailure(failure, 'grok').scope, 'account');
});

test('bare Argon 429 cannot park Hydrogen or the next Argon request in the health registry', () => {
  const health = new module.PoolHealthRegistry();
  const member = { provider: 'antigravity', account: 'fixture', model: 'gemini-4-argon' };
  const failure = new module.LlmError('resource exhausted', 'RATE_LIMIT', { status: 429 });
  const decision = module.classifyPoolFailure(failure, member.provider);
  if ('cooldownMs' in decision) health.markUnavailable(module.memberKey(member.provider, member.account, member.model), decision.cooldownMs, decision.reason);
  assert.equal(health.isMemberAvailable(member.provider, member.account, 'gemini-4-argon'), true);
  assert.equal(health.isMemberAvailable(member.provider, member.account, 'gemini-4-hydrogen'), true);
});

test('upstream requested delay is retained for that exact model', () => {
  const health = new module.PoolHealthRegistry();
  const failure = new module.LlmError('retry later', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 400000 });
  const decision = module.classifyPoolFailure(failure, 'antigravity');
  health.markUnavailable(module.memberKey('antigravity', 'fixture', 'gemini-4-argon'), decision.cooldownMs, decision.reason);
  assert.equal(health.isMemberAvailable('antigravity', 'fixture', 'gemini-4-argon'), false);
  assert.equal(health.isMemberAvailable('antigravity', 'fixture', 'gemini-4-hydrogen'), true);
});

test('Gemini request removes only the fixed Harness identity and keeps the full standard prompt', () => {
  const identity = 'You are an AI agent powered by DeepSeek Harness.';
  const guide = 'Use the read tool before editing. Keep DSH source paths unchanged.';
  const options = {
    provider: 'antigravity', model: 'gemini-4-hydrogen',
    system: identity + '\n\n' + guide,
    tools: [{ name: 'read', description: 'Read text', parameters: { type: 'object', properties: {} } }],
    maxTokens: 1024,
  };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'DeepSeek Harness is the subject of my task.' }] }];
  Object.freeze(options); Object.freeze(messages);
  const request = module.toAntigravityRequest(options, messages, 'synthetic-project', true);
  assert.equal(request.request.systemInstruction.parts[0].text, guide);
  assert.equal(request.request.tools[0].functionDeclarations[0].name, 'read');
  assert.equal(request.request.contents[0].parts[0].text, messages[0].content[0].text);
  assert.equal(options.system, identity + '\n\n' + guide, 'never rewrite canonical request inputs');
});

test('Gemini identity editing handles system history while Claude and other system text stay exact', () => {
  const system = 'You are an AI agent powered by DeepSeek Harness.\n\nYou help the user customize DeepSeek Harness itself.\nKeep the current GUI URL.';
  const messages = [{ role: 'system', content: [{ type: 'text', text: system }] }, { role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
  const gemini = module.toAntigravityRequest({ provider: 'antigravity', model: 'gemini-4-hydrogen' }, messages, 'synthetic-project');
  assert.equal(gemini.request.systemInstruction.parts[0].text, 'You help the user customize the current application itself.\nKeep the current GUI URL.');
  const claude = module.toAntigravityRequest({ provider: 'antigravity', model: 'claude-sonnet-4-5', system }, messages, 'synthetic-project');
  assert.equal(claude.request.systemInstruction.parts[0].text, system);
  const minimal = 'You are a helpful software engineer assistant.';
  assert.equal(module.toAntigravityRequest({ model: 'gemini-4-hydrogen', system: minimal }, messages, 'synthetic-project').request.systemInstruction.parts[0].text, minimal);
});

test('enhanced Host no longer registers any automatic session preset selection', () => {
  assert.equal(source.includes('registerGeminiDefault(ctx)'), false);
  assert.equal(source.includes('agentPresets.select('), false);
});

test('build does not introduce raw socket transport or a second credential store', () => {
  assert.equal(source.includes('node:tls'), false);
  assert.equal(source.includes('proxy-account.json'), false);
  assert.equal(source.includes('const tokens = new AccountTokenManager'), true);
  assert.equal(source.includes('antigravityPoolFailure(error, provider)'), true);
});
