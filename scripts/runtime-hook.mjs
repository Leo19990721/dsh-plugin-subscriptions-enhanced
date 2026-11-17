import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
if (!process.env.DSH_INSTALL_DIR || !process.env.DSH_PROFILE_DIR) throw new Error('Use the running DSH installation environment');
const anchor = pathToFileURL(join(process.env.DSH_INSTALL_DIR, 'package.json')).href;
const profile = createRequire(join(process.env.DSH_PROFILE_DIR, 'package.json'));
const undici = pathToFileURL(profile.resolve('undici')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'zod') return next(specifier, { ...context, parentURL: anchor });
    if (specifier === 'undici') return { url: undici, shortCircuit: true };
    return next(specifier, context);
  },
});
