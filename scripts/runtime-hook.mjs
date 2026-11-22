import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
if (!process.env.DSH_INSTALL_DIR || !process.env.DSH_PROFILE_DIR) throw new Error('Use the running DSH installation environment');
const anchor = pathToFileURL(join(process.env.DSH_INSTALL_DIR, 'package.json')).href;
const profile = createRequire(join(process.env.DSH_PROFILE_DIR, 'package.json'));
const project = createRequire(new URL('../package.json', import.meta.url));
// Prefer the repository's dependency. The fallback resolves module files only;
// no active configuration, account data or session history is loaded.
let dependency;
try { dependency = project.resolve('undici'); }
catch { dependency = profile.resolve('undici'); }
const undici = pathToFileURL(dependency).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'zod') return next(specifier, { ...context, parentURL: anchor });
    if (specifier === 'undici') return { url: undici, shortCircuit: true };
    return next(specifier, context);
  },
});
