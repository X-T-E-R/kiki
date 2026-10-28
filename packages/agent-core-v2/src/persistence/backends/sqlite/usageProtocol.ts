import type { UsageFactRange } from '../../../app/usageFacts/usageFactStore.ts';
import type { UsageReadModelQuery, UsageReadModelSession, UsageSourcePage } from '../../interface/usageReadModel.ts';

export type UsageStoreOperation =
  | { readonly type: 'source' | 'progress' | 'summary'; readonly source: string }
  | { readonly type: 'apply'; readonly page: UsageSourcePage }
  | { readonly type: 'abandon' | 'invalidate'; readonly source: string }
  | { readonly type: 'read'; readonly source: string; readonly range?: UsageFactRange; readonly offset?: number; readonly limit?: number; readonly until?: number }
  | { readonly type: 'catalog'; readonly sessions: readonly UsageReadModelSession[]; readonly sources: readonly { readonly source: string; readonly workspaceId: string; readonly sessionId: string }[]; readonly inventory?: boolean }
  | { readonly type: 'query'; readonly query: UsageReadModelQuery }
  | { readonly type: 'retained'; readonly workspaceIds?: readonly string[] }
  | { readonly type: 'settleRetained'; readonly ledger: string; readonly generation: string }
  | { readonly type: 'models' | 'sources' | 'close' };

export interface UsageStoreRequest {
  readonly id: number;
  readonly operation: UsageStoreOperation;
  readonly cancellation?: SharedArrayBuffer;
}

export type UsageStoreResponse = { readonly id: number; readonly result: unknown } | { readonly id: number; readonly error: { readonly message: string; readonly code?: string; readonly committed?: boolean } };

let configuredEntry: string | undefined;
export function configureUsageReadModelWorkerRuntime(entry: string | undefined): void { configuredEntry = entry; }
export function usageReadModelWorkerEntry(): string | undefined { return configuredEntry; }
