import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { isLocalAgyPath, sameAgyPath } from './agy-launch.js';

const absent = error => error?.code === 'ENOENT';
const mirrorMarker = '.dsh-skill-mirror';
export function dshHomePath(parent, ...parts) {
  const home = parent.DSH_HOME?.trim() ? parent.DSH_HOME : join(homedir(), '.dsh');
  return resolve(home.replace(/^~(?=$|[\\/])/u, () => homedir()), ...parts);
}

// realpath equality also rejects a junction or symlink in an ancestor, not just at the leaf.
async function ordinary(path, type) {
  try {
    const entry = await lstat(path);
    return (type === 'dir' ? entry.isDirectory() : entry.isFile()) && sameAgyPath(path, await realpath(path));
  } catch (error) {
    if (!absent(error)) throw error;
    return false;
  }
}

async function copySkillTree(source, target) {
  await mkdir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory() && await ordinary(from, 'dir')) await copySkillTree(from, to);
    else if (entry.isFile() && await ordinary(from, 'file')) await copyFile(from, to, constants.COPYFILE_EXCL);
  }
}

/** Materialize only user-owned DSH skills in the private agy home before the CLI scans it. */
export async function syncAgySkills(source, settingsDir) {
  if (!await ordinary(settingsDir, 'dir')) throw new Error('Unsafe Antigravity settings directory');
  const skills = join(settingsDir, 'skills');
  const existing = await lstat(skills).catch(error => { if (!absent(error)) throw error; });
  if (existing && !await ordinary(skills, 'dir')) throw new Error('Unsafe Antigravity skills directory');
  const stage = await mkdtemp(join(settingsDir, '.dsh-skills-'));
  try {
    if (await ordinary(source, 'dir')) {
      const entries = await readdir(source, { withFileTypes: true });
      const copied = new Set();
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        const from = join(source, entry.name);
        if (!await ordinary(from, 'dir') || !await ordinary(join(from, 'SKILL.md'), 'file')) continue;
        await copySkillTree(from, join(stage, entry.name));
        copied.add(entry.name.toLowerCase());
      }
      // DSH also accepts flat Markdown; agy expects a directory containing SKILL.md.
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.endsWith('.md')) continue;
        const name = entry.name.slice(0, -3), from = join(source, entry.name);
        if (copied.has(name.toLowerCase()) || !await ordinary(from, 'file')) continue;
        await mkdir(join(stage, name));
        await copyFile(from, join(stage, name, 'SKILL.md'), constants.COPYFILE_EXCL);
        copied.add(name.toLowerCase());
      }
    }
    await writeFile(join(stage, mirrorMarker), '', { flag: 'wx' });
    const previous = existing ? join(settingsDir, `.dsh-skills-previous-${randomUUID()}`) : undefined;
    const owned = existing && await ordinary(join(skills, mirrorMarker), 'file');
    // Keep an unowned existing directory as a reversible backup, never recursively delete it.
    if (previous) await rename(skills, previous);
    try { await rename(stage, skills); }
    catch (error) {
      if (previous) await rename(previous, skills);
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
