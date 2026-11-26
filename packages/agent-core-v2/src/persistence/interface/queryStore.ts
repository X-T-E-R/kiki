import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type SortDir = 'asc' | 'desc';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface ComparisonOp {
  readonly $eq?: unknown;
  readonly $ne?: unknown;
  readonly $gt?: number | string;
  readonly $gte?: number | string;
  readonly $lt?: number | string;
  readonly $lte?: number | string;
  readonly $in?: readonly unknown[];
  readonly $nin?: readonly unknown[];
  readonly $exists?: boolean;
}

export type QueryFilter = {
  readonly [field: string]: unknown;
};

export interface IQuery<T> {
  where(filter: QueryFilter): IQuery<T>;
  /**
   * Restrict to records whose ordered column `column` falls inside `bounds`.
   * The column must have been declared at write time (`put`/`batch` with
   * `columns`).
   */
  whereColumn(column: string, bounds: ColumnBounds): IQuery<T>;
  orderBy(field: string, dir?: SortDir): IQuery<T>;
  limit(n: number): IQuery<T>;
  cursor(cursor: string | undefined): IQuery<T>;
  execute(signal?: AbortSignal): Promise<Page<T>>;
}

export interface ValueIndexDef {
  readonly kind: 'value';
  readonly name: string;
  readonly field: string;
  readonly unique?: boolean;
}

export interface CompoundIndexDef {
  readonly kind: 'compound';
  readonly name: string;
  readonly groupBy: string;
  readonly orderBy: string;
}

export interface TextIndexDef {
  readonly kind: 'text';
  readonly name: string;
  readonly fields?: readonly string[];
}

export type IndexDef = ValueIndexDef | CompoundIndexDef | TextIndexDef;

export type WriteOp =
  | {
      readonly kind: 'put';
      readonly collection: string;
      readonly key: string;
      readonly value: unknown;
      readonly columns?: Record<string, number>;
    }
  | { readonly kind: 'delete'; readonly collection: string; readonly key: string };

/** Exact JSON document comparison; undefined requires an absent key. All conditions and writes share one transaction. */
export interface WriteCondition {
  readonly collection: string;
  readonly key: string;
  readonly value: unknown;
}

/** Merge staged rows and numeric columns into a target in the conditional commit; replace clears only that target first. */
export interface StagedWrite {
  readonly source: string;
  readonly collection: string;
  readonly replace?: boolean;
}

/** Owned temporary collections survive budget pauses; dispose removes both. A backend may reclaim them only after the owner retires or dies. */
export interface QueryStaging {
  readonly stage: string;
  readonly publication: string;
  dispose(): Promise<void>;
}

export interface Checkpoint {
  readonly seq: number;
  readonly sourceMaxMtimeMs?: number;
}

/** Numeric range bounds over an ordered column; every bound is optional. */
export interface ColumnBounds {
  readonly gt?: number;
  readonly gte?: number;
  readonly lt?: number;
  readonly lte?: number;
}

/**
 * A bounded page over an ordered column: rows whose column value falls inside
 * `bounds` (all bounds optional), filtered by `filter`, ordered by the column
 * in `dir` (default `'asc'`), at most `limit` rows. Rows sharing a column
 * value come back in a deterministic but engine-specific order; a caller that
 * needs a total order re-sorts the (bounded) page itself.
 */
export interface ColumnPageQuery {
  readonly column: string;
  readonly dir?: SortDir;
  readonly filter?: QueryFilter;
  readonly bounds?: ColumnBounds;
  readonly limit: number;
}

export interface SidebarQueryMemberFilter {
  readonly workspaceIds?: readonly string[];
  readonly archived: 'hide' | 'include' | 'only';
  readonly privacy: 'hide' | 'include' | 'only';
  readonly pinned?: boolean;
  readonly excludeEmpty?: boolean;
  readonly query?: string;
  readonly persona?: string;
  readonly busy?: boolean;
  readonly busyIds?: readonly string[];
}

export interface SidebarCompoundPageQuery {
  readonly sessionCollection: string;
  readonly unitCollection: string;
  readonly unitColumn: string;
  readonly recencyField: string;
  readonly filter: SidebarQueryMemberFilter;
  readonly sort: 'updated_desc' | 'created_desc' | 'title';
  readonly limit: number;
  readonly memberLimit: number;
  readonly maxRows: number;
  readonly cursor?: { readonly sortAt: number; readonly sortText?: string; readonly typedUnitId: string };
  readonly pending?: readonly unknown[];
  readonly explain?: boolean;
  readonly revisionCheckpointKey?: string;
}

export interface SidebarCompoundUnit<T> {
  readonly kind: 'session' | 'group';
  readonly id: string;
  readonly typedUnitId: string;
  readonly sortAt: number;
  readonly sortText?: string;
  readonly openerId?: string;
  readonly title?: string;
  readonly primaryWorkspaceId?: string;
  readonly hasPinned: boolean;
  readonly memberCount: number;
  readonly members: readonly T[];
  readonly hasMoreMembers: boolean;
}

export interface SidebarCompoundPageResult<T> {
  readonly units: readonly SidebarCompoundUnit<T>[];
  readonly hasMore: boolean;
  readonly revision?: number;
  readonly stats: {
    readonly unitsVisited: number;
    readonly rowsVisited: number;
    readonly indexPlan?: readonly string[];
  };
}

export interface SidebarGroupMembersQuery {
  readonly sessionCollection: string;
  readonly recencyField: string;
  readonly groupId: string;
  readonly filter: SidebarQueryMemberFilter;
  readonly limit: number;
  readonly cursor?: { readonly ownUpdatedAt: number; readonly id: string };
  readonly pending?: readonly unknown[];
  readonly revisionCheckpointKey?: string;
}

export interface SidebarGroupMembersResult<T> {
  readonly memberCount: number;
  readonly members: readonly T[];
  readonly hasMore: boolean;
  readonly revision?: number;
}

export interface SidebarResolveUnitsQuery {
  readonly sessionCollection: string;
  readonly recencyField: string;
  readonly sessionIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly filter: SidebarQueryMemberFilter;
  readonly memberLimit: number;
  readonly pending?: readonly unknown[];
  readonly revisionCheckpointKey?: string;
}

export interface SidebarResolveUnitsResult<T> {
  readonly units: readonly SidebarCompoundUnit<T>[];
  readonly missingSessionIds: readonly string[];
  readonly missingGroupIds: readonly string[];
  readonly revision?: number;
}

export interface IQueryStore {
  readonly _serviceBrand: undefined;

  put<T>(
    collection: string,
    key: string,
    value: T,
    options?: { columns?: Record<string, number> },
  ): Promise<void>;
  batch(ops: readonly WriteOp[]): Promise<void>;
  batchIf?(conditions: readonly WriteCondition[], ops: readonly WriteOp[], staged?: StagedWrite): Promise<boolean>;
  createStaging?(source: string): Promise<QueryStaging>;
  delete(collection: string, key: string): Promise<void>;
  get<T>(collection: string, key: string, signal?: AbortSignal, options?: { readonly priority?: boolean }): Promise<T | undefined>;
  /** Point reads for several keys; missing keys are absent from the result. */
  getMany<T>(collection: string, keys: readonly string[], signal?: AbortSignal): Promise<Map<string, T>>;
  query<T>(collection: string): IQuery<T>;
  /**
   * Bounded page over an ordered column (see `ColumnPageQuery`). This is the
   * keyset-pagination primitive: it must stay cheap even over large
   * collections (index walk, not a full scan + in-memory sort).
   */
  pageByColumn<T>(collection: string, query: ColumnPageQuery, signal?: AbortSignal): Promise<Page<T>>;
  /** Single-transaction compound sidebar unit page read with indexed member hydration. */
  sidebarPage?<T>(query: SidebarCompoundPageQuery, signal?: AbortSignal): Promise<SidebarCompoundPageResult<T>>;
  /** Single-transaction indexed member pagination for a single session group. */
  sidebarGroupMembers?<T>(query: SidebarGroupMembersQuery, signal?: AbortSignal): Promise<SidebarGroupMembersResult<T>>;
  /** Single-transaction batch resolution of session and group units for live replacement or multi-space coalescing. */
  sidebarResolveUnits?<T>(query: SidebarResolveUnitsQuery, signal?: AbortSignal): Promise<SidebarResolveUnitsResult<T>>;
  ensureIndex(collection: string, def: IndexDef): Promise<void>;
  /** Every key currently in the collection (engine key decoding applied). */
  listKeys(collection: string): Promise<readonly string[]>;
  /** Delete the whole collection; a no-op when it does not exist. */
  dropCollection(collection: string): Promise<void>;
  getCheckpoint(source: string, signal?: AbortSignal, options?: { readonly priority?: boolean }): Promise<Checkpoint | undefined>;
  setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void>;
  withExclusive?<T>(operation: () => Promise<T>, source?: string): Promise<T>;
  /** Drain and retire cached readers/writers without deleting persisted data; new operations wait for recovery. */
  recover?(): Promise<void>;
  close(): Promise<void>;
}

export const IQueryStore: ServiceIdentifier<IQueryStore> = createDecorator<IQueryStore>('queryStore');

/** The store rejected a request because its bounded queue is full; the data is intact and a later request can succeed. */
export class QueryStoreBusyError extends Error {
  readonly code = 'query_store.busy';
  constructor() {
    super('Query store queue full');
    this.name = 'QueryStoreBusyError';
  }
}

export function isQueryStoreBusy(error: unknown): boolean {
  return error instanceof QueryStoreBusyError || (error as { code?: unknown } | null)?.code === 'query_store.busy';
}

export {
  QUERY_STORE_MAX_VALUE_BYTES,
  QueryStoreValueTooLargeError,
  isQueryStoreValueTooLarge,
} from './queryStoreLimits';
