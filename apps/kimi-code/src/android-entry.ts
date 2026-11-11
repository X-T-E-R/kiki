import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { dispatchMobileCliEntry } from './mobile-entry';

export * from './mobile-entry';

function isAndroidEntryDirectExecution(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isAndroidEntryDirectExecution()) {
  dispatchMobileCliEntry('android');
}
