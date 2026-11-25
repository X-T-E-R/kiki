import type { IQueryStore, WriteOp } from '#/persistence/interface/queryStore';
import type { SessionSummary } from './sessionIndex';

export const SESSION_INDEX_STORAGE_VERSION = 8;
export const SESSION_INDEX_MANIFEST = `sessionIndex:v${SESSION_INDEX_STORAGE_VERSION}`;
export const LEGACY_SESSION_INDEX_MANIFEST = 'sessionIndex:v6';
export const LEGACY_V7_SESSION_INDEX_MANIFEST = 'sessionIndex:v7';
export const SESSION_INDEX_REVISION = `${SESSION_INDEX_MANIFEST}:revision`;

/** Build a revision-bump op to commit inside the same atomic batch as derived index mutations. */
export async function buildAdvanceSessionIndexRevisionOp(store: IQueryStore): Promise<WriteOp> {
  const current = await store.getCheckpoint(SESSION_INDEX_REVISION);
  return {
    kind: 'put',
    collection: '__checkpoint__',
    key: SESSION_INDEX_REVISION,
    value: { seq: (current?.seq ?? 0) + 1 },
  };
}

/** Advance under the shared publication lock before modifying the derived index. */
export async function advanceSessionIndexRevision(store: IQueryStore): Promise<void> {
  const current = await store.getCheckpoint(SESSION_INDEX_REVISION);
  await store.setCheckpoint(SESSION_INDEX_REVISION, { seq: (current?.seq ?? 0) + 1 });
}

export const PARENT_INDEX_NAME = 'byParent';
export const CREATED_BY_INDEX_NAME = 'byCreatedBy';
export const GROUP_ID_INDEX_NAME = 'byGroupId';
export const WORKSPACE_ID_INDEX_NAME = 'byWorkspaceId';
export const SESSION_SOURCE_ROOT_KEY = '\0root';
export const SESSION_PIN_METADATA_KEY = 'kiki.pinned';

export type SidebarVisibilityBucket =
  | 'pub_act'
  | 'all_act'
  | 'priv_act'
  | 'pub_any'
  | 'all_any'
  | 'priv_any'
  | 'pub_arc'
  | 'all_arc'
  | 'priv_arc'
  | 'pin_pub_act'
  | 'pin_all_act'
  | 'pin_priv_act'
  | 'pin_pub_any'
  | 'pin_all_any'
  | 'pin_priv_any'
  | 'pin_pub_arc'
  | 'pin_all_arc'
  | 'pin_priv_arc';

export interface SidebarUnitIndexEntry {
  readonly kind: 'session' | 'group';
  readonly id: string;
  readonly typedId: string;
}

export interface SessionWorkspaceCounts {
  readonly active: number;
  readonly archived: number;
}

/** Fingerprints trust managed atomic metadata writes; external same-size rewrites that preserve mtimes are outside reconciliation guarantees. */
export interface SessionSourceFingerprint {
  readonly directMtimeMs: number;
  readonly directSize: number;
  readonly nestedMtimeMs: number;
  readonly nestedSize: number;
}

export interface SessionWorkspaceSource {
  readonly sessionIds: readonly string[];
  readonly activeSessionIds: readonly string[];
  readonly archivedSessionIds: readonly string[];
}

export interface SessionSourceRoot {
  readonly workspaceIds: readonly string[];
}

export function sessionCollection(generation: number): string {
  return `session:v${SESSION_INDEX_STORAGE_VERSION}:g${generation}`;
}

export function sidebarUnitCollection(generation: number): string {
  return `sidebarUnit:v${SESSION_INDEX_STORAGE_VERSION}:g${generation}`;
}

export function sessionCountersCollection(generation: number): string {
  return `sessionCounters:v${SESSION_INDEX_STORAGE_VERSION}:g${generation}`;
}

export function sessionSourcesCollection(generation: number): string {
  return `sessionSources:v${SESSION_INDEX_STORAGE_VERSION}:g${generation}`;
}

export function sessionWorkspaceSourcesCollection(generation: number): string {
  return `sessionWorkspaceSources:v${SESSION_INDEX_STORAGE_VERSION}:g${generation}`;
}

export function legacySessionCollection(generation: number): string {
  return `session:v6:g${generation}`;
}

export function legacySessionCountersCollection(generation: number): string {
  return `sessionCounters:v6:g${generation}`;
}

export function legacySessionSourcesCollection(generation: number): string {
  return `sessionSources:v6:g${generation}`;
}

export function legacySessionWorkspaceSourcesCollection(generation: number): string {
  return `sessionWorkspaceSources:v6:g${generation}`;
}

export function legacyV7SessionCollection(generation: number): string {
  return `session:v7:g${generation}`;
}

export function legacyV7SidebarUnitCollection(generation: number): string {
  return `sidebarUnit:v7:g${generation}`;
}

export function legacyV7SessionCountersCollection(generation: number): string {
  return `sessionCounters:v7:g${generation}`;
}

export function legacyV7SessionSourcesCollection(generation: number): string {
  return `sessionSources:v7:g${generation}`;
}

export function legacyV7SessionWorkspaceSourcesCollection(generation: number): string {
  return `sessionWorkspaceSources:v7:g${generation}`;
}

/**
 * The ordered recency column for a generation. Column names are store-wide,
 * so the column is namespaced per generation: two coexisting generations
 * (one published, one being projected) then walk disjoint ordered
 * structures and can never interleave into each other's pages. The stored
 * record carries the same-named field — the engine orders by the column and
 * its cross-shard merge compares by the value field of that name — and the
 * index strips it again on every read.
 */
export function recencyColumn(generation: number): string {
  return `v${SESSION_INDEX_STORAGE_VERSION}:g${generation}:updatedAt`;
}

export function sidebarUnitColumn(generation: number, bucket: SidebarVisibilityBucket): string {
  return `v${SESSION_INDEX_STORAGE_VERSION}:g${generation}:u:${bucket}`;
}

export function resolveSidebarVisibilityBucket(
  archived: 'hide' | 'include' | 'only',
  privacy: 'hide' | 'include' | 'only',
  pinnedOnly = false,
): SidebarVisibilityBucket {
  const privPrefix = privacy === 'hide' ? 'pub' : privacy === 'only' ? 'priv' : 'all';
  const arcSuffix = archived === 'hide' ? 'act' : archived === 'only' ? 'arc' : 'any';
  const base = `${privPrefix}_${arcSuffix}` as const;
  return pinnedOnly ? (`pin_${base}` as SidebarVisibilityBucket) : base;
}

export function typedSessionUnitId(sessionId: string): string {
  return `s:${sessionId}`;
}

export function typedGroupUnitId(groupId: string): string {
  return `g:${groupId}`;
}

export function sidebarUnitKeyForSummary(summary: Pick<SessionSummary, 'id' | 'groupId'>): string {
  return summary.groupId !== undefined ? typedGroupUnitId(summary.groupId) : typedSessionUnitId(summary.id);
}

export function buildSidebarUnitColumns(
  generation: number,
  members: readonly SessionSummary[],
): Record<string, number> {
  const columns: Record<string, number> = {};
  const modes: ReadonlyArray<readonly ['hide' | 'include' | 'only', 'hide' | 'include' | 'only']> = [
    ['hide', 'hide'],
    ['hide', 'include'],
    ['hide', 'only'],
    ['include', 'hide'],
    ['include', 'include'],
    ['include', 'only'],
    ['only', 'hide'],
    ['only', 'include'],
    ['only', 'only'],
  ];
  for (const [archivedMode, privacyMode] of modes) {
    let maxOwn = -1;
    let hasPinned = false;
    for (const member of members) {
      if (archivedMode === 'hide' && member.archived) continue;
      if (archivedMode === 'only' && !member.archived) continue;
      const isPrivate = member.private === true;
      if (privacyMode === 'hide' && isPrivate) continue;
      if (privacyMode === 'only' && !isPrivate) continue;
      const own = member.ownUpdatedAt ?? member.updatedAt;
      if (own > maxOwn) maxOwn = own;
      if (member.custom?.[SESSION_PIN_METADATA_KEY] === true) hasPinned = true;
    }
    if (maxOwn >= 0) {
      columns[sidebarUnitColumn(generation, resolveSidebarVisibilityBucket(archivedMode, privacyMode, false))] = maxOwn;
      if (hasPinned) {
        columns[sidebarUnitColumn(generation, resolveSidebarVisibilityBucket(archivedMode, privacyMode, true))] = maxOwn;
      }
    }
  }
  return columns;
}

/** Attach the generation's recency field to a summary for storage. */
export function withRecencyField(generation: number, summary: SessionSummary): SessionSummary {
  return { ...summary, [recencyColumn(generation)]: summary.updatedAt };
}

/** Remove the generation's recency field from a stored record. */
export function stripRecencyField(generation: number, record: SessionSummary): SessionSummary {
  const key = recencyColumn(generation);
  if (!(key in record)) return record;
  const rest: Record<string, unknown> = { ...record };
  delete rest[key];
  return rest as unknown as SessionSummary;
}
