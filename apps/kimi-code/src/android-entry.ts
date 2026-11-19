import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { dispatchMobileCliEntry } from './mobile-entry';

export * from './mobile-entry';

function canonicalPath(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isAndroidEntryDirectExecution(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return canonicalPath(argv1) === canonicalPath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isAndroidEntryDirectExecution()) {
  dispatchMobileCliEntry('android');
}
