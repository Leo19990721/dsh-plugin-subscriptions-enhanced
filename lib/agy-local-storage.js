import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';

const absent = error => error?.code === 'ENOENT';
const mirrorMarker = '.dsh-skill-mirror';
export function dshHomePath(parent, ...parts) {
  const home = parent.DSH_HOME?.trim() ? parent.DSH_HOME : join(homedir(), '.dsh');
  return resolve(home.replace(/^~(?=$|[\\/])/u, () => homedir()), ...parts);
}

// realpath equality also rejects a junction or symlink in an ancestor, not just at the leaf.
async function ordinaryEntry(path, type) {
  if (!isLocalAgyPath(path)) return;
  try {
    const entry = await lstat(path, { bigint: true });
    if ((type === 'dir' ? entry.isDirectory() : entry.isFile()) && sameAgyPath(path, await realpath(path))) return entry;
  } catch (error) {
    if (!absent(error) && !['ENOTDIR', 'ELOOP'].includes(error?.code)) throw error;
  }
}
const ordinary = async (path, type) => Boolean(await ordinaryEntry(path, type));
const compareNames = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const entriesOf = async path => (await readdir(path, { withFileTypes: true })).sort(compareNames);
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

async function fileEntry(path) {
  const entry = await ordinaryEntry(path, 'file');
  if (entry) return { path, stamp: stamp(entry) };
}

async function skillCandidates(root, signal) {
  const result = new Map();
  if (!root || !await ordinary(root, 'dir')) return result;
  const entries = await entriesOf(root);
  // As in DSH, a directory entry wins over flat Markdown of the same name.
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const path = join(root, entry.name), key = entry.name.toLowerCase();
    if (!result.has(key) && await ordinary(path, 'dir') && await ordinary(join(path, 'SKILL.md'), 'file')) {
      result.set(key, { name: entry.name, path, tree: true });
    }
  }
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3), path = join(root, entry.name), key = name.toLowerCase();
    if (!result.has(key)) {
      const file = await fileEntry(path);
      if (file) result.set(key, { name, file });
    }
  }
  return result;
}

async function skillTree(root, signal) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await entriesOf(directory)) {
      signal?.throwIfAborted();
      if (entry.name.toLowerCase() === '.git') continue;
      const path = join(directory, entry.name), name = relative(root, path);
      if (entry.isDirectory() && await ordinary(path, 'dir')) {
        entries.push({ name });
        await visit(path);
      } else if (entry.isFile()) {
        const file = await fileEntry(path);
        if (file) entries.push({ name, file });
      }
    }
  }
  await visit(root);
  return entries;
}

/** Inventory only the configured rules, direct cwd rules and effective DSH skills. Never read their bodies here. */
export async function inventoryAgyWorkspace({ cwd, agentsFile, globalSkills, signal }) {
  signal?.throwIfAborted();
  const ordinaryCwd = cwd && await ordinary(cwd, 'dir');
  const localRules = ordinaryCwd ? join(cwd, 'AGENTS.md') : undefined;
  const localDsh = ordinaryCwd ? join(cwd, '.dsh') : undefined;
  const localSkills = localDsh && await ordinary(localDsh, 'dir') ? join(localDsh, 'skills') : undefined;
  const globalRules = agentsFile ? resolve(agentsFile) : undefined;
  const [global, workspace, globalRule, workspaceRule] = await Promise.all([
    skillCandidates(globalSkills, signal), skillCandidates(localSkills, signal),
    globalRules && fileEntry(globalRules),
    localRules && (!globalRules || !sameAgyPath(globalRules, localRules)) && fileEntry(localRules),
  ]);
  for (const [key, skill] of workspace) global.set(key, skill);
  const rules = [[globalRule, 'Global'], [workspaceRule, 'Workspace']]
    .flatMap(([file, scope]) => file ? [{ ...file, scope }] : []);
  const hash = createHash('sha256');
  const record = value => hash.update(JSON.stringify(value) + '\n');
  for (const file of rules) record(['rules', file]);
  const skills = [];
  for (const skill of [...global.values()].sort(compareNames)) {
    signal?.throwIfAborted();
    const entries = skill.tree ? await skillTree(skill.path, signal) : [{ name: 'SKILL.md', file: skill.file }];
    // If a definition was removed during inventory, fail rather than mirror a partial skill.
    if (!entries.some(entry => sameAgyPath(entry.name, 'SKILL.md') && entry.file)) throw new Error('Skill definition changed');
    record(['skill', skill.name]);
    for (const entry of entries) record(entry);
    skills.push({ name: skill.name, entries });
  }
  signal?.throwIfAborted();
  return { rules, skills, fingerprint: hash.digest('hex') };
}

async function useSourceFile({ path, stamp: expected }, use) {
  const checkPath = async () => (await fileEntry(path))?.stamp === expected;
  if (!await checkPath()) throw new Error('Workspace context source changed');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const unchanged = async () => {
      const stat = await handle.stat({ bigint: true });
      return stat.isFile() && stamp(stat) === expected;
    };
    if (!await unchanged() || !await checkPath()) throw new Error('Workspace context source changed');
    const result = await use(handle);
    if (!await unchanged()) throw new Error('Workspace context source changed');
    return result;
  } finally { await handle.close(); }
}

export async function readAgyRules(inventory) {
  const sections = await Promise.all(inventory.rules.map(async file => {
    const body = await useSourceFile(file, handle => handle.readFile('utf8'));
    return body.trim() ? `## ${file.scope} instructions (AGENTS.md)\n\n${body}` : '';
  }));
  return sections.filter(Boolean);
}

async function renameWithRetry(from, to) {
  const delays = process.platform === 'win32' ? [50, 150, 300] : [];
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (attempt >= delays.length || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** Materialize the inventory in the private agy home before the CLI scans it. */
export async function syncAgySkills(inventory, settingsDir, signal) {
  if (!await ordinary(settingsDir, 'dir')) throw new Error('Unsafe Antigravity settings directory');
  let targetParent = settingsDir;
  let skills = join(settingsDir, 'skills');
  let existing = await lstat(skills).catch(error => { if (!absent(error)) throw error; });
  if (existing && !await ordinary(skills, 'dir')) {
    // Newer agy CLI migrates .gemini/antigravity-cli/skills -> .gemini/config/skills
    // and leaves a compatibility junction/symlink inside the same isolated home.
    const migratedParent = join(dirname(settingsDir), 'config');
    const migratedSkills = join(migratedParent, 'skills');
    const resolved = existing.isSymbolicLink() ? await realpath(skills).catch(() => undefined) : undefined;
    if (!resolved || !sameAgyPath(resolved, migratedSkills)
      || !await ordinary(migratedParent, 'dir') || !await ordinary(migratedSkills, 'dir')) {
      throw new Error('Unsafe Antigravity skills directory');
    }
    targetParent = migratedParent;
    skills = migratedSkills;
    existing = await lstat(skills);
  }
  const stage = await mkdtemp(join(targetParent, '.dsh-skills-'));
  try {
    for (const skill of inventory.skills) {
      signal.throwIfAborted();
      const target = join(stage, skill.name);
      await mkdir(target);
      for (const { name, file } of skill.entries) {
        signal.throwIfAborted();
        const path = join(target, name);
        if (file) await useSourceFile(file, handle => pipeline(handle.createReadStream({ autoClose: false }),
          createWriteStream(path, { flags: 'wx' }), { signal }));
        else await mkdir(path);
      }
    }
    signal.throwIfAborted();
    await writeFile(join(stage, mirrorMarker), '', { flag: 'wx' });
    const previous = existing ? join(targetParent, `.dsh-skills-previous-${randomUUID()}`) : undefined;
    const owned = existing && await ordinary(join(skills, mirrorMarker), 'file');
    // Keep an unowned existing directory as a reversible backup, never recursively delete it.
    if (previous) await renameWithRetry(skills, previous);
    try { await renameWithRetry(stage, skills); }
    catch (error) {
      if (previous) await renameWithRetry(previous, skills);
      throw error;
    }
    if (owned) await rm(previous, { recursive: true, force: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const encloses = (directory, target) => {
  const path = relative(directory, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};

function permissionPath(value, cwd) {
  if (typeof value !== 'string' || !value || !isLocalAgyPath(cwd) || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const path = process.platform === 'win32' ? value.replace(/^\/(?=[a-z]:[\\/])/iu, '') : value;
  if (process.platform === 'win32') {
    const driveAbsolute = /^[a-z]:[\\/]/iu.test(path);
    if ((!driveAbsolute && /^[\\/]/u.test(path)) || (driveAbsolute ? path.slice(2) : path).includes(':')) return;
    // Windows can interpret trailing spaces/dots as another spelling (including a traversal).
    if (path.split(/[\\/]/u).some(part => part !== '.' && /[. ]$/u.test(part))) return;
  }
  // Never collapse a raw traversal across a link: some platform file APIs resolve it physically, not lexically.
  if (path.split(process.platform === 'win32' ? /[\\/]/u : '/').includes('..')) return;
  const absolute = resolve(cwd, path);
  if (isLocalAgyPath(absolute)) return absolute;
}

/** Capture an exact, ordinary local file identity; neither directories nor aliases create grants. */
export async function agyReadOnlyRef(path) {
  const entry = await ordinaryEntry(path, 'file');
  if (!entry) return;
  return Object.freeze({ path: resolve(path), stamp: stamp(entry) });
}

/** Compare exact spelling even when the file was removed or changed; useful for denying writes. */
export function isAgyReadOnlyRefPath(value, cwd, grant) {
  const path = permissionPath(value, cwd);
  return Boolean(path && grant && sameAgyPath(path, grant.path));
}

/** Recheck the same spelling and identity; a renamed/replaced file or alias needs a fresh grant. */
export async function matchesAgyReadOnlyRef(value, cwd, grant) {
  const path = permissionPath(value, cwd);
  if (!path || !grant || !sameAgyPath(path, grant.path)) return false;
  try { return (await agyReadOnlyRef(path))?.stamp === grant.stamp; }
  catch { return false; }
}

/** Additional DSH writable roots are explicit ordinary directories, never aliases. */
export async function withinAgyWritableRoots(value, cwd, workspaceRoot, additionalWritableRoots = []) {
  const path = permissionPath(value, cwd);
  if (!path || !Array.isArray(additionalWritableRoots)) return false;
  try {
    const candidates = [];
    if (isLocalAgyPath(workspaceRoot)) {
      const workspace = await realpath(workspaceRoot);
      if (isLocalAgyPath(workspace) && (await stat(workspace)).isDirectory()) candidates.push([workspaceRoot, workspace]);
    }
    for (const root of additionalWritableRoots) {
      if (!await ordinary(root, 'dir')) return false;
      candidates.push([root, root]);
    }
    // An external symlink into the workspace is also unsafe to delete: check
    // the reported spelling as well as the canonical future path.
    const roots = candidates.filter(([spelling, canonical]) => encloses(spelling, path) || encloses(canonical, path));
    if (!roots.length) return false;
    const suffix = [];
    let parent = path;
    for (;;) {
      try {
        const resolved = await realpath(parent);
        const target = resolve(resolved, ...suffix);
        return isLocalAgyPath(target) && roots.some(([, root]) => encloses(root, target));
      } catch (error) {
        if (!absent(error)) return false;
        // ENOENT for a dangling link is not a missing path component we may grant.
        if (await lstat(parent).then(() => true, error => { if (absent(error)) return false; throw error; })) return false;
        const ancestor = dirname(parent);
        if (ancestor === parent) return false;
        suffix.unshift(relative(ancestor, parent));
        parent = ancestor;
      }
    }
  } catch { return false; }
}

/** Atomically publish the cleaned transcript at a file in the existing private session directory. */
export async function writeAgyHistoryArchive(path, body, signal) {
  signal?.throwIfAborted();
  if (!isLocalAgyPath(path) || !await ordinary(dirname(path), 'dir')) return;
  const existing = await lstat(path).catch(error => { if (!absent(error)) throw error; });
  if (existing && !existing.isFile()) return;
  const temporary = join(dirname(path), `.dsh-history-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(body, { encoding: 'utf8', signal }); }
    finally { await handle.close(); }
    signal?.throwIfAborted();
    if (!await ordinary(temporary, 'file')) return;
    await rename(temporary, path);
    return await agyReadOnlyRef(path);
  } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
}

const defaultAgyRoots = parent => [dshHomePath(parent), dshHomePath(parent, 'profiles', 'desktop')]
  .map(home => join(home, 'plugin-data', 'subscriptions-enhanced', 'agy'));

/** Retire only the old plugin-owned Windows cache, preserving it alongside its original path. */
export async function retireAgyLegacyBrowserCaches(parent, localAppData, currentDataDir) {
  if (process.platform !== 'win32' || !isLocalAgyPath(localAppData)) return;
  const defaultRoots = defaultAgyRoots(parent);
  // A custom runtime (including test/smoke harnesses) must never migrate the default user's data.
  if (!defaultRoots.some(root => sameAgyPath(root, currentDataDir))) return;
  let privateLocal;
  try { privateLocal = await realpath(localAppData); } catch { return; }
  for (const root of defaultRoots) {
    const cache = join(root, 'catalog', 'local', 'Microsoft');
    if (!isLocalAgyPath(cache) || encloses(privateLocal, cache) || encloses(cache, privateLocal)) continue;
    try {
      if (!await ordinary(cache, 'dir')) continue;
      const layouts = new Map([['Windows', 'Caches'], ['Edge', 'User Data']]);
      const directories = await readdir(cache);
      if (!directories.length) continue;
      const recognized = await Promise.all(directories.map(async name => {
        const child = layouts.get(name);
        const dir = join(cache, name);
        if (!child || !await ordinary(dir, 'dir') || !await ordinary(join(dir, child), 'dir')) return false;
        const entries = await readdir(dir);
        return entries.length === 1 && entries[0] === child;
      }));
      // Do not move unfamiliar siblings. Keep the entire recognized legacy tree intact as a reversible backup.
      if (recognized.every(Boolean)) await rename(cache, `${cache}.dsh-retired-${randomUUID()}`);
    } catch { /* Active, inaccessible or changed cache: leave it in place; OAuth has already completed. */ }
  }
}
