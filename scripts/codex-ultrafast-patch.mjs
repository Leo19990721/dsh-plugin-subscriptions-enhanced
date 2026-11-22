// Narrow patches to upstream dsh-plugin-subscriptions@0.9.13 adding Codex
// "ultrafast" service_tier discovery, wire dispatch, UI selection, and a
// Host-side /speed command usable from both Desktop and mobile DSH Go.

export function patchCodexUltrafastHost(host, replaceOnce) {
  const replace = (old, next) => { host = replaceOnce(host, old, next); };

  // 1. Validate "ultrafast" in RPC, provider settings, and model speeds store.
  replace(
    'if (tier !== "standard" && tier !== "fast") throw new BadRequest("payload.tier must be \\"standard\\" or \\"fast\\"");',
    'if (tier !== "standard" && tier !== "fast" && tier !== "ultrafast") throw new BadRequest("payload.tier must be \\"standard\\", \\"fast\\", or \\"ultrafast\\"");'
  );
  replace(
    'if (!model.trim() || tier !== "standard" && tier !== "fast") throw new Error("subagent speeds require a model id and either \\"standard\\" or \\"fast\\"");',
    'if (!model.trim() || tier !== "standard" && tier !== "fast" && tier !== "ultrafast") throw new Error("subagent speeds require a model id and \\"standard\\", \\"fast\\", or \\"ultrafast\\"");'
  );
  replace(
    'if (!model.trim() || tier !== "standard" && tier !== "fast") throw new Error("invalid model speed");',
    'if (!model.trim() || tier !== "standard" && tier !== "fast" && tier !== "ultrafast") throw new Error("invalid model speed");'
  );

  // 2. Persist & sanitize ultrafastTier in the catalog cache; mark pre-upgrade
  // Codex snapshots as stale (at: 0) so SWR refreshes once while staying offline-safe.
  replace(
    '\tconst fastTier = raw.fastTier;\n\tif (fastTier !== void 0 && typeof fastTier !== "boolean") return void 0;',
    '\tconst fastTier = raw.fastTier;\n\tif (fastTier !== void 0 && typeof fastTier !== "boolean") return void 0;\n\tconst ultrafastTier = raw.ultrafastTier;\n\tif (ultrafastTier !== void 0 && typeof ultrafastTier !== "boolean") return void 0;'
  );
  replace(
    '\t\t...fastTier === void 0 ? {} : { fastTier },',
    '\t\t...fastTier === void 0 ? {} : { fastTier },\n\t\t...ultrafastTier === void 0 ? {} : { ultrafastTier },'
  );
  replace(
    '\t\tasync load() {\n\t\t\treturn sanitizeSnapshot((await readCatalogFile(path))[provider]);\n\t\t},',
    '\t\tasync load() {\n\t\t\tconst snapshot = sanitizeSnapshot((await readCatalogFile(path))[provider]);\n\t\t\tif (provider === "codex" && snapshot !== void 0 && snapshot.models.some((model) => model.fastTier === true && model.ultrafastTier === void 0)) return void 0;\n\t\t\treturn snapshot;\n\t\t},'
  );
  replace(
    '\t\tasync load() {\n\t\t\tconst section = accountSection(await readCatalogFile(path), provider);\n\t\t\treturn section !== void 0 && Object.hasOwn(section, account) ? sanitizeSnapshot(section[account]) : void 0;\n\t\t},',
    '\t\tasync load() {\n\t\t\tconst section = accountSection(await readCatalogFile(path), provider);\n\t\t\tconst snapshot = section !== void 0 && Object.hasOwn(section, account) ? sanitizeSnapshot(section[account]) : void 0;\n\t\t\tif (provider === "codex" && snapshot !== void 0 && snapshot.models.some((model) => model.fastTier === true && model.ultrafastTier === void 0)) return void 0;\n\t\t\treturn snapshot;\n\t\t},'
  );

  // 3. Discover ultrafast from live Codex catalog (service_tiers or additional_speed_tiers).
  replace(
    'const CODEX_FAST_SERVICE_TIER = "priority";\nconst CODEX_FAST_SPEED_TIER = "fast";',
    'const CODEX_FAST_SERVICE_TIER = "priority";\nconst CODEX_FAST_SPEED_TIER = "fast";\nconst CODEX_ULTRAFAST_SERVICE_TIER = "ultrafast";\nconst CODEX_ULTRAFAST_SPEED_TIER = "ultrafast";'
  );
  replace(
    'function supportsFastTier(entry) {\n\treturn (entry.service_tiers ?? []).some((tier) => tier.id === CODEX_FAST_SERVICE_TIER) || (entry.additional_speed_tiers ?? []).includes(CODEX_FAST_SPEED_TIER);\n}',
    'function supportsFastTier(entry) {\n\treturn (entry.service_tiers ?? []).some((tier) => tier.id === CODEX_FAST_SERVICE_TIER) || (entry.additional_speed_tiers ?? []).includes(CODEX_FAST_SPEED_TIER);\n}\nfunction supportsUltrafastTier(entry) {\n\treturn (entry.service_tiers ?? []).some((tier) => tier.id === CODEX_ULTRAFAST_SERVICE_TIER) || (entry.additional_speed_tiers ?? []).includes(CODEX_ULTRAFAST_SPEED_TIER);\n}'
  );
  replace(
    '\t\t\t...supportsFastTier(entry) ? { fastTier: true } : {}',
    '\t\t\t...supportsFastTier(entry) ? { fastTier: true } : {},\n\t\t\tultrafastTier: supportsUltrafastTier(entry)'
  );

  // 4. Send service_tier: "ultrafast" (or "priority" for fast) in Codex wire body.
  replace(
    'function codexRequestBody(options, resolved, fast) {\n\treturn {',
    'function codexRequestBody(options, resolved, speedTier) {\n\tconst wireTier = speedTier === "ultrafast" ? CODEX_ULTRAFAST_SERVICE_TIER : (speedTier === "fast" || speedTier === true) ? CODEX_FAST_SERVICE_TIER : void 0;\n\treturn {'
  );
  replace(
    '\t\t...fast ? { service_tier: CODEX_FAST_SERVICE_TIER } : {}',
    '\t\t...wireTier === void 0 ? {} : { service_tier: wireTier }'
  );

  // 5. CodexAdapter helpers for ultrafast capability queries and request speed resolution.
  replace(
    '\t/** Whether the discovered catalog advertises a fast tier for this model. */\n\tasync supportsFastTier(model, account) {\n\t\treturn (await this.discovered(model, account))?.fastTier === true;\n\t}',
    '\t/** Whether the discovered catalog advertises a fast tier for this model. */\n\tasync supportsFastTier(model, account) {\n\t\treturn (await this.discovered(model, account))?.fastTier === true;\n\t}\n\t/** Whether the discovered catalog advertises an ultrafast tier for this model. */\n\tasync supportsUltrafastTier(model, account) {\n\t\treturn (await this.discovered(model, account))?.ultrafastTier === true;\n\t}\n\t/** Ids of every discovered model with an ultrafast tier. */\n\tasync ultrafastCapableModels() {\n\t\tif (!this.options.discovery) return [];\n\t\tconst accounts = (await this.options.tokens.list()).map((entry) => entry.key);\n\t\tif (accounts.length === 0) return [];\n\t\tconst seen = /* @__PURE__ */ new Set();\n\t\tconst ids = [];\n\t\tfor (const account of accounts) try {\n\t\t\tconst models = await (await this.catalogFor(account)).resolve(() => this.fetchCatalog(account));\n\t\t\tfor (const model of models ?? []) {\n\t\t\t\tif (model.ultrafastTier !== true || seen.has(model.id)) continue;\n\t\t\t\tseen.add(model.id);\n\t\t\t\tids.push(model.id);\n\t\t\t}\n\t\t} catch {}\n\t\treturn ids;\n\t}'
  );
  replace(
    '\t\tconst fast = this.options.speedFor !== void 0 && await this.options.speedFor(options.sessionId, options.model);\n\t\tconst body = codexRequestBody(options, toResponsesInput(messages, options.system), fast);',
    '\t\tconst speedTier = this.options.speedFor !== void 0 ? await this.options.speedFor(options.sessionId, options.model) : "standard";\n\t\tconst body = codexRequestBody(options, toResponsesInput(messages, options.system), speedTier);'
  );

  // 6. Wire speedFor, speed RPC, and providerSettings metadata to expose ultrafast.
  replace(
    '\t\t\t\tspeedFor: (sessionId, model) => sessionId !== void 0 && selectedSpeed(sessionId, model) === "fast" && adapter.supportsFastTier(model)',
    `\t\t\t\tspeedFor: async (sessionId, model) => {
					if (sessionId === void 0) return "standard";
					const wanted = selectedSpeed(sessionId, model);
					if (wanted === "ultrafast") {
						if (await adapter.supportsUltrafastTier(model)) return "ultrafast";
						if (await adapter.supportsFastTier(model)) return "fast";
						return "standard";
					}
					if (wanted === "fast" && await adapter.supportsFastTier(model)) return "fast";
					return "standard";
				}`
  );
  replace(
    `\tconst speed = {
		async speed(sessionId, model) {
			const fastModels = await codexAdapter?.fastCapableModels() ?? [];
			const accountPreferences = preferences.get("codex").accounts;
			for (const { key } of await codexTokens?.list() ?? []) {
				if (!accountPreferences || !Object.hasOwn(accountPreferences, key) || accountPreferences[key].independentEntry !== true) continue;
				for (const model$1 of [...fastModels]) {
					if (parseAccountModelId(model$1)) continue;
					if (await codexAdapter?.supportsFastTier(model$1, key)) fastModels.push(accountModelId(key, model$1));
				}
			}
			return {
				tier: model !== void 0 && !fastModels.includes(model) ? "standard" : selectedSpeed(sessionId, model),
				fastModels
			};
		},`,
    `\tconst speed = {
		async speed(sessionId, model) {
			const fastModels = await codexAdapter?.fastCapableModels() ?? [];
			const ultrafastModels = await codexAdapter?.ultrafastCapableModels() ?? [];
			const accountPreferences = preferences.get("codex").accounts;
			for (const { key } of await codexTokens?.list() ?? []) {
				if (!accountPreferences || !Object.hasOwn(accountPreferences, key) || accountPreferences[key].independentEntry !== true) continue;
				for (const model$1 of [...fastModels]) {
					if (parseAccountModelId(model$1)) continue;
					if (await codexAdapter?.supportsFastTier(model$1, key)) fastModels.push(accountModelId(key, model$1));
				}
				for (const model$1 of [...ultrafastModels]) {
					if (parseAccountModelId(model$1)) continue;
					if (await codexAdapter?.supportsUltrafastTier(model$1, key)) ultrafastModels.push(accountModelId(key, model$1));
				}
			}
			const chosen = selectedSpeed(sessionId, model);
			const tier = model === void 0 ? chosen
				: chosen === "ultrafast" ? (ultrafastModels.includes(model) ? "ultrafast" : fastModels.includes(model) ? "fast" : "standard")
				: chosen === "fast" ? (fastModels.includes(model) ? "fast" : "standard")
				: "standard";
			return {
				tier,
				fastModels,
				ultrafastModels
			};
		},`
  );
  replace(
    '\t\t\tconst fastModels = new Set(provider === "codex" ? await codexAdapter?.fastCapableModels() ?? [] : []);',
    '\t\t\tconst fastModels = new Set(provider === "codex" ? await codexAdapter?.fastCapableModels() ?? [] : []);\n\t\t\tconst ultrafastModels = new Set(provider === "codex" ? await codexAdapter?.ultrafastCapableModels() ?? [] : []);'
  );
  replace(
    '\t\t\t\t\t...provider === "codex" ? { fastTier: !tierIds.has(model.id) && fastModels.has(model.id) } : {},',
    '\t\t\t\t\t...provider === "codex" ? { fastTier: !tierIds.has(model.id) && fastModels.has(model.id), ultrafastTier: !tierIds.has(model.id) && ultrafastModels.has(model.id) } : {},'
  );

  // 7. Register Host-side /speed slash command so both Desktop and mobile DSH Go
  // can view and switch Codex speed tiers (standard / fast / ultrafast).
  replace(
    '\tif (codexTokens !== void 0) {\n\t\tconst tokens = codexTokens;',
    `\tif (codexTokens !== void 0) {
		ctx.inject(["commands"], (commandsCtx) => {
			const tierLabels = { standard: "标准 (standard)", fast: "快速 (fast)", ultrafast: "超快 (ultrafast)" };
			const parseTier = (input) => {
				const value = input.trim().toLowerCase();
				if (["standard", "std", "normal", "default", "标准"].includes(value)) return "standard";
				if (["fast", "priority", "快速", "快"].includes(value)) return "fast";
				if (["ultrafast", "ultra", "max", "超快", "极速"].includes(value)) return "ultrafast";
				return void 0;
			};
			commandsCtx.commands.register({
				name: "speed",
				description: "查看或切换 Codex 速度档（standard / fast / ultrafast）",
				input: { hint: "standard | fast | ultrafast" },
				async handler(invocation) {
					const current = invocation.agent.model.current();
					if (!current || current.provider !== "codex") {
						return { kind: "error", text: "当前会话不是 Codex 模型，/speed 仅适用于 Codex 模型。" };
					}
					const state = await speed.speed(invocation.agent.id, current.model);
					const available = [
						"standard",
						...state.fastModels.includes(current.model) ? ["fast"] : [],
						...(state.ultrafastModels ?? []).includes(current.model) ? ["ultrafast"] : [],
					];
					const raw = invocation.rawInput.trim();
					if (!raw) {
						return {
							kind: "success",
							text: \`当前模型 \${current.model} 速度档：\${tierLabels[state.tier] ?? state.tier}。支持：\${available.join(" / ")}。用法：/speed ultrafast\`,
						};
					}
					const target = parseTier(raw);
					if (target === void 0) {
						return { kind: "error", text: \`无法识别的速度档「\${raw}」。可选：\${available.join(" / ")}\` };
					}
					if (!available.includes(target)) {
						return { kind: "error", text: \`模型 \${current.model} 当前不支持 \${target} 档（支持：\${available.join(" / ")}）。\` };
					}
					await speed.setSpeed(invocation.agent.id, target, current.model);
					return {
						kind: "success",
						text: \`已将 \${current.model} 切换为「\${tierLabels[target]}」，后续消息立即生效。\`,
					};
				}
			});
		});
		const tokens = codexTokens;`
  );

  return host;
}

export function patchCodexUltrafastClient(client, replaceOnce) {
  const replace = (old, next) => { client = replaceOnce(client, old, next); };

  // 1. Add zh & en copy for ultrafast tier.
  replace(
    '\tspeedFast: "Fast",\n\tspeedFastDescription: "1.5x speed, more usage",\n\tcommandFast: "Switch the Codex speed tier (Standard/Fast)",',
    '\tspeedFast: "Fast",\n\tspeedFastDescription: "1.5x speed, more usage",\n\tspeedUltrafast: "Ultrafast",\n\tspeedUltrafastDescription: "Fastest available speed, highest usage",\n\tcommandFast: "Switch the Codex speed tier (Standard/Fast/Ultrafast)",'
  );
  replace(
    '\tspeedFast: "快速",\n\tspeedFastDescription: "约 1.5 倍速度，消耗更多用量",\n\tcommandFast: "切换 Codex 速度档（标准/快速）",',
    '\tspeedFast: "快速",\n\tspeedFastDescription: "约 1.5 倍速度，消耗更多用量",\n\tspeedUltrafast: "超快",\n\tspeedUltrafastDescription: "最高响应速度，消耗更多用量",\n\tcommandFast: "切换 Codex 速度档（标准/快速/超快）",'
  );

  // 2. Expose ultrafast in Provider Settings subagent speed dropdown.
  replace(
    'provider === "codex" && (model.fastTier || Object.hasOwn(draft.subagentSpeeds ?? {}, model.id)) && /* @__PURE__ */',
    'provider === "codex" && (model.fastTier || model.ultrafastTier || Object.hasOwn(draft.subagentSpeeds ?? {}, model.id)) && /* @__PURE__ */'
  );
  replace(
    `\t\t\t\t\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "standard",
													children: t("speedStandard")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: "fast",
													disabled: !model.fastTier,
													children: [t("speedFast"), !model.fastTier && \` (\${t("modelsUnavailable")})\`]
												})]`,
    `\t\t\t\t\t\t\t\t\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "standard",
													children: t("speedStandard")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: "fast",
													disabled: !model.fastTier,
													children: [t("speedFast"), !model.fastTier && \` (\${t("modelsUnavailable")})\`]
												}), (model.ultrafastTier || draft.subagentSpeeds?.[model.id] === "ultrafast") && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: "ultrafast",
													disabled: !model.ultrafastTier,
													children: [t("speedUltrafast"), !model.ultrafastTier && \` (\${t("modelsUnavailable")})\`]
												})]`
  );

  // 3. Support dynamic tiers (including ultrafast) in createSpeedLoader, SpeedSelect, and /fast.
  replace(
    `\t\tconst visible = current !== null && current.provider === "codex" && state.fastModels.includes(current.model);
		const latest = (await directory?.load())?.current ?? null;
		if (latest?.provider !== current?.provider || latest?.model !== current?.model) throw new Error("Model changed while loading speed");
		return {
			visible,
			tier: state.tier,
			...visible && current ? { model: current.model } : {}
		};`,
    `\t\tconst fastSupported = current !== null && current.provider === "codex" && (state.fastModels ?? []).includes(current.model);
		const ultrafastSupported = current !== null && current.provider === "codex" && (state.ultrafastModels ?? []).includes(current.model);
		const visible = fastSupported || ultrafastSupported;
		const tiers = ["standard", ...fastSupported ? ["fast"] : [], ...ultrafastSupported ? ["ultrafast"] : []];
		const latest = (await directory?.load())?.current ?? null;
		if (latest?.provider !== current?.provider || latest?.model !== current?.model) throw new Error("Model changed while loading speed");
		return {
			visible,
			tier: state.tier,
			tiers,
			...visible && current ? { model: current.model } : {}
		};`
  );
  replace(
    '\tconst tierName = (tier) => translate(tier === "fast" ? "speedFast" : "speedStandard");\n\tconst tierDescription = (tier) => translate(tier === "fast" ? "speedFastDescription" : "speedStandardDescription");',
    '\tconst tierName = (tier) => translate(tier === "ultrafast" ? "speedUltrafast" : tier === "fast" ? "speedFast" : "speedStandard");\n\tconst tierDescription = (tier) => translate(tier === "ultrafast" ? "speedUltrafastDescription" : tier === "fast" ? "speedFastDescription" : "speedStandardDescription");'
  );
  replace(
    '\t\t\t\tchildren: TIERS.map((tier) => /* @__PURE__ */',
    '\t\t\t\tchildren: (state.tiers ?? TIERS).map((tier) => /* @__PURE__ */'
  );
  replace(
    `\t\t\t\t\treturn [{
						id: "standard",
						label: t("speedStandard"),
						detail: t("speedStandardDescription")
					}, {
						id: "fast",
						label: t("speedFast"),
						detail: t("speedFastDescription")
					}].map((option) => ({
						...option,
						active: option.id === state.tier
					}));`,
    `\t\t\t\t\tconst labelFor = (id) => id === "ultrafast" ? [t("speedUltrafast"), t("speedUltrafastDescription")]
						: id === "fast" ? [t("speedFast"), t("speedFastDescription")]
						: [t("speedStandard"), t("speedStandardDescription")];
					return (state.tiers ?? ["standard", "fast"]).map((id) => {
						const [label, detail] = labelFor(id);
						return { id, label, detail, active: id === state.tier };
					});`
  );

  return client;
}
