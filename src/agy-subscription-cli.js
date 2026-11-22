import { addAbortListener } from 'node:events';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isPromise } from 'node:util/types';
import { AgyAcpClient, AgyAcpError } from './agy-acp-client.js';
import { AGY_WINDOWS_X64, AgyLaunchError, agyWindowsEnv, isLocalAgyPath, sameAgyPath, verifiedAgyExecutable } from './agy-launch.js';
import { createAgyTurnSession } from './agy-turn-session.js';

const OWNER = '.subscriptions-agy-v1';
const OWNER_BYTES = 'dsh-subscriptions-agy-runtime/1\n';
const DENY = Object.freeze(['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)']);
const SETTINGS = { agentMode: '', toolPermission: 'strict', allowNonWorkspaceAccess: false,
  enableTerminalSandbox: true, useG1Credits: false, permissions: { allow: [], ask: [], deny: DENY } };
const SETTINGS_BYTES = `${JSON.stringify(SETTINGS)}\n`;
const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const noop = () => {};
const fail = code => Object.assign(new Error(`Antigravity runtime: ${code}`), { code });
const gateErrors = new WeakSet();
const fileReasons = ['work-identity', 'storage-identity', 'work-changed', 'workspace-discovery', 'unexpected-config',
  'settings-missing', 'settings-read'];
const policyReasons = [...fileReasons, 'settings-parse', 'settings-normalization', 'settings-shape', 'settings-mode', 'settings-permissions'];
const gateReasons = new Map([
  ['initial', [...fileReasons, 'root-policy', 'root-ownership', 'storage-prepare', 'settings-seed']],
  ['after-initialize', policyReasons], ['after-session-new', policyReasons], ['before-prompt', policyReasons],
  ['cleanup', ['storage-identity', 'storage-remove', 'process-unconfirmed', 'cleanup-failed']],
]);
const discoverySlots = {
  home: [['.agents', 'home-agents'], ['.agent', 'home-legacy-agent'], ['.gemini-cli', 'home-gemini-cli']],
  gemini: [['config', 'gemini-config'], ['AGENTS.md', 'gemini-agents-md'], ['GEMINI.md', 'gemini-gemini-md'], ['skills', 'gemini-skills']],
  cli: [['agents', 'cli-agents'], ['mcp_config.json', 'cli-mcp'], ['plugins', 'cli-plugins'], ['rules', 'cli-rules'],
    ['skills', 'cli-skills'], ['hooks.json', 'cli-hooks']],
};
const discoveryLeaves = new Set(Object.values(discoverySlots).flatMap(slots => slots.map(([, leaf]) => leaf)));
const discoveryKinds = new Set(['file', 'link', 'other', 'unreadable', 'directory-unverified', 'empty-directory', 'nonempty-directory']);

// Only local, fixed labels may cross this boundary. Never attach the underlying
// error, file path, configuration key/value, or any data from the ACP peer.
class RuntimeGateError extends Error {
  constructor(phase, reason, leaf, kind) {
    const code = phase === 'cleanup' ? 'cleanup-unconfirmed' : 'unsafe-storage';
    super(`Antigravity runtime: ${code}`);
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
    if (gateReasons.get(phase)?.includes(reason)) {
      const diagnostic = reason === 'unexpected-config' && discoveryLeaves.has(leaf) && discoveryKinds.has(kind)
        ? { phase, reason, leaf, kind } : { phase, reason };
      Object.defineProperty(this, 'diagnostic', { value: Object.freeze(diagnostic), enumerable: true });
    }
    gateErrors.add(Object.freeze(this));
  }
}

async function storageCheck(phase, reason, check) {
  try { return await check(); }
  catch { throw new RuntimeGateError(phase, reason); }
}

const absent = error => error?.code === 'ENOENT';
const entriesOnly = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object)
  && Reflect.ownKeys(object).every(key => keys.includes(key));
const contains = (dir, target) => {
  const relative = path.relative(dir, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

function aborted(signal) {
  if (signal === undefined) return false;
  try { return readAborted.call(signal); }
  catch { throw fail('invalid-options'); }
}

const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
async function directory(dir, expected) {
  const info = await lstat(dir, { bigint: true });
  if (!info.isDirectory() || (expected && !sameEntry(info, expected)) || !sameAgyPath(dir, await realpath(dir))) {
    throw fail('unsafe-storage');
  }
  return info;
}

async function absentPath(file) {
  try { await lstat(file); }
  catch (error) { if (absent(error)) return; throw error; }
  throw fail('unsafe-storage');
}

async function allowNames(dir, names = []) {
  const handle = await opendir(dir);
  try {
    for (let item; (item = await handle.read());) {
      if (!names.includes(item.name)) throw fail('unsafe-storage');
    }
  } finally { await handle.close(); }
}

// Classification is diagnostic only. Check canonical identity before opening,
// then recheck before reading a single entry, whose name is never inspected.
async function classifyDiscovery(dir, expectedDir, file, info) {
  if (info.isSymbolicLink()) return 'link';
  if (info.isFile()) return 'file';
  if (!info.isDirectory()) return 'other';
  const verify = async () => {
    await directory(dir, expectedDir);
    await directory(file, info);
  };
  try {
    await verify();
    const handle = await opendir(file, { bufferSize: 1 });
    try {
      await verify();
      return (await handle.read()) === null ? 'empty-directory' : 'nonempty-directory';
    } finally { await handle.close(); }
  } catch { return 'directory-unverified'; }
}

async function checkDiscovery(phase, dir, expectedDir, name, leaf) {
  const file = path.join(dir, name);
  let info;
  try { info = await lstat(file, { bigint: true }); }
  catch (error) {
    if (absent(error)) return;
    throw new RuntimeGateError(phase, 'unexpected-config', leaf, 'unreadable');
  }
  throw new RuntimeGateError(phase, 'unexpected-config', leaf, await classifyDiscovery(dir, expectedDir, file, info));
}

// Metadata first, then a bounded read from the same regular, single-link file.
async function readOwnedText(file, limit) {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(limit) || !sameAgyPath(file, await realpath(file))) {
    throw fail('unsafe-storage');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n || !sameEntry(info, current)) throw fail('unsafe-storage');
    const bytes = Buffer.alloc(limit + 1);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read !== Number(info.size) || read > limit) throw fail('unsafe-storage');
    return bytes.toString('utf8', 0, read);
  } finally { await handle.close(); }
}

async function createStorage(root, lease, guard) {
  // Google searches parent directories when a workspace is inside a Git repo.
  // Refuse that layout, including worktrees with a .git file.
  const ancestry = [];
  for (let dir = path.dirname(root);;) {
    ancestry.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const dir of ancestry.reverse()) {
    guard();
    await storageCheck('initial', 'storage-identity', () => directory(dir));
    await storageCheck('initial', 'workspace-discovery', () => absentPath(path.join(dir, '.git')));
  }
  guard();
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const rootInfo = await storageCheck('initial', 'storage-identity', () => directory(root));
  const owner = path.join(root, OWNER);
  await storageCheck('initial', 'root-ownership', async () => {
    try { await lstat(owner); }
    catch (error) {
      if (!absent(error)) throw error;
      await allowNames(root);
      await writeFile(owner, OWNER_BYTES, { flag: 'wx', mode: 0o600 });
    }
    if (await readOwnedText(owner, OWNER_BYTES.length) !== OWNER_BYTES) throw fail('unsafe-storage');
  });
  await storageCheck('initial', 'workspace-discovery', () => absentPath(path.join(root, '.git')));
  guard();

  const lock = path.join(root, 'active');
  await storageCheck('initial', 'root-ownership', () => allowNames(root, [OWNER, 'active']));
  guard();
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') throw fail('cli-busy'); throw error; }
  // Record every created identity before writing beneath it. If identity or
  // reaping cannot be confirmed, keep the lock in place and report the failure.
  Object.assign(lease, { root, rootInfo, lock });
  lease.lockInfo = await directory(lock);
  lease.run = await mkdtemp(path.join(lock, 'run-'));
  lease.runInfo = await directory(lease.run);
  const areas = Object.fromEntries(['home', 'local', 'roaming', 'scratch', 'work'].map(key => [key, path.join(lease.run, key)]));
  const gemini = path.join(areas.home, '.gemini');
  const settingsDir = path.join(gemini, 'antigravity-cli');
  const directories = new Map([[root, rootInfo], [lock, lease.lockInfo], [lease.run, lease.runInfo]]);
  for (const dir of [...Object.values(areas), gemini, settingsDir]) {
    guard();
    await mkdir(dir, { mode: 0o700 });
    directories.set(dir, await directory(dir));
  }
  const settingsFile = path.join(settingsDir, 'settings.json');
  await writeFile(settingsFile, SETTINGS_BYTES, { flag: 'wx', mode: 0o600 });
  return { areas, gemini, settingsDir, settingsFile, directories };
}

async function checkPolicy(storage, phase) {
  const { areas, gemini, settingsDir, settingsFile, directories } = storage;
  const initial = phase === 'initial';
  for (const [dir, info] of directories) {
    await storageCheck(phase, dir === areas.work ? 'work-identity' : 'storage-identity', () => directory(dir, info));
  }
  await storageCheck(phase, 'work-changed', () => allowNames(areas.work));
  await storageCheck(phase, 'workspace-discovery', async () => {
    for (let dir = areas.work;;) {
      await absentPath(path.join(dir, '.git'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  });

  if (initial) {
    await storageCheck(phase, 'unexpected-config', async () => {
      for (const dir of [areas.local, areas.roaming, areas.scratch]) await allowNames(dir);
      await allowNames(areas.home, ['.gemini']);
      await allowNames(gemini, ['antigravity-cli']);
      await allowNames(settingsDir, ['settings.json']);
    });
  }
  let text;
  try { text = await readOwnedText(settingsFile, initial ? Buffer.byteLength(SETTINGS_BYTES) : 4096); }
  catch (error) { throw new RuntimeGateError(phase, absent(error) ? 'settings-missing' : 'settings-read'); }
  if (initial) {
    if (text !== SETTINGS_BYTES) throw new RuntimeGateError(phase, 'settings-seed');
  } else {
    // The CLI normalizes its own settings and omits default values. Refuse
    // duplicate keys/ambiguous encodings instead of accepting JSON.parse's
    // last-value-wins view of a file another parser could merge differently.
    const json = await storageCheck(phase, 'settings-parse', () => JSON.parse(text));
    const compact = text.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/gu, item => item.startsWith('"') ? item : '');
    if (compact !== JSON.stringify(json)) throw new RuntimeGateError(phase, 'settings-normalization');
    if (!entriesOnly(json, Object.keys(SETTINGS))) throw new RuntimeGateError(phase, 'settings-shape');
    if (json.toolPermission !== 'strict' || ![undefined, ''].includes(json.agentMode)
      || json.enableTerminalSandbox !== true || ![undefined, false].includes(json.allowNonWorkspaceAccess)
      || ![undefined, false].includes(json.useG1Credits)) throw new RuntimeGateError(phase, 'settings-mode');
    const rules = json.permissions;
    const empty = list => list === undefined || (Array.isArray(list) && list.length === 0);
    if (!entriesOnly(rules, ['allow', 'ask', 'deny']) || !empty(rules.allow) || !empty(rules.ask)
      || !Array.isArray(rules.deny) || rules.deny.length !== DENY.length || !DENY.every(rule => rules.deny.includes(rule))) {
      throw new RuntimeGateError(phase, 'settings-permissions');
    }
  }

  // No shared home customizations, including hooks, MCP, plugins and rules.
  for (const [dir, slots] of [[areas.home, discoverySlots.home], [gemini, discoverySlots.gemini], [settingsDir, discoverySlots.cli]]) {
    for (const [name, leaf] of slots) await checkDiscovery(phase, dir, directories.get(dir), name, leaf);
  }
}

async function removeStorage(lease) {
  if (!lease.lock) return;
  if (!lease.lockInfo || (lease.run && !lease.runInfo)) throw new RuntimeGateError('cleanup', 'storage-identity');
  const verify = (dir, info) => storageCheck('cleanup', 'storage-identity', () => directory(dir, info));
  await verify(lease.root, lease.rootInfo);
  await verify(lease.lock, lease.lockInfo);
  if (lease.run) {
    await verify(lease.run, lease.runInfo);
    await storageCheck('cleanup', 'storage-remove', () => rm(lease.run, { recursive: true, maxRetries: 2 }));
  }
  await verify(lease.lock, lease.lockInfo);
  await storageCheck('cleanup', 'storage-remove', () => rmdir(lease.lock));
}

/**
 * Lazy Host-only access to the reviewed Windows CLI. `root` is an absolute,
 * dedicated product-data leaf with an existing trusted parent, outside every
 * DSH workspace and Git tree. No credential, history, or working directory
 * is supplied by DSH. The caller owns admission and must always close/dispose.
 */
export function createAgySubscriptionCli({ root, executable, loopbackProxy } = {}) {
  let active, disposed, disposing, cleanupFailure;
  const userHome = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  const profilePaths = [process.env.DSH_AGENTS_HOME, process.env.DSH_PROFILE_DIR, process.env.DSH_INSTALL_DIR,
    ...['.gemini', '.gemini-cli', '.agents'].map(name => isLocalAgyPath(userHome) ? path.join(userHome, name) : undefined),
  ].filter(isLocalAgyPath);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
  const protectedParents = [process.env.DSH_HOME, userHome].filter(isLocalAgyPath);
  const blockedPaths = Object.freeze([isLocalAgyPath(root) ? root : undefined,
    isLocalAgyPath(executable) ? path.dirname(executable) : undefined].filter(Boolean));

  async function makeSession(options = {}) {
    if (!entriesOnly(options, ['signal'])) throw fail('invalid-options');
    const field = Object.getOwnPropertyDescriptor(options, 'signal');
    if (field && !Object.hasOwn(field, 'value')) throw fail('invalid-options');
    const signal = field?.value === undefined ? new AbortController().signal : field.value;
    if (cleanupFailure) throw cleanupFailure;
    if (disposed) throw fail('closed');
    if (aborted(signal)) throw fail('cancelled');
    if (active) throw fail('cli-busy');
    const lease = {};
    let storage, transport, session, opening, opened, turnUsed, policyRead, closing, abortListener;

    function live() {
      if (aborted(signal)) throw fail('cancelled');
      if (closing || disposed) throw fail('closed');
    }

    async function start() {
      // Prevent Windows aliases (including ambiguous final dot/space) before
      // creating the leaf. Windows drive roots are never owned runtime storage.
      if (!isLocalAgyPath(root) || path.resolve(root) !== root || path.dirname(root) === root
        || (process.platform === 'win32' && root.split(path.sep).some(part => /[. ]$/u.test(part)))
        || protectedParents.some(dir => contains(root, dir))
        || (process.platform === 'win32' && isLocalAgyPath(systemRoot) && (contains(root, systemRoot) || contains(systemRoot, root)))
        || profilePaths.some(dir => contains(dir, root) || contains(root, dir))
        || (isLocalAgyPath(executable) && contains(root, executable))) throw new RuntimeGateError('initial', 'root-policy');
      const verified = await verifiedAgyExecutable(executable);
      live();
      try { storage = await createStorage(root, lease, live); }
      catch (error) {
        if (gateErrors.has(error)) throw error;
        const code = error?.code;
        if (['cancelled', 'closed', 'cli-busy'].includes(code)) throw fail(code);
        throw new RuntimeGateError('initial', 'storage-prepare');
      }
      live();
      const { areas } = storage;
      const env = { ...agyWindowsEnv(areas, undefined, loopbackProxy), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
      await checkPolicy(storage, 'initial');
      live();
      session = createAgyTurnSession({ cwd: areas.work, makeClient(hooks) {
        transport = new AgyAcpClient({ ...hooks, executable: verified, cwd: areas.work, env, timeoutMs: 20_000 });
        return {
          async start() {
            const result = await transport.start();
            live();
            if (result.agentInfo.version !== AGY_WINDOWS_X64.version) throw fail('cli-version-mismatch');
            await checkPolicy(storage, 'after-initialize');
            live();
            return result;
          },
          request: (...args) => transport.request(...args),
          notify: (...args) => transport.notify(...args),
          close: () => transport.close(),
        };
      } });
      await session.open();
      live();
      await checkPolicy(storage, 'after-session-new');
      live();
      if (!session.options) throw fail('catalog-unavailable');
      opened = true;
    }

    const wrapper = Object.freeze({
      get id() { return session?.id; },
      get options() { return opened && !closing ? session.options : undefined; },
      async open(officialId) {
        live();
        if (officialId !== undefined || opening) throw fail('invalid-session');
        opening = start();
        try { await opening; }
        catch (error) {
          const revoked = disposed || closing;
          await wrapper.close();
          if (aborted(signal)) throw fail('cancelled');
          if (revoked || disposed) throw fail('closed');
          // Only locally created errors may carry diagnostics to the caller.
          if (gateErrors.has(error) || error instanceof AgyLaunchError || error instanceof AgyAcpError) throw error;
          const { code } = error ?? {};
          throw fail(['cli-version-mismatch', 'catalog-unavailable', 'closed', 'cli-busy',
            'invalid-session', 'config-unconfirmed'].includes(code) ? code : 'cli-unavailable');
        }
      },
      async prepare(selection, prepareSignal = signal) {
        live();
        if (!opened || turnUsed) throw fail('turn-unavailable');
        return session.prepare(selection, prepareSignal);
      },
      async runTurn(text, options = {}) {
        live();
        if (!opened || turnUsed) throw fail('turn-unavailable');
        const { beforeDispatch, ...turnOptions } = options;
        if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw fail('turn-unavailable');
        turnUsed = true;
        try { await (policyRead = checkPolicy(storage, 'before-prompt')); }
        catch (error) { await wrapper.close(); throw error; }
        finally { policyRead = undefined; }
        live();
        return session.runTurn(text, { signal, ...turnOptions, beforeDispatch() {
          live();
          const result = beforeDispatch?.();
          if (isPromise(result)) return result;
          if (typeof result?.then === 'function') throw fail('turn-unavailable');
          live();
        } });
      },
      close() {
        return closing ??= Promise.resolve().then(async () => {
          abortListener?.[Symbol.dispose]();
          // Close transport promptly during setup; during a turn, keep the
          // existing session/cancel protocol and bounded graceful shutdown.
          await storageCheck('cleanup', 'process-unconfirmed', async () => {
            if (!opened) {
              await transport?.close();
              await opening?.catch(noop);
            }
            await session?.close();
          });
          await policyRead?.catch(noop);
          await removeStorage(lease);
        }).catch(error => {
          cleanupFailure = gateErrors.has(error) ? error : new RuntimeGateError('cleanup', 'cleanup-failed');
          throw cleanupFailure;
        }).finally(() => {
          if (active === wrapper) active = undefined;
        });
      },
    });
    active = wrapper;
    abortListener = addAbortListener(signal, () => { void wrapper.close().catch(noop); });
    return wrapper;
  }

  return Object.freeze({
    blockedPaths,
    makeSession,
    async probe(signal) {
      const wrapper = await makeSession({ signal });
      try {
        await wrapper.open();
        const options = wrapper.options;
        if (!options) throw fail('catalog-unavailable');
        return options;
      } finally {
        await wrapper.close();
        if (aborted(signal)) throw fail('cancelled');
      }
    },
    dispose() {
      disposed = true;
      return disposing ??= Promise.resolve().then(async () => {
        await active?.close();
        if (cleanupFailure) throw cleanupFailure;
      });
    },
  });
}
