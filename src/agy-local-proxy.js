import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dshHomePath } from './agy-local-storage.js';

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

async function subscriptionProxy(parent) {
  try {
    const text = await readFile(dshHomePath(parent, 'plugins', 'subscriptions', 'proxy.json'), 'utf8');
    const saved = JSON.parse(text.replace(/^\uFEFF/u, ''));
    // This is the subscription plugin's on-disk record, not the redacted settings RPC view.
    if (saved?.enabled !== true || typeof saved.url !== 'string') return;
    const url = new URL(saved.url.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return;
    if (typeof saved.username === 'string') url.username = saved.username.trim();
    if (typeof saved.password === 'string') url.password = saved.password;
    url.pathname = '/';
    url.search = url.hash = '';
    const bypass = Array.isArray(saved.bypass) ? saved.bypass.flatMap(raw => {
      if (typeof raw !== 'string') return [];
      let host = raw.trim().toLowerCase();
      if (host.includes('://')) {
        try { host = new URL(host).hostname; } catch { return []; }
      }
      // Match upstream host/suffix semantics without importing an accidental NO_PROXY wildcard.
      host = host.replace(/:\d+$/u, '');
      return host && host !== '*' && !/[\s,]/u.test(host) ? [host] : [];
    }) : [];
    return { url: url.href.slice(0, -1), bypass: [...new Set(bypass)] };
  } catch { /* Missing, unreadable or malformed upstream configuration: keep automatic fallback. */ }
}

async function windowsProxy(parent) {
  const system = parent.SystemRoot ?? parent.SYSTEMROOT ?? parent.WINDIR;
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

/** Child-only environment: explicit override, then saved subscription settings, env and Windows. */
export async function agyProxyEnv(configured, parent = process.env, discover = windowsProxy) {
  const env = key => parent[key] || parent[key.toLowerCase()];
  try {
    const config = configured?.trim();
    if (configured !== undefined && (!config || config.toLowerCase() === 'direct')) return {};
    let https, http, bypass;
    if (config && config.toLowerCase() !== 'auto') https = http = proxyUrl(config);
    else {
      const saved = await subscriptionProxy(parent);
      if (saved) {
        https = http = saved.url;
        bypass = saved.bypass.join(',');
      } else {
        https = proxyUrl(env('HTTPS_PROXY') || env('ALL_PROXY') || env('HTTP_PROXY'));
        http = proxyUrl(env('HTTP_PROXY') || env('ALL_PROXY') || env('HTTPS_PROXY'));
        if (!https && !http) https = http = proxyUrl(await discover(parent));
        bypass = env('NO_PROXY');
      }
    }
    return https || http ? {
      ...(https ? { HTTPS_PROXY: https } : {}), ...(http ? { HTTP_PROXY: http } : {}),
      NO_PROXY: [LOCAL_BYPASS, bypass].filter(Boolean).join(','),
    } : {};
  } catch {
    throw Object.assign(new Error('Invalid Antigravity proxy configuration.'), { code: 'invalid-proxy' });
  }
}
