/** Remove the product identity prose only; preserve every operational instruction. */
export function geminiSystemPrompt(model, system) {
  let id = model ?? '';
  if (id.startsWith('~account:')) {
    try { id = decodeURIComponent(id.split(':')[2] ?? ''); } catch { return system; }
  }
  if (!/^(?:antigravity-)?gemini(?:-|$)/i.test(id) || typeof system !== 'string') return system;
  return system
    .replace(/^You are an AI agent powered by DeepSeek Harness\.[ \t]*(?:\r?\n(?:[ \t]*\r?\n)?)?/gm, '')
    .replaceAll('You help the user customize DeepSeek Harness itself.', 'You help the user customize the current application itself.');
}
