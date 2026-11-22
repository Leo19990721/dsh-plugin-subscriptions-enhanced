// This fixture runs two installed, DOM-free Client leaves (the submit machine
// and the Connection caller). It does not load a Client page or connect to a
// Host. The bridge below owns synthetic draft metadata and injected I/O only.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agyTurnDraftProblem, canTakeAgyTurnAttachments } from '../../src/agy-turn-input.js';

const VERSION = '0.2.2-rc.5';
const PINNED = Object.freeze({
  machine: ['dsh-client-ui-conversation', 'src/client/input/machine.ts', '3ffcbbd565a2e9dee058c7f7689eb99aa032a95c0be7593b1d411afdc841f472'],
  caller: ['dsh-client-connection', 'src/client/rpc.ts', '8a55426351dfc3b4150b6fdd60daf20735824cbb90b4b806321ec442c639e460'],
  uuid: ['dsh-client-connection', 'src/client/random-uuid.ts', 'c037b0e0224ca27a70682fd86d06e3527e6f45acf467b0b70a56e1d8c3000f7c'],
  rpc: ['dsh-client-connection', 'src/rpc.ts', '74ba5632fea441a4c76de677ddeb840de51a775b42514c0908a3ef207339d94b'],
  sessionTypes: ['dsh-session', 'lib/types/types.js', '91723a2522999e2c8b6c455796ad699794a6f0abfcb44d9cb883edb13142ff9b'],
});

async function checkManifest(path, name) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(manifest.name, name, `expected ${name} for the native Client fixture`);
  assert.equal(manifest.version, VERSION, `expected installed ${name}@${VERSION}`);
}

async function readPinned(resolve, [id, relativePath, sha256]) {
  const name = `@deepseek-ai/${id}`;
  const manifestPath = resolve(`${name}/package.json`);
  await checkManifest(manifestPath, name);
  const path = join(dirname(manifestPath), relativePath);
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256,
    `native Client fixture source differs from the installed ${VERSION} pin: ${id}/${relativePath}`);
  return { path, source: bytes.toString('utf8') };
}

const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const strip = ({ path, source }) => stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: pathToFileURL(path).href });

function linkLocal(source, specifier, url) {
  const literal = `'${specifier}'`;
  assert.equal(source.split(literal).length, 2, `expected one runtime import of ${specifier}`);
  return source.replace(literal, JSON.stringify(url));
}

export async function loadNativeComposer(install = process.env.DSH_INSTALL_DIR) {
  assert.ok(typeof install === 'string' && isAbsolute(install), 'DSH_INSTALL_DIR must point to the installed DSH CLI package');
  if (/\.asar(?:[\\/]|$)/i.test(install)) assert.ok(process.versions.electron, 'run this Desktop fixture in Electron as Node');
  const manifest = join(install, 'package.json');
  await checkManifest(manifest, '@deepseek-ai/dsh');
  const resolve = createRequire(manifest).resolve;
  const [machine, caller, uuid, rpc, sessionTypes] = await Promise.all(Object.values(PINNED).map(pin => readPinned(resolve, pin)));
  // Strip only types; the Connection's two local specifiers point to copies of
  // those exact pinned modules in memory. No process-wide loader hook is needed.
  const callerSource = linkLocal(linkLocal(strip(caller), '../rpc.ts', asModule(strip(rpc))),
    './random-uuid.ts', asModule(strip(uuid)));
  const [{ SubmitMachine }, { createWebConnectionRpc }, { SessionId }] = await Promise.all([
    import(asModule(strip(machine))), import(asModule(callerSource)), import(pathToFileURL(sessionTypes.path).href),
  ]);
  for (const value of [SubmitMachine, createWebConnectionRpc, SessionId]) assert.equal(typeof value, 'function');
  return Object.freeze({ SubmitMachine, createWebConnectionRpc, SessionId });
}

function copyDraft({ text = '', attachmentIds = [], references = [], quotes = [] } = {}) {
  return Object.freeze({ text, attachmentIds: Object.freeze([...attachmentIds]),
    references: Object.freeze([...references]), quotes: Object.freeze([...quotes]) });
}

/** Drive the real machine with application metadata and an in-memory transport. */
export function bindSyntheticComposer(native, { id, selection, draft, serialize, doFetch }) {
  assert.equal(typeof serialize, 'function', 'a synthetic serializer is required');
  assert.equal(typeof doFetch, 'function', 'a synthetic fetch is required (never use the browser default)');
  const sessionId = native.SessionId(id);
  const machine = new native.SubmitMachine();
  const rpc = native.createWebConnectionRpc(doFetch);
  let entry = copyDraft(draft);
  let current = selection;

  return {
    sessionId,
    get draft() { return entry; },
    get phase() { return machine.state.phase; },
    select(next) { current = next; },
    takeAttachment(allocate) {
      if (!canTakeAgyTurnAttachments(current) || !['plain', 'claimed'].includes(machine.state.phase)) return false;
      entry = copyDraft({ ...entry, attachmentIds: [...entry.attachmentIds, allocate()] });
      return true;
    },
    async submit(mode = 'queue') {
      const effects = machine.dispatch({ type: 'enter', mode, draft: entry.text,
        occurrences: entry.references, quotes: entry.quotes, attachmentIds: entry.attachmentIds });
      if (effects.length === 0) return { kind: 'ignored' };
      const [effect] = effects;
      assert.equal(effect.type, 'default-sink', 'this bridge covers the ordinary message path only');
      const { attempt } = effect;
      // Proposed insertion point: only the default sink, after command
      // arbitration and before reference or attachment serialization.
      const problem = agyTurnDraftProblem(current, { attachmentIds: attempt.attachmentIds, references: attempt.occurrences });
      if (problem !== undefined) {
        machine.dispatch({ type: 'sink-settled', attempt, ok: false, message: problem });
        return { kind: 'blocked', problem };
      }
      let result;
      try {
        const content = await serialize(attempt);
        result = await rpc.call('/api', 'session/prompt', { args: { request: {
          requestId: randomUUID(), sessionId, mode: effect.mode, content, clientTimeZone: 'UTC',
        } } }, attempt.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        machine.dispatch({ type: 'sink-settled', attempt, ok: false, message });
        return { kind: 'error', message };
      }
      const accepted = result.ok && result.value?.accepted === true;
      const settled = machine.dispatch({ type: 'sink-settled', attempt, ok: accepted });
      // The real machine decides when it is safe to commit; the fixture models
      // the facade with one owned object instead of a Lexical editor/storage.
      if (settled.some(effect => effect.type === 'commit-draft')) entry = copyDraft();
      return accepted ? { kind: 'success' } : { kind: 'error', code: result.error?.code };
    },
  };
}
