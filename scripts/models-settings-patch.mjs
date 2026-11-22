// Narrow edits to the hash-checked V1ki browser bundle. Leave its account,
// quota, model-editor, and RPC implementations in the same client factory.
export function patchModelsSettings(client, replaceOnce) {
  const replace = (old, next) => { client = replaceOnce(client, old, next); };
  const swapSection = (start, end, next) => {
    if (client.split(start).length !== 2 || client.split(end).length !== 2) throw new Error(`Models settings seam changed: ${start}`);
    const first = client.indexOf(start);
    const last = client.indexOf(end, first + start.length);
    if (last < 0) throw new Error(`Models settings seam reversed: ${start}`);
    replace(client.slice(first, last), next(client.slice(first, last)));
  };

  client = client.replaceAll('Settings → Subscriptions', 'Settings → Models').replaceAll('设置 → 订阅', '设置 → 模型');
  replace(`\t\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
\t\t\t\t\t\t\t\tstyle: {
\t\t\t\t\t\t\t\t\t...styles.providerMeta,
\t\t\t\t\t\t\t\t\twhiteSpace: "normal",
\t\t\t\t\t\t\t\t\toverflow: "visible"
\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t\tchildren: translate("quotaAccountsHint")
\t\t\t\t\t\t\t}),\n`, '');
  for (const key of ['accountsManage', 'nav', 'intro', 'proxyDialogClose']) {
    const marker = `\t${key}: "`;
    const lines = client.split('\n').filter(line => line.startsWith(marker));
    if (lines.length !== 2) throw new Error(`Expected one retired copy key per language: ${marker}`);
    for (const line of lines) replace(line + '\n', '');
  }
  replace(`	card: {
		border: "0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))",
		borderRadius: "var(--dsw-radius-xl, 20px)",
		background: "var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))",
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: 6
	},
	proxyCard: {`, '\tproxyCard: {');
  replace('\tseparator: { borderTop: "0.5px solid var(--dsw-alias-border-l2)" },\n', '');
  replace('\t\tzh,\n\t\ten\n\t}), "dsh-plugin-subscriptions: copy dictionaries");', '\t\tzh: { ...zh, ...enhancedSettingsCopy.zh },\n\t\ten: { ...en, ...enhancedSettingsCopy.en }\n\t}), "dsh-plugin-subscriptions: copy dictionaries");');
  // The public Models slot is rendered after the native Add provider control.
  swapSection('\tctx.effect(() => {\n\t\tconst style = document.createElement("style");\n\t\tstyle.setAttribute("data-plugin", "dsh-plugin-subscriptions");', '\tconst connection = ctx.get("connection");\n\tconst t = ctx.locale.bind(NS);', () => '');
  replace(`const injected = () => ({
		rpc: connection.rpc,
		t
	});
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "subscriptions",
		order: 90,
		label: () => t("nav"),
		inject: injected
	}, SubscriptionsSection));`, 'registerEnhancedModelsSettings(ctx, connection, t, SubscriptionsSection);');
  replace(`Register the Subscriptions section once the \`settings.section\` declaration
* is on the ledger (the shell's apply order relative to this one is NOT
* constrained; registration depends on the slot through \`slots.inject()\`).`, 'Register the Models footer and the existing subscription chat tools.');
  replace('The Subscriptions settings page component.', 'The subscription accounts section inside the native Models page.');

  // The upstream host broadcasts adapter updates on auth/model changes; keep
  // this UI-only move separate from the native picker and global defaults.
  replace('const t = props.t ?? fallbackTranslate$4;', `const t = props.t ?? ((key, params) => {
		const text = enhancedSettingsCopy.en[key];
		if (text === void 0) return fallbackTranslate$4(key, params);
		return Object.entries(params ?? {}).reduce((copy, [key, value]) => copy.replaceAll(\`{\${key}}\`, () => String(value)), text);
	});
	const sectionId = react.useId();
	const [openProvider, setOpenProvider] = react.useState();
	const [optionsOpen, setOptionsOpen] = react.useState(false);
	const [proxyAttempt, retryProxy] = react.useReducer(count => count + 1, 0);
	const [statusError, setStatusError] = react.useState();
	const attempts = react.useSyncExternalStore(loginState.subscribe, loginState.getSnapshot);
	const statusGeneration = react.useRef(0);
	const googleStatus = useEnhancedGoogleStatus(rpc, props.quotaState);
	const agyT = props.agyT ?? fallbackAgyTranslate;`);
  replace('const { rpc } = props;', 'const { rpc, loginState } = props;');
  replace('\tconst [deviceCodes, setDeviceCodes] = (0, react.useState)({});\n', '');
  replace('\tconst pollersRef = (0, react.useRef)(/* @__PURE__ */ new Map());\n', '');
  // A single poller follows busy state, including existing accounts while a
  // second account is signing in. It is removed when the Models page closes.
  swapSection('\tconst stopPolling = (0, react.useCallback)((provider) => {', '\tconst loadUsage = (0, react.useCallback)', () => `	const refresh = react.useCallback(async () => {
		if (!rpc || !mountedRef.current) return;
		const generation = ++statusGeneration.current;
		const observed = loginState.getSnapshot();
		try {
			const { providers } = await callSubscriptionsAuth(rpc, "status", {});
			if (!mountedRef.current || generation !== statusGeneration.current) return;
			setStatuses(previous => mergeEnhancedStatuses(previous, providers));
			setStatusError(void 0);
			loginState.reconcile(providers, observed);
		} catch (error) {
			if (mountedRef.current && generation === statusGeneration.current) setStatusError(messageOf(error));
		}
	}, [rpc, loginState]);
	react.useEffect(() => {
		mountedRef.current = true;
		void refresh();
		return () => {
			mountedRef.current = false;
			statusGeneration.current++;
		};
	}, [refresh]);
	const loginPending = hasEnhancedLoginPending(statuses, attempts);
	react.useEffect(() => {
		if (loginPending) return startEnhancedStatusPolling(refresh, POLL_INTERVAL_MS$1);
	}, [loginPending, refresh]);
`);
  replace('if (usages[key] === void 0 && usageErrors[key] === void 0) loadUsage(id, account.key);', 'if (id === openProvider && usages[key] === void 0 && usageErrors[key] === void 0) loadUsage(id, account.key);');
  replace('\t\tstatuses,\n\t\tusages,\n\t\tusageErrors,\n\t\tloadUsage\n\t]);', '\t\tstatuses,\n\t\tusages,\n\t\tusageErrors,\n\t\tloadUsage,\n\t\topenProvider\n\t]);');
  swapSection('\tconst login = (0, react.useCallback)(async (provider, method) => {', '\tconst submitManual = (0, react.useCallback)', () => `	const login = react.useCallback(async (provider, method) => {
		if (!rpc) return;
		const attempt = loginState.begin(provider);
		if (!attempt) return;
		setOpenProvider(provider);
		setManualDrafts(previous => ({ ...previous, [provider]: "" }));
		setProviderError(provider, void 0);
		try {
			const response = await callSubscriptionsAuth(rpc, "login", { provider, ...(method ? { method } : {}) });
			if (response.authorizeUrl === "") {
				await refresh();
				return;
			}
			if (typeof response.authorizeUrl !== "string") throw new SubscriptionsAuthError(t("loginMissingUrl"));
			if (loginState.ready(attempt, response) && mountedRef.current && !response.userCode) {
				window.open(response.authorizeUrl, "_blank", "noopener");
			}
		} catch (error) {
			setProviderError(provider, messageOf(error));
		} finally {
			loginState.finish(attempt);
		}
	}, [rpc, loginState, t, refresh, setProviderError]);
	const cancel = react.useCallback(async (provider) => {
		if (!rpc) return;
		const attempt = loginState.getSnapshot()[provider];
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "cancel", { provider });
			if (attempt) loginState.finish(attempt);
			if (mountedRef.current) setManualDrafts(previous => ({ ...previous, [provider]: "" }));
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [rpc, loginState, refresh, setProviderError]);
`);
  replace('\t\tif (rpc === void 0) return;\n\t\tlet alive = true;\n\t\tcallSubscriptionsAuth(rpc, "proxyGet", {})', '\t\tif (!rpc || !optionsOpen) return;\n\t\tlet alive = true;\n\t\tcallSubscriptionsAuth(rpc, "proxyGet", {})');
  replace(`	}, [rpc]);
	(0, react.useEffect)(() => {
		if (!proxyOpen) return;
		const onKey = (event) => {
			if (event.key === "Escape") setProxyOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [proxyOpen]);`, '\t}, [rpc, optionsOpen, proxyAttempt]);');
  // Keep proxy controls inside the native Settings dialog's focus boundary.
  let proxyEditor;
  swapSection('\t\t\tproxyOpen && /* @__PURE__ */', '\n\t\t]\n\t});\n}\n\n//#endregion\n//#region src/client/ImageGallery.tsx', (content) => {
    const bodyStart = '\t\t\t\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {\n\t\t\t\t\t\t\tstyle: styles$5.proxyCheck,';
    const first = content.indexOf(bodyStart);
    const last = content.lastIndexOf('\n\t\t\t\t\t]\n');
    if (first < 0 || last < first) throw new Error('Proxy editor layout seam changed');
    proxyEditor = `proxyOpen && react.createElement("div", { className: "dsh-enhanced-subscription-body" },
						react.createElement("h3", { style: { margin: 0 } }, t("proxyDialogTitle")),
${content.slice(first, last)}
					)`;
    return '';
  });
  swapSection('\tmodalOverlay: {', '\tmodal: {', () => '');
  swapSection('\tmodalHeader: {', '\tmodalTitle: {', () => '');
  replace('children: t("proxyConfigure")', 'disabled: proxy === void 0 || proxyLoadError !== void 0 || proxyOpen || proxySaving || proxyTesting,\n\t\t\t\t\t\t\tchildren: t("proxyConfigure")');
  replace('\tconst saveProxy = (0, react.useCallback)', `	const closeProxyEditor = () => {
		setProxyOpen(false);
		setProxyPassword("");
		setProxyClearPassword(false);
	};
	const saveProxy = (0, react.useCallback)`);
  replace('\t\t\tsetProxyOpen(false);\n\t\t} catch (error)', '\t\t\tsetProxyOpen(false);\n\t\t\tsetProxyPassword("");\n\t\t\tsetProxyClearPassword(false);\n\t\t} catch (error)');
  proxyEditor = replaceOnce(proxyEditor, 'type: "password",', 'type: "password", autoComplete: "new-password", "aria-label": t("proxyPassword"),');
  proxyEditor = replaceOnce(proxyEditor, 'onClick: () => setProxyOpen(false),', 'onClick: closeProxyEditor,');

  const optionsStart = '\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UsageBadgeDisplaySetting, { t }),';
  const providersStart = '\t\t\tPROVIDERS.map(({ id, name }) => {';
  let options;
  swapSection(optionsStart, providersStart, (content) => {
    options = content;
    return '';
  });
  replace(`className: "dsh-subscriptions-settings",
		style: styles$5.section,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: providerSettingsCss }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$5.intro,
				children: t("intro")
			}),`, `className: "dsh-subscriptions-settings",
		style: { ...styles$5.section, maxWidth: "none" },
		"aria-labelledby": sectionId,
		role: "region",
		children: [
			react.createElement("style", null, providerSettingsCss + enhancedModelsCss + agyQuotaCss),
			react.createElement("h3", { id: sectionId, className: "dsh-enhanced-subscription-title" }, t("enhancedAccountsTitle")),
			statusError && react.createElement("div", { style: styles$5.actions },
				react.createElement("p", { role: "alert" }, t("enhancedStatusError", { message: statusError })),
				react.createElement("button", { type: "button", onClick: refresh }, t("modelDefaultsRetry"))),`);
  replace(providersStart, `			Object.keys(statuses).length === 0 && statusError === void 0 &&
				react.createElement("p", { role: "status", style: styles$5.statusLine }, t("checking")),
			react.createElement(EnhancedSubscriptionGroups, {
				id: sectionId, t, statuses, attempts, errors,
				extraConnected: googleStatus.connected ? [react.createElement(EnhancedGoogleRow, {
					key: "google-local", sectionId, state: googleStatus,
					open: openProvider === "google-local",
					toggle: () => setOpenProvider(current => current === "google-local" ? void 0 : "google-local"),
					t, agyT,
				})] : [],
				extraAvailable: !googleStatus.connected ? [react.createElement(EnhancedGoogleRow, {
					key: "google-local", sectionId, state: googleStatus,
					open: openProvider === "google-local",
					toggle: () => setOpenProvider(current => current === "google-local" ? void 0 : "google-local"),
					t, agyT,
				})] : [],
				render: ({ id, name }) => {`);
  replace(`				const status = statuses[id];
				const busy = status?.busy === true;
				const deviceCode = deviceCodes[id];`, `				const attempt = attempts[id];
				const starting = attempt?.starting === true;
				const status = statuses[id];
				const busy = status?.busy === true || (attempt !== void 0 && !starting);
				const unavailable = status?.statusUnavailable === true || (status === void 0 && statusError !== void 0);
				const deviceCode = attempt?.deviceCode;`);
  swapSection('\t\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\tstyle: styles$5.card,\n\t\t\t\t\tchildren: [', '\t\t\t\t\t\taccounts.map((account) => {', () => `				return react.createElement(EnhancedSubscriptionRow, {
					key: id, id, name, status, titleId: \`\${sectionId}-\${id}\`,
					busy, starting, unavailable,
					error: errors[id] ?? (status?.statusUnavailable || (!starting && !busy) ? status?.detail : void 0), t,
					retry: status?.statusUnavailable ? refresh : void 0,
					open: (!unavailable && openProvider === id) || busy || starting,
					toggle: () => setOpenProvider(current => current === id ? void 0 : id),
					connect: () => login(id), cancel: () => cancel(id),
				},
						status?.clientVersion && react.createElement(ClientVersionTag, { clientVersion: status.clientVersion, t }),
`);
  // Login/cancel are now primary row actions. Keep add-account, manager,
  // usage, and the provider-specific manual/device fallback in the same body.
  swapSection('\t\t\t\t\t\t\t\t!busy && accounts.length === 0 &&', '\t\t\t\t\t\t\t\t!busy && accounts.length > 0 && id === "claude"', () => '');
  replace('\t\t\t\t\t\t\t\t!busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\t\t\t"aria-haspopup": "dialog",', '\t\t\t\t\t\t\t\tstatus && !busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\t\t\t"aria-haspopup": "dialog",');
  replace('children: t("accountsManage")\n\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\tbusy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\t\t\t\t\tcancel(id);\n\t\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t\t\tchildren: t("cancel")\n\t\t\t\t\t\t\t\t})', 'children: t("enhancedAccountSettings")\n\t\t\t\t\t\t\t\t})');
  replace('\t\t\t\t\t\tbusy && deviceCode === void 0 &&', `						busy && attempt?.authorizeUrl && react.createElement("div", { style: styles$5.actions },
							react.createElement("button", { type: "button", onClick: () => window.open(attempt.authorizeUrl, "_blank", "noopener") }, t("enhancedOpenAuthorization"))),
						busy && id === "copilot" && !deviceCode && react.createElement("p", { style: styles$5.statusLine }, t("enhancedDeviceRestart")),
						busy && id !== "copilot" &&`);
  replace('placeholder: t("manualPlaceholder"),', 'placeholder: t("manualPlaceholder"),\n\t\t\t\t\t\t\t\t\t"aria-label": t("manualPlaceholder"),\n\t\t\t\t\t\t\t\t\tautoComplete: "off",\n\t\t\t\t\t\t\t\t\tspellCheck: false,');
  replace(`					]
				}, id);
			}),
			managedProvider &&`, `				);
			} }),
			react.createElement("details", { className: "dsh-enhanced-subscription-more", onToggle: event => setOptionsOpen(event.currentTarget.open) },
				react.createElement("summary", null, t("enhancedOptions")),
				optionsOpen && react.createElement("div", { className: "dsh-enhanced-subscription-options" },
${options.replace('\t\t\t/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: styles$5.separator }),\n', '')}
					proxyLoadError && react.createElement("button", { type: "button", onClick: retryProxy }, t("modelDefaultsRetry")),
					proxyMessage?.tone === "success" && react.createElement("p", { role: "status" }, proxyMessage.text),
					${proxyEditor}
				)),
			managedProvider &&`);
  replace('"aria-labelledby": "subscriptions-reset-title",', '"aria-labelledby": `${sectionId}-reset`,');
  replace('id: "subscriptions-reset-title",', 'id: `${sectionId}-reset`,');

  // Geometry/interaction helpers are already copied locally by badge-compat.
  // The remaining imports only supplied decorative glyphs.
  replace('let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");\n__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);\n', '');
  swapSection('//#region src/client/host-icons.ts', '//#region src/client/ImageGenerateToolview.tsx', () => '');
  replace('const SparkleIcon$1 = hostIcon(__deepseek_ai_dsh_client_ui_primitives, "Sparkle");', 'const SparkleIcon$1 = enhancedSparkleIcon;');
  replace('const SparkleIcon = hostIcon(__deepseek_ai_dsh_client_ui_primitives, "Sparkle");', 'const SparkleIcon = enhancedSparkleIcon;');
  swapSection('/** DSH renamed the data icon in 0.1.7; retain older supported hosts too. */', '/** How often the badge re-reads usage;', () => 'const UsageBadgeIcon = enhancedUsageIcon;\n');
  return client;
}
