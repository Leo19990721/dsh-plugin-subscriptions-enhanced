import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('built browser preserves original subscription UI and never replaces native selection', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.startsWith('window.__ModuleLoader__.load({ id: "dsh-plugin-subscriptions-enhanced"'));
  assert.doesNotMatch(source, /installWritingClient|WritingDirectories|subscriptions-enhanced-writing|conversation\.hero\.agentPreset|conversation\.input\.model|writing-mode|document\.querySelector/);
  assert.equal(source.includes('__deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition'), false);
  assert.equal(source.includes('__deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer'), false);
  assert.equal(source.includes('function enhancedAnchoredPosition('), true);
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(patch, /id: ui-model-selection|id: ui-agent-preset/);
});
