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
if (manifest.name !== 'dsh-plugin-subscriptions') throw new Error('Unexpected subscriptions build input');
let host = await readFile(join(upstream, 'lib/index.js'), 'utf8');
let client = await readFile(join(upstream, 'lib/client.js'), 'utf8');
const hash = source => createHash('sha256').update(source).digest('hex');
const hostSha256 = hash(host), clientSha256 = hash(client);
// The patch functions below validate the code they modify, independent of version.
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
		proxy: z.string().default("auto").description("auto: use the enabled subscription proxy, then environment or Windows system proxy; direct or empty: no proxy; otherwise a proxy URL."),
		dataDir: z.string().description("Optional absolute path for the persistent DSH-owned Google CLI state."),
		agentsFile: z.string().description("Optional absolute path to global instructions; empty disables loading them."),
		mcp: z.array(z.string().pattern(/^(?:[*]|[A-Za-z0-9_-]{1,32})$/)).default(["*"]).description("DSH MCP server allowlist (remote includes native Remote tools); * discovers enabled servers, [] disables their bridge.")
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
  'const quotaState = installAgyClient(ctx);\n\tconst agyT = ctx.locale.bind(agySection);\n\tregisterAgyToolCards(ctx, react, loadAgyPrimitives(require));\n\tctx.inject(["modelDirectories"], (scope) => registerAgyTeamMenu(scope, react.createElement));\n\tregisterEnhancedModelsSettings(ctx, connection, t, SubscriptionsSection, quotaState);');
client = replaceOnce(client, `			currentModel: createCurrentModelReader(models, sessionId)
		})
	}, SubscriptionUsageBadge));`, `			currentModel: createCurrentModelReader(models, sessionId),
			sessionId, agyT, quotaState,
			hooks: { agyDockModel: agyDockModelStore(models, sessionId) }
		})
	}, ComposerSubscriptionUsage));`);
// Retain the original badge's last non-Google selection across provider swaps,
// without keeping its request effects mounted while Google is selected.
client = replaceOnce(client, 'function SubscriptionUsageBadge({ rpc, currentModel, t }) {',
  'function SubscriptionUsageBadge({ rpc, currentModel, t, legacySelection }) {');
client = replaceOnce(client, 'const [lastSubscription, setLastSubscription] = (0, react.useState)(void 0);',
  'const [lastSubscription, setLastSubscription] = legacySelection;');
const clientSources = await Promise.all(['badge-compat.js', 'models-settings-ui.js', 'agy-client.js', 'agy-quota-state.js',
  'agy-usage-dock.js', 'agy-team-menu.js', 'agy-local-tool-data.js', 'agy-tool-cards-client.js'].map(async name =>
  (await readFile(join(root, 'src', name), 'utf8'))
    .replace(/^import \{[^\n]+\} from '\.\/agy-local-tool-data\.js';\r?\n/gm, '')
    .replace(/^export (?=function |const )/gm, '')));
client = replaceOnce(client, 'return module.exports; } });', [...clientSources, 'return module.exports; } });'].join('\n'));
client = client.replace('//# sourceMappingURL=client.js.map', '');
await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib/index.js'), host);
await writeFile(join(root, 'lib/client.js'), client);
for (const name of ['writing-policy.js', 'writing-host.js', 'agy-local-plugin.js', 'agy-local-host.js', 'agy-local-runtime.js',
  'agy-local-background.js', 'agy-local-context.js', 'agy-local-progress.js', 'agy-local-tool-data.js', 'agy-local-proxy.js', 'agy-local-mcp.js', 'agy-local-lineage.js', 'agy-local-storage.js', 'agy-local-persona.js',
  'agy-ingress.js', 'agy-identity.js', 'agy-launch.js', 'agy-acp-client.js', 'agy-session.js', 'agy-turn-session.js', 'agy-turn-options.js']) {
  await copyFile(join(root, 'src', name), join(root, 'lib', name));
}
await copyFile(join(upstream, 'LICENSE'), join(root, 'LICENSE'));
await writeFile(join(root, 'lib/upstream.json'), JSON.stringify({ name: manifest.name, version: manifest.version, hostSha256, clientSha256, patches: ['Remove legacy Antigravity transport and sign-in', 'Route the Google subscription to local official ACP', 'Codex ultrafast service_tier and /speed command', 'Native subagent MCP tools for Gemini', 'Host-only writing policy for ordinary DSH models', 'DSH quota badge positioning compatibility', 'Native Models footer for subscription management', 'local package identity'] }, null, 2) + '\n');
console.log(`Built from ${manifest.name}@${manifest.version}; Google subscription uses official agy ACP.`);
