import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('built browser keeps subscription UI and quota compatibility without automatic mode selection', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(source.startsWith('window.__ModuleLoader__.load({ id: "dsh-plugin-subscriptions-enhanced"'));
  assert.equal(source.includes('registerGeminiObserver'), false);
  assert.equal(source.includes('subscriptions-enhanced.geminiDefault'), false);
  assert.equal(source.includes('remote.agentPresets.select('), false);
  assert.equal(source.includes('subscriptions-enhanced-gemini-default'), false);
  assert.equal(source.includes('document.querySelector'), false);
  assert.equal(source.includes('__deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition'), false);
  assert.equal(source.includes('__deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer'), false);
  assert.equal(source.includes('function enhancedAnchoredPosition('), true);
});
