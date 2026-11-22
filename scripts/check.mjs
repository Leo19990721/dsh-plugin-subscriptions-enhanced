import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

for (const dir of ['src', 'lib', 'scripts']) {
  const folder = new URL(`../${dir}/`, import.meta.url);
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:mjs|js)$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(entry.name, folder))], {
      stdio: 'inherit', windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
