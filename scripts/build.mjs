import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { patchCodexUltrafastClient, patchCodexUltrafastHost } from './codex-ultrafast-patch.mjs';
import { patchModelsSettings } from './models-settings-patch.mjs';
import { retireAntigravityClient, retireAntigravityHost } from './retire-antigravity.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name: packageName } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
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
  return source.replace(old, () => next);
}
host = retireAntigravityHost(host);
host = patchCodexUltrafastHost(host, replaceOnce);
host = 'import * as writing from "./writing-host.js";\nimport * as agy from "./agy-local-plugin.js";\n' + host;
host = replaceOnce(host, 'const Config = z.object({', `const Config = z.object({
	google: z.object({
		executable: z.string().description("Absolute path to Google agy.exe; empty uses the standard install location."),
		proxy: z.string().default("auto").description("auto: use environment or Windows system proxy; direct or empty: no proxy; otherwise a proxy URL."),
		dataDir: z.string().description("Optional absolute path for the persistent DSH-owned Google CLI state."),
		agentsFile: z.string().description("Optional absolute path to global instructions; empty disables loading them."),
		mcp: z.array(z.union(["knowledge", "windows", "playwright"])).default(["knowledge", "windows", "playwright"]).description("Existing DSH MCP servers available to Gemini with Full Access; [] disables the bridge."),
		gptBridge: z.boolean().default(true).description("Allow Gemini to delegate and coordinate parallel non-Google DSH sessions via built-in MCP tools.")
	}),`);
host = replaceOnce(host, 'function apply(ctx, config) {', 'function apply(ctx, config) {\n\tctx.plugin(writing, { localGoogle: true });\n\tctx.plugin(agy, config.google);');
host = replaceOnce(host, 'const name = "dsh-plugin-subscriptions";', `const name = ${JSON.stringify(packageName)};`);
// Distinguish a failed status read from a confirmed empty account list.
host = replaceOnce(host, '\t\t\t\tbusy: false,\n\t\t\t\taccounts: [],\n\t\t\t\tdetail:', '\t\t\t\tbusy: false,\n\t\t\t\taccounts: [],\n\t\t\t\tstatusUnavailable: true,\n\t\t\t\tdetail:');
client = replaceOnce(client, 'id: "dsh-plugin-subscriptions", factory:', `id: ${JSON.stringify(packageName)}, factory:`);
client = replaceOnce(client, '(0, __deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)', 'enhancedAnchoredPosition');
client = replaceOnce(client, '(0, __deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)', 'enhancedDismissOutside');
// Only update the destination named in auth/quota help text on the Host.
host = host.replaceAll('Settings → Subscriptions', 'Settings → Models')
  .replaceAll('Settings > Subscriptions', 'Settings > Models').replaceAll('设置 → 订阅', '设置 → 模型');
client = retireAntigravityClient(patchCodexUltrafastClient(patchModelsSettings(client, replaceOnce), replaceOnce));
client = replaceOnce(client, 'registerEnhancedModelsSettings(ctx, connection, t, SubscriptionsSection);',
  'installAgyClient(ctx);\n\tctx.inject(["modelDirectories"], (scope) => registerAgyTeamMenu(scope, react.createElement));\n\tregisterEnhancedModelsSettings(ctx, connection, t, SubscriptionsSection);');
const badge = await readFile(join(root, 'src/badge-compat.js'), 'utf8');
const modelsSettings = (await readFile(join(root, 'src/models-settings-ui.js'), 'utf8')).replace(/^export (?=function )/gm, '');
const agyClient = await readFile(join(root, 'src/agy-client.js'), 'utf8');
const teamMenu = (await readFile(join(root, 'src/agy-team-menu.js'), 'utf8')).replace(/^export (?=function )/gm, '');
client = replaceOnce(client, 'return module.exports; } });', [badge, modelsSettings, agyClient, teamMenu, 'return module.exports; } });'].join('\n'));
client = client.replace('//# sourceMappingURL=client.js.map', '');
await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib/index.js'), host);
await writeFile(join(root, 'lib/client.js'), client);
for (const name of ['writing-policy.js', 'writing-host.js', 'agy-local-plugin.js', 'agy-local-host.js', 'agy-local-runtime.js',
  'agy-local-context.js', 'agy-local-progress.js', 'agy-local-proxy.js', 'agy-local-mcp.js', 'agy-local-gpt-bridge.js',
  'agy-ingress.js', 'agy-identity.js', 'agy-launch.js', 'agy-acp-client.js', 'agy-session.js', 'agy-turn-session.js', 'agy-turn-options.js']) {
  await copyFile(join(root, 'src', name), join(root, 'lib', name));
}
await copyFile(join(upstream, 'LICENSE'), join(root, 'LICENSE'));
await writeFile(join(root, 'lib/upstream.json'), JSON.stringify({ name: manifest.name, version: manifest.version, hostSha256: expectedHost, clientSha256: expectedClient, patches: ['Remove legacy Antigravity transport and sign-in', 'Route the Google subscription to local official ACP', 'Codex ultrafast service_tier and /speed command', 'Parallel GPT session MCP bridge for Gemini', 'Host-only writing policy for ordinary DSH models', 'DSH quota badge positioning compatibility', 'Native Models footer for subscription management', 'local package identity'] }, null, 2) + '\n');
console.log('Built from verified dsh-plugin-subscriptions@0.9.13; Google subscription uses official agy ACP.');
