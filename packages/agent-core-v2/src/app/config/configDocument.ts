import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { Error2, ErrorCodes } from '#/errors';
import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { StorageReadOptions } from '#/persistence/interface/storage';

import { deepEqual, isPlainObject, stripTomlBom } from './configPure';
import { planConfigWriteback, type DomainUpdate } from './tomlWriteback';

const CONFIG_SCOPE = '';

export async function readConfigDocumentSnapshot(
  store: IAtomicTomlDocumentStore,
  key: string,
  options?: StorageReadOptions,
): Promise<{ readonly data: Record<string, unknown>; readonly text: string | undefined }> {
  const text = await store.getText(CONFIG_SCOPE, key, options);
  const parsed: unknown = text === undefined ? {} : parseToml(stripTomlBom(text));
  return { data: isPlainObject(parsed) ? parsed : {}, text };
}

export async function writeConfigDocument(
  store: IAtomicTomlDocumentStore,
  key: string,
  before: Record<string, unknown>,
  originalText: string | undefined,
  after: Record<string, unknown>,
): Promise<string | undefined> {
  if (deepEqual(before, after)) return undefined;
  const updates: DomainUpdate[] = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((snakeKey) => ({ snakeKey, previousValue: before[snakeKey], nextValue: after[snakeKey] }));
  const plannedText = originalText === undefined
    ? undefined
    : planConfigWriteback(originalText, updates, after);
  const next = plannedText ?? `${stringifyToml(after)}\n`;
  if (next === originalText) return undefined;
  let published: boolean;
  try {
    published = await store.compareAndSetText(CONFIG_SCOPE, key, originalText, next);
  } catch (error) {
    let observed: string | undefined;
    try {
      observed = await store.getText(CONFIG_SCOPE, key);
    } catch (readError) {
      throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Configuration write failed and the on-disk state could not be checked. Reload and inspect the config file.', { cause: readError });
    }
    if (observed === next) {
      try {
        if (!await store.compareAndSetText(CONFIG_SCOPE, key, next, originalText)) {
          throw new Error('Rollback conflicted with another writer', { cause: error });
        }
      } catch (rollbackError) {
        throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Configuration write failed and rollback could not be completed. Reload and inspect the config file.', { cause: rollbackError });
      }
    } else if (observed !== originalText) {
      throw new Error2(ErrorCodes.CONFIG_PERSIST_BLOCKED, 'Configuration write failed and another writer changed the file. Reload and inspect the config file.', { cause: error });
    }
    throw error;
  }
  if (!published) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Configuration changed while writing. Reload settings and retry.', { details: { reason: 'write_conflict' } });
  }
  return next;
}
