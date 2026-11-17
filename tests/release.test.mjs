import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);

test('public release keeps the existing subscription identity and uses its own repository metadata', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.name, 'dsh-plugin-subscriptions-enhanced');
  assert.equal(pkg.engines.dsh, '0.2.2-rc.3');
  assert.match(pkg.repository.url, /github\.com\/Leo19990721\/dsh-plugin-subscriptions-enhanced/);
  assert.ok(pkg.files.includes('NOTICE'));
  for (const file of ['README.md', 'scripts/pack.ps1', 'tests/gemini-prompt.test.mjs']) assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /[CE]:[\\/](?:Users|Personal|AI)/);
});

test('release preserves the upstream copyright and explains its fixed-version patch maintenance', async () => {
  const license = await readFile(new URL('LICENSE', root), 'utf8');
  const notice = await readFile(new URL('NOTICE', root), 'utf8');
  assert.match(license, /Copyright \(c\) 2026 V1ki/);
  assert.match(notice, /0\.9\.13/);
  assert.match(notice, /V1ki\/dsh-plugin-subscriptions/);
});

test('packed subscription release has no private host data or local source map paths', { skip: !process.env.RELEASE_TGZ && 'run against the packed release with RELEASE_TGZ' }, async () => {
  const { gunzipSync } = await import('node:zlib');
  const tar = gunzipSync(await readFile(process.env.RELEASE_TGZ));
  const names = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(at + 124, at + 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    const body = tar.subarray(at + 512, at + 512 + size).toString();
    names.push(name);
    assert.doesNotMatch(name, /(?:node_modules|\.git|accounts|credentials|sessions|\.env)(?:\/|$)/);
    assert.doesNotMatch(body, /[CE]:[\\/](?:Users|Personal|AI)|01a1d0eb-00b2/);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(names.includes('package/NOTICE'));
  assert.ok(names.includes('package/LICENSE'));
});
