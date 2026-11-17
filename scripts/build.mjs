import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const upstream = process.env.SUBSCRIPTIONS_UPSTREAM_DIR
  ?? dirname(require.resolve('dsh-plugin-subscriptions/package.json'));
const manifest = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'));
if (manifest.version !== '0.9.13') throw new Error(`Review enhancement seams before upgrading upstream ${manifest.version}`);
let host = await readFile(join(upstream, 'lib/index.js'), 'utf8');
let client = await readFile(join(upstream, 'lib/client.js'), 'utf8');
const expectedHost = 'b5d71b623f9155d206587ca77fe7b9458427cb881b92dc91b24a958587eea7b4';
const expectedClient = '4bc997d564f8ec7ad6434a760df94bb2d32b73889153c9f0fc3524c96a5c961b';
const hash = source => createHash('sha256').update(source).digest('hex');
if (hash(host) !== expectedHost || hash(client) !== expectedClient) throw new Error('Upstream artifacts changed; review instead of applying unverified patches');
function replaceOnce(source, old, next) {
  if (source.split(old).length !== 2) throw new Error(`Expected one integration seam: ${old.slice(0, 90)}`);
  return source.replace(old, next);
}
host = 'import { enhancedRetryPolicy, antigravityPoolFailure } from "./policy.js";\nimport { geminiSystemPrompt } from "./gemini-prompt.js";\n' + host;
host = replaceOnce(host, 'const name = "dsh-plugin-subscriptions";', 'const name = "dsh-plugin-subscriptions-enhanced";');
host = replaceOnce(host,
  'return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `antigravity: provider "${provider}" retryPolicy`);',
  'return resolveRetryPolicy(enhancedRetryPolicy(), `antigravity: provider "${provider}" retryPolicy`);');
host = replaceOnce(host,
  'function classifyPoolFailure(error, provider) {\n\tif (!(error instanceof LlmError)) return { action: "throw" };',
  'function classifyPoolFailure(error, provider) {\n\tif (!(error instanceof LlmError)) return { action: "throw" };\n\tconst enhanced = antigravityPoolFailure(error, provider);\n\tif (enhanced !== undefined) return enhanced;');
// Transform only the provider's local wire copy: canonical Session history,
// model-loop requests, tool declarations and all non-Gemini routes stay intact.
host = replaceOnce(host,
  'const system = options.system ?? (systemTexts.length > 0 ? systemTexts.join("\\n\\n") : void 0);',
  'const system = geminiSystemPrompt(options.model, options.system ?? (systemTexts.length > 0 ? systemTexts.join("\\n\\n") : void 0));');
client = replaceOnce(client, 'id: "dsh-plugin-subscriptions", factory:', 'id: "dsh-plugin-subscriptions-enhanced", factory:');
client = replaceOnce(client, '(0, __deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)', 'enhancedAnchoredPosition');
client = replaceOnce(client, '(0, __deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)', 'enhancedDismissOutside');
client = replaceOnce(client, 'return module.exports; } });', (await readFile(join(root, 'src/badge-compat.js'), 'utf8')) + '\nreturn module.exports; } });');
client = client.replace('//# sourceMappingURL=client.js.map', '');
await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib/index.js'), host);
await writeFile(join(root, 'lib/client.js'), client);
for (const name of ['policy.js', 'gemini-prompt.js']) await copyFile(join(root, 'src', name), join(root, 'lib', name));
await copyFile(join(upstream, 'LICENSE'), join(root, 'LICENSE'));
await writeFile(join(root, 'lib/upstream.json'), JSON.stringify({ name: manifest.name, version: manifest.version, hostSha256: expectedHost, clientSha256: expectedClient, patches: ['Antigravity retry policy', 'Antigravity pool cooldown classification', 'Gemini-only neutral system identity; all four user-selected presets retained', 'DSH quota badge positioning compatibility', 'local package identity'] }, null, 2) + '\n');
console.log('Built Subscriptions Enhanced from verified dsh-plugin-subscriptions@0.9.13; auth, transport, UI and other providers retained.');
