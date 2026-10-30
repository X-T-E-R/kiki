import type { MemoryEntry } from '../../../app/memory/memoryStore.ts';
import type { MemoryCommit, MemoryLegacyPayload } from '../../interface/memoryPersistence.ts';

export type MemoryOperation =
  | { readonly type: 'read'; readonly scopes: readonly string[]; readonly generation?: number }
  | { readonly type: 'revision'; readonly scope: string; readonly id: string; readonly revision: string }
  | { readonly type: 'commit'; readonly input: MemoryCommit }
  | { readonly type: 'receipt'; readonly operationId: string; readonly request?: string }
  | { readonly type: 'journal'; readonly scope: string; readonly id?: string }
  | { readonly type: 'source'; readonly scope: string; readonly id: string }
  | { readonly type: 'provenance'; readonly scope: string; readonly id: string }
  | { readonly type: 'importLegacy'; readonly batch: readonly MemoryLegacyPayload[] }
  | { readonly type: 'rejectedLegacyIds'; readonly scope: string; readonly entries: readonly MemoryEntry[] }
  | { readonly type: 'legacy'; readonly scope: string }
  | { readonly type: 'namespaces' }
  | { readonly type: 'backup'; readonly destination: string }
  | { readonly type: 'close' };
export interface MemoryRequest { readonly id: number; readonly operation: MemoryOperation }
export type MemoryResponse = { readonly id: number; readonly result: unknown } | { readonly id: number; readonly error: { readonly message: string; readonly code?: string; readonly committed?: boolean } };
let configuredEntry: string | undefined;
export function configureMemoryWorkerRuntime(entry?: string): void { configuredEntry = entry; }
export function memoryWorkerEntry(): string | undefined { return configuredEntry; }
