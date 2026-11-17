import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Dynamic import lets the RED test report the missing behavior as an assertion.
let policy;
try { policy = await import('../src/gemini-prompt.js'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const apply = (model, system) => {
  assert.equal(typeof policy?.geminiSystemPrompt, 'function', 'Gemini-only prompt policy exists');
  return policy.geminiSystemPrompt(model, system);
};
const identity = 'You are an AI agent powered by DeepSeek Harness.';

test('only Gemini loses the fixed Harness identity across model and independent-account ids', () => {
  for (const model of ['gemini-4-hydrogen', 'antigravity-gemini-4-argon', '~account:synthetic:gemini-4-hydrogen']) {
    assert.equal(apply(model, identity + '\n\nUse read before edit.'), 'Use read before edit.');
  }
  for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'grok-4', '~account:synthetic:gpt-6.1-sol', undefined]) {
    assert.equal(apply(model, identity), identity);
  }
});

test('remove only exact identity prose and preserve user-authored names, URLs and tool rules', () => {
  const untouched = 'Discuss DeepSeek Harness, DSH and harness APIs.\nKeep @deepseek-ai/dsh-tools and the current GUI URL.\nYou are a coding agent powered by the gemini-4-hydrogen model.';
  assert.equal(apply('gemini-4-hydrogen', identity + '\n\n' + untouched), untouched);
  assert.equal(apply('gemini-4-hydrogen', untouched), untouched);
  assert.equal(apply('gemini-4-hydrogen', undefined), undefined);
  assert.equal(apply('gemini-4-hydrogen', ''), '');
});

test('Creator keeps its purpose using neutral application wording', () => {
  const text = 'You are a coding agent powered by the gemini-4-hydrogen model. You help the user customize DeepSeek Harness itself.';
  assert.equal(apply('gemini-4-hydrogen', text), text.replace('DeepSeek Harness', 'the current application'));
});

test('historical failing standard prompt changes only its fixed identity opener', { skip: !process.env.DSH_TEST_STANDARD_PROMPT && 'optional private fixture is not part of the public repository' }, async () => {
  const path = process.env.DSH_TEST_STANDARD_PROMPT;
  const original = await readFile(path, 'utf8');
  assert.ok(original.startsWith(identity + '\n\n'));
  assert.equal(apply('gemini-4-hydrogen', original), original.slice((identity + '\n\n').length));
});
