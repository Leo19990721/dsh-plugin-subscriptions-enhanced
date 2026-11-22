// Configuration-only Windows probe. No prompt or account changes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAgy } from '../src/agy-local-runtime.js';

const dataDir = await mkdtemp(join(tmpdir(), 'dsh-agy-efforts-'));
const runtime = createLocalAgy({ dataDir });
try {
  const signal = AbortSignal.timeout(60_000);
  let session = await runtime.open(signal);
  const models = session.options.model.options.filter(({ value }) => /^gemini-(?!pro-orchestrator)/u.test(value));
  console.log(JSON.stringify({ models: models.map(({ value }) => value) }));
  for (const { value } of models) {
    try {
      session ??= await runtime.open(signal);
      const { thoughtLevel } = await session.prepare({ model: value }, signal);
      console.log(JSON.stringify({ model: value, thoughtLevel }));
    } catch (error) {
      console.log(JSON.stringify({ model: value, error: error.code ?? 'probe-failed' }));
      process.exitCode = 1;
      await session?.close();
      session = undefined;
    }
  }
} finally {
  await runtime.dispose();
  await rm(dataDir, { recursive: true, force: true });
}
