import type { SqliteSearchResult, SqliteSessionInput, SqliteSyncStatus } from './index';
import type { NormalizedQuery, SearchBudgets } from '../match';

export const INDEXER_COMMAND = '__search-indexer';
export const MEMORY_BUDGET_EXIT = 86;

export type IndexerRequest =
  | { type: 'heartbeat' }
  | { type: 'reader_released' }
  | { type: 'sync'; sessions: SqliteSessionInput[] }
  | { type: 'close' };

export type IndexerEvent =
  | { type: 'ready'; pid: number; writer?: boolean }
  | { type: 'heartbeat' }
  | { type: 'release_reader' }
  | { type: 'status'; rss: number; heapUsed: number; external: number; heapLimit: number;
      status: SqliteSyncStatus; pending: number; dbBytes: number; lastBatchMs: number; inflight?: string }
  | { type: 'synced'; sessionId: string }
  | { type: 'error'; message: string };

export type QueryRequest =
  | { id: number; type: 'search'; query: NormalizedQuery; pageToken?: string; budgets?: SearchBudgets }
  | { id: number; type: 'close' };

export type QueryEvent =
  | { type: 'ready' }
  | { id: number; type: 'result'; value: SqliteSearchResult }
  | { id: number; type: 'error'; message: string };
