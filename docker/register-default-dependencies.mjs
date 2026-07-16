import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const defaults = new Map([
  ['sharp', pathToFileURL(require.resolve('sharp')).href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const fallback = defaults.get(specifier);
      if (!fallback || error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return { url: fallback, shortCircuit: true };
    }
  },
});
