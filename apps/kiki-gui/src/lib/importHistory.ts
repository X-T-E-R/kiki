/**
 * Import history — the GUI half of the D27 first-phase managed import.
 *
 * The DTOs are the protocol's, read from `@kiki/protocol`; nothing here
 * restates a wire shape. The production calls go through the
 * `client.global.imports` facade (owned by the core slice, not this file);
 * `importsApi` is the single place that reaches for it. The flag check below is
 * what reports the domain as *unavailable* when the server has not registered
 * those routes — a dead entry rather than an empty archive.
 *
 * Honesty rules kept here, because the wire is what can prove them:
 *
 *  - `probe.status` is `preserved` / `partial` / `unsupported`, and
 *    `preview.coverage` is `sample` / `complete`. A sample preview is never
 *    drawn as a complete import.
 *  - Losses are the server's own `code` + `count` + `detail`; the count is
 *    shown, and an unrecognised code falls back to its detail line rather than
 *    a guessed cause.
 *  - `targetHome` is not chosen here. The archive lands in the home of the
 *    server this window is connected to, and the view names that home.
 *  - A job's `records` / `bytesRead` against `totalBytes` is real progress
 *    from the host, not a timer advanced by the page.
 */

import { useQuery } from '@tanstack/react-query';

import type {
  ImportArchive,
  ImportDestination,
  ImportJob,
  ImportLoss,
  ImportPreview,
  ImportReadPage,
  ImportRecord,
  ImportSource,
} from '@kiki/protocol';
import type { Klient } from '@kiki/klient';
import type { I18nKey, PluralBase } from '@kiki/session-core/i18n';

import type { KikiClient } from './client';

export type {
  ImportArchive, ImportDestination, ImportJob, ImportLoss, ImportPreview, ImportReadPage, ImportRecord, ImportSource,
} from '@kiki/protocol';

/** Server flag that registers the import routes; off by default (D27 first phase). */
export const PLUGIN_IMPORT_FLAG = 'plugin_import';

export const importKeys = {
  all: ['plugin-import'] as const,
  sources: (scopeId: string) => ['plugin-import', 'sources', scopeId] as const,
  discovery: (scopeId: string, pluginId: string, sourceId: string, home: string) =>
    ['plugin-import', 'discovery', scopeId, pluginId, sourceId, home] as const,
  /**
   * A preview is not only about the file. The same file read into a Kiki
   * session and into a read-only archive are different reads with different
   * consequences, so the destination is part of the key: switching the target
   * working directory re-probes instead of showing the previous target's
   * losses and reuse receipt.
   */
  preview: (scopeId: string, previewId: string, destinationKey = '') =>
    ['plugin-import', 'preview', scopeId, destinationKey, previewId] as const,
  jobs: (scopeId: string) => ['plugin-import', 'jobs', scopeId] as const,
  job: (scopeId: string, jobId: string) => ['plugin-import', 'job', scopeId, jobId] as const,
  archives: (scopeId: string, query: string) => ['plugin-import', 'archives', scopeId, query] as const,
  archive: (scopeId: string, archiveId: string) => ['plugin-import', 'archive', scopeId, archiveId] as const,
};

/** Stable string form of a destination for a query key; `archive` is the empty tail. */
export function destinationKey(destination: ImportDestination | undefined): string {
  return destination?.kind === 'native-session' ? `native:${destination.workDir}` : '';
}

/**
 * The production call surface, reached through the public klient global
 * facade (`client.global.imports`, backed by `pluginImportService`). The GUI
 * never re-declares the protocol or builds a private fetch path.
 */
export type ImportsFacade = Klient['global']['imports'];

/** The import domain of one connected client. */
export function importsApi(client: KikiClient): ImportsFacade {
  return client.klient.global.imports;
}

/**
 * Flag read from `/meta`, the same query key and shape the SSH and
 * usage-export settings use. `undefined` means not known yet; `false` means the
 * server has not registered the routes, so the entry is a dead link rather than
 * a list that will not load.
 */
export function useImportHistoryEnabled(client: KikiClient): { enabled: boolean | undefined; loading: boolean } {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  return {
    enabled: meta.data === undefined ? undefined : meta.data.experimental_flags?.[PLUGIN_IMPORT_FLAG] === true,
    loading: meta.isLoading,
  };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Job states where the host is still doing work and a cancel is meaningful. */
export const ACTIVE_JOB_STATES: ReadonlySet<ImportJob['status']> = new Set<ImportJob['status']>(['queued', 'running']);
/** Job states a reader can act on again: resume a redone parse, or re-read an archive. */
export const UNFINISHED_JOB_STATES: ReadonlySet<ImportJob['status']> = new Set<ImportJob['status']>(['cancelled', 'failed', 'interrupted']);

export function isJobActive(job: ImportJob | undefined): boolean {
  return job !== undefined && ACTIVE_JOB_STATES.has(job.status);
}

/**
 * The three facts a progress bar can honestly draw: how much of the source has
 * been read, and whether that number is known yet. `totalBytes === 0` is a
 * source the host has not measured, so the ratio is undefined and the caller
 * shows an indeterminate line rather than 0%.
 */
export function importProgress(job: ImportJob | undefined): { readonly value: number; readonly total: number; readonly ratio: number | undefined } | undefined {
  if (job === undefined) return undefined;
  const total = Math.max(job.totalBytes, 0);
  const value = Math.min(Math.max(job.bytesRead, 0), total === 0 ? job.bytesRead : total);
  return { value, total, ratio: total === 0 ? undefined : value / total };
}

const STATUS_KEYS: Readonly<Record<ImportJob['status'], I18nKey>> = {
  queued: 'cap.import.state.queued',
  running: 'cap.import.state.running',
  cancelled: 'cap.import.state.cancelled',
  failed: 'cap.import.state.failed',
  interrupted: 'cap.import.state.interrupted',
  completed: 'cap.import.state.completed',
};

/** Translation key for a job state; unknown states are impossible (the schema is closed). */
export function jobStateKey(status: ImportJob['status']): I18nKey {
  return STATUS_KEYS[status];
}

const PROBE_KEYS: Readonly<Record<ImportPreview['probe']['status'], I18nKey>> = {
  preserved: 'cap.import.probe.preserved',
  partial: 'cap.import.probe.partial',
  unsupported: 'cap.import.probe.unsupported',
};

export function probeStateKey(status: ImportPreview['probe']['status']): I18nKey {
  return PROBE_KEYS[status];
}

const ARCHIVE_STATUS_KEYS: Readonly<Record<ImportArchive['status'], I18nKey>> = {
  preserved: 'cap.import.probe.preserved',
  partial: 'cap.import.probe.partial',
};
export function archiveStateKey(status: ImportArchive['status']): I18nKey {
  return ARCHIVE_STATUS_KEYS[status];
}

const RECORD_ROLE_KEYS: Readonly<Record<ImportReadPage['records'][number]['role'], I18nKey>> = {
  user: 'localSessions.role.user',
  assistant: 'localSessions.role.assistant',
  system: 'localSessions.role.system',
  tool: 'localSessions.block.tool',
  tool_call: 'localSessions.block.tool',
  metadata: 'cap.import.role.metadata',
};
export function recordRoleKey(role: ImportReadPage['records'][number]['role']): I18nKey {
  return RECORD_ROLE_KEYS[role];
}

/** Total loss count the server recorded; a `detail`-only line is not a count. */
export function lossCount(losses: readonly ImportLoss[]): number {
  return losses.reduce((sum, loss) => sum + loss.count, 0);
}

/** `C:/Users/ada/.claude` → `.claude`; the row's own label for a home, not its full path. */
export function homeName(home: string): string {
  return home.split(/[\\/]/).findLast((part) => part !== '') ?? home;
}

/**
 * A source's identity is its plugin *and* its id: two plugins may both
 * contribute a source called `claude-code`, and naming one by id alone would
 * silently read the other plugin's parser. The tuple is a visible separator
 * rather than a NUL so the value is a readable string in a query key, a DOM
 * attribute and a log line alike.
 */
export function sourceKey(pluginId: string, sourceId: string): string {
  return `${pluginId}:${sourceId}`;
}

/** The source a deep link names, when the link carries only a source id. */
export function anySourceKey(sourceId: string): string {
  return `*:${sourceId}`;
}

/** Whether a link or a remembered key still resolves to this source. */
export function isSameSource(key: string | undefined, pluginId: string, sourceId: string): boolean {
  if (key === undefined) return false;
  return key === sourceKey(pluginId, sourceId) || key === anySourceKey(sourceId);
}

/**
 * A revision is a 64-character digest. Shown whole it is a wall of hex that
 * pushes its sentence out of the box, so a line names its head; the full value
 * is the archive's own fact and stays in the archive reader.
 */
export function shortDigest(revision: string | null | undefined): string {
  if (revision === undefined || revision === null || revision === '') return '—';
  return revision.length <= 12 ? revision : revision.slice(0, 12);
}

/** The last two segments of a path, for a source file's own line. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `${parts.at(-2)}/${parts.at(-1)}`;
}

/**
 * A source's own id, shown beside its title. Two conversations can share a
 * title, so the row still has to say which is which — but a 36-character
 * digest on every row is noise that competes with the title for the same
 * glance. A real path keeps its path shape, because a folder truncated to
 * twelve characters would not identify a folder.
 *
 * This is display only. The full id stays in the row's `title` and remains
 * what selection, preview and submit send.
 */
export function shortSourceId(externalId: string): string {
  if (/[\\/]/.test(externalId)) return shortPath(externalId);
  // A uuid is cut on a group boundary, so what is left still reads as the head
  // of an id rather than as a truncated word. `shortDigest` cuts at a fixed
  // width, which lands mid-group here and would also clip a value that is
  // short but not tiny (`2024-05-06-run`).
  // Two groups, not one: real uuids share nothing but their shape, and a
  // prefix that collides on the first group is noise rather than a
  // discriminator — which is the only reason the id is on the row at all.
  const uuid = /^([0-9a-f]{8}-[0-9a-f]{4})[0-9a-f-]*$/i.exec(externalId);
  if (uuid !== null) return uuid[1]!;
  return externalId.length <= 16 ? externalId : `${externalId.slice(0, 8)}…`;
}

/**
 * The two facts a stored page count and a record count are, in one line. Each
 * word carries its own number, so each is chosen on its own count — `1 page`
 * beside `3 records` is the case a single templated string got wrong. Chinese
 * counters do not inflect, so both forms read the same there.
 */
export function importCountsText(
  plural: (base: PluralBase, count: number) => string,
  records: number,
  pages: number,
): string {
  return `${plural('cap.import.jobRecords', records)} · ${plural('cap.import.jobPages', pages)}`;
}

/**
 * Whether this read lands as a Kiki session the reader can keep talking in.
 * The read-only archive is the other kind, and the two are not drawn alike: an
 * archive is history, a native session is a live conversation with the imported
 * turn as its context.
 */
export function isNativeDestination(destination: ImportDestination | undefined): boolean {
  return destination?.kind === 'native-session';
}

/** The working directory a native import is aimed at, when it is aimed anywhere. */
export function nativeWorkDir(destination: ImportDestination | undefined): string | undefined {
  return destination?.kind === 'native-session' ? destination.workDir : undefined;
}

/**
 * Whether this job finished as a Kiki session. `sessionId` is the host's own
 * fact, written only when the session was committed, so it is what proves the
 * import landed — a job that is merely finished has not made a session yet.
 */
export function nativeSessionId(job: ImportJob): string | undefined {
  return isNativeDestination(job.destination) && job.status === 'completed' && job.sessionId !== null && job.sessionId !== undefined && job.sessionId !== ''
    ? job.sessionId
    : undefined;
}

/**
 * An import target is usable when the reader has actually chosen one. A native
 * read has no home to fall back on — the session's own working directory is part
 * of what it is — so an empty workDir is a missing field, not a default.
 */
export function destinationReady(destination: ImportDestination | undefined): boolean {
  return isNativeDestination(destination) ? (nativeWorkDir(destination)?.trim() ?? '') !== '' : true;
}
