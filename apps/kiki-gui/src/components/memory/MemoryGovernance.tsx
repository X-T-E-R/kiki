/**
 * The governed-store faces of /memory: which store is in charge, the sources
 * and human decisions behind one entry, a historical revision, and permanent
 * forget.
 *
 * Forget is not delete. Delete is journal-backed and undoable; forget removes
 * every object sharing the entry's source, with their revisions and sources,
 * and leaves a barrier so the content cannot return. So it always previews
 * the exact set first, confirms with the revisions that preview returned, and
 * never offers Undo. A preview that went stale fails as a whole and is
 * previewed again rather than partially applied.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  ApiError,
  MEMORY_NOT_FOUND,
  MEMORY_REVISION_CONFLICT,
  type MemoryAdjudication,
  type MemoryEntry,
  type MemoryEvidenceSource,
  type MemoryTarget,
} from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { InlineError } from '../controls';

import { RelativeTime } from '../RelativeTime';
import { DANGER_BUTTON, SECONDARY_BUTTON } from '../ui';
import { VersionBlock } from '../MemoryHistory';
import { memoryTargetKey } from '../persona/PersonaMemoryScope';
import { parseMemoryEntry } from './memoryReceipt';
import { MEMORY_AUTHORITY_QUERY_KEY, useMemoryAuthority, type MemoryStoreKind } from './memoryAuthority';
import { MemoryUpgradeStatus } from './MemoryUpgrade';

const LABEL = 'text-[12px] font-medium text-ink-soft';
const QUIET = 'rounded-sm text-[12px] text-ink-soft underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:opacity-60';

/** A v4 id for operation idempotency, without assuming `randomUUID` exists. */
export function memoryOperationId(): string {
  const native = globalThis.crypto?.randomUUID?.();
  if (native !== undefined) return native;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Revisions are long opaque ids; the tail is what tells two apart at a glance. */
export function shortRevision(revision: string): string {
  const bare = revision.replace(/^mem2:/u, '');
  return bare.length <= 10 ? bare : bare.slice(-8);
}

const STORE_LABEL = {
  legacy: 'memory.store.legacy',
  governed: 'memory.store.governed',
  migrating: 'memory.store.migrating',
  readonly: 'memory.store.readonly',
  unknown: 'memory.store.unknown',
} as const satisfies Record<MemoryStoreKind, string>;

/** Every memory read and write depends on the store; one write moves them all. */
function useRefreshMemory() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of ['memory-authority', 'memory', 'memory-journal', 'memory-related', 'memory-inbox', 'memory-provenance', 'memory-detail']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** One quiet header line: which store, plus the recovery switch a governed store offers. */
export function MemoryStoreStatus() {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const authority = useMemoryAuthority();
  const queryClient = useQueryClient();
  const refresh = useRefreshMemory();
  const [confirm, setConfirm] = useState(false);
  const recover = useMutation({
    mutationFn: () => client.recoverMemoryReadOnly(),
    onSuccess: () => {
      setConfirm(false);
      pushToast({ tone: 'success', text: t('memory.store.recovered') });
      refresh();
    },
    onError: (error: unknown) => {
      setConfirm(false);
      pushToast({ tone: 'error', text: t('memory.actionFailed', { detail: errorText(locale, error) }) });
      void queryClient.invalidateQueries({ queryKey: MEMORY_AUTHORITY_QUERY_KEY });
    },
  });
  if (authority.loading) return null;
  const kind = authority.kind;
  return (
    <>
      <span data-memory-store={kind} className="flex items-center gap-1.5">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${kind === 'governed' ? 'bg-accent' : kind === 'legacy' ? 'bg-ink-faint' : kind === 'unknown' ? 'border border-ink-faint' : 'bg-amber-ink'}`} />
        <span className={kind === 'readonly' || kind === 'migrating' ? 'font-medium text-amber-ink' : undefined}>{t(authority.state?.migration?.phase === 'failed' ? 'memory.store.upgradeStopped' : STORE_LABEL[kind])}</span>
      </span>
      {kind === 'governed' ? (
        <button type="button" data-memory-recover onClick={() => { setConfirm(true); }} className="text-ink-soft hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink">
          {t('memory.store.recover')}
        </button>
      ) : null}
      <ConfirmDialog
        open={confirm}
        title={t('memory.store.recoverTitle')}
        body={t('memory.store.recoverBody')}
        confirmLabel={t('memory.store.recoverConfirm')}
        tone="default"
        busy={recover.isPending}
        overlayId="memory-recover-confirm"
        onCancel={() => { setConfirm(false); }}
        onConfirm={() => { recover.mutate(); }}
      />
    </>
  );
}

/**
 * Shown above the console only while edits are held: what is going on, and
 * the one action that lifts it when this page can take it. Resume sends the
 * exact recovery id and epoch it was shown, so a recovery that moved on is
 * re-read instead of resumed blindly.
 */
export function MemoryWriteHold() {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const authority = useMemoryAuthority();
  const refresh = useRefreshMemory();
  const state = authority.state;
  const resume = useMutation({
    mutationFn: () => client.resumeMemoryEditing(state!.recoveryId!, state!.epoch),
    onSuccess: () => {
      pushToast({ tone: 'success', text: t('memory.store.resumed') });
      refresh();
    },
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: error instanceof ApiError && error.code === 40001 ? t('memory.store.resumeChanged') : t('memory.actionFailed', { detail: errorText(locale, error) }) });
      refresh();
    },
  });
  if (authority.kind !== 'readonly' && authority.kind !== 'migrating') return null;
  const readonly = authority.kind === 'readonly';
  // The automatic upgrade has its own status; it is never started from here.
  if (!readonly) {
    return (
      <div data-memory-write-hold="migrating" className="mb-4 border-l-2 border-amber-rule pl-3">
        <MemoryUpgradeStatus />
      </div>
    );
  }
  return (
    <div data-memory-write-hold={authority.kind} role="status" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-l-2 border-amber-rule pl-3 text-[13px] leading-relaxed text-ink-soft">
      <p className="min-w-0 flex-1 basis-[28ch]">{t(readonly ? 'memory.store.readonlyBanner' : 'memory.store.migratingBanner')}</p>
      {readonly && state?.recoveryId !== undefined ? (
        <button type="button" data-memory-resume disabled={resume.isPending} onClick={() => { resume.mutate(); }} className={SECONDARY_BUTTON}>
          {t('memory.store.resume')}
        </button>
      ) : null}
    </div>
  );
}

/** A source as a reader recognises it: where it came from, else its own words. */
function sourceText(source: MemoryEvidenceSource): { readonly head: string; readonly body?: string } {
  // An imported Markdown file is kept whole; its header is bookkeeping, the body is what was learned.
  const file = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/u.exec(source.payload);
  if (file !== null) return { head: source.locator !== undefined && source.locator !== '' ? source.locator : source.id, body: file[1]!.trim() };
  let payload: unknown;
  try { payload = JSON.parse(source.payload); } catch { payload = undefined; }
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
  const basis = record?.['basis'] as { note?: unknown } | undefined;
  const note = typeof basis?.note === 'string' && basis.note !== '' ? basis.note : undefined;
  if (source.locator !== undefined && source.locator !== '') return { head: source.locator, body: record === undefined ? source.payload : note };
  if (record !== undefined) return { head: note ?? source.id };
  return { head: source.payload };
}

/**
 * Sources and decisions for one entry. Decisions are what a person ruled on a
 * specific revision; sources are what the content was learned from. They stay
 * separate lists, and the current revision is named so a reader can tell
 * which ruling is in force.
 */
export function MemoryGovernancePanel({ target, entry }: { readonly target: MemoryTarget; readonly entry: MemoryEntry }) {
  const { t, tp } = useI18n();
  const { client } = useConnection();
  const authority = useMemoryAuthority();
  const [openRevision, setOpenRevision] = useState<string | null>(null);
  const provenance = useQuery({
    queryKey: ['memory-provenance', memoryTargetKey(target), entry.id, entry.revision],
    queryFn: ({ signal }) => client.memoryProvenance(target, entry.id, signal),
    enabled: authority.governed,
    staleTime: 5_000,
    retry: false,
  });
  if (!authority.governed) return null;
  const data = provenance.data;
  const shared = (data?.relatedObjectIds ?? []).filter((id) => id !== entry.id).length;
  const decisions = [...(data?.adjudications ?? [])].reverse();
  return (
    <section data-memory-governance="governed" aria-labelledby={`memory-governance-${entry.id}`} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={`memory-governance-${entry.id}`} className={LABEL}>{t('memory.governance.title')}</h3>
        <span data-memory-current-revision={entry.revision} className="text-[12px] text-ink-faint">
          {t('memory.governance.current')} <span className="font-mono text-ink-soft" title={entry.revision}>{shortRevision(entry.revision)}</span>
        </span>
      </div>
      {provenance.isPending ? <p role="status" className="text-[12px] text-ink-faint">{t('memory.loading')}</p>
        : provenance.isError ? (
          <div role="alert" className="space-y-1">
            <p className="text-[12px] font-medium text-danger">{t('memory.governance.loadFailed')}</p>
            <InlineError error={provenance.error} />
            <button type="button" onClick={() => { void provenance.refetch(); }} className={`mt-1 ${SECONDARY_BUTTON}`}>{t('common.retry')}</button>
          </div>
        ) : data !== undefined ? (
          <div className="space-y-3">
            <div>
              <p className="text-[12px] text-ink-faint">{t('memory.governance.decisions')}</p>
              {decisions.length === 0 ? <p className="mt-1 text-[12px] text-ink-faint">{t('memory.governance.noDecisions')}</p> : (
                <ul className="mt-1 space-y-1.5">
                  {decisions.map((decision) => <DecisionRow key={decision.id} decision={decision} current={decision.revision === entry.revision} onOpen={() => { setOpenRevision(decision.revision); }} />)}
                </ul>
              )}
            </div>
            <div>
              <p className="text-[12px] text-ink-faint">{t('memory.governance.sources')}</p>
              {data.sources.length === 0 ? <p className="mt-1 text-[12px] text-ink-faint">{t('memory.governance.noSources')}</p> : (
                <ul className="mt-1 space-y-2">
                  {data.sources.map((source) => {
                    const text = sourceText(source);
                    return (
                      <li key={source.id} data-memory-source-record={source.id} className="min-w-0 text-[12px] leading-relaxed">
                        <p className="break-words text-ink-soft">{text.head}</p>
                        {text.body !== undefined && text.body !== text.head ? <p className="line-clamp-3 break-words text-ink-faint">{text.body}</p> : null}
                        <p className="text-ink-faint">{t('memory.governance.learned')} <RelativeTime at={source.learnedAt} /></p>
                      </li>
                    );
                  })}
                </ul>
              )}
              {shared > 0 ? <p data-memory-shared-source={shared} className="mt-1.5 text-[12px] text-ink-soft">{tp('memory.governance.shared', shared)}</p> : null}
            </div>
          </div>
        ) : null}
      {openRevision !== null ? (
        <MemoryRevisionDialog target={target} entry={entry} revision={openRevision} onClose={() => { setOpenRevision(null); }} />
      ) : null}
    </section>
  );
}

function DecisionRow({ decision, current, onOpen }: { readonly decision: MemoryAdjudication; readonly current: boolean; readonly onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <li data-memory-decision={decision.kind} data-memory-decision-current={current ? 'true' : undefined} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
      <span className={`shrink-0 font-medium ${current ? 'text-ink' : 'text-ink-soft'}`}>{t(`memory.governance.kind.${decision.kind}`)}</span>
      {decision.reason !== '' ? <span className="min-w-0 break-words text-ink-soft">{decision.reason}</span> : null}
      <span className="font-mono text-[11px] text-ink-faint" title={decision.revision}>{shortRevision(decision.revision)}{current ? ` · ${t('memory.governance.isCurrent')}` : ''}</span>
      {!current ? (
        <button type="button" data-memory-open-revision={decision.revision} onClick={onOpen} className={QUIET}>{t('memory.governance.viewRevision')}</button>
      ) : null}
    </li>
  );
}

/** One historical revision, read from the store rather than reconstructed from the journal. */
function MemoryRevisionDialog({ target, entry, revision, onClose }: {
  readonly target: MemoryTarget; readonly entry: MemoryEntry; readonly revision: string; readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const query = useQuery({
    queryKey: ['memory-revision', memoryTargetKey(target), entry.id, revision],
    queryFn: ({ signal }) => client.memoryRevision(target, entry.id, revision, signal),
    retry: false,
  });
  const missing = query.error instanceof ApiError && query.error.code === MEMORY_NOT_FOUND;
  return (
    <Dialog onClose={onClose} ariaLabel={t('memory.revision.title')} overlayId="memory-revision" panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} flex max-h-[85dvh] flex-col`}>
      <div data-memory-revision-detail={revision} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="font-display text-[18px] font-semibold text-ink">{t('memory.revision.title')}</h3>
          <span className="font-mono text-[12px] break-all text-ink-faint">{revision}</span>
        </div>
        <p className="mt-0.5 truncate text-[12px] text-ink-faint">{entry.title}</p>
        <div className="mt-4">
          {query.isPending ? <p role="status" className="text-[12px] text-ink-faint">{t('memory.loading')}</p>
            : missing ? <p className="text-[13px] text-ink-soft">{t('memory.revision.missing')}</p>
            : query.isError ? <InlineError error={query.error} />
            : <VersionBlock label={t('memory.revision.title')} entry={parseMemoryEntry(query.data)} raw={undefined} revision={revision} />}
        </div>
      </div>
      <div className="mt-4 flex shrink-0 justify-end border-t border-hairline pt-4">
        <button type="button" data-memory-revision-close onClick={onClose} className={SECONDARY_BUTTON}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}

/**
 * Preview, then confirm, a permanent forget. The preview fixes both the set
 * and each member's revision; the confirmation sends exactly those, under one
 * operation id per preview so a retried click after a lost response cannot
 * forget twice or forget something newer. A changed set refuses as a whole.
 */
export function MemoryForgetDialog({ target, entry, onClose, onForgotten }: {
  readonly target: MemoryTarget;
  readonly entry: MemoryEntry;
  readonly onClose: () => void;
  readonly onForgotten: () => void;
}) {
  const { t, tp, locale } = useI18n();
  const { client } = useConnection();
  const refresh = useRefreshMemory();
  const [attempt, setAttempt] = useState(0);
  const [ack, setAck] = useState(false);
  const [stale, setStale] = useState(false);
  const preview = useQuery({
    queryKey: ['memory-forget-preview', memoryTargetKey(target), entry.id, attempt],
    queryFn: ({ signal }) => client.previewMemoryForget(target, [entry.id], signal),
    retry: false, gcTime: 0, staleTime: Infinity,
  });
  // One operation per preview: a retry of the same confirmation is the same operation.
  const operationId = useMemo(() => memoryOperationId(), [preview.data]);
  const targets = preview.data?.targets ?? [];
  const forget = useMutation({
    mutationFn: () => client.forgetMemory(target, operationId, targets.map((item) => ({ id: item.id, expectedRevision: item.expectedRevision }))),
    onSuccess: (result) => {
      pushToast({ tone: 'success', text: tp('memory.forget.done', result.forgotten.length) });
      refresh();
      onForgotten();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === MEMORY_REVISION_CONFLICT) { setStale(true); setAck(false); }
    },
  });
  const repreview = () => { setStale(false); setAck(false); forget.reset(); setAttempt((value) => value + 1); };
  // The store can stop accepting writes while this dialog is open; the preview
  // stays readable, the confirmation waits, and it is not sent on the hope
  // that the server will refuse it.
  const { writable, kind } = useMemoryAuthority();
  const busy = forget.isPending;
  const failed = forget.isError && !stale ? forget.error : undefined;
  // Forget is the one irreversible memory action, so it renders through
  // ConfirmDialog: the exact preview, the acknowledgement and the repreview
  // escape are its children.
  return (
    <ConfirmDialog
      open
      overlayId="memory-forget"
      title={t('memory.forget.title')}
      tone="danger"
      busy={busy}
      confirmLabel={stale || preview.isError ? t('memory.forget.repreview') : tp('memory.forget.confirm', Math.max(targets.length, 1))}
      confirmDisabled={stale || preview.isError ? false : !ack || targets.length === 0 || !writable || preview.isPending}
      confirmData={stale || preview.isError ? { 'data-memory-forget-repreview': '' } : { 'data-memory-forget-confirm': '' }}
      cancelLabel={t('common.cancel')}
      onCancel={() => { if (!busy) onClose(); }}
      onConfirm={() => {
        if (stale || preview.isError) { repreview(); return; }
        if (writable) forget.mutate();
      }}
    >
      <div data-memory-forget={entry.id} className="max-h-[55dvh] overflow-y-auto">
        {preview.isPending ? (
          <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ink-faint"><span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />{t('memory.forget.previewing')}</p>
        ) : preview.isError ? (
          <div role="alert" className="mt-3 space-y-1">
            <p className="text-[13px] font-medium text-danger">{t('memory.forget.previewFailed')}</p>
            <InlineError error={preview.error} />
          </div>
        ) : (
          <>
            <p data-memory-forget-scope={targets.length} className="mt-3 text-[13px] leading-relaxed text-ink-soft">{tp('memory.forget.scope', targets.length)}</p>
            <ul data-memory-forget-targets className="mt-3 divide-y divide-hairline border-y border-hairline">
              {targets.map((item) => (
                <li key={item.id} data-memory-forget-target={item.id} data-memory-forget-revision={item.expectedRevision} className="flex min-w-0 items-baseline gap-2 py-2 text-[13px]">
                  <span className={`min-w-0 flex-1 truncate ${item.entry === null ? 'text-ink-faint' : 'text-ink'}`}>
                    {item.entry?.title ?? t('memory.forget.deletedTarget')}
                  </span>
                  {item.id === entry.id ? null : <span className="shrink-0 font-mono text-[11px] text-ink-faint">{item.id}</span>}
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint" title={item.expectedRevision}>{shortRevision(item.expectedRevision)}</span>
                </li>
              ))}
            </ul>
            {stale ? (
              <p role="alert" data-memory-forget-stale className="mt-3 text-[12px] leading-relaxed text-amber-ink">{t('memory.forget.changed')}</p>
            ) : (
              <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-ink">
                <input type="checkbox" data-memory-forget-ack checked={ack} disabled={busy} onChange={(event) => { setAck(event.target.checked); }} className="mt-0.5 h-4 w-4 shrink-0 accent-danger pointer-coarse:h-5 pointer-coarse:w-5" />
                <span>{t('memory.forget.ack')}</span>
              </label>
            )}
            {failed !== undefined ? <p role="alert" data-memory-forget-failed className="mt-3 text-[12px] text-danger">{t('memory.forget.failed', { detail: errorText(locale, failed) })}</p> : null}
            {!writable && !busy ? (
              <p role="status" data-memory-forget-held={kind} className="mt-3 text-[12px] leading-relaxed text-amber-ink">
                {t(kind === 'migrating' ? 'memory.store.migratingBanner' : 'memory.store.readonlyBanner')}
              </p>
            ) : null}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
