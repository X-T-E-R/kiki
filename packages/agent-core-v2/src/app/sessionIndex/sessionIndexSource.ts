import { ILogService } from '#/_base/log/log';
import type { TokenUsage } from '#/kosong/contract/usage';
import { SESSION_INDEX_KEY, SESSION_INDEX_SCOPE } from '#/app/workspace/workspaceAlias';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IFileSystemStorageService,
  StorageError,
  StorageErrors,
} from '#/persistence/interface/storage';

import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  type SessionSummary,
  type SessionUsageSummary,
} from './sessionIndex';
import type { SessionSourceFingerprint } from './sessionIndexModel';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';
const MTIME_SCAN_CONCURRENCY = 16;

export function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function parseTurnOutcome(value: unknown): 'completed' | 'cancelled' | 'failed' | undefined {
  return value === 'completed' || value === 'cancelled' || value === 'failed' ? value : undefined;
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inputOther = record['inputOther'];
  const output = record['output'];
  const inputCacheRead = record['inputCacheRead'];
  const inputCacheCreation = record['inputCacheCreation'];
  if (
    typeof inputOther !== 'number' ||
    !Number.isFinite(inputOther) ||
    inputOther < 0 ||
    typeof output !== 'number' ||
    !Number.isFinite(output) ||
    output < 0 ||
    typeof inputCacheRead !== 'number' ||
    !Number.isFinite(inputCacheRead) ||
    inputCacheRead < 0 ||
    typeof inputCacheCreation !== 'number' ||
    !Number.isFinite(inputCacheCreation) ||
    inputCacheCreation < 0
  ) {
    return undefined;
  }
  return { inputOther, output, inputCacheRead, inputCacheCreation };
}

function parseSessionUsageSummary(value: unknown): SessionUsageSummary | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const total = parseTokenUsage(record['total']);
  if (total === undefined) return undefined;
  const wireComplete = record['wireComplete'] === true ? true : undefined;
  const rawByModel = record['byModel'];
  if (rawByModel === null || typeof rawByModel !== 'object' || Array.isArray(rawByModel)) {
    return { total, wireComplete };
  }
  const byModel: Record<string, TokenUsage> = {};
  for (const [model, rawUsage] of Object.entries(rawByModel)) {
    const usage = parseTokenUsage(rawUsage);
    if (usage !== undefined) byModel[model] = usage;
  }
  return {
    total,
    byModel: Object.keys(byModel).length === 0 ? undefined : byModel,
    wireComplete,
  };
}

export function recoverCwd(meta: Record<string, unknown>): string | undefined {
  if (typeof meta['cwd'] === 'string' && meta['cwd'].length > 0) return meta['cwd'];
  if (typeof meta['workDir'] === 'string' && meta['workDir'].length > 0) {
    return meta['workDir'];
  }
  const custom = meta['custom'];
  if (custom !== null && typeof custom === 'object' && !Array.isArray(custom)) {
    const fromCustom = (custom as Record<string, unknown>)['cwd'];
    if (typeof fromCustom === 'string' && fromCustom.length > 0) return fromCustom;
  }
  return undefined;
}

/** The single construction path for summaries — field order is fixed so a
 *  stored summary deep-compares equal to a fresh projection of the same
 *  metadata document. */
export function buildSessionSummary(fields: {
  id: string;
  workspaceId: string;
  cwd?: string;
  title?: string;
  lastPrompt?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  archivedAt?: number;
  custom?: Record<string, unknown>;
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  usage?: SessionUsageSummary;
}): SessionSummary {
  return {
    id: fields.id,
    workspaceId: fields.workspaceId,
    cwd: fields.cwd,
    title: fields.title,
    lastPrompt: fields.lastPrompt,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    archived: fields.archived,
    archivedAt: fields.archivedAt,
    custom: fields.custom,
    lastTurnReason: fields.lastTurnReason,
    usage: fields.usage,
  };
}

export function summaryMatchesChildOf(
  summary: SessionSummary,
  parentId: string | undefined,
): boolean {
  if (parentId === undefined) return true;
  const custom = summary.custom;
  return (
    custom?.['parent_session_id'] === parentId &&
    custom?.[CHILD_SESSION_KIND_KEY] === CHILD_SESSION_KIND
  );
}

/** Deep-enough equality for reconciliation: the projection-relevant fields,
 *  with `custom` compared structurally (both sides are JSON-round-tripped
 *  values built by `buildSessionSummary`, so key order is stable). */
export function summaryEquals(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.cwd === b.cwd &&
    a.title === b.title &&
    a.lastPrompt === b.lastPrompt &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.archived === b.archived &&
    a.archivedAt === b.archivedAt &&
    a.lastTurnReason === b.lastTurnReason &&
    JSON.stringify(a.custom) === JSON.stringify(b.custom) &&
    JSON.stringify(a.usage) === JSON.stringify(b.usage)
  );
}

export function listWorkspaceIds(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  log?: ILogService,
): Promise<readonly string[]> {
  return listChildEntries(storage, sessionsScope, log);
}

export function listSessionIds(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  workspaceId: string,
  log?: ILogService,
): Promise<readonly string[]> {
  return listChildEntries(storage, `${sessionsScope}/${workspaceId}`, log);
}

function isNonDirectoryEntry(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    error.code === StorageErrors.codes.STORAGE_IO_FAILED &&
    error.details?.['errno'] === 'ENOTDIR'
  );
}

function warnSkippedEntry(error: unknown, log: ILogService | undefined): void {
  if (log === undefined) return;
  const details = error instanceof StorageError ? error.details : undefined;
  log.warn('session index skips a non-directory entry', { path: details?.['path'] });
}

async function listChildEntries(
  storage: IFileSystemStorageService,
  scope: string,
  log: ILogService | undefined,
): Promise<readonly string[]> {
  try {
    return await storage.list(scope);
  } catch (error) {
    if (!isNonDirectoryEntry(error)) throw error;
    warnSkippedEntry(error, log);
    return [];
  }
}

async function tolerantStat<T>(
  read: () => Promise<T | undefined>,
  log: ILogService | undefined,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (!isNonDirectoryEntry(error)) throw error;
    warnSkippedEntry(error, log);
    return undefined;
  }
}

export type SessionSummaryReadResult =
  | { readonly kind: 'found'; readonly summary: SessionSummary }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly error: unknown };

export async function readSessionSummaryResult(
  docs: IAtomicDocumentStore,
  sessionsScope: string,
  workspaceId: string,
  sessionId: string,
): Promise<SessionSummaryReadResult> {
  const metadata = await readSessionMetadataResult(docs, sessionsScope, workspaceId, sessionId);
  if (metadata.kind !== 'found') return metadata;
  return {
    kind: 'found',
    summary: summaryFromMetadata(metadata.meta, workspaceId, sessionId),
  };
}

export async function readSessionSummary(
  docs: IAtomicDocumentStore,
  sessionsScope: string,
  workspaceId: string,
  sessionId: string,
): Promise<SessionSummary | undefined> {
  const result = await readSessionSummaryResult(docs, sessionsScope, workspaceId, sessionId);
  if (result.kind === 'error') throw result.error;
  return result.kind === 'found' ? result.summary : undefined;
}

function summaryFromMetadata(
  meta: Record<string, unknown>,
  workspaceId: string,
  sessionId: string,
): SessionSummary {
  const rawCustom = meta['custom'];
  const custom =
    rawCustom !== null && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
      ? (rawCustom as Record<string, unknown>)
      : undefined;
  return buildSessionSummary({
    id: sessionId,
    workspaceId,
    cwd: recoverCwd(meta),
    title: typeof meta['title'] === 'string' ? meta['title'] : undefined,
    lastPrompt: typeof meta['lastPrompt'] === 'string' ? meta['lastPrompt'] : undefined,
    createdAt: parseTime(meta['createdAt']),
    updatedAt: parseTime(meta['updatedAt']),
    archived: meta['archived'] === true,
    archivedAt: meta['archivedAt'] === undefined ? undefined : parseTime(meta['archivedAt']),
    custom,
    lastTurnReason: parseTurnOutcome(meta['lastTurnReason']),
    usage: parseSessionUsageSummary(meta['usage']),
  });
}

type SessionMetadataReadResult =
  | { readonly kind: 'found'; readonly meta: Record<string, unknown> }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly error: unknown };

async function readSessionMetadataResult(
  docs: IAtomicDocumentStore,
  sessionsScope: string,
  workspaceId: string,
  sessionId: string,
): Promise<SessionMetadataReadResult> {
  const base = `${sessionsScope}/${workspaceId}/${sessionId}`;
  let current: Record<string, unknown> | undefined;
  try {
    current = await docs.get<Record<string, unknown>>(base, META_KEY);
  } catch (error) {
    return { kind: 'error', error };
  }
  if (current !== undefined) return { kind: 'found', meta: current };
  try {
    const legacy = await docs.get<Record<string, unknown>>(`${base}/${META_SCOPE}`, META_KEY);
    return legacy === undefined ? { kind: 'missing' } : { kind: 'found', meta: legacy };
  } catch (error) {
    return { kind: 'error', error };
  }
}

/** Bounded-concurrency map: resolves every item through `fn`, dropping
 *  `undefined` results, with at most `concurrency` calls in flight. */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R | undefined>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      const value = await fn(item);
      if (value !== undefined) out.push(value);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function sessionStateFingerprint(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  workspaceId: string,
  sessionId: string,
  log?: ILogService,
): Promise<SessionSourceFingerprint> {
  const base = `${sessionsScope}/${workspaceId}/${sessionId}`;
  const nestedScope = `${base}/${META_SCOPE}`;
  const [directMtimeMs, directSize, nestedMtimeMs, nestedSize] = await Promise.all([
    tolerantStat(() => storage.mtime(base, META_KEY), log),
    tolerantStat(() => storage.size(base, META_KEY), log),
    tolerantStat(() => storage.mtime(nestedScope, META_KEY), log),
    tolerantStat(() => storage.size(nestedScope, META_KEY), log),
  ]);
  return {
    directMtimeMs: directMtimeMs ?? 0,
    directSize: directSize ?? 0,
    nestedMtimeMs: nestedMtimeMs ?? 0,
    nestedSize: nestedSize ?? 0,
  };
}

export async function sessionStateMaxMtime(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  workspaceId: string,
  sessionId: string,
  log?: ILogService,
): Promise<number> {
  const fingerprint = await sessionStateFingerprint(
    storage,
    sessionsScope,
    workspaceId,
    sessionId,
    log,
  );
  return Math.max(fingerprint.directMtimeMs, fingerprint.nestedMtimeMs);
}

export async function scanSessionsMaxMtime(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  log?: ILogService,
): Promise<number> {
  let max = (await storage.mtime(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY)) ?? 0;

  for (const workspaceId of await listWorkspaceIds(storage, sessionsScope, log)) {
    const sessionIds = await listSessionIds(storage, sessionsScope, workspaceId, log);
    const mtimes = await mapBounded(sessionIds, MTIME_SCAN_CONCURRENCY, (sessionId) =>
      sessionStateMaxMtime(storage, sessionsScope, workspaceId, sessionId, log),
    );
    for (const mtime of mtimes) {
      if (mtime > max) max = mtime;
    }
  }

  return max;
}
