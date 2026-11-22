import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

const pathKey = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
export const sameAgyPath = (left, right) => pathKey(left) === pathKey(right);
export function isLocalAgyPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value)
    && (process.platform !== 'win32' || /^[a-z]:[\\/][^:]*$/i.test(value));
}

export class AgyLaunchError extends Error {
  constructor(code) { super(`Antigravity launch: ${code}`); this.code = code; }
}

export async function verifiedAgyExecutable(file) {
  const expectedName = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const base = typeof file === 'string' ? path.basename(file) : '';
  const nameMatches = process.platform === 'win32' ? base.toLowerCase() === expectedName : base === expectedName;
  if (!isLocalAgyPath(file) || !nameMatches) throw new AgyLaunchError('unsupported-cli');
  try {
    const canonical = await realpath(file);
    // Don't follow a symlink, junction, or other alias to a different path.
    // The OS validates executability when spawning; ACP validates the protocol.
    if (!sameAgyPath(canonical, file) || !(await lstat(file)).isFile()) throw new AgyLaunchError('unsupported-cli');
    return canonical;
  } catch (error) {
    throw new AgyLaunchError(error?.code === 'ENOENT' ? 'missing-cli' : 'unsupported-cli');
  }
}

export async function discoverAgyExecutable(configured, parentEnv = process.env, verify = verifiedAgyExecutable) {
  if (configured) return verify(configured);
  const env = key => {
    const name = Object.keys(parentEnv).find(item => item.toUpperCase() === key);
    return name === undefined ? undefined : parentEnv[name];
  };
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const localAppData = env('LOCALAPPDATA');
  const userProfile = env('USERPROFILE') ?? env('HOME');
  const pathDirs = (env('PATH') ?? '').split(path.delimiter).map(part => part.trim().replace(/^"(.*)"$/u, '$1')).filter(Boolean);
  const candidates = [
    ...(process.platform === 'win32' && localAppData ? [path.join(localAppData, 'agy', 'bin', exe)] : []),
    ...(userProfile ? [path.join(userProfile, '.local', 'bin', exe)] : []),
    ...pathDirs.map(dir => path.join(dir, exe)),
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!isLocalAgyPath(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const target = await realpath(candidate).catch(() => candidate);
      return await verify(target);
    } catch (error) {
      if (error?.code !== 'missing-cli' && error?.code !== 'unsupported-cli') throw error;
    }
  }
  return verify(candidates[0]);
}

/**
 * Build a child-only environment. Never inherit proxies, credentials or DSH/Electron settings.
 * @param {object} areas - Dedicated absolute home, local, roaming and scratch directories.
 * @param {object} parent - Source for the Windows system directory only.
 * @param {string} [loopbackProxy] - Explicit HTTP proxy on 127.0.0.1 with no credentials or path.
 * @returns {object} Fresh child process environment. Whether the CLI uses the proxy is verified separately.
 */
export function agyWindowsEnv({ home, local, roaming, scratch }, parent = process.env, loopbackProxy) {
  const system = parent.SystemRoot ?? parent.SYSTEMROOT ?? parent.WINDIR;
  if (![system, home, local, roaming, scratch].every(isLocalAgyPath)) throw new AgyLaunchError('invalid-environment');
  if (loopbackProxy !== undefined) {
    const match = typeof loopbackProxy === 'string' && /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(loopbackProxy);
    if (!match || match[0] !== loopbackProxy || Number(match[1]) > 65535) throw new AgyLaunchError('invalid-proxy');
  }
  const systemDir = path.join(system, 'System32');
  const drive = path.parse(home).root.slice(0, 2);
  return {
    SYSTEMROOT: system, WINDIR: system, COMSPEC: path.join(systemDir, 'cmd.exe'),
    PATH: [systemDir, system].join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PROCESSOR_ARCHITECTURE: 'AMD64', USERPROFILE: home, HOME: home,
    HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length),
    LOCALAPPDATA: local, APPDATA: roaming, TEMP: scratch, TMP: scratch,
    ...(loopbackProxy === undefined ? {} : {
      HTTP_PROXY: loopbackProxy, HTTPS_PROXY: loopbackProxy, NO_PROXY: 'localhost,127.0.0.1,::1',
    }),
  };
}
