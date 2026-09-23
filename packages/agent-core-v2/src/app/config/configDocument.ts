import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { deepEqual } from './configPure';
import { planConfigWriteback, type DomainUpdate } from './tomlWriteback';

const CONFIG_SCOPE = '';

export async function writeConfigDocument(
  store: IAtomicTomlDocumentStore,
  key: string,
  before: Record<string, unknown>,
  originalText: string | undefined,
  after: Record<string, unknown>,
): Promise<void> {
  if (deepEqual(before, after)) return;
  const updates: DomainUpdate[] = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((snakeKey) => ({ snakeKey, previousValue: before[snakeKey], nextValue: after[snakeKey] }));
  const plannedText = originalText === undefined
    ? undefined
    : planConfigWriteback(originalText, updates, after);
  if (plannedText === undefined) {
    await store.set(CONFIG_SCOPE, key, after);
  } else if (plannedText !== originalText) {
    await store.setText(CONFIG_SCOPE, key, plannedText);
  }
}
