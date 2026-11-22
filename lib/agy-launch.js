import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

// Reviewed vendor release: Google operator manifest for windows_amd64; signed
// by Google LLC and matched to SHA-512 before this separate SHA-256 was recorded.
export const AGY_WINDOWS_X64 = Object.freeze({
  version: '1.5.12',
  bytes: 235_400_344,
  sha256: '397f0acb4005232799ebea7d5691fd113be009695f1986321876a300bf80aec6',
});

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
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isLocalAgyPath(file)
    || path.basename(file).toLowerCase() !== 'agy.exe') throw new AgyLaunchError('unsupported-cli');
  try {
    const expected = AGY_WINDOWS_X64;
    const canonical = await realpath(file);
    const before = await lstat(canonical);
    if (!sameAgyPath(canonical, file) || !before.isFile() || before.nlink !== 1 || before.size !== expected.bytes) {
      throw new AgyLaunchError('unverified-cli');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(canonical)) {
      if ((bytes += chunk.length) > expected.bytes) throw new AgyLaunchError('unverified-cli');
      hash.update(chunk);
    }
    const after = await lstat(canonical);
    if (hash.digest('hex') !== expected.sha256 || bytes !== expected.bytes || after.size !== before.size
      || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || !sameAgyPath(canonical, await realpath(file))) {
      throw new AgyLaunchError('unverified-cli');
    }
    return canonical;
  } catch (error) {
    if (error instanceof AgyLaunchError) throw error;
    throw new AgyLaunchError(error?.code === 'ENOENT' ? 'missing-cli' : 'unverified-cli');
  }
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
