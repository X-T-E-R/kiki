import {
  ATOMIC_TEMP_READY_SUFFIX,
  AtomicWriteChmodError,
  atomicCreate as kaosAtomicCreate,
  atomicWrite as kaosAtomicWrite,
  atomicWriteStream as kaosAtomicWriteStream,
  atomicWriteSync as kaosAtomicWriteSync,
  registerWin32MoveFileReplace,
  replaceFileNonDestructive,
  syncDir,
  syncDirSync,
  writeFileAtomicDurable,
  type Win32MoveFileReplace,
} from '@kiki/kaos/atomic-fs';

import { BugIndicatingError } from '#/_base/errors/errors';

export {
  ATOMIC_TEMP_READY_SUFFIX,
  registerWin32MoveFileReplace,
  replaceFileNonDestructive,
  syncDir,
  syncDirSync,
  writeFileAtomicDurable,
  type Win32MoveFileReplace,
};

function rethrowAtomicChmodError(error: unknown): never {
  if (error instanceof AtomicWriteChmodError) {
    throw new BugIndicatingError(error.message);
  }
  throw error;
}

export async function atomicWrite(
  ...args: Parameters<typeof kaosAtomicWrite>
): Promise<void> {
  try {
    await kaosAtomicWrite(...args);
  } catch (error) {
    rethrowAtomicChmodError(error);
  }
}

export function atomicWriteSync(
  ...args: Parameters<typeof kaosAtomicWriteSync>
): void {
  try {
    kaosAtomicWriteSync(...args);
  } catch (error) {
    rethrowAtomicChmodError(error);
  }
}

export async function atomicCreate(
  ...args: Parameters<typeof kaosAtomicCreate>
): Promise<void> {
  try {
    await kaosAtomicCreate(...args);
  } catch (error) {
    rethrowAtomicChmodError(error);
  }
}

export async function atomicWriteStream(
  ...args: Parameters<typeof kaosAtomicWriteStream>
): Promise<void> {
  try {
    await kaosAtomicWriteStream(...args);
  } catch (error) {
    rethrowAtomicChmodError(error);
  }
}
