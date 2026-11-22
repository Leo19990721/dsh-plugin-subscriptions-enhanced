import assert from 'node:assert/strict';
import test from 'node:test';
import { AGY_TURN_PROVIDER } from '../src/agy-turn-input.js';
import { bindSyntheticComposer, loadNativeComposer } from './fixtures/dsh-native-composer.mjs';

const normal = Object.freeze({ provider: 'codex', model: 'synthetic-dsh' });
const acp = Object.freeze({ provider: AGY_TURN_PROVIDER, model: 'synthetic-acp' });
const idA = 'a14804ec-f383-4f0c-8f5c-d695543bdc9d';
const idB = 'fea39b55-359d-4ffc-80b6-ffb11c74d412';
const uuidV4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const accepted = { ok: true, value: { accepted: true } };
let native;
const getNative = () => native ??= loadNativeComposer();

function inspectPrompt(route, init, sessionId, content) {
  assert.equal(route, 'api/session/prompt');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal);
  const envelope = JSON.parse(init.body);
  const { rpcId, payload: { args: { request: { requestId } } } } = envelope;
  assert.match(rpcId, uuidV4);
  assert.match(requestId, uuidV4);
  assert.notEqual(rpcId, requestId, 'transport correlation and prompt admission identities are independent');
  assert.deepEqual(envelope, { type: 'client-request', rpcId, method: 'session/prompt', payload: { args: { request: {
    requestId, sessionId, mode: 'queue', content, clientTimeZone: 'UTC',
  } } } });
  return { rpcId, requestId };
}

const reply = (rpcId, result) => Response.json({ type: 'server-response', rpcId, result });

const enter = (machine, draft, attachments = []) => machine.dispatch({
  type: 'enter', draft, attachmentIds: attachments, mode: 'queue', occurrences: [], quotes: [],
});

test('installed SubmitMachine commits only the current accepted ordinary attempt', async () => {
  const { SubmitMachine } = await getNative();
  const machine = new SubmitMachine();
  const attachmentIds = Object.freeze(['fixture-file', 'fixture-image']);
  assert.deepEqual(enter(machine, ' '), []);
  const [{ attempt: first }] = enter(machine, ' ', attachmentIds);
  assert.equal(machine.state.phase, 'sending', 'a native attachment-only message occupies the send slot');
  assert.deepEqual(first.attachmentIds, attachmentIds);
  assert.deepEqual(enter(machine, 'not a second prompt'), []);
  assert.deepEqual(machine.dispatch({ type: 'sink-settled', attempt: first, ok: false, message: 'Synthetic refusal' }), [
    { type: 'notice', level: 'error', text: 'Synthetic refusal' },
  ]);
  assert.equal(machine.state.phase, 'plain');

  const [{ attempt: second }] = enter(machine, 'retry');
  assert.equal(machine.sendingAttempt, second);
  assert.deepEqual(machine.dispatch({ type: 'sink-settled', attempt: first, ok: true }), [], 'late first receipt does not clear the retry');
  assert.equal(machine.state.phase, 'sending');
  assert.deepEqual(machine.dispatch({ type: 'sink-settled', attempt: second, ok: true }), [
    { type: 'commit-draft', retainSuffixOf: null },
  ]);
  assert.equal(machine.state.phase, 'plain');

  const [{ attempt: released }] = enter(machine, 'Session scope released');
  assert.deepEqual(machine.dispatch({ type: 'release' }), []);
  assert.equal(released.signal.aborted, true);
  assert.deepEqual(machine.dispatch({ type: 'sink-settled', attempt: released, ok: true }), []);
});

test('installed SubmitMachine dispatches /model to command arbitration before any ordinary prompt', async () => {
  const { SubmitMachine } = await getNative();
  const machine = new SubmitMachine();
  const [slash] = enter(machine, '/model');
  assert.equal(slash.type, 'adjudicate');
  assert.equal(machine.state.phase, 'adjudicating');
  assert.deepEqual(enter(machine, 'second Enter'), []);
  // Only the command source's verdict is synthetic here. This does not run the popup.
  assert.deepEqual(machine.dispatch({ type: 'adjudicated', attempt: slash.attempt, outcome: 'handled' }), []);
  assert.equal(machine.state.phase, 'plain');
});

test('same Session and draft survive an ACP refusal and clear only on later acceptance', { timeout: 5_000 }, async () => {
  const modules = await getNative();
  const pending = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const identities = [];
  const text = '合成草稿，切换前已输入';
  const a = bindSyntheticComposer(modules, { id: idA, selection: normal, draft: { text },
    serialize: attempt => [{ type: 'text', text: attempt.draftSnapshot }],
    async doFetch(route, init) {
      const identity = inspectPrompt(route, init, idA, [{ type: 'text', text }]);
      identities.push(identity);
      if (identities.length === 1) {
        reached.resolve();
        return reply(identity.rpcId, await pending.promise);
      }
      return reply(identity.rpcId, accepted);
    },
  });
  const b = bindSyntheticComposer(modules, { id: idB, selection: normal, draft: { text: '独立会话的草稿' },
    serialize: () => assert.fail('the other Session must not serialize'),
    doFetch: () => assert.fail('the other Session must not send'),
  });
  const before = a.draft;
  const other = b.draft;
  a.select(acp);
  assert.equal(a.sessionId, idA);
  assert.equal(a.draft, before);
  const inFlight = a.submit();
  await Promise.race([reached.promise, inFlight.then(() => assert.fail('native prompt did not reach the synthetic transport'))]);
  assert.equal(a.phase, 'sending');
  assert.equal(a.draft, before, 'waiting for the Host keeps the draft');
  assert.deepEqual(await a.submit(), { kind: 'ignored' });
  pending.resolve({ ok: false, error: { code: 'fixture/refused', message: 'Synthetic refusal', details: {} } });
  assert.deepEqual(await inFlight, { kind: 'error', code: 'fixture/refused' });
  assert.equal(a.phase, 'plain');
  assert.equal(a.draft, before);
  assert.equal(b.draft, other);

  a.select(normal);
  assert.equal(a.draft, before);
  assert.deepEqual(await a.submit(), { kind: 'success' });
  assert.equal(a.sessionId, idA);
  assert.notEqual(identities[0].requestId, identities[1].requestId);
  assert.notEqual(identities[0].rpcId, identities[1].rpcId);
  assert.deepEqual(a.draft, { text: '', attachmentIds: [], references: [], quotes: [] });
  assert.equal(b.draft, other);
});

test('text-only policy refuses attachment intake and keeps preexisting attachments until an ordinary send', async () => {
  const modules = await getNative();
  const content = [{ type: 'file', receiptId: 'synthetic-file-receipt' },
    { type: 'file', receiptId: 'synthetic-image-receipt' }, { type: 'text', text: '合成附带文字' }];
  let serialized = 0;
  let sent = 0;
  const composer = bindSyntheticComposer(modules, { id: idA, selection: normal, draft: { text: '合成附带文字' },
    serialize(attempt) {
      serialized += 1;
      assert.deepEqual(attempt.attachmentIds, ['file', 'image']);
      return content;
    },
    doFetch(route, init) {
      sent += 1;
      const { rpcId } = inspectPrompt(route, init, idA, content);
      return reply(rpcId, accepted);
    },
  });
  assert.equal(composer.takeAttachment(() => 'file'), true);
  assert.equal(composer.takeAttachment(() => 'image'), true);
  const before = composer.draft;
  composer.select(acp);
  let allocated = false;
  assert.equal(composer.takeAttachment(() => { allocated = true; return 'must-not-be-allocated'; }), false);
  assert.equal(allocated, false, 'the upload-start callback must never run under the text-only selection');
  assert.deepEqual(await composer.submit(), { kind: 'blocked', problem: 'attachments-unsupported' });
  assert.equal(serialized, 0);
  assert.equal(sent, 0);
  assert.equal(composer.phase, 'plain');
  assert.equal(composer.draft, before);
  composer.select(normal);
  assert.equal(composer.draft, before);
  assert.deepEqual(await composer.submit(), { kind: 'success' });
  assert.deepEqual(composer.draft.attachmentIds, []);
  assert.equal(serialized, 1);
  assert.equal(sent, 1);
});

test('semantic references are refused before their codec; synthetic quote text can remain in an ACP prompt', async () => {
  const modules = await getNative();
  const reference = Object.freeze({ occurrenceId: 'fixture-reference', source: 'reference', ref: '@fixture.txt',
    offset: 0, length: 12, clipboardText: '@fixture.txt', label: 'fixture.txt', appearance: 'file' });
  const withReference = bindSyntheticComposer(modules, { id: idA, selection: acp,
    draft: { text: reference.clipboardText, references: [reference] },
    serialize: () => assert.fail('an ACP reference must not reach serialization'),
    doFetch: () => assert.fail('an ACP reference must not reach the wire'),
  });
  const before = withReference.draft;
  assert.deepEqual(await withReference.submit(), { kind: 'blocked', problem: 'references-unsupported' });
  assert.equal(withReference.draft, before);

  const visible = '> fixture quote\n\n合成正文';
  const quote = Object.freeze({ text: 'fixture quote', offset: 0, length: '> fixture quote'.length });
  const withQuote = bindSyntheticComposer(modules, { id: idB, selection: acp, draft: { text: visible, quotes: [quote] },
    serialize(attempt) {
      assert.deepEqual(attempt.quotes, [quote]);
      // Already-rendered quote text for the transport test; no Lexical codec is loaded.
      return [{ type: 'text', text: attempt.draftSnapshot }];
    },
    doFetch(route, init) {
      return reply(inspectPrompt(route, init, idB, [{ type: 'text', text: visible }]).rpcId, accepted);
    },
  });
  assert.deepEqual(await withQuote.submit(), { kind: 'success' });
  assert.equal(withQuote.draft.text, '');
  assert.equal(withReference.draft, before);
});
