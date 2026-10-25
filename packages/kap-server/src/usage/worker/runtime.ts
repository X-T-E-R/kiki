import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

let entryPath: string | undefined;

/** Select a packaged pure usage parser asset without starting its isolate. */
export function configureUsageWorkerRuntime(path: string): void {
  if (!isAbsolute(path) || !statSync(path).isFile()) throw new TypeError('Usage worker requires an absolute regular file');
  if (entryPath !== undefined && entryPath !== path) throw new Error('Usage worker runtime is already configured');
  entryPath = path;
}

export function usageWorkerEntry(): string | undefined { return entryPath; }
export function resetUsageWorkerRuntime(): void { entryPath = undefined; }
