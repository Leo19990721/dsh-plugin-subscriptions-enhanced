import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as plugin from '../lib/agy-local-plugin.js';
import * as writing from '../lib/writing-host.js';
import { createTurnHost, ORDINARY_SELECTION } from './fixtures/agy-turn-host.mjs';

// Explicit opt-in. Synthetic data only; use the credential already managed by official agy.
const executable = process.env.AGY_LOCAL_SMOKE_EXE;
const model = process.env.AGY_LOCAL_SMOKE_MODEL ?? 'gemini-4-neon';
const selected = { provider: 'antigravity', model };
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=';
const marker = () => `PROBE-${randomBytes(5).toString('hex').toUpperCase()}`;
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const options = {
  releasedReader: true, withCompaction: true, withRetry: true, desktopRequests: true,
  withWorkingDirectory: true, localPermissions: { mode: 'danger-full-access', approval: 'never' }, localAttachments: true,
  async mountSubscription({ scope, root }) {
    const fiber = scope.plugin(plugin, { executable, proxy: process.env.AGY_LOCAL_SMOKE_PROXY,
      dataDir: join(root, 'agy-data'), agentsFile: join(root, 'fixture-rules.md') });
    await fiber.await();
    assert.equal(fiber.state, 2);
  },
};
async function ask(h, id, content, check) {
  const feed = await h.follow(id);
  try {
    assert.equal((await feed.next()).value.header.id, id);
    ok(await h.prompt(id, content));
    let reply, reasoning = '', deltas = 0;
    for (;;) {
      const { value, done } = await feed.next();
      assert.equal(done, false);
      const chunk = value.type === 'assistant-stream' && value.frame.chunk;
      if (chunk?.type === 'text-delta') deltas++;
      if (chunk?.type === 'reasoning-delta') reasoning += chunk.text;
      if (value.type === 'event' && value.event.type === 'assistant/message') reply = value.event.data.message;
      if (value.type === 'event' && value.event.type === 'turn/end') {
        assert.deepEqual(value.event.data.reason, { kind: 'completed' });
        break;
      }
    }
    assert.ok(deltas > 0, 'DSH received live ACP text chunks');
    assert.equal(reply?.source.provider, selected.provider);
    assert.equal(reply.source.model, model);
    const text = reply.content.filter(block => block.type === 'text').map(block => block.text).join('');
    check(text, reasoning);
    await h.idle(id);
  } finally { await feed.return(); }
}

test('the built bundle streams local file tools and restores the official conversation after the Host is recreated', {
  skip: !executable && 'Set AGY_LOCAL_SMOKE_EXE to the verified official agy.exe to run the signed acceptance', timeout: 240_000,
}, async t => {
  const file = marker(), recall = marker(), global = marker(), attached = marker(), edited = marker(), history = marker(), mcp = marker();
  const h = await createTurnHost(t, { ...options, localMcpMarker: mcp });
  const fiber = h.ctx.plugin(writing, { localGoogle: true });
  await fiber.await();
  assert.equal(fiber.state, 2);
  const working = join(h.cwd, '实际目录');
  await mkdir(working);
  h.apis.workingDirectory = working;
  await writeFile(join(working, 'gemini-local-fixture.txt'), file);
  await writeFile(join(h.root, 'fixture-rules.md'), `# Synthetic rule\nIf the user asks for the global rules marker, it is ${global}. Do not open this file.\n`);
  const id = await h.create();
  const session = h.agent(id).session;
  const catalog = ok(await h.post('session', 'modelCatalog', {}));
  assert.ok(catalog.groups.some(group => group.id === selected.provider && group.models.some(row => row.id === model)), 'agy reported the requested Gemini');
  ok(await h.select(id, ORDINARY_SELECTION));
  ok(await h.prompt(id, `The previous-model marker to carry forward is ${history}.`));
  await h.idle(id);
  assert.deepEqual(ok(await h.select(id, selected)), { selected });
  await ask(h, id, `This is a synthetic integration test. In the current directory, use your own file tool to read relative gemini-local-fixture.txt. Report its exact value. Use the available DSH MCP tool with a name ending in dsh_integration_marker and return its exact value. Also return the previous-model marker in DSH history and the global rules marker from your already loaded instructions. Remember the new memory marker ${recall} for future turns. Limit your actions to this file read and local MCP call.`, (text, reasoning) => {
    for (const value of [file, history, global, mcp]) assert.ok(text.includes(value), `first live reply contains ${value}: ${text}`);
    assert.match(reasoning, /工具(?:执行中|已完成)：.*gemini-local-fixture\.txt/);
  });
  assert.equal(h.agent(id).session, session);
  const upload = await h.uploadBinary(id, { bytes: Buffer.from(attached), name: 'signed-attachment.txt' });
  const receiptId = upload.value?.receiptId ?? upload.receiptId ?? upload.id;
  assert.equal(typeof receiptId, 'string', JSON.stringify(upload));
  await ask(h, id, [
    { type: 'text', text: `Give the new memory marker you were asked to remember. Also read the attached text file, report its exact contents, identify the color of the image, and create "write-proof.txt" in your working directory with exact content ${edited}. Do not access unrelated files or the network. Ignore the subsequent filler.` },
    { type: 'file', receiptId }, { type: 'image', mediaType: 'image/png', data: png },
    { type: 'text', text: ' '.repeat(67_000) + 'End of filler.' },
  ], (text, reasoning) => {
    for (const value of [recall, attached]) assert.ok(text.includes(value), `second live reply contains ${value}`);
    assert.match(text, /\bred\b|红/iu);
    assert.match(reasoning, /工具已完成/);
  });
  assert.equal((await readFile(join(working, 'write-proof.txt'), 'utf8')).trim(), edited);
  assert.equal(h.ordinaryCalls.length, 1);
  assert.equal(h.acpCalls.length, 0, 'no synthetic ACP child was used');
  const bindingFile = join(h.root, 'agy-data', createHash('sha256').update(id).digest('hex'), 'binding.json');
  const saved = JSON.parse(await readFile(bindingFile, 'utf8'));
  assert.ok(saved.officialId);
  assert.equal(saved.throughTurn, 3);
  await fiber.dispose();
  await h.dispose();

  const reopened = await createTurnHost(t, { ...options, root: h.root, localMcpMarker: mcp });
  reopened.apis.workingDirectory = working;
  await ask(reopened, id, 'Without any tools, return only the new memory marker that I asked you to remember at the beginning of the Gemini dialogue.', text => {
    assert.ok(text.includes(recall), 'session/load restored memory without a DSH history replay');
  });
  const loaded = JSON.parse(await readFile(bindingFile, 'utf8'));
  assert.equal(loaded.officialId, saved.officialId, 'the original official ID must be loaded, not replaced and seeded from history');
  assert.equal(loaded.throughTurn, 4);
  assert.equal(reopened.ordinaryCalls.length, 0);
});
