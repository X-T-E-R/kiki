import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../i18n';
import { MEMORY_TYPES, type MemoryEntry, type MemoryJournalRecord, type MemoryTarget } from '../lib/client';
import { useConnection } from '../state/connection';
import { memoryTargetKey } from './persona/PersonaMemoryScope';

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
    };
  } catch { return undefined; }
}

export function MemoryReadView({ entry, target, sourceLabel }: {
  readonly entry: MemoryEntry;
  readonly target: MemoryTarget;
  readonly sourceLabel: string;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const replacement = useQuery({
    queryKey: ['memory-related', memoryTargetKey(target), entry.superseded_by],
    queryFn: () => client.getMemory(target, entry.superseded_by!),
    enabled: entry.superseded_by !== undefined,
    staleTime: 5_000,
  });
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
  const date = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString(locale);
  const retired = entry.status === 'archived' || entry.status === 'superseded';
  const reason = entry.status === 'superseded' ? originalReplacement?.reason : entry.reason;
  return (
    <article data-memory-read={entry.id} className="min-w-0 space-y-4">
      <div>
        <p className="mb-2 flex flex-wrap gap-x-2 gap-y-1 text-[12px] text-ink-soft">
          <span>{sourceLabel}</span><span>·</span><span>{t(`memory.type.${entry.type}`)}</span>
          {entry.status !== 'active' ? <><span>·</span><span>{t(`memory.status.${entry.status}`)}</span></> : null}
        </p>
        <h3 className="break-words text-[17px] leading-snug font-medium text-ink">{entry.title}</h3>
      </div>
      <p data-memory-read-body className="text-[13px] leading-7 break-words whitespace-pre-wrap text-ink">{entry.body}</p>
      {reason ? <div className="space-y-1">
        <p className="text-[12px] font-medium text-ink-soft">{t(retired ? 'memory.history.retirementReason' : 'memory.field.reason')}</p>
        <p data-memory-read-reason className="text-[13px] leading-6 break-words whitespace-pre-wrap text-ink-soft">{reason}</p>
      </div> : retired ? <p className="text-[12px] text-ink-faint">{t(entry.status === 'superseded' && (replacement.isPending || replacementHistory.isPending) ? 'memory.loading' : 'memory.history.reasonUnavailable')}</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px] text-ink-soft">
        <dt>{t('memory.history.createdAt')}</dt><dd>{date(entry.created)}</dd>
        <dt>{t('memory.history.updatedAt')}</dt><dd>{date(entry.updated)}</dd>
        <dt>{t('memory.history.scope')}</dt><dd className="break-all">{sourceLabel} <span className="text-ink-faint">({memoryTargetKey(target)})</span></dd>
        <dt>{t('memory.history.revision')}</dt><dd className="break-all font-mono text-[11px]">{entry.revision}</dd>
        {entry.supersedes !== undefined ? <><dt>{t('memory.history.replaces')}</dt><dd className="break-all font-mono text-[11px]">{entry.supersedes}{entry.supersedes_revision ? ` · ${entry.supersedes_revision}` : ''}</dd></> : null}
        {entry.superseded_by !== undefined ? <><dt>{t('memory.history.replacedBy')}</dt><dd className="break-all">{replacement.data?.title ?? entry.superseded_by}<span className="mt-1 block font-mono text-[11px] text-ink-faint">{entry.superseded_by}{replacement.data?.revision ? ` · ${replacement.data.revision}` : ''}</span></dd></> : null}
      </dl>
    </article>
  );
}

export function MemoryHistorySnapshot({ record, history, current, target, sourceLabel }: {
  readonly record: MemoryJournalRecord;
  readonly history: readonly MemoryJournalRecord[];
  readonly current: MemoryEntry;
  readonly target: MemoryTarget;
  readonly sourceLabel: string;
}) {
  const { t, locale } = useI18n();
  const before = memorySnapshot(record.before, record.beforeRevision);
  // Journal records carry only "before". Match revisions, never assume the next row is the next version.
  const afterRecord = record.afterRevision === null ? undefined : history.find((candidate) => candidate.id === record.id && candidate.beforeRevision === record.afterRevision && candidate.before !== null);
  const after = current.revision === record.afterRevision ? current : memorySnapshot(afterRecord?.before ?? null, record.afterRevision);
  const versions = [
    { label: t('memory.history.after'), entry: after, raw: afterRecord?.before, revision: record.afterRevision },
    { label: t('memory.history.before'), entry: before, raw: record.before, revision: record.beforeRevision },
  ];
  return (
    <div data-memory-history-detail={record.operationId} className="space-y-5 pt-3 pb-5 pl-5">
      <p className="text-[12px] text-ink-soft">{new Date(record.at).toLocaleString(locale)} · {t(`memory.writer.${record.writer}`)}</p>
      <div className="space-y-1 text-[11px] text-ink-faint" data-memory-revision-chain>
        <p className="font-medium">{t('memory.history.revision')}</p>
        <p className="font-mono break-all">{record.beforeRevision ?? t('memory.history.noVersion')} → {record.afterRevision ?? t('memory.history.noVersion')}</p>
      </div>
      {versions.map((version) => version.revision === null ? null : (
        <section key={version.label} className="space-y-3">
          <h4 className="text-[12px] font-medium text-ink-soft">{version.label}</h4>
          {version.entry !== undefined ? <MemoryReadView entry={version.entry} target={target} sourceLabel={sourceLabel} />
            : version.raw ? <pre className="font-mono text-[12px] leading-6 break-words whitespace-pre-wrap text-ink-soft">{version.raw}</pre>
            : <p className="text-[12px] text-ink-faint">{t('memory.history.snapshotUnavailable')}</p>}
        </section>
      ))}
    </div>
  );
}
