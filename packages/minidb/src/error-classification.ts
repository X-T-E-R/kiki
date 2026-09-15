// src/error-classification.ts
//
// One verdict for "is this storage error worth destroying the store dir for?".
// A DERIVED store (a search index, a session index) is never repaired, only
// rebuilt, so its owner must tell corruption apart from a transient I/O
// failure: rebuilding on a full disk, a permission error, or a lock
// contention turns a recoverable hiccup into data loss. Every such owner must
// reach the SAME verdict, so the policy lives here once.

import { CorruptFrameError } from './codec.js';

export type StorageErrorAction = 'rebuild' | 'transient';

export function classifyStorageError(error: unknown): StorageErrorAction {
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => classifyStorageError(inner) === 'rebuild')
      ? 'rebuild'
      : 'transient';
  }
  if (error instanceof SyntaxError || error instanceof CorruptFrameError) return 'rebuild';
  const code = (error as { code?: unknown } | null | undefined)?.code;
  // The WAL declared itself unusable: its frames can no longer be trusted, and
  // no amount of retrying brings them back.
  if (code === 'WAL_WRITE_DISABLED' || code === 'WAL_POISONED') return 'rebuild';
  return 'transient';
}
