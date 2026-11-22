// Test-only source injection. The installed FileUploads class, native routes,
// and attachment storage stay intact apart from the shared admission check.
import { Buffer } from 'node:buffer';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AGY_TURN_PROVIDER } from '../../src/agy-turn-input.js';
import { loadPinned } from './dsh-turn-runtime.mjs';

const SHA256 = 'b17e3621ce127ceb4f68919acdeeac64c54cf64c5d42429be8a7a65b5d20bbfe';
const STORE = '\t\tasync store(agent, save) {\n\t\t\tthis.assertOrdinaryAgent(agent);\n';

/** Load the pinned rc.5 upload service without touching normal module imports or files. */
export async function loadTurnUploadFixture(anchorDir) {
  const { bundle, source } = await loadPinned(anchorDir, 'dsh-client-file-upload', SHA256);
  const offset = source.indexOf(STORE);
  if (offset < 0 || source.indexOf(STORE, offset + 1) !== -1) {
    throw new Error('DSH 0.2.2-rc.5 FileUploads.store anchor missing or ambiguous');
  }
  const guard = `\t\t\tif (agent.model.current()?.provider === ${JSON.stringify(AGY_TURN_PROVIDER)}) {
\t\t\t\tthrow new RemoteError('session/attachment-invalid', 'Antigravity accepts text only.', { reason: 'MODEL_DOES_NOT_SUPPORT_ATTACHMENTS' });
\t\t\t}\n`;
  // Admission is synchronous after the raw route resolves the Agent. Once
  // admitted, the native save and receipt staging may finish after a switch.
  const boundary = offset + STORE.length;
  const patched = source.slice(0, boundary) + guard + source.slice(boundary);
  const url = `data:text/javascript;base64,${Buffer.from(patched, 'utf8').toString('base64')}`;
  const parentURL = pathToFileURL(bundle).href;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return next(specifier, context.parentURL === url ? { ...context, parentURL } : context);
    },
  });
  try {
    const { FileUploads } = await import(url);
    if (typeof FileUploads !== 'function') throw new Error('Pinned FileUploads fixture export is unavailable');
    return { FileUploads };
  } finally {
    hook.deregister();
  }
}
