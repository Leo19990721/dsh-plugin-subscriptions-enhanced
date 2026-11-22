import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const LOCAL_BYPASS = 'localhost,127.0.0.1,::1';

function proxyUrl(value) {
  if (!value?.trim()) return;
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : `http://${input}`);
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname
    || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('Invalid proxy URL');
  return url.href.replace(/\/$/u, '');
}

async function windowsProxy(parent) {
  const system = parent.SystemRoot ?? parent.WINDIR;
  if (process.platform !== 'win32' || !system) return;
  // Windows' current-user resolver honors the active static/PAC proxy without changing it.
  // The URI is used only to choose a proxy; all Google traffic is sent by agy.
  try {
    const { stdout } = await exec(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "$u=[uri]'https://daily-cloudcode-pa.googleapis.com'; $p=[Net.WebRequest]::GetSystemWebProxy().GetProxy($u); if ($p -and $p -ne $u) { $p.AbsoluteUri }",
    ], { windowsHide: true, timeout: 4000 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

/** Child-only environment: explicit address or direct, then environment, then Windows. */
export async function agyProxyEnv(configured, parent = process.env, discover = windowsProxy) {
  const env = key => parent[key] || parent[key.toLowerCase()];
  try {
    const config = configured?.trim();
    if (configured !== undefined && (!config || config.toLowerCase() === 'direct')) return {};
    let https, http;
    if (config && config.toLowerCase() !== 'auto') https = http = proxyUrl(config);
    else {
      https = proxyUrl(env('HTTPS_PROXY') || env('ALL_PROXY') || env('HTTP_PROXY'));
      http = proxyUrl(env('HTTP_PROXY') || env('ALL_PROXY') || env('HTTPS_PROXY'));
      if (!https && !http) https = http = proxyUrl(await discover(parent));
    }
    return https || http ? {
      ...(https ? { HTTPS_PROXY: https } : {}), ...(http ? { HTTP_PROXY: http } : {}),
      NO_PROXY: [LOCAL_BYPASS, config && config.toLowerCase() !== 'auto' ? '' : env('NO_PROXY')].filter(Boolean).join(','),
    } : {};
  } catch {
    throw Object.assign(new Error('Invalid Antigravity proxy configuration.'), { code: 'invalid-proxy' });
  }
}
