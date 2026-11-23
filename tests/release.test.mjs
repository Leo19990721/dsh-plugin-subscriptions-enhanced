import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);

test('the renamed bundle retains the existing repository and dependency metadata', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.name, 'dsh-subscriptions-enhanced');
  assert.deepEqual(pkg.engines, { node: '>=24.0.0' });
  for (const [id, range] of Object.entries(pkg.peerDependencies)) assert.equal(range, '*', id);
  assert.match(pkg.repository.url, /github\.com\/Leo19990721\/dsh-plugin-subscriptions-enhanced/);
  assert.ok(pkg.files.includes('NOTICE'));
  assert.deepEqual(pkg.dependencies, { undici: '7.30.2' });
  assert.equal(pkg.devDependencies['dsh-plugin-subscriptions'], '*');
  assert.deepEqual(Object.keys(pkg.exports), ['.', './client', './locale/*.json', './icon', './package.json']);
  for (const file of ['README.md', 'scripts/pack.ps1', 'scripts/smoke-agy-windows.mjs']) assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /[CE]:[\\/](?:Users|Personal|AI)/);
});

test('release preserves the upstream copyright and patch provenance', async () => {
  const license = await readFile(new URL('LICENSE', root), 'utf8');
  const notice = await readFile(new URL('NOTICE', root), 'utf8');
  assert.match(license, /Copyright \(c\) 2026 V1ki/);
  assert.match(notice, /0\.9\.13/);
  assert.match(notice, /V1ki\/dsh-plugin-subscriptions/);
});

test('packed subscription release has no private host data or local source map paths', { skip: !process.env.RELEASE_TGZ && 'run against the packed release with RELEASE_TGZ' }, async () => {
  const { gunzipSync } = await import('node:zlib');
  const tar = gunzipSync(await readFile(process.env.RELEASE_TGZ));
  const files = new Map();
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    const body = tar.subarray(at + 512, at + 512 + size);
    assert.equal(files.has(name), false, `duplicate archive entry: ${name}`);
    files.set(name, body);
    assert.doesNotMatch(name, /(?:node_modules|\.git|accounts|credentials|sessions|\.env)(?:\/|$)/);
    assert.doesNotMatch(body.toString(), /[CE]:[\\/](?:Users|Personal|AI)|01a1d0eb-00b2/);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  const runtime = ['client.js', 'index.js', 'upstream.json', 'writing-host.js', 'writing-policy.js',
    'agy-local-plugin.js', 'agy-local-host.js', 'agy-local-runtime.js', 'agy-local-background.js', 'agy-local-context.js', 'agy-local-progress.js', 'agy-local-tool-data.js',
    'agy-local-proxy.js', 'agy-local-mcp.js', 'agy-local-lineage.js', 'agy-local-storage.js', 'agy-local-persona.js', 'agy-ingress.js', 'agy-identity.js',
    'agy-launch.js', 'agy-acp-client.js', 'agy-session.js', 'agy-turn-session.js', 'agy-turn-options.js'];
  const expected = [...runtime.map(file => `lib/${file}`), 'package.json', 'NOTICE', 'LICENSE', 'LICENSE-DSH',
    'README.md', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json'];
  assert.deepEqual([...files.keys()].sort(), expected.map(file => `package/${file}`).sort());
  for (const file of expected) {
    const archived = files.get(`package/${file}`);
    const source = await readFile(new URL(file, root));
    // pnpm serializes the manifest; compare fields rather than whitespace.
    if (file === 'package.json') assert.deepEqual(JSON.parse(archived), JSON.parse(source));
    else assert.ok(archived.equals(source), `packed bytes differ: ${file}`);
  }
});
