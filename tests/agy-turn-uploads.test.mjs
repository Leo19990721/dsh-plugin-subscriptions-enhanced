import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import test from 'node:test';
import { AGY_SELECTION, ORDINARY_SELECTION, createTurnHost } from './fixtures/agy-turn-host.mjs';

// All traffic is in-process; only these synthetic bytes can reach the owned store.
// A single RGB pixel with no metadata passes native PNG normalization unchanged.
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQT2wGAAHWARTNq1LKAAAAAElFTkSuQmCC', 'base64');
const installed = (name, run) => test(name, { timeout: 30_000 }, run);
const attachmentRoot = h => join(h.root, 'attachments', 'v1');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedFile = ({ bytes, name }) => ({ attachmentId: `sha256:${digest(bytes)}`, name, bytes: bytes.length });
const text = value => ({ type: 'text', text: value });
const receiptPart = receiptId => ({ type: 'file', receiptId });
const userMessages = (h, id) => h.events(id).filter(event => event.type === 'user/message').map(event => event.data);

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function deniedUpload(result) {
  assert.deepEqual(result, { ok: false, error: {
    code: 'session/attachment-invalid', message: 'Antigravity accepts text only.',
    details: { reason: 'MODEL_DOES_NOT_SUPPORT_ATTACHMENTS' },
  } });
}

function deniedPrompt(result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, 'session/agent-busy');
  assert.match(result.error.message, /text prompt/);
}

function objectPath(h, { bytes, mediaType }) {
  const hash = digest(bytes);
  return join(attachmentRoot(h), mediaType === undefined ? 'file-objects' : 'objects', hash.slice(0, 2), hash);
}

function encoded(h, id, { bytes, name }, who) {
  return h.post('fileUploads', 'upload', { agentId: id, request: { data: bytes.toString('base64'), name } }, who);
}

function bodyProbe(bytes) {
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) {
    pulls++;
    controller.enqueue(bytes);
    controller.close();
  } }, { highWaterMark: 0 });
  return { body, get pulls() { return pulls; } };
}

async function waitForBoundary(t, ready, upload) {
  t.signal.throwIfAborted();
  const stopped = Promise.withResolvers();
  using abort = addAbortListener(t.signal, () => stopped.reject(t.signal.reason));
  return await Promise.race([ready, stopped.promise, upload.then(result => {
    assert.fail(`Upload settled before its held boundary: ${JSON.stringify(result)}`);
  })]);
}

installed('ACP refuses native raw files, PNGs and encoded files before attachment intake', async t => {
  const { symbols } = await import('@deepseek-ai/cordis');
  const h = await createTurnHost(t, { withUploads: true });
  const id = await h.create();
  const agent = h.agent(id);
  assert.equal(h.ctx.attachments.root, attachmentRoot(h));
  const store = h.ctx.attachments[symbols.original];
  const writes = ['saveFileStream', 'saveImages', 'admitEncodedFile', 'saveFile'].map(method => t.mock.method(store, method));
  const raw = { bytes: Buffer.from([0, 255, 68, 83, 72, 0, 137]), name: 'synthetic-raw.bin' };
  const png = { bytes: pngBytes, name: 'synthetic-pixel.png', mediaType: 'image/png' };
  const base64 = { bytes: Buffer.from('Synthetic encoded bytes.\0\n'), name: 'synthetic-encoded.bin' };

  assert.deepEqual(ok(await h.select(id)), { selected: AGY_SELECTION });
  const before = h.events(id);
  for (const specimen of [raw, png]) {
    const input = bodyProbe(specimen.bytes);
    deniedUpload(await h.uploadBinary(id, { ...specimen, bytes: input.body }));
    assert.equal(input.pulls, 0, `${specimen.name}: the streaming route never pulled the body`);
  }
  deniedUpload(await encoded(h, id, base64, 'api'));
  assert.deepEqual(writes.map(spy => spy.mock.callCount()), [0, 0, 0, 0]);
  for (const specimen of [raw, png, base64]) await assert.rejects(lstat(objectPath(h, specimen)), { code: 'ENOENT' });
  await assert.rejects(lstat(attachmentRoot(h)), { code: 'ENOENT' }, 'even the staging directory stays absent');
  assert.deepEqual(h.events(id), before);
  assert.equal(agent.inbox.hasPending, false);
  assert.deepEqual(h.acpCalls, []);

  assert.deepEqual(ok(await h.select(id, ORDINARY_SELECTION)), { selected: ORDINARY_SELECTION });
  assert.equal(h.agent(id), agent);
  for (const specimen of [raw, png, base64]) {
    const value = ok(await (specimen === base64 ? encoded(h, id, specimen, 'api') : h.uploadBinary(id, specimen)));
    assert.equal(typeof value.receiptId, 'string');
    assert.ok(value.receiptId.length > 0);
    const ref = specimen === png ? value.image : value.file;
    assert.deepEqual(ref, { ...expectedFile(specimen), ...(specimen === png ? { mediaType: 'image/png', width: 1, height: 1 } : {}) });
    assert.deepEqual(await readFile(objectPath(h, specimen)), specimen.bytes);
  }
  assert.deepEqual(writes.map(spy => spy.mock.callCount()), [1, 1, 1, 1], 'the same store and routes accept bytes on DSH');
});

installed('an existing DSH upload receipt survives an ACP prompt refusal and works again on DSH', async t => {
  const { symbols } = await import('@deepseek-ai/cordis');
  const h = await createTurnHost(t, { withUploads: true });
  const id = await h.create();
  const agent = h.agent(id);
  const specimen = { bytes: Buffer.from('Synthetic retained receipt bytes.\n'), name: 'synthetic-reusable.txt' };
  const { receiptId, file } = ok(await h.uploadBinary(id, specimen));
  assert.deepEqual(file, expectedFile(specimen));
  assert.deepEqual(await readFile(objectPath(h, specimen)), specimen.bytes);
  const stored = { type: 'file', attachment: file };
  assert.deepEqual(h.ctx.fileUploads.resolve(agent, receiptId), stored);
  const receipts = h.ctx.fileUploads[symbols.original];
  const access = ['resolve', 'bindPrompt', 'retire'].map(method => t.mock.method(receipts, method));
  const admit = t.mock.method(h.ctx.attachments[symbols.original], 'admitPromptContent');

  ok(await h.select(id));
  const before = h.events(id);
  const requestId = randomUUID();
  const content = [text('Synthetic attachment prompt'), receiptPart(receiptId)];
  deniedPrompt(await h.prompt(id, content, { requestId }));
  assert.deepEqual(access.map(spy => spy.mock.callCount()), [0, 0, 0]);
  assert.equal(admit.mock.callCount(), 0);
  assert.deepEqual(h.events(id), before);
  assert.equal(agent.inbox.hasPending, false);
  assert.deepEqual(h.acpCalls, []);
  assert.deepEqual(h.ctx.fileUploads.resolve(agent, receiptId), stored);
  assert.deepEqual(await readFile(objectPath(h, specimen)), specimen.bytes);

  ok(await h.select(id, ORDINARY_SELECTION));
  assert.deepEqual(ok(await h.prompt(id, content, { requestId })), { accepted: true });
  await h.idle(id);
  assert.deepEqual(h.events(id).findLast(event => event.type === 'turn/end')?.data.reason, { kind: 'completed' });
  assert.equal(h.ordinaryCalls.length, 1);
  assert.deepEqual(h.acpCalls, []);
  assert.deepEqual(userMessages(h, id).filter(message => message.source.rpcId === requestId).map(message => message.content), [[content[0], stored]]);
  assert.equal(h.ctx.fileUploads.resolve(agent, receiptId), undefined, 'ordinary delivery retires the staged receipt');
  assert.deepEqual(await readFile(objectPath(h, specimen)), specimen.bytes, 'ordinary delivery retains the durable bytes');
});

installed('raw upload admission uses the selection after awaiting Agent resolution', async t => {
  const { symbols } = await import('@deepseek-ai/cordis');
  const h = await createTurnHost(t, { withUploads: true });
  const id = await h.create();
  const agent = h.agent(id);
  const service = h.ctx.fileUploads[symbols.original];
  const resolve = service.resolveAgent;
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  t.mock.method(service, 'resolveAgent', async function (sessionId) {
    const resolved = await resolve.call(this, sessionId);
    ready.resolve(resolved);
    await release.promise;
    return resolved;
  });
  const specimen = { bytes: Buffer.from('Synthetic bytes pending Agent resolution.'), name: 'synthetic-before-admission.bin' };
  const input = bodyProbe(specimen.bytes);
  const upload = h.uploadBinary(id, { ...specimen, bytes: input.body });
  let result;
  try {
    assert.equal(await waitForBoundary(t, ready.promise, upload), agent);
    assert.deepEqual(agent.model.current(), ORDINARY_SELECTION);
    assert.equal(input.pulls, 0);
    ok(await h.select(id));
  } finally {
    release.resolve();
    result = await upload;
  }
  deniedUpload(result);
  assert.equal(input.pulls, 0);
  await assert.rejects(lstat(objectPath(h, specimen)), { code: 'ENOENT' });
  await assert.rejects(lstat(attachmentRoot(h)), { code: 'ENOENT' });
});

installed('a raw upload admitted on DSH can finish after ACP selection and keep its receipt', async t => {
  const h = await createTurnHost(t, { withUploads: true });
  const id = await h.create();
  const agent = h.agent(id);
  const specimen = { bytes: Buffer.from('Synthetic in-flight DSH upload.\0'), name: 'synthetic-older.bin' };
  const next = { bytes: Buffer.from('Synthetic refused ACP upload.\0'), name: 'synthetic-newer.bin' };
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  const stream = new ReadableStream({ async pull(controller) {
    ready.resolve();
    await release.promise;
    controller.enqueue(specimen.bytes);
    controller.close();
  } }, { highWaterMark: 0 });
  const upload = h.uploadBinary(id, { ...specimen, bytes: stream });
  let result;
  try {
    await waitForBoundary(t, ready.promise, upload);
    const stagingDir = join(attachmentRoot(h), 'tmp');
    const staging = await readdir(stagingDir);
    assert.equal(staging.length, 1, 'the DSH upload already owns its staging file');
    await assert.rejects(lstat(objectPath(h, specimen)), { code: 'ENOENT' });
    ok(await h.select(id));
    const input = bodyProbe(next.bytes);
    deniedUpload(await h.uploadBinary(id, { ...next, bytes: input.body }));
    assert.equal(input.pulls, 0);
    assert.deepEqual(await readdir(stagingDir), staging);
    await assert.rejects(lstat(objectPath(h, next)), { code: 'ENOENT' });
  } finally {
    release.resolve();
    result = await upload;
  }
  assert.deepEqual(agent.model.current(), AGY_SELECTION);
  const { receiptId, file } = ok(result);
  assert.deepEqual(file, expectedFile(specimen));
  assert.deepEqual(await readFile(objectPath(h, specimen)), specimen.bytes);
  const stored = { type: 'file', attachment: file };
  assert.deepEqual(h.ctx.fileUploads.resolve(agent, receiptId), stored);
  const content = [text('Synthetic retained in-flight receipt'), receiptPart(receiptId)];
  deniedPrompt(await h.prompt(id, content));
  assert.deepEqual(h.acpCalls, []);
  assert.deepEqual(h.ctx.fileUploads.resolve(agent, receiptId), stored);

  ok(await h.select(id, ORDINARY_SELECTION));
  assert.deepEqual(ok(await h.prompt(id, content)), { accepted: true });
  await h.idle(id);
  assert.deepEqual(userMessages(h, id).map(message => message.content), [[content[0], stored]]);
});
