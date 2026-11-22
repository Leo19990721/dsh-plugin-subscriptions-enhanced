/** Explicit, isolated Web trial; the parent validates paths and prepares the dedicated CLI HOME. */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { AgyAcpClient, AgyAcpErrorCode } from './agy-acp-client.js';
import { AGY_WINDOWS_X64, agyWindowsEnv, isLocalAgyPath, sameAgyPath, verifiedAgyExecutable } from './agy-launch.js';
import { assertAgyNativeTurnHost, mountAgyNativeTurnHost } from './agy-native-turn-host.js';
import { openAgyTurnLedger } from './agy-turn-ledger.js';
import { createAgyTurnSession } from './agy-turn-session.js';
import { createTrialAuthentication, trialAuthRoute } from './agy-native-trial.auth.mjs';

const provider = 'trial-idle';
const model = 'select-antigravity';
const modelName = '请在模型菜单选择 Antigravity';
const safeCodes = new Set([
  'invalid-config', 'unsafe-host', 'workspace-mismatch', 'catalog-unavailable', 'cleanup-unconfirmed',
  'unsupported-cli', 'unverified-cli', 'missing-cli', 'invalid-environment', 'cli-version-unavailable',
  'invalid-session', 'config-unconfirmed', 'closed', 'host-unavailable', 'ready-unavailable', 'native-turn-required',
  ...Object.values(AgyAcpErrorCode).filter(code => typeof code === 'string'),
]);
const failure = code => Object.assign(new Error(`Antigravity trial: ${code}`), { code });
const safeCode = error => safeCodes.has(error?.code) ? error.code : 'host-unavailable';
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const encloses = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

class IdleTrialAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: 'Antigravity 试跑入口' }; }
  listModels(id) { return Promise.resolve([{ provider: id, id: model, name: modelName }]); }
  async *stream() {
    throw new LlmError('请先在当前会话的模型菜单选择 Antigravity，再发送消息。', 'MODEL_UNSUPPORTED');
  }
}

// Only fixed startup markers enter the launcher; no configuration, URL, or official response is logged.
const milestone = label => { if (process.env.DSH_AGY_TRIAL_STARTUP === '1') process.stderr.write(`agy-trial:${label}\n`); };
milestone('import');
export const name = 'antigravity-native-trial';
export const inject = ['agentLoop', 'agents', 'appExit', 'appReady', 'connection', 'llm', 'sessionController',
  'sessionPersistence', 'sessions', 'storageDomain', 'webServer', 'workspaceRegistry', 'workingDirectory'];

/**
 * Mount only on the user's explicitly launched trial Web profile. No prompt or model selection is sent.
 * The parent verifies ordinary, non-reparse paths; HOME alone does not isolate Windows Credential Manager.
 * @param {object} ctx - Trial plugin context.
 * @param {object} config - Exact { root, workspace, executable, cliAreas: { home, local, roaming, scratch } }.
 * @returns {Promise<void>} Resolves after preparation or a sanitized stop request.
 */
export async function apply(ctx, config) {
  milestone('apply');
  // Without a trusted absolute root there is no permitted destination for a status file.
  if (!isLocalAgyPath(config?.root)) throw failure('invalid-config');
  const { root } = config;
  const ready = path.join(root, 'ready.json');
  let released = false;
  let exitRequested = false;
  let timer;
  let ledger;
  let nativeHost;
  let auth;
  let unregisterIdle;
  let unregisterReady;
  const sessions = new Set();

  const exit = () => {
    if (released || exitRequested) return;
    exitRequested = true;
    ctx.appExit(0);
  };
  const writeStatus = status => writeFileSync(ready, `${JSON.stringify(status)}\n`, { flag: 'wx' });
  const unavailable = code => {
    // A stale or unwritable handoff is never replaced, and its error contains no diagnostic output.
    try { writeStatus({ status: 'unavailable', code: safeCodes.has(code) ? code : 'host-unavailable' }); }
    catch (_error) { /* The parent owns the handoff path and observes the clean process exit. */ }
    exit();
  };

  ctx.effect(() => async () => {
    released = true;
    clearInterval(timer);
    let failed = false;
    for (const dispose of [auth && (() => auth.dispose()), unregisterReady, unregisterIdle, nativeHost && (() => nativeHost.dispose())]) {
      try { await dispose?.(); }
      catch (_error) { failed = true; }
    }
    for (const session of sessions) {
      try { await session.close(); }
      catch (_error) { failed = true; }
    }
    sessions.clear();
    try { await ledger?.close(); }
    catch (_error) { failed = true; }
    // Preserve the dedicated HOME, official account data and all DSH/CLI sessions.
    if (failed) throw failure('cleanup-unconfirmed');
  }, 'Antigravity trial resources');

  try {
    if (!exactKeys(config, ['root', 'workspace', 'executable', 'cliAreas'])
      || !exactKeys(config.cliAreas, ['home', 'local', 'roaming', 'scratch'])
      || ![config.workspace, config.executable, ...Object.values(config.cliAreas)].every(isLocalAgyPath)) {
      throw failure('invalid-config');
    }
    const { workspace, executable, cliAreas } = config;
    if (ctx.webServer.host !== '127.0.0.1' || ctx.connection.allowsRemoteAuthorities !== false
      || !isLocalAgyPath(process.env.DSH_HOME) || !encloses(root, process.env.DSH_HOME)) {
      throw failure('unsafe-host');
    }
    if (AGY_WINDOWS_X64.version !== '1.5.12') throw failure('cli-version-unavailable');
    const env = Object.freeze({ ...agyWindowsEnv(cliAreas), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });

    function live(signal) {
      if (released || exitRequested || signal?.aborted) throw failure('closed');
      if (ctx.webServer.host !== '127.0.0.1' || ctx.connection.allowsRemoteAuthorities !== false) throw failure('unsafe-host');
    }
    async function verify(signal) {
      live(signal);
      const verified = await verifiedAgyExecutable(executable);
      live(signal);
      return verified;
    }
    async function makeSession({ cwd }, signal) {
      if (!isLocalAgyPath(cwd) || !sameAgyPath(cwd, workspace)) throw failure('workspace-mismatch');
      const verified = await verify(signal);
      live(signal);
      const session = createAgyTurnSession({
        cwd: workspace, timeLimits: { open: 20_000, turn: 20 * 60_000, cancel: 8_000 },
        makeClient: hooks => new AgyAcpClient({ ...hooks, executable: verified, cwd: workspace, env, timeoutMs: 20_000, allowAuthentication: false }),
      });
      // request_permission stays deny-only in createAgyTurnSession. CLI strict/deny settings are parent-owned.
      let closing;
      const tracked = Object.freeze({
        get id() { return session.id; },
        get options() { return session.options; },
        open: (...args) => session.open(...args),
        prepare: (...args) => session.prepare(...args),
        runTurn: (...args) => session.runTurn(...args),
        close() {
          return closing ??= session.close().then(() => { sessions.delete(tracked); });
        },
      });
      sessions.add(tracked);
      return tracked;
    }

    const stop = path.join(root, 'stop');
    timer = setInterval(() => {
      if (existsSync(stop)) exit();
    }, 150);
    if (existsSync(stop)) { exit(); return; }
    assertAgyNativeTurnHost(ctx);

    async function connect(signal) {
      let probe, openedLedger, mounted, options;
      let mounting = false;
      const abortProbe = () => { void probe.close().catch(() => {}); }; // finally awaits the same close result.
      try {
        live(signal);
        if (nativeHost) throw failure('catalog-unavailable');
        try {
          probe = await makeSession({ cwd: workspace }, signal);
          live(signal);
          signal.addEventListener('abort', abortProbe, { once: true });
          await probe.open(); // Only after explicit authentication: one empty session supplies the official catalog.
          live(signal);
          options = probe.options;
          if (!options?.model?.options.length) throw failure('catalog-unavailable');
        } finally {
          signal.removeEventListener('abort', abortProbe);
          try { await probe?.close(); }
          catch (_error) { throw failure('cleanup-unconfirmed'); }
        }
        live(signal);
        openedLedger = await openAgyTurnLedger(ctx.storageDomain);
        live(signal);
        mounting = true;
        mounted = mountAgyNativeTurnHost(ctx, {
          options, defaultEffort: options.thoughtLevel?.currentValue, ledger: openedLedger, makeSession,
          blockedPaths: [cliAreas.home, cliAreas.local, cliAreas.roaming, cliAreas.scratch, path.dirname(executable)],
        });
        live(signal);
        nativeHost = mounted;
        ledger = openedLedger;
      } catch (error) {
        // A throwing mount may have installed individual Cordis effects. Tear down their owner before any retry.
        let uncertain = mounting && !mounted;
        try { await mounted?.dispose(); } catch (_error) { uncertain = true; }
        try { await openedLedger?.close(); } catch (_error) { uncertain = true; }
        if (uncertain) { exit(); throw failure('cleanup-unconfirmed'); }
        const code = error?.code === AgyAcpErrorCode.AUTH_REQUIRED ? 'auth-required' : safeCode(error);
        throw failure(code);
      }
    }
    auth = createTrialAuthentication({
      async makeClient({ allowAuthentication }) {
        const verified = await verify();
        live();
        return new AgyAcpClient({ executable: verified, cwd: workspace, env, timeoutMs: 20_000, allowAuthentication });
      }, connect,
    });
    milestone('inspect');
    await auth.inspect(); // Only initialize. A signed-out browser can open Settings without creating an official session.
    milestone('inspected');
    if (released || exitRequested) return;
    ctx.effect(() => ctx.webServer.register(trialAuthRoute(ctx, auth)), 'Antigravity trial sign-in');
    unregisterIdle = ctx.llm.registerAdapter([provider], new IdleTrialAdapter());
    milestone('workspace');
    await ctx.workspaceRegistry.create(workspace);
    if (released || exitRequested) return;
    milestone('waiting-ready');
    unregisterReady = ctx.appReady.onReady(() => {
      milestone('ready');
      if (released || exitRequested) return;
      try {
        const port = ctx.webServer.port;
        if (ctx.webServer.host !== '127.0.0.1' || ctx.connection.allowsRemoteAuthorities !== false
          || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw failure('unsafe-host');
        const base = `http://127.0.0.1:${port}`;
        // Only this exclusive local handoff stores the launch URL. Never log it or expose an observation route.
        writeStatus({ status: 'ready', base, launchUrl: ctx.connection.authenticatedUrl(base) });
      } catch (_error) { unavailable('ready-unavailable'); }
    });
  } catch (error) { unavailable(safeCode(error)); }
}
