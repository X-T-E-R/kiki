import type { SessionSummary } from './sessionIndex';

export const SESSION_INDEX_STORAGE_VERSION = 4;
export const SESSION_INDEX_MANIFEST = `sessionIndex:v${SESSION_INDEX_STORAGE_VERSION}`;
export const LEGACY_SESSION_INDEX_MANIFEST = 'sessionIndex:v3';

export const PARENT_INDEX_NAME = 'byParent';
export const SESSION_SOURCE_ROOT_KEY = '\0root';

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
  return `session:v4:g${generation}`;
}

export function sessionCountersCollection(generation: number): string {
  return `sessionCounters:v4:g${generation}`;
}

export function sessionSourcesCollection(generation: number): string {
  return `sessionSources:v4:g${generation}`;
}

export function sessionWorkspaceSourcesCollection(generation: number): string {
  return `sessionWorkspaceSources:v4:g${generation}`;
}

export function legacySessionCollection(generation: number): string {
  return `session:v2:g${generation}`;
}

export function legacySessionCountersCollection(generation: number): string {
  return `sessionCounters:v2:g${generation}`;
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
  return `v4:g${generation}:updatedAt`;
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
