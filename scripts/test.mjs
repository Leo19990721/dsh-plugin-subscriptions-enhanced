import { run } from 'node:test';
import { spec } from 'node:test/reporters';
const portable = process.argv.includes('--portable');
const installed = !portable && Boolean(process.env.DSH_INSTALL_DIR && process.env.DSH_PROFILE_DIR)
  && (!process.env.DSH_INSTALL_DIR.includes('.asar') || Boolean(process.versions.electron));
if (process.argv.includes('--require-installed') && !installed) {
  console.error('Installed DSH checks were required. Use the installed runtime (Desktop: Electron as Node) and the DSH installation paths.');
  process.exit(1);
}
if (installed) await import('./runtime-hook.mjs');
const files = ['tests/client.test.mjs', 'tests/release.test.mjs', 'tests/writing.test.mjs', 'tests/retire-antigravity.test.mjs',
  'tests/agy-acp-client.test.mjs', 'tests/agy-session.test.mjs', 'tests/agy-host.test.mjs', 'tests/agy-client.test.mjs', 'tests/agy-release-status.test.mjs',
  'tests/agy-turn-context.test.mjs', 'tests/agy-turn-options.test.mjs', 'tests/agy-turn-session.test.mjs', 'tests/agy-turn-executor.test.mjs',
  'tests/agy-native-trial-auth.test.mjs', 'tests/agy-native-trial.test.mjs', 'tests/agy-subscription-cli.test.mjs', 'tests/agy-local-runtime.test.mjs',
  'tests/v030-gemini6-portable.test.mjs', 'tests/agy-local-file-links.test.mjs'];
if (installed) files.push('tests/integration.test.mjs', 'tests/writing-runtime.test.mjs', 'tests/subscriptions-upstream.test.mjs',
  'tests/agy-native-agent.test.mjs', 'tests/agy-native-cache.test.mjs', 'tests/agy-native-turn.test.mjs', 'tests/agy-turn-boundaries.test.mjs',
  'tests/agy-native-composer.test.mjs', 'tests/agy-turn-uploads.test.mjs', 'tests/agy-subscription-host.test.mjs',
  'tests/agy-subscription-rollback.test.mjs', 'tests/agy-local-persona.test.mjs', 'tests/agy-local-chat.test.mjs', 'tests/agy-local-subagents.test.mjs', 'tests/agy-local-plugin.test.mjs', 'tests/v030-gemini6-installed.test.mjs');
else console.log('Running portable checks. Installed Desktop verification requires Electron as Node and DSH installation paths.');
const stream = run({ files, isolation: 'none' });
stream.on('test:fail', () => { process.exitCode = 1; });
stream.compose(spec).pipe(process.stdout);
