import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createAgySubscriptionCli } from '../src/agy-subscription-cli.js';

// Explicit owner-authorized preflight. No authentication request, model prompt,
// previous session load, history access, or OAuth/remote text in output.
const [executable, flag, loopbackProxy, ...rest] = process.argv.slice(2);
assert.ok(isAbsolute(executable ?? '') && rest.length === 0
  && (flag === undefined || (flag === '--loopback-proxy' && loopbackProxy !== undefined)),
  'Pass a verified official agy.exe path, optionally with --loopback-proxy');
const temp = await realpath(tmpdir());
const parent = await mkdtemp(join(temp, 'dsh-google-catalog-'));
const root = join(parent, 'runtime');
const cli = createAgySubscriptionCli({ root, executable, loopbackProxy });
let cleanup = false;
try {
  const snapshot = await cli.probe(AbortSignal.timeout(45_000));
  const clean = value => /^gemini-[a-z0-9.-]{1,60}$/u.test(value);
  const modelIds = snapshot.model.options.map(model => model.value).filter(clean);
  console.log(JSON.stringify({ status: 'catalog', modelIds, promptSent: false, signInStarted: false }));
} catch (error) {
  const known = new Set([-32000, 'unsafe-storage', 'missing-cli', 'unsupported-cli',
    'TIMEOUT', 'RPC_ERROR', 'SPAWN_FAILED', 'PROCESS_EXIT', 'PROTOCOL', 'cancelled', 'catalog-unavailable', 'cleanup-unconfirmed']);
  const phases = new Set(['initial', 'after-initialize', 'after-session-new', 'before-prompt', 'cleanup']);
  const reasons = new Set(['work-changed', 'work-identity', 'storage-identity', 'workspace-discovery', 'unexpected-config',
    'settings-missing', 'settings-read', 'settings-parse', 'settings-normalization', 'settings-shape', 'settings-mode',
    'settings-permissions', 'settings-seed', 'root-policy', 'root-ownership', 'storage-prepare',
    'process-unconfirmed', 'storage-remove', 'cleanup-failed']);
  const leaves = new Set(['home-agents', 'home-legacy-agent', 'home-gemini-cli', 'gemini-config', 'gemini-agents-md', 'gemini-gemini-md',
    'gemini-skills', 'cli-agents', 'cli-mcp', 'cli-plugins', 'cli-rules', 'cli-skills', 'cli-hooks']);
  const kinds = new Set(['file', 'link', 'other', 'unreadable', 'directory-unverified', 'empty-directory', 'nonempty-directory']);
  const { phase, reason, leaf, kind } = error?.diagnostic ?? {};
  const diagnostic = phases.has(phase) && reasons.has(reason) ? { phase, reason,
    ...(reason === 'unexpected-config' && leaves.has(leaf) && kinds.has(kind) ? { leaf, kind } : {}) } : undefined;
  console.log(JSON.stringify({ status: 'unavailable', code: known.has(error?.code) ? error.code : 'cli-unavailable', diagnostic,
    promptSent: false, signInStarted: false }));
  process.exitCode = 2;
} finally {
  try {
    await cli.dispose();
    assert.equal(dirname(parent), temp);
    assert.match(basename(parent), /^dsh-google-catalog-[A-Za-z0-9]+$/u);
    const entries = await readdir(root).catch(error => { if (error?.code === 'ENOENT') return; throw error; });
    if (entries) {
      assert.deepEqual(entries, ['.subscriptions-agy-v1']);
      await unlink(join(root, '.subscriptions-agy-v1'));
      await rmdir(root);
    }
    await rmdir(parent);
    cleanup = true;
  } catch (_error) { process.exitCode = 3; }
  console.log(JSON.stringify({ directChildAndScratchCleaned: cleanup }));
}
