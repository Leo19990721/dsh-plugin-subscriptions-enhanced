import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgyPresetPersona } from '../src/agy-local-persona.js';

const PERSONA = '@deepseek-ai/dsh-persona';
const selection = { provider: 'antigravity', model: 'gemini-fixture' };

// Only the installed package files are resolved; this fixture never opens the
// profile, network, session persistence, or an actual model adapter.
async function fixture(t) {
  const anchor = join(process.env.DSH_INSTALL_DIR, 'package.json');
  const require = createRequire(anchor);
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const [{ Context }, { Loader }, { SystemPrompt }, { AgentPresetRegistry }, { createScope },
    { SessionProjectionRegistry }, { SessionStore }, { AgentRegistry }] = await Promise.all([
    'cordis', 'cordis-plugin-loader', 'dsh-system-prompt', 'dsh-agent-preset-registry', 'dsh-scope',
    'dsh-session-projection', 'dsh-session', 'dsh-agent',
  ].map(load));
  const ctx = new Context();
  const baseUrl = pathToFileURL(anchor).href;
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  async function mount(plugin, config) {
    const fiber = ctx.plugin(plugin, config);
    cleanups.push(() => fiber.dispose());
    await fiber.await();
    assert.equal(fiber.state, 2);
  }
  await mount(Loader, { baseUrl });
  await mount(SessionStore);
  await mount(SessionProjectionRegistry);
  await mount(AgentRegistry);
  await mount(SystemPrompt, { personaPrefix: 'private global prefix', personaSuffix: 'private global suffix' });
  await mount(AgentPresetRegistry, { default: 'fixture' });
  await mount({ inject: ['systemPrompt'], apply(scope) {
    scope.systemPrompt.section({ name: 'test:private', order: 1, text() { assert.fail('persona must not assemble other sections'); } });
    scope.systemPrompt.variable('private', () => assert.fail('persona must not resolve arbitrary variables'));
  } });
  async function register(id, plugins) {
    const off = await ctx.extend({ baseUrl }).agentPresets.register({ id, plugins });
    cleanups.push(off);
    return off;
  }
  async function bind(id) {
    const agent = createScope(ctx, {});
    cleanups.push(() => agent.dispose());
    assert.deepEqual(await ctx.agentPresets.mount(agent.ctx, id), { id });
    return agent.ctx;
  }
  return { ctx, register, bind };
}

const row = (config, other) => ({ id: 'persona', name: PERSONA, config, ...other });

test('installed native persona comes from the exact retained preset revision', async t => {
  const h = await fixture(t);
  const retired = await h.register('fixture', [row({ prefix: '\nWriting on {{model}}', suffix: 'Use {{provider}}.\n' })]);
  const old = await h.bind('fixture');
  await retired();
  await h.register('fixture', [row({ prefix: 'Revised persona', suffix: 'do not forward {{private}}', complete: true })]);
  const current = await h.bind('fixture');
  assert.equal(h.ctx.agentPresets.composedPreset(old), h.ctx.agentPresets.composedPreset(current));
  assert.equal(resolveAgyPresetPersona(old, selection), '\nWriting on gemini-fixture\n\nUse antigravity.\n');
  assert.equal(resolveAgyPresetPersona(current, selection), 'Revised persona');
  assert.equal(resolveAgyPresetPersona(h.ctx, selection), undefined, 'no live preset, even when a default exists');
});

test('installed native persona excludes disabled rows, defaults and dynamic values', async t => {
  const h = await fixture(t);
  for (const [id, plugins, wanted] of [
    ['none', [], undefined],
    ['disabled', [row({ prefix: 'disabled persona' }, { disabled: true })], undefined],
    ['dynamic', [row({ prefix: { __jsExpr: '"computed expression"' } })], undefined],
    ['variable', [row({ prefix: 'Do not resolve {{private}}' })], undefined],
    ['malformed', [row({ prefix: 'Do not resolve {{ model }}' })], undefined],
    ['complete', [row({ prefix: '', suffix: 'ignored', complete: true })], undefined],
    ['suffix-only', [row({ prefix: '', suffix: 'Explicit suffix' })], 'Explicit suffix'],
    ['literal', [row({ prefix: 'Keep a lone {{ open' })], 'Keep a lone {{ open'],
  ]) {
    await h.register(id, plugins);
    assert.equal(resolveAgyPresetPersona(await h.bind(id), selection), wanted, id);
  }
});

test('persona capability fails closed if the Host cannot identify an exact active row', () => {
  const of = entries => ({ get: name => {
    assert.equal(name, 'agentPresets');
    return { composedPreset: () => 'fixture', generationFor: () => ({ mount: { presetId: 'fixture', tree: { entries: () => entries } } }) };
  } });
  const fiber = { state: 2, rawConfig: { prefix: 'literal' }, effectiveConfig: { prefix: 'literal', suffix: '', complete: false } };
  const candidate = { options: { name: PERSONA }, fiber, get disabled() { assert.fail('do not re-evaluate disabled expressions'); } };
  assert.equal(resolveAgyPresetPersona(of([candidate]), selection), 'literal');
  assert.equal(resolveAgyPresetPersona(of([candidate, candidate]), selection), undefined);
  assert.equal(resolveAgyPresetPersona(of([{ options: { name: 'not-dsh-persona' }, fiber }]), selection), undefined);
  assert.equal(resolveAgyPresetPersona(of([{ options: { name: PERSONA }, fiber: { ...fiber, state: 1 } }]), selection), undefined);
  assert.equal(resolveAgyPresetPersona({ get: () => ({ composedPreset: () => 'fixture' }) }, selection), undefined);
});
