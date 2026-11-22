import { createHash } from 'node:crypto';

// These patches target the monolithic dsh-plugin-subscriptions@0.9.13 files.
// The caller verifies the upstream artifact hashes before other build patches.
// Pin the removed spans too: never cut a larger (or changed) block by accident.
function patcher(source, artifact) {
  const fail = label => { throw new Error(`Retire Antigravity ${artifact}: unexpected seam (${label})`); };
  const unique = (text, label) => {
    const start = source.indexOf(text);
    if (start === -1 || source.indexOf(text, start + 1) !== -1) fail(label);
    return start;
  };
  const splice = (start, end, next) => { source = source.slice(0, start) + next + source.slice(end); };
  const check = (start, end, hashes, label) => {
    if (end <= start || !hashes.includes(createHash('sha256').update(source.slice(start, end)).digest('hex'))) fail(label);
  };
  return {
    replace(label, before, after = '') {
      const start = unique(before, label);
      splice(start, start + before.length, after);
    },
    range(label, from, to, hash, after = '') {
      const start = unique(from, label);
      const end = unique(to, label);
      check(start, end, [hash], label);
      splice(start, end, after);
    },
    region(name, ...hashes) {
      const start = unique(`//#region ${name}\n`, name);
      const closing = '\n//#endregion\n';
      const end = source.indexOf(closing, start);
      if (end === -1) fail(name);
      check(start, end + closing.length, hashes, name);
      splice(start, end + closing.length, '');
    },
    finish(permittedLines = []) {
      const retired = /antigravity|cloudcode-pa|cloudaicompanion|googleusercontent\.com|accounts\.google\.com|oauth2\.googleapis\.com|googleapis\.com\/oauth2|loadCodeAssist|onboardUser|retrieveUserQuotaSummary|streamGenerateContent|\bgenerateContent\b|geminiSystemPrompt|enhancedRetryPolicy/i;
      const lines = source.split('\n');
      if (permittedLines.some(line => lines.filter(candidate => candidate === line).length !== 1)
        || lines.some(line => !permittedLines.includes(line) && retired.test(line))) fail('old provider code still present');
      return source;
    },
  };
}

const modelIdHash = '32e7addd3324ca5a398e2da61f917c697be8f0ed66919f6c67d3a84575593bbf';
const archivedProvider = 'const ARCHIVED_PROVIDER = "antigravity";';
const filterArchivedProvider = '\t\t(ids) => ids.filter((id) => id !== "antigravity")).default(PROVIDER_IDS),';
const filterArchivedPool = '\t(members) => members[0]?.provider === "antigravity" ? [] : members.filter((member) => member.provider !== "antigravity"));';

export function retireAntigravityHost(source) {
  const p = patcher(source, 'Host');
  p.region('src/antigravity-model-id.ts', modelIdHash);
  p.region('src/providers/antigravity-usage.ts', 'a0e2a97f88a9697219b9145aa625bf8fd1c9561250db3e60f04ce90a535395ca');
  p.region('src/providers/antigravity-models.ts', 'aac089c10e36d668a8390eced550166977a0eca3d54d7b06655d8e9d232a25ef');
  p.region('src/translate/antigravity-thinking.ts', '95ce8d584f6e443e39c52e2405af5141c80b31a0b5a8a33a881c385fbda02b3f');
  p.region('src/translate/antigravity-images.ts', '403ae7f0b4d3e6f4af47e34e4d70865020ec1256b5152c81aa0f50cc0db6db96');
  p.region('src/translate/antigravity-schema.ts', 'ad2e4f283479dbfb1ceaae9fbea5d772a61aab45602a4a0e5c73241792dcbcea');
  p.region('src/translate/antigravity.ts', '33cadee910c122e2951acd0b2cc979f1637cb141b3609e38fbd245382fa7872e');
  p.region('src/providers/antigravity-oauth-client.ts', '3de6e06509b1ab9ead093313aec30a0066ae1dcb6478eb43b80a5f97abccf3a4');
  p.region('src/providers/antigravity.ts', 'e4cd3b1726b76852bbe571f53788a38ad9547a62dd0235c930c5a636108d9fc8');

  // RPCs and every active account consumer share this allowlist. The opaque
  // compatibility data belongs only to the serializers, outside active maps.
  p.replace('active provider IDs', `const PROVIDER_IDS = [
	"codex",
	"claude",
	"grok",
	"copilot",
	"antigravity"
];`, `const PROVIDER_IDS = ["codex", "claude", "grok", "copilot"];
${archivedProvider}
const archivedAuth = new WeakMap();`);
  p.replace('account key', '\t\tcase "antigravity": return session.account ?? tokenHash(session.refreshToken);\n');
  p.replace('session validation',
    '\tif (provider === "antigravity" && (typeof entry.projectId !== "string" || entry.projectId.length === 0)) throw new Error("subscriptions auth store: entry \\"antigravity\\" is missing projectId; log out and complete Antigravity login again");\n');
  p.replace('active session writes', 'async function saveAccountSession(provider, account, session, path = authFilePath()) {\n\tassertSessionShape',
    'async function saveAccountSession(provider, account, session, path = authFilePath()) {\n\tif (!PROVIDER_IDS.includes(provider)) throw new Error("unsupported subscription provider");\n\tassertSessionShape');
  p.replace('opaque auth section', '\tconst raw = parsed;\n\tconst store = {};\n\tfor (const provider of PROVIDER_IDS) {',
    '\tconst raw = parsed;\n\tconst store = {};\n\tif (Object.hasOwn(raw, ARCHIVED_PROVIDER)) archivedAuth.set(store, raw[ARCHIVED_PROVIDER]);\n\tfor (const provider of PROVIDER_IDS) {');
  p.replace('atomic auth write', '\t\tawait writeFile(tmp, JSON.stringify(store, null, 2), { mode: 384 });',
    '\t\tconst document = archivedAuth.has(store) ? { ...store, [ARCHIVED_PROVIDER]: archivedAuth.get(store) } : store;\n\t\tawait writeFile(tmp, JSON.stringify(document, null, 2), { mode: 384 });');

  p.replace('archived model defaults', 'let current = EMPTY;\n', 'let current = EMPTY;\nlet archivedModelDefaults = {};\n');
  p.replace('load model defaults', '\t\tconst { defaults, dropped } = sanitizeDefaults(parseJsonText(text));', `		const raw = parseJsonText(text);
		if (raw !== null && typeof raw === "object" && Object.hasOwn(raw, ARCHIVED_PROVIDER)) archivedModelDefaults = { [ARCHIVED_PROVIDER]: raw[ARCHIVED_PROVIDER] };
		const { defaults, dropped } = sanitizeDefaults(raw);`);
  p.replace('save model defaults', '\t\tawait persistDefaults(frozen, modelDefaultsFilePath());',
    '\t\tawait persistDefaults({ ...frozen, ...archivedModelDefaults }, modelDefaultsFilePath());');

  // Retain shared 429/reset parsing behavior, including for Copilot models.
  p.replace('quota reset comment', `* Antigravity discloses the window in \`quotaResetDelay\` and
* \`quotaResetTimeStamp\` and supplies no rate-limit reader. A wait beyond the`,
    '* A response may disclose the window in `quotaResetDelay` or\n* `quotaResetTimeStamp`. A wait beyond the');
  p.range('catalog profile', '\tlet antigravity;\n', '\treturn {\n\t\tid: raw.id,',
    'dce104f03865025281621aebe0796500664c6055e10d31621d25932dec4956bd');
  p.replace('catalog profile return', '\t\t...antigravity === void 0 ? {} : { antigravity },\n');
  p.replace('pool quota providers', `* model says nothing about its siblings (Claude's Opus/Sonnet lanes;
* Antigravity's per-model quotas, whose 429 names the exhausted model and
* can disclose a reset 35 hours out that must not park its Gemini siblings).`,
    "* model says nothing about its siblings (Claude's Opus/Sonnet lanes).");
  p.replace('model-scoped quota IDs', 'const MODEL_SCOPED_QUOTA_PROVIDERS = new Set(["claude", "antigravity"]);',
    'const MODEL_SCOPED_QUOTA_PROVIDERS = new Set(["claude"]);');
  p.replace('pool window calculation', 'windowApplies(window, member.model, member.provider)', 'windowApplies(window, member.model)');
  p.replace('scoped quota window', `function windowApplies(window, model, provider) {
	if (window.scope === void 0) return true;
	if (provider === "antigravity" && antigravityQuotaApplies(window.scope, model)) return true;`,
    'function windowApplies(window, model) {\n\tif (window.scope === void 0) return true;');

  p.replace('provider tools', '\tcopilot: [],\n\tantigravity: []\n', '\tcopilot: []\n');
  p.replace('archived provider settings fields', 'var ProviderSettingsStore = class {\n\tcurrent = {',
    'var ProviderSettingsStore = class {\n\t#archivedProviders = {};\n\t#archivedHistory = [];\n\tcurrent = {');
  p.replace('load provider settings', `			for (const provider of PROVIDER_IDS) if (Object.hasOwn(raw.providers, provider)) this.current.providers[provider] = validatePreferences(provider, raw.providers[provider]);
			this.current.toolHistory = raw.toolHistory.map((revision) => {`, `			if (Object.hasOwn(raw.providers, ARCHIVED_PROVIDER)) this.#archivedProviders[ARCHIVED_PROVIDER] = raw.providers[ARCHIVED_PROVIDER];
			for (const provider of PROVIDER_IDS) if (Object.hasOwn(raw.providers, provider)) this.current.providers[provider] = validatePreferences(provider, raw.providers[provider]);
			this.current.toolHistory = raw.toolHistory.filter((revision) => {
				if (revision?.provider !== ARCHIVED_PROVIDER) return true;
				this.#archivedHistory.push(revision);
				return false;
			}).map((revision) => {`);
  p.replace('save provider settings', '\t\t\t\tawait writeFile(temporary, JSON.stringify(next, null, 2), { mode: 384 });', `				const document = {
					providers: { ...next.providers, ...this.#archivedProviders },
					toolHistory: [...next.toolHistory, ...this.#archivedHistory]
				};
				await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 384 });`);
  p.replace('model visibility aliases', `		if (selected === void 0) return true;
		if (selected.includes(model)) return true;
		return provider === "antigravity" && antigravityModelId(model) === model && selected.some((id) => antigravityModelId(id) === model);`,
    '\t\treturn selected === void 0 || selected.includes(model);');

  p.replace('configured provider IDs', `const providerIdSchema = z.union([
	"codex",
	"claude",
	"grok",
	"copilot",
	"antigravity"
]);`, 'const providerIdSchema = z.union([...PROVIDER_IDS, z.const(ARCHIVED_PROVIDER).hidden()]);');
  // A pool identity is owned by its first configured provider. Dropping an
  // entire retired-owned pool avoids silently giving its name to another
  // subscription. Keep a supported owner's remaining members and row order.
  p.replace('pool member compatibility', 'const Config = z.object({\n\tproviders: z.array(providerIdSchema)',
    `const activePoolMembers = z.transform(z.array(poolMemberSchema),\n${filterArchivedPool}\nconst Config = z.object({\n\tproviders: z.array(providerIdSchema)`);
  p.replace('configured pools', '\t\tfamilies: z.dict(z.array(poolMemberSchema)),\n\t\ttiers: z.dict(z.array(poolMemberSchema))',
    '\t\tfamilies: z.dict(activePoolMembers),\n\t\ttiers: z.dict(activePoolMembers)');
  // Filter an explicit old provider list without disabling the rest of the
  // plugin. Keep the transform self-contained for the serialized schema UI.
  p.replace('default providers', `	providers: z.array(providerIdSchema).default([
		"codex",
		"claude",
		"grok",
		"copilot",
		"antigravity"
	]),`, `	providers: z.transform(z.array(z.union([...PROVIDER_IDS, z.const(ARCHIVED_PROVIDER).hidden()])),
${filterArchivedProvider}`);
  p.replace('configured catalogs and obsolete OAuth options', `		copilot: z.array(modelEntrySchema),
		antigravity: z.array(modelEntrySchema)
	}),
	antigravity: z.object({
		clientId: z.string(),
		clientSecret: z.string().role("secret"),
		baseURL: z.string(),
		userAgent: z.string(),
		onboard: z.boolean().default(true)
	}),\n`, `		copilot: z.array(modelEntrySchema),
		[ARCHIVED_PROVIDER]: z.transform(z.any(), () => void 0).hidden()
	}),
	[ARCHIVED_PROVIDER]: z.transform(z.any(), () => void 0).hidden().role("secret"),
`);
  p.range('obsolete default catalog', '\t],\n\tantigravity: [\n', '\n};\n/** Validate and detach the model catalog',
    'a1bebb574d3b5cbe661e625793d92de428778318f499e08e8dd23d661bd4505f', '\t]');
  p.replace('catalog resolution', '\t\tcopilot: resolve$1("copilot"),\n\t\tantigravity: resolve$1("antigravity")', '\t\tcopilot: resolve$1("copilot")');
  p.replace('status account label', '\t\tcase "antigravity": return session.account;\n');
  p.replace('auth controller signature', 'poolUsage = void 0, antigravityConfig = {}, clientVersions = {}, resetRedemption, onUsageForced)',
    'poolUsage = void 0, clientVersions = {}, resetRedemption, onUsageForced)');
  p.replace('auth controller options', '\t\tthis.antigravityConfig = antigravityConfig;\n');
  p.replace('login dispatch', '\t\tconst spec = provider === "grok" ? await grokFlow() : provider === "antigravity" ? antigravityFlow(resolveAntigravityOAuthConfig(this.antigravityConfig)) : codexFlow;',
    '\t\tconst spec = provider === "grok" ? await grokFlow() : provider === "codex" ? codexFlow : void 0;\n\t\tif (spec === void 0) throw new BadRequest("unsupported subscription provider");');
  p.replace('authorization code dispatch', '\t\t\tcase "antigravity": return exchangeAntigravityCode(code, attempt.pkce.verifier, attempt.redirectUri, resolveAntigravityOAuthConfig(this.antigravityConfig), this.antigravityConfig);\n');
  p.range('adapter registration', '\t\tcase "antigravity": {\n\t\t\tconst tokens = new AccountTokenManager({\n', '\n\t}\n\tconst poolConfig = config.pool;',
    '9ca7b4dfa2791042a568ff9e3188042acf76cf511d2ba084b389d7dc0bc7542f');
  p.range('pool usage registration', '\t\t\t\tcase "antigravity": {\n', '\t\t\t\tcase "copilot": return;',
    'a8e6f6963742f77c9300a5e88cd87dfbbf55c0fb732467b579cd48c233781911');
  p.replace('auth controller registration', 'usageFetchers, void 0, poolUsage, config.antigravity, {', 'usageFetchers, void 0, poolUsage, {');
  return p.finish([archivedProvider, filterArchivedProvider, filterArchivedPool]);
}

export function retireAntigravityClient(source) {
  const p = patcher(source, 'Client');
  p.region('src/antigravity-model-id.ts', modelIdHash);
  p.region('src/client/AntigravityQuotaSummary.tsx', '088ee335258ff7a0e51821670cf91af3adad8f7ddf9cd124e8b0cb456ada0103');
  p.region('src/client/usage-window-filter.ts', 'b6716987ae3437a8016e972b2f604f6c5913d25139314bfeb599e3a02095d203');

  for (const copy of ['Claude and GPT models', 'Claude 和 GPT 模型']) {
    p.replace('shared model quota copy', `\tusageClaudeGptModels: "${copy}",\n\tusageArgon: "Gemini 4 Argon",\n`);
  }
  for (const [key, en, zh] of [
    ['usageGeminiModels', 'Gemini Models', 'Gemini 模型'],
    ['usageWeeklyLimit', 'Weekly limit', '每周限额'],
    ['usageFiveHourLimit', '5h limit', '5 小时限额'],
    ['usageResetsIn', 'Resets in {time}', '{time} 后重置'],
    ['usageBadgeModelCount', '{count} model quotas', '{count} 个模型配额'],
    ['usageBadgeModelUnavailable', 'Current model quota unavailable', '当前模型暂无配额数据'],
  ]) {
    p.replace(`${key} (en)`, `\t${key}: "${en}",\n`);
    p.replace(`${key} (zh)`, `\t${key}: "${zh}",\n`);
  }
  const providerName = source.includes('name: "Gemini (Google Antigravity)"') ? 'Gemini (Google Antigravity)' : 'Google Antigravity';
  p.replace('account selection', `		name: "GitHub Copilot"
	},
	{
		id: "antigravity",
		name: "${providerName}"
	}
];`, '\t\tname: "GitHub Copilot"\n\t}\n];');
  p.replace('manual sign-in drafts', '\t\tcopilot: "",\n\t\tantigravity: ""\n', '\t\tcopilot: ""\n');
  p.replace('settings usage windows', 'const shownWindows = visibleUsageWindows(id, usage?.windows, status?.visibleModels);',
    'const shownWindows = usage?.windows ?? [];');
  p.range('settings quota widget', '\t\t\t\t\t\t\t\t\t\tusage?.windows !== void 0 && usage.windows.length > 0 && shownWindows.length === 0 &&',
    'shownWindows.map((window$1, index) => {', 'dab2ce862b45604fc893c6cfb6485e1fd6b67c2eb40ff9e88af30a04265f3552', '\t'.repeat(10));

  p.replace('quota badge provider IDs', '\tcopilot: "Copilot",\n\tantigravity: "Antigravity"\n', '\tcopilot: "Copilot"\n');
  p.replace('quota badge roster', 'for (const provider of Object.keys(statusResp.providers)) for (const account of accountsOf(statusResp.providers[provider]))',
    'for (const provider of Object.keys(statusResp.providers).filter((id) => Object.hasOwn(PROVIDER_NAMES, id))) for (const account of accountsOf(statusResp.providers[provider]))');
  p.replace('quota badge windows', 'windows: visibleUsageWindows(provider, windows, statusResp.providers[provider]?.visibleModels)', 'windows');
  p.replace('quota window priority', 'function prioritizeWindows(windows, model, provider) {', 'function prioritizeWindows(windows, model) {');
  p.replace('quota window scope flags', 'filter((w) => provider === "antigravity" ? antigravityQuotaApplies(w.scope, model) : w.scope === model)', 'filter((w) => w.scope === model)');
  p.replace('quota window sort', 'provider === "antigravity" ? !antigravityQuotaApplies(w.scope, model) : w.scope !== model', 'w.scope !== model');
  p.replace('quota preview', `function previewWindows(windows, model, provider) {
	const ordered = prioritizeWindows(windows, model, provider);
	const limit = provider === "antigravity" ? Math.min(2, model === void 0 ? 0 : windows.filter((w) => antigravityQuotaApplies(w.scope, model)).length) : WINDOW_PREVIEW_LIMIT;`,
    'function previewWindows(windows, model) {\n\tconst ordered = prioritizeWindows(windows, model);\n\tconst limit = WINDOW_PREVIEW_LIMIT;');
  p.replace('compact badge signature', `/** Bounded readout; Antigravity quotas belong to individual models, not the account. */
function compactSegment(d, model, t = fallbackTranslate, mode = "used") {`,
    '/** Bounded readout for the default account. */\nfunction compactSegment(d, t = fallbackTranslate, mode = "used") {');
  p.range('compact badge quota summary', '\tif (d.provider === "antigravity") {\n', '\tconst parts = windows.slice(0, 2).map(',
    '3f82e0e1861d16b5dad69b9800ee1bb8f41261a8ebf6b189a5d90363c432e64b');
  p.replace('compact badge call', 'compactSegment(collapsed[0], badgeSelection?.model, translate, quotaMode)', 'compactSegment(collapsed[0], translate, quotaMode)');
  p.replace('account quota preview options', 'function AccountWindows({ windows, model, provider, translate, mode }) {',
    'function AccountWindows({ windows, model, translate, mode }) {');
  p.replace('account quota preview option producer', '\t\t\t\t\t\t\t\t\t\tprovider: d.provider,\n\t\t\t\t\t\t\t\t\t\ttranslate,',
    '\t\t\t\t\t\t\t\t\t\ttranslate,');
  p.replace('account quota summary', `	if (provider === "antigravity" && windows.some((window$1) => antigravityQuotaScope(window$1.scope))) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AntigravityQuotaSummary, {
		windows,
		t: translate,
		mode
	});
	const { shown, hidden } = previewWindows(windows, model, provider);`,
    '\tconst { shown, hidden } = previewWindows(windows, model);');
  p.replace('current quota label', '(provider === "antigravity" ? antigravityQuotaApplies(w.scope, model) : w.scope === model) ? ` · ${translate("usageBadgeCurrent")}`',
    'w.scope === model ? ` · ${translate("usageBadgeCurrent")}`');
  return p.finish();
}
