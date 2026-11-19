import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Options for resolving a worker thread entry URL. */
export interface ResolveWorkerEntryOptions {
  readonly configuredEntry?: string;
  readonly unavailableMessage?: string;
}

/**
 * Resolve a worker thread entry from an explicit path override, a dev relative
 * path, or a bundled/SEA filename next to the current module.
 */
export function resolveWorkerEntry(
  importMetaUrl: string,
  devEntryRel: string,
  bundledFilename: string,
  options?: ResolveWorkerEntryOptions,
): URL {
  if (options?.configuredEntry !== undefined) {
    return pathToFileURL(options.configuredEntry);
  }
  const bundledRel = bundledFilename.startsWith('./') || bundledFilename.startsWith('../')
    ? bundledFilename
    : `./${bundledFilename}`;
  for (const relative of [devEntryRel, bundledRel]) {
    const entry = new URL(relative, importMetaUrl);
    try {
      if (statSync(entry).isFile()) return entry;
    } catch {}
  }
  throw new Error(options?.unavailableMessage ?? `Worker asset ${bundledFilename} is unavailable`);
}
