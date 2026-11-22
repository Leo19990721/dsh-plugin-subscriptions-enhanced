import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve, win32 } from 'node:path';
import { AgyAcpClient } from './agy-acp-client.js';
import { agyWindowsEnv, discoverAgyExecutable, isLocalAgyPath, sameAgyPath, verifiedAgyExecutable } from './agy-launch.js';
import { LOCAL_FRAME_BYTES } from './agy-local-context.js';
import { agyProxyEnv, agyProxySnapshot } from './agy-local-proxy.js';
import { dshHomePath, inventoryAgyWorkspace, readAgyRules, retireAgyLegacyBrowserCaches, syncAgySkills } from './agy-local-storage.js';
import { isAgySessionId } from './agy-session.js';
import { createAgyTurnSession } from './agy-turn-session.js';

const settingsFor = (mode, hostFileReview = false) => {
  const restricted = mode === 'workspace-write' || mode === 'read-only';
  // With a DSH permission handler, permit requests (not access) for external
  // paths. Explicit Ask rules take precedence over the CLI workspace/preset
  // defaults, so the Host must check the exact paths before each approval.
  const ask = [...(hostFileReview ? ['read_file(*)'] : []), ...(mode === 'workspace-write' ? ['write_file(*)'] : [])];
  return {
    useG1Credits: false,
    agentMode: '', // Override agy's default Auto mode; DSH owns the requested tool policy.
    toolPermission: mode === 'full' ? 'always-proceed' : 'request-review',
    allowNonWorkspaceAccess: !restricted || hostFileReview,
    enableTerminalSandbox: restricted,
    // The CLI terminal sandbox is not the DSH Windows ACL sandbox. Native
    // commands remain denied; the DSH loopback bridge has its own tool policy.
    ...(restricted ? { permissions: {
      deny: ['command(*)', 'unsandboxed(*)', 'execute_url(*)', ...(mode === 'read-only' ? ['write_file(*)'] : [])],
      allow: ['mcp(dsh/*)'],
      ...(ask.length ? { ask } : {}),
    } } : {}),
  };
};
// Keep the user's normal Windows paths/profile without copying provider credentials from the Host environment.
const quotaUserKeys = new Set([
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL',
]);
const runPrint = promisify(execFile);
const quotaLabel = /^[\p{L}\p{N} .(),&+/_-]{1,100}$/u;
const resetTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const rowsOf = output => output.split(/\r?\n/u).map(line => line.trim().split('\t').map(cell => cell.trim()));

export function parseAgyQuota(usage, balance, fetchedAt = new Date().toISOString()) {
  const windows = [];
  const seen = new Set();
  for (const row of rowsOf(usage)) {
    const [group, label, percent, resetAt] = row;
    if (row.length !== 4 || !quotaLabel.test(group) || !quotaLabel.test(label)
      || !/^\d{1,3}(?:\.\d+)?%$/u.test(percent) || !resetTime.test(resetAt) || !Number.isFinite(Date.parse(resetAt))) continue;
    const remainingPercent = Number(percent.slice(0, -1));
    const key = `${group}\t${label}`;
    if (remainingPercent > 100 || seen.has(key)) continue;
    seen.add(key);
    windows.push({ group, label, remainingPercent, resetAt });
    if (windows.length === 64) break;
  }
  const rows = rowsOf(balance);
  const remaining = rows.find(row => row.length === 2 && row[0] === 'Remaining credits' && /^\d+(?:\.\d+)?$/u.test(row[1]))?.[1];
  if (!windows.length || remaining === undefined || !Number.isFinite(Number(remaining))) throw fault('quota-output-invalid');
  const upgradeUrl = 'https://antigravity.google/g1-upgrade';
  return { windows, credits: { remaining: Number(remaining),
    ...(rows.some(row => row.length === 2 && row[0] === 'Upgrade' && row[1] === upgradeUrl) ? { upgradeUrl } : {}) }, fetchedAt };
}
const missing = error => error?.code === 'ENOENT';
const stateKey = id => createHash('sha256').update(id).digest('hex');
const bindingIsValid = row => isAgySessionId(row?.officialId) && isLocalAgyPath(row.cwd)
  && Number.isSafeInteger(row.createdAt) && Number.isSafeInteger(row.throughTurn) && row.throughTurn >= 0;
const fault = code => Object.assign(new Error(`Antigravity: ${code}`), { code });

async function actualDirectory(cwd) {
  try {
    if (isLocalAgyPath(cwd)) {
      const canonical = await realpath(cwd);
      if (isLocalAgyPath(canonical) && (await stat(canonical)).isDirectory()) return canonical;
    }
  } catch { /* report a stable error instead of a host path */ }
  throw fault('workspace-unavailable');
}

/** Each DSH conversation owns a stable CLI home, separate from the standalone agy settings. */
export function createLocalAgy({ executable, proxy, dataDir, agentsFile } = {}, {
  verify = verifiedAgyExecutable, makeTransport = options => new AgyAcpClient(options), resolveProxy = agyProxyEnv,
  printQuota = runPrint, parentEnv = process.env,
} = {}) {
  const inherited = key => {
    const name = Object.keys(parentEnv).find(name => name.toUpperCase() === key);
    return name === undefined ? undefined : parentEnv[name];
  };
  const localAppData = inherited('LOCALAPPDATA');
  const resolveBinary = () => executable ? verify(executable) : discoverAgyExecutable(undefined, parentEnv, verify);
  const stateDir = dataDir ?? dshHomePath(parentEnv, 'plugin-data', 'subscriptions-enhanced', 'agy');
  const skillsSource = dshHomePath(parentEnv, 'skills');
  const sessions = new Set();
  const skillRefresh = new Map();
  let disposed = false;

  const directory = id => {
    if (!isLocalAgyPath(stateDir)) throw fault('invalid-data-dir');
    return join(stateDir, id === undefined ? 'catalog' : stateKey(id));
  };

  const contextCwd = (requested, canonical) => sameAgyPath(resolve(requested), canonical) ? canonical : undefined;

  async function workspaceInventory(cwd, signal) {
    try { return await inventoryAgyWorkspace({ cwd, agentsFile, globalSkills: skillsSource, signal }); }
    catch { signal?.throwIfAborted(); throw fault('skill-sync-failed'); }
  }

  async function resolveProxySnapshot(signal) {
    signal?.throwIfAborted();
    if (disposed) throw fault('closed');
    const snapshot = agyProxySnapshot(await resolveProxy(proxy, parentEnv));
    signal?.throwIfAborted();
    if (disposed) throw fault('closed');
    return snapshot;
  }

  async function proxyFingerprint(signal) {
    return (await resolveProxySnapshot(signal)).fingerprint;
  }

  async function workspaceFingerprint(cwd, signal) {
    signal?.throwIfAborted();
    if (disposed) throw fault('closed');
    const canonical = await actualDirectory(cwd);
    return (await workspaceInventory(contextCwd(cwd, canonical), signal)).fingerprint;
  }

  function materializeWorkspace(settingsDir, cwd, signal) {
    const pending = (skillRefresh.get(settingsDir) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const inventory = await workspaceInventory(cwd, signal);
      try {
        const rules = await readAgyRules(inventory);
        await syncAgySkills(inventory, settingsDir, signal);
        return { rules, fingerprint: inventory.fingerprint };
      } catch { signal.throwIfAborted(); throw fault('skill-sync-failed'); }
    }).finally(() => { if (skillRefresh.get(settingsDir) === pending) skillRefresh.delete(settingsDir); });
    skillRefresh.set(settingsDir, pending);
    return pending;
  }

  function childEnv(areas, proxies) {
    const env = { ...agyWindowsEnv(areas, parentEnv), ...proxies, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
    const path = inherited('PATH');
    if (path) env.PATH += delimiter + path;
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
      const value = inherited(key.toUpperCase());
      if (value) env[key] = value;
    }
    return env;
  }

  async function readBinding(id) {
    try {
      const row = JSON.parse(await readFile(join(directory(id), 'binding.json'), 'utf8'));
      return bindingIsValid(row) ? row : undefined;
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
  }

  async function writeBinding(id, row) {
    if (!bindingIsValid(row)) throw fault('invalid-binding');
    const dir = directory(id);
    const file = join(dir, 'binding.json');
    const temporary = join(dir, `binding-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(row) + '\n', { flag: 'wx' });
    await rename(temporary, file);
  }

  async function open(signal, { id, cwd: requestedCwd, mode = 'read-only', officialId, mcpServers = [], onPermission, persona } = {}) {
    if (disposed) throw fault('closed');
    signal.throwIfAborted();
    const binary = await resolveBinary();
    signal.throwIfAborted();
    if (disposed) throw fault('closed');
    const root = directory(id);
    const catalog = id === undefined;
    if (!catalog && !['full', 'review', 'workspace-write', 'read-only'].includes(mode)) throw fault('invalid-policy');
    const areas = Object.fromEntries(['home', 'local', 'roaming', 'scratch'].map(name => [name, join(root, name)]));
    const geminiDir = join(areas.home, '.gemini');
    const settingsDir = join(geminiDir, 'antigravity-cli');
    const isolatedWork = join(root, 'workspace');
    await Promise.all([...Object.values(areas), settingsDir, ...(catalog ? [isolatedWork] : [])].map(dir => mkdir(dir, { recursive: true })));
    const [cwd, proxySnapshot] = await Promise.all([actualDirectory(catalog ? isolatedWork : requestedCwd), resolveProxySnapshot(signal)]);
    const workspace = catalog ? undefined : await materializeWorkspace(settingsDir, contextCwd(requestedCwd, cwd), signal);
    await Promise.all([
      writeFile(join(settingsDir, 'settings.json'), JSON.stringify(settingsFor(mode, !catalog && typeof onPermission === 'function'))),
      writeFile(join(geminiDir, 'GEMINI.md'), [...(workspace?.rules ?? []), !catalog && persona].filter(Boolean).join('\n\n')),
    ]);
    const env = childEnv(areas, proxySnapshot.env);
    signal.throwIfAborted();
    if (disposed) throw fault('closed');

    const session = createAgyTurnSession({ cwd, mcpServers, onPermission, captureHistory: false,
      ignoreUnchangedConfigNotices: true, ...(catalog ? { configTimeoutMs: 2_000 } : {}), makeClient(hooks) {
      const transport = makeTransport({ ...hooks, executable: binary, cwd, env, timeoutMs: 25_000,
        permissionMode: mode === 'full' || mode === 'review' ? mode : 'sandbox', allowMcpServers: mcpServers.length > 0,
        maxFrameBytes: LOCAL_FRAME_BYTES,
      });
      return {
        async start() {
          const result = await transport.start();
          signal.throwIfAborted();
          return result;
        },
        request: (...args) => transport.request(...args), notify: (...args) => transport.notify(...args), close: () => transport.close(),
      };
    } });
    let closing;
    const close = () => closing ??= session.close().finally(() => sessions.delete(close));
    sessions.add(close);
    try {
      await session.open(officialId);
      signal.throwIfAborted();
      if (disposed || closing) throw fault('closed');
      if (!session.options) throw fault('catalog-unavailable');
      return { id: session.id, get options() { return session.options; }, get capabilities() { return session.capabilities; },
        workspaceFingerprint: workspace?.fingerprint, proxyFingerprint: proxySnapshot.fingerprint,
        prepare: session.prepare, runTurn: session.runTurn, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function runAuthAction(signal, action) {
    if (disposed) throw fault('closed');
    signal.throwIfAborted();
    const binary = await resolveBinary();
    signal.throwIfAborted();
    if (disposed) throw fault('closed');
    const root = directory(undefined);
    const areas = Object.fromEntries(['home', 'local', 'roaming', 'scratch'].map(name => [name, join(root, name)]));
    const geminiDir = join(areas.home, '.gemini');
    const settingsDir = join(geminiDir, 'antigravity-cli');
    const isolatedWork = join(root, 'workspace');
    await Promise.all([...Object.values(areas), settingsDir, isolatedWork].map(dir => mkdir(dir, { recursive: true })));
    const [cwd, { env: proxies }] = await Promise.all([actualDirectory(isolatedWork), resolveProxySnapshot(signal)]);
    await writeFile(join(settingsDir, 'settings.json'), JSON.stringify(settingsFor('read-only')));
    // Login launches the system browser. Give only this child the real LOCALAPPDATA;
    // the CLI's home/settings, roaming and scratch directories remain private.
    const env = childEnv(action === 'login' ? { ...areas, local: localAppData } : areas, proxies);
    signal.throwIfAborted();
    if (disposed) throw fault('closed');

    const transport = makeTransport({
      executable: binary, cwd, env, timeoutMs: 25_000,
      permissionMode: 'sandbox', allowAuthentication: true, allowMcpServers: false,
      maxFrameBytes: LOCAL_FRAME_BYTES,
    });
    let closing;
    const close = () => closing ??= transport.close().finally(() => sessions.delete(close));
    sessions.add(close);
    const onAbort = () => { void close(); };
    signal.addEventListener('abort', onAbort, { once: true });
    let reaped = false;
    try {
      await transport.start();
      signal.throwIfAborted();
      if (action === 'login') await transport.authenticate('oauth-personal');
      else if (action === 'logout') await transport.logout();
      else throw fault('invalid-auth-action');
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', onAbort);
      reaped = await close().then(() => true, () => false);
    }
    if (action === 'login' && reaped && !signal.aborted && !disposed) {
      await retireAgyLegacyBrowserCaches(parentEnv, localAppData, stateDir);
    }
  }

  async function fetchQuota(signal) {
    if (disposed) throw fault('closed');
    signal?.throwIfAborted();
    const binary = await resolveBinary();
    signal?.throwIfAborted();
    const { env: proxies } = await resolveProxySnapshot(signal);
    const env = Object.fromEntries(Object.keys(parentEnv).filter(key => quotaUserKeys.has(key.toUpperCase()))
      .map(key => [key.toUpperCase(), parentEnv[key]]));
    Object.assign(env, proxies, { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    const system = env.SYSTEMROOT ?? env.WINDIR;
    const cwd = env.USERPROFILE ?? env.HOME;
    if (!system || !win32.isAbsolute(system) || !cwd || !win32.isAbsolute(cwd)) throw fault('invalid-environment');
    signal?.throwIfAborted();
    if (disposed) throw fault('closed');

    const cancel = new AbortController();
    const options = { cwd, env, windowsHide: true, shell: false, timeout: 20_000, maxBuffer: 128 * 1024,
      encoding: 'utf8', signal: signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal };
    const query = command => printQuota(binary, ['--print', command, '--print-timeout', '15s'], options);
    try {
      const [usage, balance] = await Promise.all([query('/usage'), query('/credits')]);
      return parseAgyQuota(usage.stdout, balance.stdout);
    } catch { throw fault('quota-query-failed'); }
    finally { cancel.abort(); }
  }

  const authenticate = signal => runAuthAction(signal, 'login');
  const logout = signal => runAuthAction(signal, 'logout');
  const historyArchivePath = id => id === undefined ? undefined : join(directory(id), 'dsh-history-archive.md');

  return Object.freeze({ open, workspaceFingerprint, proxyFingerprint, readBinding, writeBinding, historyArchivePath, authenticate, logout, fetchQuota, async dispose() {
    disposed = true;
    await Promise.allSettled([...sessions].map(close => close()));
  } });
}
