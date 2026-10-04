/**
 * Usage → External sync: the client half of `/api/usage-export`.
 *
 * The whole feature is a typed facade on the klient REST transport
 * (`klient.rest.usageExport`); this module owns the parts a view should not
 * repeat: the experimental flag read, the state/category vocabulary, the
 * payload shorthand the list rows print, and the two downloads.
 *
 * Honesty rules kept here: a server that never registered the routes (the
 * `usage_export` flag is off) is reported as *unavailable*, never as an empty
 * destination list; an error category the facade sends is mapped to the exact
 * recorded name, and anything else falls back to a generic sentence instead of
 * guessing a cause. Nothing here derives a number the server did not send.
 */

import type { Klient } from '@kiki/klient';
import type {
  UsageExportDestination,
  UsageExportHandoff,
  UsageExportItem,
  UsageExportPreview,
  UsageExportQueue,
  UsageExportTarget,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useQuery } from '@tanstack/react-query';

import type { KikiClient } from './client';

/** Server flag that registers the management routes; off by default. */
export const USAGE_EXPORT_FLAG = 'usage_export';
export const USAGE_EXPORT_QUERY_KEY = 'usage-export';
export const HALF_HOUR_MS = 1_800_000;

/**
 * The typed facade itself, reached through the public klient surface — the GUI
 * never re-declares the protocol or builds a private fetch path. `rest` is
 * optional (IPC/memory transports do not serve REST domains), so callers get
 * `undefined` and render "this connection cannot manage external sync".
 */
export type UsageExportApi = NonNullable<Klient['rest']>['usageExport'];

export function usageExportApi(klient: Klient): UsageExportApi | undefined {
  return klient.rest?.usageExport;
}

export type UsageExportEntry = { readonly destination: UsageExportDestination; readonly queue: UsageExportQueue };

export const EXPORT_KINDS: readonly UsageExportTarget['kind'][] = ['vibe', 'webhook', 'script'];
export const EXPORT_SCHEDULES = [0, 5, 15, 30, 60] as const;

const KIND_KEY: Record<UsageExportTarget['kind'], I18nKey> = {
  vibe: 'usage.export.kind.vibe',
  webhook: 'usage.export.kind.webhook',
  script: 'usage.export.kind.script',
};
const KIND_SHORT_KEY: Record<UsageExportTarget['kind'], I18nKey> = {
  vibe: 'usage.export.kindShort.vibe',
  webhook: 'usage.export.kindShort.webhook',
  script: 'usage.export.kindShort.script',
};
const STATE_KEY: Record<UsageExportDestination['state'], I18nKey> = {
  draft: 'usage.export.state.draft',
  disabled: 'usage.export.state.disabled',
  ready: 'usage.export.state.ready',
  'needs-auth': 'usage.export.state.needs-auth',
  retrying: 'usage.export.state.retrying',
  'queue-full': 'usage.export.state.queue-full',
  quarantined: 'usage.export.state.quarantined',
  'remote-diverged': 'usage.export.state.remote-diverged',
  'adapter-unavailable': 'usage.export.state.adapter-unavailable',
};

/**
 * Category vocabulary. Exact names come from the server: the adapter allowlist
 * (`USAGE_EXPORT_ERROR_CATEGORIES`), the store's own queue/scan/ack markers
 * (`queue-full`, `scan_failed`, `receipt-*`), and the route's refusal names.
 * Anything else renders the generic sentence with the recorded word shown
 * beside it, so a category this build has not learned yet is still visible
 * instead of being smoothed into a cause Kiki guessed.
 */
const CATEGORY_KEYS = [
  'adapter_unavailable', 'network', 'http_auth', 'http_rate_limited', 'http_too_large', 'invalid_protocol',
  'partial_receipt', 'remote_diverged', 'cached_only_unsupported', 'vibe_partial_receipt', 'vibe_protected',
  'vibe_unknown_source', 'vibe_unknown_model', 'vibe_implausible', 'script_timeout', 'script_output_limit',
  'script_spawn_failed', 'script_nonzero_exit', 'script_invalid_receipt', 'script_protocol_error', 'generic',
  'queue-full', 'scan_failed', 'scan-incomplete', 'consent-preview-changed', 'destination-not-found',
  'identity-change-requires-new-destination', 'export-queue-full', 'export-writer-unavailable',
  'invalid-usage-export-input', 'usage-export-operation-failed', 'queue-explicitly-cleared',
  'handoff-recovery-needs-new-cutoff',
] as const;
export type UsageExportErrorCategory = (typeof CATEGORY_KEYS)[number];

export function kindLabelKey(kind: UsageExportTarget['kind']): I18nKey {
  return KIND_KEY[kind];
}
export function kindShortKey(kind: UsageExportTarget['kind']): I18nKey {
  return KIND_SHORT_KEY[kind];
}
export function stateLabelKey(state: UsageExportDestination['state']): I18nKey {
  return STATE_KEY[state];
}
function categoryKeyOf(category: string): I18nKey | undefined {
  if (category.startsWith('receipt-')) return 'usage.export.category.receipt';
  return CATEGORY_KEYS.includes(category as UsageExportErrorCategory)
    ? (`usage.export.category.${category}` as I18nKey)
    : undefined;
}
export function categoryTextKey(category: string | null): I18nKey {
  if (category === null) return 'usage.export.category.generic';
  return categoryKeyOf(category) ?? 'usage.export.category.generic';
}
/** False when the recorded word is not one this build has its own sentence for. */
export function categoryIsKnown(category: string | null): boolean {
  return category !== null && CATEGORY_KEYS.includes(category as UsageExportErrorCategory);
}

/** States whose next automatic attempt the server keeps scheduling. */
export function isTransient(state: UsageExportDestination['state']): boolean {
  return state === 'retrying';
}
/** States where Kiki has stopped retrying on its own. */
export function needsAttention(state: UsageExportDestination['state']): boolean {
  return state === 'queue-full' || state === 'quarantined' || state === 'remote-diverged'
    || state === 'needs-auth' || state === 'adapter-unavailable';
}

/** True while the agreed configuration still matches what would be sent. */
export function consentIsCurrent(destination: UsageExportDestination): boolean {
  return destination.consent_fingerprint !== null;
}

export function queuePending(queue: UsageExportQueue): number {
  return queue.pending + queue.inflight;
}
export function queueIsEmpty(queue: UsageExportQueue): boolean {
  return queue.pending === 0 && queue.inflight === 0 && queue.quarantined === 0;
}

/** What the endpoint column prints: the retargetable origin, or the command. */
export function targetSummary(target: UsageExportTarget): { readonly text: string; readonly exact: string } {
  if (target.kind === 'script') return { text: target.command, exact: target.command };
  const grant = target.private_grant;
  const origin = grant === undefined ? target.endpoint : `${target.endpoint} → ${grant.host} (${grant.ip}:${grant.port})`;
  return { text: origin, exact: origin };
}

export function historyStart(destination: UsageExportDestination): string {
  const start = destination.scope.start_at;
  return start === 0 ? '1970-01-01T00:00:00.000Z' : new Date(start).toISOString();
}

/**
 * Exact UTC stamp for the values a consent is bound to (history start, cut-over
 * boundary). Deliberately not locale-formatted: the same instant is what the
 * server records and what the CLI takes, so the screen must print it verbatim.
 */
export function utcLabel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
export function isoOf(ms: number | null): string | undefined {
  return ms === null ? undefined : new Date(ms).toISOString();
}

/** Clamp a free-typed moment to the UTC half-hour bucket containing it. */
export function floorToHalfHour(ms: number): number {
  return Math.floor(ms / HALF_HOUR_MS) * HALF_HOUR_MS;
}
/** The first half-hour boundary strictly after `ms` — used for a cut-over T. */
export function ceilToHalfHour(ms: number): number {
  return (Math.floor(ms / HALF_HOUR_MS) + 1) * HALF_HOUR_MS;
}
export function isHalfHour(ms: number): boolean {
  return Number.isSafeInteger(ms) && ms >= 0 && ms % HALF_HOUR_MS === 0;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export interface PreviewQuality {
  readonly total: number;
  readonly known: number;
  readonly missing: number;
  readonly legacy: number;
  readonly invalid: number;
  readonly unmapped: number;
  readonly unpriced: number;
}

/** Summed quality over the buckets a preview would send. */
export function previewQuality(preview: UsageExportPreview): PreviewQuality {
  const sum = { known: 0, missing: 0, legacy: 0, invalid: 0, unmapped: 0, unpriced: 0 };
  for (const item of preview.items) {
    const bucket = item.bucket;
    if (bucket === null) continue;
    sum.known += bucket.quality.known_records;
    sum.missing += bucket.quality.missing_records;
    sum.legacy += bucket.quality.legacy_zero_records;
    sum.invalid += bucket.quality.invalid_records;
    if (bucket.quality.mapping_unknown) sum.unmapped += 1;
    if (bucket.quality.price_unknown) sum.unpriced += 1;
  }
  return { total: preview.total_buckets, ...sum, invalid: sum.invalid + preview.invalid_records };
}

export function sampleItem(preview: UsageExportPreview): UsageExportItem | undefined {
  return preview.items.find((item) => item.bucket !== null) ?? preview.items[0];
}

/** `usage-export-<label>-<id8>.json` — a name a person can find again. */
export function downloadFileName(label: string, id: string, suffix: string): string {
  const safe = label.trim().replaceAll(/[^A-Za-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 40);
  const name = safe === '' ? 'usage-export' : `usage-export-${safe}`;
  return `${name}-${id.slice(0, 8)}-${suffix}.json`;
}

/** Hand the payload to the browser; nothing is uploaded anywhere. */
export function downloadJson(fileName: string, payload: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 0);
}

/**
 * Flag read from `/meta` — the same query key and shape the SSH settings use.
 * `undefined` means the flag is not known yet; `false` means the server has not
 * registered the routes, which is why the panel never treats a 404 as "no
 * destinations".
 */
export function useUsageExportEnabled(client: KikiClient): { enabled: boolean | undefined; loading: boolean } {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  return {
    enabled: meta.data === undefined ? undefined : meta.data.experimental_flags?.[USAGE_EXPORT_FLAG] === true,
    loading: meta.isLoading,
  };
}

// ---------------------------------------------------------------------------
// Legacy-collector handoff
// ---------------------------------------------------------------------------

/**
 * `kiki.usage.handoff.v1` projected for the view. Two facts are derived here
 * rather than guessed: the collector endpoint recorded in the last receipt, and
 * whether it disagrees with the destination's own endpoint — that comparison is
 * the one mismatch the wire can actually prove, and a disagreement asks the user
 * to check the configuration instead of claiming the same account.
 */
export type UsageExportHandoffPhase = 'prepared' | 'armed' | 'awaiting-native' | 'completed' | 'rollback-prepared';

export interface UsageExportHandoffView {
  readonly phase: UsageExportHandoffPhase;
  readonly cutoffAt: number;
  readonly previousCutoffAt: number | null;
  readonly namespace: string;
  readonly legacyReceipt: { readonly completedAt: number; readonly buckets: number; readonly endpoint: string } | null;
  readonly nativeReceipt: { readonly buckets: number } | null;
  /** The collector's recorded ingest endpoint is not the one this destination sends to. */
  readonly mismatch: boolean;
}

export function handoffViewOf(
  handoff: UsageExportHandoff | null,
  destination: UsageExportDestination,
): UsageExportHandoffView | null {
  if (handoff === null) return null;
  const receipt = handoff.legacy_receipt;
  const endpoint = receipt === null ? null : receipt.collector_identity.ingest_endpoint;
  return {
    phase: handoff.phase,
    cutoffAt: handoff.cutoff_at,
    previousCutoffAt: handoff.previous_cutoff_at,
    namespace: handoff.namespace,
    legacyReceipt: receipt === null || endpoint === null
      ? null
      : { completedAt: receipt.completed_at, buckets: receipt.ingested, endpoint },
    nativeReceipt: handoff.native_receipt === null ? null : { buckets: handoff.native_receipt.items.length },
    mismatch: endpoint !== null && endpoint !== (destination.target.kind === 'script' ? '' : destination.target.endpoint),
  };
}
