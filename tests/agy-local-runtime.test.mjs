import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyProxyEnv } from '../src/agy-local-proxy.js';
import { localHistory, localPrompt } from '../src/agy-local-context.js';
import { agyProgress } from '../src/agy-local-progress.js';
import { createLocalAgy } from '../src/agy-local-runtime.js';
import { verifiedAgyExecutable } from '../src/agy-launch.js';

const signal = new AbortController().signal;
const text = text => ({ type: 'text', text });

test('validates an ordinary local agy.exe without pinning its contents', {
  skip: (process.platform !== 'win32' || process.arch !== 'x64') && 'Windows x64 executable validation',
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-path-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exe = join(root, 'agy.exe');
  await assert.rejects(verifiedAgyExecutable(exe), { code: 'missing-cli' });
  await assert.rejects(verifiedAgyExecutable('agy.exe'), { code: 'unsupported-cli' });
  const wrong = join(root, 'other.exe');
  await writeFile(wrong, 'fixture');
  await assert.rejects(verifiedAgyExecutable(wrong), { code: 'unsupported-cli' });
  // No process is spawned; Windows performs the executable format check at launch.
  for (const bytes of ['original bytes', 'different and longer upgraded bytes']) {
    await writeFile(exe, bytes);
    assert.equal(await verifiedAgyExecutable(exe), exe);
  }
  const directory = join(root, 'directory', 'agy.exe');
  await mkdir(directory, { recursive: true });
  await assert.rejects(verifiedAgyExecutable(directory), { code: 'unsupported-cli' });
  const linked = join(root, 'linked');
  await symlink(root, linked, 'junction');
  await assert.rejects(verifiedAgyExecutable(join(linked, 'agy.exe')), { code: 'unsupported-cli' });
});

test('proxy auto-detects using environment then OS; direct and explicit trump both', async () => {
  let reads = 0;
  const discover = () => { reads++; return '127.0.0.1:43217'; };
  const parent = { Https_Proxy: 'unused-in-posix', HTTPS_PROXY: 'http://fixture:3000', HTTP_PROXY: 'http://fixture:3001', NO_PROXY: '.fixture.com' };
  assert.deepEqual(await agyProxyEnv('auto', parent, discover), {
    HTTPS_PROXY: 'http://fixture:3000', HTTP_PROXY: 'http://fixture:3001', NO_PROXY: 'localhost,127.0.0.1,::1,.fixture.com',
  });
  assert.deepEqual(await agyProxyEnv('direct', parent, discover), {});
  assert.deepEqual(await agyProxyEnv('', parent, discover), {});
  assert.equal((await agyProxyEnv('http://fixture:34567', parent, discover)).HTTPS_PROXY, 'http://fixture:34567');
  assert.equal(reads, 0);
  assert.equal((await agyProxyEnv(undefined, {}, discover)).HTTPS_PROXY, 'http://127.0.0.1:43217');
  assert.equal(reads, 1);
  await assert.rejects(agyProxyEnv('file:///not-a-proxy', {}, discover), { code: 'invalid-proxy' });
});

test('quota reads both fixed commands concurrently via the verified CLI', async () => {
  const binary = String.raw`C:\Official Apps & Tools\agy.exe`;
  const parentEnv = { SystemRoot: String.raw`C:\Windows`, USERPROFILE: String.raw`C:\Users\fixture`,
    GOOGLE_OAUTH_TOKEN: 'not-forwarded', https_proxy: 'http://old-proxy.invalid' };
  const calls = [];
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const runtime = createLocalAgy({ executable: binary, proxy: 'auto' }, {
    parentEnv,
    async verify(file) { assert.equal(file, binary); return file; },
    async resolveProxy(config, parent) {
      assert.equal(config, 'auto'); assert.equal(parent, parentEnv);
      return { HTTPS_PROXY: 'http://fixture-proxy.invalid:43217' };
    },
    makeTransport() { assert.fail('quota never opens ACP'); },
    async printQuota(file, args, options) {
      calls.push(args);
      assert.equal(file, binary);
      assert.deepEqual({ ...options, signal: undefined }, { cwd: parentEnv.USERPROFILE, shell: false, windowsHide: true,
        timeout: 20_000, maxBuffer: 128 * 1024, encoding: 'utf8', signal: undefined,
        env: { SYSTEMROOT: parentEnv.SystemRoot, USERPROFILE: parentEnv.USERPROFILE,
          HTTPS_PROXY: 'http://fixture-proxy.invalid:43217', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } });
      if (calls.length === 2) started.resolve();
      await finish.promise;
      return { stdout: args[1] === '/usage' ? 'noise\r\nGemini Models\tWeekly Limit Remaining\t63%\t2026-11-28T15:02:14Z\r\nInvalid\tWeekly\t500%\t2026-11-28T15:02:14Z' : 'Remaining credits\t0\nUpgrade\thttps://antigravity.google/g1-upgrade' };
    },
  });
  const pending = runtime.fetchQuota(signal);
  await Promise.race([pending, started.promise]);
  assert.deepEqual(calls, [['--print', '/usage', '--print-timeout', '15s'], ['--print', '/credits', '--print-timeout', '15s']]);
  finish.resolve();
  const quota = await pending;
  assert.deepEqual(quota.windows, [{ group: 'Gemini Models', label: 'Weekly Limit Remaining', remainingPercent: 63, resetAt: '2026-11-28T15:02:14Z' }]);
  assert.deepEqual(quota.credits, { remaining: 0, upgradeUrl: 'https://antigravity.google/g1-upgrade' });
  assert.ok(Number.isFinite(Date.parse(quota.fetchedAt)));
  await assert.rejects(runtime.fetchQuota(AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(calls.length, 2);
  await runtime.dispose();
});

test('real cwd, stable home and official ID survive CLI upgrade and policy changes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-agy-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'runtime'), agentsFile = join(root, 'AGENTS.md');
  await writeFile(agentsFile, '# Synthetic local rules');
  const spawns = [], calls = [];
  const officialId = randomUUID();
  const configOptions = [{ type: 'select', name: 'Model', id: 'model', category: 'model', currentValue: 'gemini-fixture',
    options: [{ value: 'gemini-fixture', name: 'Fixture' }] }];
  const dependencies = {
    verify: () => join(root, 'agy.exe'), resolveProxy: () => ({}),
    makeTransport(options) {
      spawns.push(options);
      return {
        start: async () => ({ agentInfo: { version: spawns.length === 1 ? '1.5.12' : '1.5.13' },
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }),
        async request(method, params) {
          calls.push({ method, params });
          return { sessionId: params.sessionId ?? officialId, configOptions };
        }, close: async () => {},
      };
    },
  };
  let runtime = createLocalAgy({ dataDir, agentsFile }, dependencies);
  const id = 'test-session';
  const first = await runtime.open(signal, { id, cwd: root, mode: 'full', persona: '合成写作人设' });
  assert.equal(first.id, officialId);
  assert.equal(first.capabilities.promptCapabilities.image, true);
  const binding = { createdAt: 1, cwd: root, officialId, throughTurn: 2 };
  await runtime.writeBinding(id, binding);
  const home = spawns[0].env.HOME;
  const settings = () => readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8').then(JSON.parse);
  assert.equal(spawns[0].cwd, root);
  assert.equal(spawns[0].permissionMode, 'full');
  assert.equal((await settings()).permissions, undefined);
  assert.equal((await settings()).allowNonWorkspaceAccess, true);
  const rules = () => readFile(join(home, '.gemini', 'GEMINI.md'), 'utf8');
  await runtime.dispose();
  assert.equal(await rules(), '# Synthetic local rules\n\n合成写作人设');

  runtime = createLocalAgy({ dataDir, agentsFile }, dependencies);
  assert.deepEqual(await runtime.readBinding(id), binding);
  const reopened = await runtime.open(signal, { id, cwd: root, mode: 'read-only', officialId });
  assert.equal(reopened.id, officialId);
  assert.equal(spawns[1].env.HOME, home);
  assert.equal(spawns[1].permissionMode, 'sandbox');
  assert.equal(await rules(), '# Synthetic local rules', 'ordinary mode removes writing persona while preserving global rules');
  assert.ok((await settings()).permissions.deny.includes('write_file(*)'));
  assert.deepEqual(calls, [{ method: 'session/new', params: { cwd: root, mcpServers: [] } },
    { method: 'session/load', params: { cwd: root, mcpServers: [], sessionId: officialId } }]);
  await runtime.dispose();
});

test('ACP input keeps text over 64 KiB, attachment links, and verified image bytes in order', async () => {
  const long = '中文长文'.repeat(20_000);
  const image = { mediaType: 'image/png', height: 1, width: 1, bytes: 3 };
  const file = { name: '合成.txt' };
  const filename = join(tmpdir(), file.name);
  const blocks = await localPrompt([text(long), { type: 'file', attachment: file }, { type: 'image', attachment: image }], {
    fileHostPath(ref) { assert.equal(ref, file); return filename; },
    async readImage(ref) { assert.equal(ref, image); return { ref, data: Buffer.from('abc') }; },
  }, signal);
  assert.deepEqual(blocks[0], text(long));
  assert.equal(blocks[1].type, 'resource_link');
  assert.match(blocks[1].uri, /^file:\/\//);
  assert.ok(blocks[2].text.includes(JSON.stringify(filename)));
  assert.deepEqual(blocks[3], { type: 'image', mimeType: 'image/png', data: 'YWJj' });
});

test('history keeps recent user/assistant body only, bounded independently from the current text', () => {
  const events = [];
  const append = (type, data) => events.push({ seq: events.length, surfaceOp: 'append', type, data });
  const turn = (number, user, assistant, result = 'completed') => {
    append('turn/start', { turn: number });
    append('user/message', { source: user ? { kind: 'user' } : { kind: 'schedule' }, content: [text(user ?? 'AUTOMATION')] });
    append('tool/result', { content: [text('INTERNAL TOOL')] });
    append('assistant/message', { turn: number, message: { content: [text(assistant), { type: 'reasoning', text: 'INTERNAL REASONING' }] } });
    append('turn/end', { turn: number, reason: { kind: result } });
  };
  turn(1, 'old user', 'old assistant');
  turn(2, undefined, 'AUTOMATED ANSWER');
  turn(3, 'interrupted user', 'interrupted assistant', 'aborted');
  turn(4, 'middle message', 'new answer');
  turn(5, 'current prompt', 'not in history');
  const result = localHistory({ snapshotEvents: () => events }, 20, 1);
  assert.match(result, /middle message.*new answer/);
  assert.doesNotMatch(result, /old user|AUTOMA|interrupted user|INTERNAL|current prompt/);
});

test('reasoning and tool progress are display-only with final status and a tool-only receipt', () => {
  const view = agyProgress();
  assert.equal(view.push({ kind: 'thought', value: 'Reasoning' })[1].type, 'reasoning-delta');
  const update = (id, status) => view.push({ kind: 'tool', value: { toolCallId: id, title: 'Read x.txt', status } });
  assert.match(update('1', 'in_progress').at(-1).text, /工具执行中/);
  assert.match(update('1', 'completed').at(-1).text, /工具已完成/);
  update('2', 'failed');
  assert.match(view.close()[0].block.text, /^工具失败/);
  assert.match(view.receipt(), /已完成 1 项，失败 1 项/);
  assert.equal(view.hasAnswer, false);
});
