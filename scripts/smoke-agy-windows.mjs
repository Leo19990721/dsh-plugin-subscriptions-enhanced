// Explicit Windows verification: connect to the hash-pinned official CLI
// with an isolated home. No login, session, prompt, or real workspace access.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgyAcpClient } from '../src/agy-acp-client.js';
import { AGY_WINDOWS_X64, agyWindowsEnv, verifiedAgyExecutable } from '../src/agy-launch.js';

const [input, flag, loopbackProxy, ...extra] = process.argv.slice(2);
assert.ok(input && extra.length === 0 && (flag === undefined || (flag === '--loopback-proxy' && loopbackProxy !== undefined)),
  'Pass the absolute path of the verified Google agy.exe [--loopback-proxy http://127.0.0.1:PORT]');
const executable = await verifiedAgyExecutable(resolve(input));
const parent = await realpath(tmpdir());
const base = await realpath(await mkdtemp(join(parent, 'dsh-agy-acp-smoke-')));
let client;
try {
  const areas = {};
  for (const name of ['home', 'local', 'roaming', 'scratch', 'work']) {
    areas[name] = join(base, name);
    await mkdir(areas[name]);
  }
  const env = { ...agyWindowsEnv(areas, process.env, loopbackProxy), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  client = new AgyAcpClient({ executable, cwd: areas.work, env, timeoutMs: 15_000 });
  const result = await client.start();
  assert.equal(result.agentInfo.version, AGY_WINDOWS_X64.version);
  const caps = result.agentCapabilities?.sessionCapabilities ?? {};
  await client.close();
  console.log(JSON.stringify({ protocolVersion: result.protocolVersion, program: result.agentInfo.name,
    version: result.agentInfo.version, load: result.agentCapabilities?.loadSession === true, list: Boolean(caps.list),
    resume: Boolean(caps.resume), close: Boolean(caps.close), transportClosed: true, sent: ['initialize'] }));
} finally {
  // If transport cleanup is unconfirmed, leave this one scratch directory intact.
  await client?.close();
  assert.match(base, /[/\\]dsh-agy-acp-smoke-[^/\\]+$/);
  await rm(base, { recursive: true, force: true, maxRetries: 3 });
}
