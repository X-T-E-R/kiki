/**
 * The reading face of one entry, and the version walk beside it.
 *
 * Three facts about a memory are separate things, and this view keeps them
 * apart instead of merging them into one "source" line: what the content is
 * based on (`basis`), who last wrote it (`source`, the writer's session and
 * turn), and when it must be checked again (`validity`). A tool call records
 * the writer, never the original human instruction, so the two never stand in
 * for each other. An entry with no recorded basis says so; none is invented.
 *
 * The journal panel shows the real before and after content, with the
 * metadata that rode each version, so a change can be read rather than
 * inferred from a revision number.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { MEMORY_TYPES, type MemoryEntry, type MemoryJournalRecord, type MemoryTarget } from '../lib/client';
import { useConnection } from '../state/connection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from './Dialog';
import { Icon } from './icons';
import { memoryTargetKey } from './persona/PersonaMemoryScope';
import { SECONDARY_BUTTON } from './ui';
import {
  memoryApplicability,
  parseMemoryEntry,
  type MemoryEntryView,
  type MemoryValidity,
} from './memory/memoryReceipt';

/** Store-written snapshots have JSON frontmatter. Keep hand-edited formats intact as raw text. */
export function memorySnapshot(raw: string | null, revision: string | null): MemoryEntry | undefined {
  if (raw === null || revision === null) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (match === null) return undefined;
  try {
    const meta = JSON.parse(match[1]!) as Partial<MemoryEntry>;
    if (typeof meta.id !== 'string' || typeof meta.title !== 'string'
      || !MEMORY_TYPES.includes(meta.type!) || !['active', 'pending', 'archived', 'superseded'].includes(meta.status!)) return undefined;
    return {
      id: meta.id, title: meta.title, type: meta.type!, status: meta.status!,
      body: match[2]!.replace(/\r?\n$/, ''), revision,
      pinned: meta.pinned === true,
      created: typeof meta.created === 'string' ? meta.created : '',
      updated: typeof meta.updated === 'string' ? meta.updated : '',
      reason: typeof meta.reason === 'string' ? meta.reason : '',
      source: meta.source && ['user', 'agent', 'consolidator', 'import'].includes(meta.source.writer) ? meta.source : { writer: 'import' },
      superseded_by: typeof meta.superseded_by === 'string' ? meta.superseded_by : undefined,
      supersedes: typeof meta.supersedes === 'string' ? meta.supersedes : undefined,
      supersedes_revision: typeof meta.supersedes_revision === 'string' ? meta.supersedes_revision : undefined,
      // What this entry proposes to do to the one it supersedes. Absent on an
      // entry that is itself the fact; present on a review candidate, whose
      // own id and revision are what a decision is made about.
      pending_action: meta.pending_action === 'update' || meta.pending_action === 'archive' ? meta.pending_action : undefined,
      // A before-image written after the metadata existed carries it; an older
      // one simply has none, and reads as a version with no recorded basis.
      basis: meta.basis as MemoryEntry['basis'],
      validity: meta.validity as MemoryEntry['validity'],
      covered_by: meta.covered_by as MemoryEntry['covered_by'],
    };
  } catch { return undefined; }
}

/** Journal actions the history list names; anything else shows its raw verb. */
const HISTORY_LABELS = {
  create: 'memory.history.create',
  update: 'memory.history.update',
  delete: 'memory.history.delete',
  archive: 'memory.history.archive',
  supersede: 'memory.history.supersede',
  supersede_previous: 'memory.history.supersede_previous',
  undo: 'memory.history.undo',
} as const satisfies Readonly<Record<string, I18nKey>>;

export function historyLabel(action: string, t: (key: I18nKey) => string): string {
  const key = (HISTORY_LABELS as Readonly<Record<string, I18nKey>>)[action];
  return key === undefined ? action : t(key);
}

export function TypeTag({ type }: { readonly type: MemoryEntry['type'] }) {
  const { t } = useI18n();
  return (
    <span data-memory-type={type} className="shrink-0 rounded-sm bg-ink/[0.05] px-1.5 py-px text-[11px] font-medium text-ink-soft">
      {t(`memory.type.${type}`)}
    </span>
  );
}

const dateText = (locale: string, value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString(locale);

/**
 * Why this content is recorded, separate from who last wrote it. An absent
 * basis is a gap in the record, not a judgment about the content, and it is
 * worded that way.
 */
export function BasisLine({ entry, className = '' }: { readonly entry: MemoryEntryView; readonly className?: string }) {
  const { t } = useI18n();
  const basis = entry.basis;
  return (
    <div data-memory-basis={basis?.kind ?? 'unrecorded'} className={`min-w-0 ${className}`}>
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-ink-faint">{t('memory.basis.label')}</span>
        <span className={`font-medium ${basis?.kind === 'unknown' || basis === undefined ? 'text-ink-faint' : 'text-ink-soft'}`}>
          {t(basis === undefined ? 'memory.basis.unrecorded' : `memory.basis.${basis.kind}`)}
        </span>
        {basis !== undefined && basis.refs.length > 0 ? (
          <span className="text-ink-faint">{tpRefs(t, basis.refs.length)}</span>
        ) : null}
      </p>
      {basis !== undefined && basis.note !== '' ? (
        <p data-memory-basis-note className="mt-0.5 text-[12px] leading-relaxed break-words text-ink-soft">{basis.note}</p>
      ) : null}
      {basis !== undefined && basis.refs.length > 0 ? (
        <ul data-memory-basis-refs className="mt-1 space-y-0.5">
          {basis.refs.map((ref) => (<li key={ref} className="font-mono text-[11px] break-all text-ink-faint">{ref}</li>))}
        </ul>
      ) : null}
    </div>
  );
}

const tpRefs = (t: (key: I18nKey, params?: Readonly<Record<string, string | number>>) => string, count: number) =>
  t('memory.basis.refs', { count });

/**
 * What must be checked before relying on this, and whether its answer has run
 * out. `unrecorded` states that no check was written down; it never implies
 * the fact is permanent.
 */
export function ValidityLine({ validity, now, className = '' }: {
  readonly validity: MemoryValidity | undefined;
  readonly now?: number;
  readonly className?: string;
}) {
  const { t, locale } = useI18n();
  const applicability = memoryApplicability(validity, now);
  if (applicability === 'unrecorded') {
    return (
      <p data-memory-validity="unrecorded" data-memory-validity-state="unrecorded" className={`text-ink-faint ${className}`}>
        <span className="text-ink-faint">{t('memory.validity.label')}: </span>
        {t('memory.validity.unrecorded')}
      </p>
    );
  }
  const expired = applicability === 'expired';
  return (
    <div data-memory-validity={applicability} data-memory-validity-state={applicability} className={`min-w-0 ${className} ${expired ? 'text-amber-ink' : 'text-ink-soft'}`}>
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span>{t('memory.validity.label')}: </span>
        <span className="font-medium">{t(expired ? 'memory.validity.expired' : 'memory.validity.recheck')}</span>
        {validity?.until !== undefined ? (
          <span className="text-ink-faint">{dateText(locale, validity.until)}</span>
        ) : null}
      </p>
      {validity !== undefined ? (
        <p data-memory-validity-check className="mt-0.5 text-[12px] leading-relaxed break-words text-ink-soft">{validity.check}</p>
      ) : null}
    </div>
  );
}

/** The entry a consolidation retired this one into, and whether it still holds that role. */
function CoveredByLine({ coveredBy, onOpen }: { readonly coveredBy: NonNullable<MemoryEntryView['covered_by']>; readonly onOpen?: () => void }) {
  const { t } = useI18n();
  return (
    <p data-memory-covered-by={coveredBy.id} className="text-[13px] text-ink-soft">
      <span className="text-ink-faint">{t('memory.coveredBy.label')}: </span>
      {onOpen === undefined ? coveredBy.id : (
        <button
          type="button"
          data-memory-open-covered
          onClick={onOpen}
          className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          {coveredBy.id}
        </button>
      )}
    </p>
  );
}

/**
 * The reading face of one entry: source, title, body, and the reason when one
 * was written. Provenance (revisions, exact timestamps, replacement chains)
 * stays in the history panel, so the normal view carries only what a reader
 * needs. A superseded entry still reads its retirement reason from the
 * replacement's journal, and links to the replacement when it is in view.
 */
export function MemoryReadView({ entry, target, sourceLabel, onOpenReplacement, onOpenCoveredBy, now }: {
  readonly entry: MemoryEntry;
  readonly target: MemoryTarget;
  readonly sourceLabel: string;
  readonly onOpenReplacement?: () => void;
  readonly onOpenCoveredBy?: () => void;
  /** Passed in so a list of entries shares one reading of "now". */
  readonly now?: number;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const replacement = useQuery({
    queryKey: ['memory-related', memoryTargetKey(target), entry.superseded_by],
    queryFn: () => client.getMemory(target, entry.superseded_by!),
    enabled: entry.superseded_by !== undefined,
    staleTime: 5_000,
  });
  const covered = useQuery({
    queryKey: ['memory-related', memoryTargetKey(target), entry.covered_by?.id],
    queryFn: () => client.getMemory(target, entry.covered_by!.id),
    enabled: entry.covered_by !== undefined,
    staleTime: 5_000,
  });
  const coveredChanged = covered.data !== undefined && (covered.data.revision !== entry.covered_by?.revision || covered.data.status !== 'active');
  const replacementHistory = useQuery({
    queryKey: ['memory-journal', memoryTargetKey(target), entry.superseded_by],
    queryFn: () => client.memoryJournal(target, entry.superseded_by!),
    enabled: entry.superseded_by !== undefined,
    staleTime: 5_000,
  });
  const supersede = replacementHistory.data?.find((record) => record.action === 'supersede');
  const originalReplacement = supersede === undefined ? undefined
    : replacement.data?.revision === supersede.afterRevision ? replacement.data
      : memorySnapshot(replacementHistory.data?.find((record) => record.beforeRevision === supersede.afterRevision)?.before ?? null, supersede.afterRevision);
  const retired = entry.status === 'archived' || entry.status === 'superseded';
  const reason = entry.status === 'superseded' ? originalReplacement?.reason : entry.reason;
  const view = parseMemoryEntry(entry);
  return (
    <article data-memory-read={entry.id} className="min-w-0 space-y-3">
      <div>
        <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-faint">
          <span>{sourceLabel}</span><span aria-hidden>·</span><span>{t(`memory.type.${entry.type}`)}</span>
          {entry.status !== 'active' ? <><span aria-hidden>·</span><span>{t(`memory.status.${entry.status}`)}</span></> : null}
        </p>
        <h3 className="break-words text-[17px] leading-snug font-medium text-ink">{entry.title}</h3>
      </div>
      <p data-memory-read-body className="text-[13px] leading-7 break-words whitespace-pre-wrap text-ink">{entry.body}</p>
      {reason ? (
        <p className="text-[13px] leading-6 break-words text-ink-soft">
          <span className="font-medium">{t(retired ? 'memory.history.retirementReason' : 'memory.field.reason')}</span>
          {' · '}
          <span data-memory-read-reason className="whitespace-pre-wrap">{reason}</span>
        </p>
      ) : retired ? (
        <p className="text-[12px] text-ink-faint">
          {t(entry.status === 'superseded' && (replacement.isPending || replacementHistory.isPending) ? 'memory.loading' : 'memory.history.reasonUnavailable')}
        </p>
      ) : null}
      {/* Who last wrote this, and why the content reads as it does: two
          different facts, so two lines rather than one merged one. */}
      {view !== undefined ? (
        <div data-memory-provenance className="space-y-3 border-t border-hairline pt-3">
          <BasisLine entry={view} />
          <ValidityLine validity={view.validity} now={now} />
        </div>
      ) : null}
      {view?.covered_by !== undefined ? <>
        <CoveredByLine coveredBy={view.covered_by} onOpen={onOpenCoveredBy} />
        {coveredChanged || covered.isError ? <p data-memory-covered-state className="text-[12px] text-amber-ink">{t(covered.isError ? 'memory.coveredBy.unavailable' : 'memory.coveredBy.changed')}</p> : null}
      </> : null}
      {entry.superseded_by !== undefined ? (
        onOpenReplacement !== undefined && replacement.data !== undefined ? (
          <button
            type="button"
            data-memory-open-replacement
            onClick={onOpenReplacement}
            className="text-[13px] text-ink-soft underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
          >
            {t('memory.replacedBy', { title: replacement.data.title })}
          </button>
        ) : (
          <p data-memory-replacement-text role={replacement.isPending ? 'status' : undefined} className="text-[13px] text-ink-faint">
            {replacement.isPending ? t('memory.loading') : t('memory.replacedBy', { title: replacement.data?.title ?? entry.superseded_by })}
          </p>
        )
      ) : null}
    </article>
  );
}

function VersionBlock({ label, entry, raw, revision }: {
  readonly label: string;
  readonly entry: MemoryEntryView | undefined;
  readonly raw: string | null | undefined;
  readonly revision: string | null;
}) {
  const { t, locale } = useI18n();
  if (revision === null) return null;
  const dates = entry === undefined ? '' : [
    entry.created === '' ? '' : `${t('memory.history.createdAt')} ${dateText(locale, entry.created)}`,
    entry.updated === '' ? '' : `${t('memory.history.updatedAt')} ${dateText(locale, entry.updated)}`,
  ].filter((part) => part !== '').join(' · ');
  return (
    <section className="space-y-2">
      <h4 className="text-[12px] font-medium text-ink-soft">{label}</h4>
      {entry !== undefined ? (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-1.5">
            <TypeTag type={entry.type} />
            {entry.status !== 'active' ? <span className="text-[11px] text-ink-faint">{t(`memory.status.${entry.status}`)}</span> : null}
            {entry.covered_by !== undefined ? <span data-memory-version-covered className="text-[11px] text-ink-faint">{t('memory.coveredBy.label')}</span> : null}
          </p>
          <p className="break-words text-[14px] font-medium leading-snug text-ink">{entry.title}</p>
          <p className="text-[13px] leading-6 break-words whitespace-pre-wrap text-ink">{entry.body}</p>
          {entry.reason !== '' ? (
            <p className="text-[13px] leading-6 break-words text-ink-soft">{t('memory.field.reason')} · {entry.reason}</p>
          ) : null}
          {/* The metadata that rode this version, so a diff of the basis or the
              check is readable next to the content it belongs to. */}
          <BasisLine entry={entry} />
          <ValidityLine validity={entry.validity} />
          {entry.covered_by === undefined ? null : <CoveredByLine coveredBy={entry.covered_by} />}
          {dates === '' ? null : <p className="text-[12px] text-ink-faint">{dates}</p>}
        </div>
      ) : raw !== null && raw !== undefined ? (
        <pre className="font-mono text-[12px] leading-6 break-words whitespace-pre-wrap text-ink-soft">{raw}</pre>
      ) : (
        <p className="text-[12px] text-ink-faint">{t('memory.history.snapshotUnavailable')}</p>
      )}
    </section>
  );
}

/**
 * One journal record as a panel: when, who, the revision chain, and the full
 * before/after content. Newer / Older steps through the records newest-first,
 * so the panel doubles as version browsing instead of a one-shot lookup.
 */
export function MemoryHistoryDialog({
  recordId,
  onNavigate,
  onClose,
  history,
  current,
  sourceLabel,
  onUndo,
  undoBusy,
}: {
  readonly recordId: string;
  readonly onNavigate: (recordId: string) => void;
  readonly onClose: () => void;
  readonly history: readonly MemoryJournalRecord[];
  readonly current: MemoryEntry;
  readonly target: MemoryTarget;
  readonly sourceLabel: string;
  readonly onUndo: (record: MemoryJournalRecord) => void;
  readonly undoBusy: boolean;
}) {
  const { t, locale } = useI18n();
  // Newest first, matching the order of the history rows in the detail pane.
  const records = [...history].reverse();
  const index = records.findIndex((candidate) => candidate.operationId === recordId);
  const record = index >= 0 ? records[index] : undefined;
  useEffect(() => { if (record === undefined) onClose(); }, [record, onClose]);
  if (record === undefined) return null;

  const before = memorySnapshot(record.before, record.beforeRevision);
  // Journal records carry only "before". Match revisions, never assume the next row is the next version.
  const afterRecord = record.afterRevision === null ? undefined : history.find((candidate) => candidate.id === record.id && candidate.beforeRevision === record.afterRevision && candidate.before !== null);
  const after = current.revision === record.afterRevision ? current : memorySnapshot(afterRecord?.before ?? null, record.afterRevision);

  const navClass = 'text-[12px] text-ink-soft underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:text-ink-faint disabled:no-underline disabled:opacity-60';
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('memory.history')}
      overlayId="memory-history"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} flex max-h-[85dvh] flex-col`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto" data-memory-history-detail={record.operationId}>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="font-display text-[18px] font-semibold text-ink">{historyLabel(record.action, t)}</h3>
          <span className="text-[12px] text-ink-faint">
            {dateText(locale, record.at)} · {t(`memory.writer.${record.writer}`)}
          </span>
          {records.length > 1 ? (
            <span className="ml-auto text-[12px] text-ink-faint tabular-nums">{index + 1} / {records.length}</span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-ink-faint">{current.title} · {sourceLabel}</p>
        {record.beforeRevision !== null || record.afterRevision !== null ? (
          <p className="mt-3 text-[11px] text-ink-faint" data-memory-revision-chain>
            {t('memory.history.revision')}{' '}
            <span className="font-mono break-all">{record.beforeRevision ?? t('memory.history.noVersion')} → {record.afterRevision ?? t('memory.history.noVersion')}</span>
          </p>
        ) : null}
        <div className="mt-4 space-y-4">
          <VersionBlock label={t('memory.history.after')} entry={parseMemoryEntry(after)} raw={afterRecord?.before} revision={record.afterRevision} />
          {record.beforeRevision !== null ? <hr className="border-hairline" /> : null}
          <VersionBlock label={t('memory.history.before')} entry={parseMemoryEntry(before)} raw={record.before} revision={record.beforeRevision} />
        </div>
      </div>
      <div className="mt-4 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline pt-4">
        {records.length > 1 ? (
          <span className="flex items-center gap-3">
            <button type="button" data-memory-history-nav="newer" disabled={index === 0}
              onClick={() => { onNavigate(records[index - 1]!.operationId); }} className={`${navClass} flex items-center gap-1`}>
              <Icon name="chevron" size={12} className="rotate-90" />
              <span>{t('memory.history.newer')}</span>
            </button>
            <button type="button" data-memory-history-nav="older" disabled={index === records.length - 1}
              onClick={() => { onNavigate(records[index + 1]!.operationId); }} className={`${navClass} flex items-center gap-1`}>
              <span>{t('memory.history.older')}</span>
              <Icon name="chevron" size={12} className="-rotate-90" />
            </button>
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {record.action !== 'undo' ? (
            <button type="button" data-memory-undo={record.operationId} disabled={undoBusy}
              onClick={() => { onUndo(record); }} className={SECONDARY_BUTTON}>
              {t('memory.undo')}
            </button>
          ) : null}
          <button type="button" data-memory-history-close onClick={onClose} className={SECONDARY_BUTTON}>
            {t('common.close')}
          </button>
        </span>
      </div>
    </Dialog>
  );
}
