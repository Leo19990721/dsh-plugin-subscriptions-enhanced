import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as persona from '@deepseek-ai/dsh-persona';
import { geminiSystemPrompt } from '../src/gemini-prompt.js';

// Installed preset definitions and the real assembly registry, in an isolated
// Context. No active Session, profile settings, or provider account is changed.
for (const mode of ['standard', 'ptc', 'minimal', 'cordis']) {
  test(`installed ${mode} persona keeps its mode-specific prompt and tools for Gemini`, async () => {
    const presetFile = join(process.env.DSH_INSTALL_DIR, '../dsh-web-app/presets', mode + '.patch.yml');
    const yaml = await readFile(presetFile, 'utf8');
    const prefixLine = yaml.match(/^\s+prefix: (.+)$/m)?.[1];
    assert.ok(prefixLine, 'installed persona prefix exists');
    const prefix = prefixLine === '>-' ? yaml.match(/^\s+prefix: >-\n((?: {16}[^\n]+\n)+)/m)[1].trim().split(/\n\s*/).join(' ') : prefixLine;
    const complete = /^\s+complete: true$/m.test(yaml);
    const includeRuntimeContext = !/^\s+includeRuntimeContext: false$/m.test(yaml);
    const ctx = new Context();
    const root = ctx.plugin({ apply(scope) { new SystemPrompt(scope, {}); } });
    await root.inertia;
    const key = {}; const agentScope = createScope(ctx, key);
    const personaFiber = agentScope.ctx.plugin(persona, { prefix, complete, includeRuntimeContext });
    const guideFiber = agentScope.ctx.plugin({ inject: ['systemPrompt'], apply(scope) {
      scope.systemPrompt.section({ name: 'synthetic:tool-guide', order: 1100, text: 'Use read before edit. Do not discard user changes.' });
      scope.systemPrompt.tools(() => ({ schemas: [{ name: 'read', description: 'Read text', parameters: { type: 'object', properties: {} } }] }));
    } });
    try {
      await personaFiber.inertia; await guideFiber.inertia;
      assert.equal(guideFiber.state, 2);
      const registry = ctx.get('systemPrompt');
      registry.variable('model', () => 'gemini-4-hydrogen');
      const assembly = await registry.assemble({ scope: key });
      const original = renderPrompt(assembly);
      const toolsBefore = structuredClone(assembly.tools);
      const changed = geminiSystemPrompt('gemini-4-hydrogen', original);
      const expected = original.replace(/^You are an AI agent powered by DeepSeek Harness\.\n\n/, '')
        .replace('You help the user customize DeepSeek Harness itself.', 'You help the user customize the current application itself.');
      assert.equal(changed, expected);
      assert.equal(changed.includes('You are an AI agent powered by DeepSeek Harness.'), false);
      assert.deepEqual(assembly.tools, toolsBefore);
      assert.equal(geminiSystemPrompt('gpt-6.1-sol', original), original);
      if (mode === 'minimal') assert.equal(changed, 'You are a helpful software engineer assistant.');
      else assert.ok(changed.includes('Use read before edit. Do not discard user changes.'));
      if (mode === 'cordis') assert.ok(changed.includes('customize the current application itself.'));
    } finally {
      await guideFiber.dispose(); await personaFiber.dispose(); await agentScope.dispose(); await root.dispose();
    }
  });
}
