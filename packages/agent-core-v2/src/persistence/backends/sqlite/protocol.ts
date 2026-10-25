import type { ColumnBounds, IndexDef, QueryFilter, SortDir, StagedWrite, WriteCondition, WriteOp } from '../../interface/queryStore.ts';

export interface ReadQuery {
  readonly collection: string;
  readonly filter?: QueryFilter;
  readonly column?: { readonly name: string; readonly bounds: ColumnBounds };
  readonly sort?: { readonly field: string; readonly dir: SortDir };
  readonly columnOrder?: SortDir;
  readonly limit?: number;
  readonly cursor?: string;
}

export type StoreOperation =
  | { readonly type: 'get'; readonly collection: string; readonly keys: readonly string[] }
  | { readonly type: 'batch'; readonly ops: readonly WriteOp[]; readonly conditions?: readonly WriteCondition[]; readonly staged?: StagedWrite }
  | { readonly type: 'query'; readonly query: ReadQuery }
  | { readonly type: 'keys'; readonly collection: string }
  | { readonly type: 'drop'; readonly collection: string }
  | { readonly type: 'index'; readonly collection: string; readonly definition: IndexDef }
  | { readonly type: 'close' };

export interface StoreRequest {
  readonly id: number;
  readonly operation: StoreOperation;
  readonly cancellation?: SharedArrayBuffer;
}

export type StoreResponse =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly message: string; readonly code?: string; readonly committed?: boolean } };

let entry: string | undefined;
export function configureQueryStoreWorkerRuntime(path: string): void { entry = path; }
export function queryStoreWorkerEntry(): string | undefined { return entry; }
