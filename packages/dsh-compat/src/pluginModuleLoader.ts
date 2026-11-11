import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const cjsRequire = createRequire(import.meta.url);

/**
 * Dynamically import a plugin module through Node's native ESM loader so that
 * `node:module.registerHooks` synchronously governs specifier resolution even
 * when the host process runs inside Vite/Vitest module runners.
 */
export async function importDshPluginModule<T = Record<string, unknown>>(
  entryPathOrUrl: string,
): Promise<T> {
  const target = entryPathOrUrl.startsWith('file:')
    ? entryPathOrUrl
    : isAbsolute(entryPathOrUrl)
      ? pathToFileURL(entryPathOrUrl).href
      : entryPathOrUrl;
  const loader = cjsRequire('./esmImportHelper.cjs') as {
    importModule: (specifier: string) => Promise<T>;
  };
  return loader.importModule(target);
}
