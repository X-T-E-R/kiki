/**
 * Markdown round trip for one governed entry: export the current revision as a
 * file, edit it anywhere, then import it back through a preview.
 *
 * The preview is the decision. It shows the stored entry next to what the file
 * would make of it, and only a preview the store marked appliable gets a
 * confirm button. Confirming sends that preview's token and one operation id,
 * never the inputs again, so what is written is exactly what was reviewed. A
 * token is dropped as soon as anything it was issued for moves: the file, the
 * source or reason, the connection, the store's epoch, or its ten-minute
 * expiry. The dialog lives inside one scope's view, so a scope switch unmounts
 * it with its token.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import {
  ApiError,
  MEMORY_REVISION_CONFLICT,
  type MemoryEntry,
  type MemoryImportPreview,
  type MemoryMarkdownDocument,
  type MemoryTarget,
} from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { SidePanel } from '../SidePanel';
import { VersionBlock } from '../MemoryHistory';
import { downloadBlob } from '../persona/usePersonas';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { memoryOperationId, shortRevision } from './MemoryGovernance';
import { useMemoryAuthority } from './memoryAuthority';
import { parseMemoryEntry, type MemoryEntryView } from './memoryReceipt';

const LABEL = 'text-[12px] font-medium text-ink-soft';
const QUIET = 'rounded-sm text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:opacity-60';
const MARKDOWN_LIMIT = 65_536;
const LOCATOR_LIMIT = 2_000;
const REASON_LIMIT = 500;

/** Server issue and error codes this dialog explains in the reader's language. */
const ISSUE_TEXT = {
  revision_conflict: 'memory.markdown.issue.revisionConflict',
  inactive_target: 'memory.markdown.issue.inactiveTarget',
  duplicate_title: 'memory.markdown.issue.duplicateTitle',
  invalid_input: 'memory.markdown.issue.scopeFull',
} as const;
const REFUSAL_TEXT = {
  scope_mismatch: 'memory.markdown.refused.scopeMismatch',
  invalid_input: 'memory.markdown.refused.invalidFile',
  inactive_target: 'memory.markdown.refused.forgotten',
} as const;

function detailCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = error.details as { code?: unknown } | undefined;
  return typeof details?.code === 'string' ? details.code : undefined;
}

/** A safe file name for one entry's export. */
export function memoryMarkdownFileName(entry: Pick<MemoryEntry, 'id' | 'title'>): string {
  const slug = entry.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48);
  return `${slug === '' ? 'memory' : slug}-${entry.id}.md`;
}

/** Saves an export through the host's save dialog when it has one. */
export function useMemoryMarkdownExport(target: MemoryTarget) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const host = useHost();
  return useMutation({
    mutationFn: async (id: string) => {
      const exported = await client.exportMemoryMarkdown(target, id);
      const filename = memoryMarkdownFileName(exported.entry);
      const blob = new Blob([exported.markdown], { type: 'text/markdown;charset=utf-8' });
      const saved = await host.saveBlob?.(blob, filename);
      if (host.saveBlob === undefined) downloadBlob(blob, filename);
      return saved === false ? null : filename;
    },
    onSuccess: (filename) => {
      if (filename !== null) pushToast({ tone: 'success', text: t('memory.markdown.exported', { file: filename }) });
    },
    onError: (error: unknown) => {
      pushToast({ tone: 'error', text: t('memory.markdown.exportFailed', { detail: errorText(locale, error) }) });
    },
  });
}

export function MemoryExportButton({ target, entry }: { readonly target: MemoryTarget; readonly entry: MemoryEntry }) {
  const { t } = useI18n();
  const exporter = useMemoryMarkdownExport(target);
  return (
    <button type="button" data-memory-export disabled={exporter.isPending} onClick={() => { exporter.mutate(entry.id); }} className={QUIET}>
      {t('memory.markdown.export')}
    </button>
  );
}
/** The file's fields in the shape the version view reads. */
function documentView(doc: MemoryMarkdownDocument, reason: string): MemoryEntryView | undefined {
  return parseMemoryEntry({ ...doc, created: '', updated: '', reason, revision: doc.revision ?? 'new', validity: doc.validity ?? undefined });
}

interface PickedFile { readonly name: string; readonly text: string }

function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsText yields a string; anything else is a failed read, not text.
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('read failed'));
    };
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')); };
    reader.readAsText(file);
  });
}

/**
 * What one preview request was sent for, frozen when it was sent. Its answer
 * is kept only while this is still the latest request, and its token stays
 * usable only while every field still matches the dialog.
 */
interface PreviewRequest {
  readonly generation: number;
  readonly inputs: string;
  readonly client: unknown;
  readonly epoch: number | undefined;
  readonly markdown: string;
  readonly sourceLocator: string;
  readonly reason: string;
}

interface IssuedPreview extends Omit<PreviewRequest, 'markdown' | 'sourceLocator' | 'reason'> {
  readonly preview: MemoryImportPreview;
}

/** A confirmed write: the receipt is kept apart from the read that checks it. */
interface ImportReceipt {
  readonly entry: MemoryEntry;
  readonly operationId: string;
}

/**
 * `stale`: preview again with the same file. `closed`: the source was forgotten,
 * so no preview of this file can be confirmed. `failed`: anything else.
 */
type ApplyFailure = { readonly kind: 'stale'; readonly text: string } | { readonly kind: 'closed' } | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Import one edited file into this scope: pick it, say where it came from and
 * why, preview, then confirm what the preview showed. `onOpenEntry` is the way
 * back to an existing entry when the preview says to use it instead.
 */
export function MemoryImportDialog({ target, onClose, onOpenEntry }: {
  readonly target: MemoryTarget;
  readonly onClose: () => void;
  readonly onOpenEntry: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const authority = useMemoryAuthority();
  const { writable, kind } = authority;
  const epoch = authority.state?.epoch;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [locator, setLocator] = useState('');
  const [reason, setReason] = useState('');
  const [issued, setIssued] = useState<IssuedPreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [failure, setFailure] = useState<ApplyFailure | null>(null);
  const [expired, setExpired] = useState(false);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [reading, setReading] = useState(false);
  const targetKey = JSON.stringify([target.scope, target.workspaceId ?? null, target.personaId ?? null]);
  const inputs = JSON.stringify([targetKey, file?.text ?? null, locator.trim(), reason.trim()]);

  // Only the latest preview request may answer; an older one that lands late
  // (after an edit, a reconnect or an epoch change) is dropped, success or not.
  const generation = useRef(0);
  const dropPreview = () => { generation.current += 1; setIssued(null); setPreviewError(null); setFailure(null); setExpired(false); };
  useEffect(() => { generation.current += 1; }, [client, epoch]);

  // Likewise only the latest file pick may fill the form.
  const pickGeneration = useRef(0);
  const pick = async (picked: File | undefined) => {
    if (picked === undefined) return;
    const mine = ++pickGeneration.current;
    dropPreview();
    setReading(true);
    let text: string;
    try {
      text = await readText(picked);
    } catch {
      if (mine !== pickGeneration.current) return;
      setReading(false);
      setFile(null);
      setFileError(t('memory.markdown.fileUnreadable', { file: picked.name }));
      return;
    }
    if (mine !== pickGeneration.current) return;
    setReading(false);
    if (text.length > MARKDOWN_LIMIT) { setFile(null); setFileError(t('memory.markdown.fileTooLarge')); return; }
    setFileError(null);
    setFile({ name: picked.name, text });
    setLocator((value) => value.trim() === '' ? picked.name : value);
  };

  const preview = useMutation({
    mutationFn: (request: PreviewRequest) => client.previewMemoryImport(target, { markdown: request.markdown, sourceLocator: request.sourceLocator, reason: request.reason }),
    onSuccess: (result, request) => {
      if (request.generation !== generation.current) return;
      setFailure(null); setExpired(false); setPreviewError(null);
      setIssued({ preview: result, generation: request.generation, inputs: request.inputs, client: request.client, epoch: request.epoch });
    },
    onError: (error: unknown, request) => {
      if (request.generation !== generation.current) return;
      setIssued(null);
      setPreviewError(error);
    },
  });
  const sendPreview = () => {
    if (file === null) return;
    generation.current += 1;
    setPreviewError(null);
    preview.mutate({ generation: generation.current, inputs, client, epoch, markdown: file.text, sourceLocator: locator.trim(), reason: reason.trim() });
  };
  const current = issued !== null && issued.inputs === inputs && issued.client === client && issued.epoch === epoch ? issued.preview : undefined;
  const moved = issued !== null && current === undefined && (issued.client !== client || issued.epoch !== epoch);
  // One operation per preview: a retried click after a lost answer is the same import.
  const operationId = useMemo(() => memoryOperationId(), [current]);
  useEffect(() => {
    if (current?.expiresAt === undefined) return undefined;
    const left = Date.parse(current.expiresAt) - Date.now();
    if (left <= 0) { setExpired(true); return undefined; }
    const timer = setTimeout(() => { setExpired(true); }, left);
    return () => { clearTimeout(timer); };
  }, [current]);

  // A second click lands before `isPending` renders; one confirmation sends once.
  const applying = useRef(false);
  const apply = useMutation({
    mutationFn: () => client.applyMemoryImport(target, current!.previewToken!, operationId),
    onSuccess: (result) => {
      setReceipt({ entry: result.entry, operationId: result.operationId ?? operationId });
      pushToast({ tone: 'success', text: t('memory.markdown.imported', { title: result.entry.title }) });
      for (const key of ['memory', 'memory-journal', 'memory-related', 'memory-inbox', 'memory-provenance', 'memory-detail']) void queryClient.invalidateQueries({ queryKey: [key] });
    },
    onSettled: () => { applying.current = false; },
    onError: (error: unknown) => {
      const code = detailCode(error);
      if (error instanceof ApiError && error.code === MEMORY_REVISION_CONFLICT) setFailure({ kind: 'stale', text: t('memory.markdown.stale.changed') });
      else if (code === 'invalid_input') setFailure({ kind: 'stale', text: t('memory.markdown.stale.expired') });
      else if (code === 'inactive_target') setFailure({ kind: 'closed' });
      else setFailure({ kind: 'failed', error });
    },
  });

  // The write is settled by its receipt; this read only checks what is stored
  // now. Retrying it never sends the import again.
  const readback = useQuery({
    queryKey: ['memory-import-readback', targetKey, receipt?.entry.id, receipt?.operationId],
    queryFn: () => client.getMemory(target, receipt!.entry.id),
    enabled: receipt !== null,
    retry: false, gcTime: 0, staleTime: Infinity,
  });

  const refusal = previewError === null ? null : (REFUSAL_TEXT[detailCode(previewError) as keyof typeof REFUSAL_TEXT] ?? null);
  // A request sent for an earlier epoch, connection or input no longer holds the dialog.
  const previewing = preview.isPending && preview.variables?.inputs === inputs && preview.variables.client === client && preview.variables.epoch === epoch;
  const busy = previewing || apply.isPending || reading;
  const ready = file !== null && locator.trim() !== '' && reason.trim() !== '';
  const appliable = current?.canApply === true && current.previewToken !== undefined && !expired && (failure === null || failure.kind === 'failed');
  const needsRepreview = moved || expired || failure?.kind === 'stale';

  return (
    <SidePanel onClose={() => { if (!busy) onClose(); }} dismissible={!busy && file === null} title={t('memory.markdown.importTitle')} overlayId="memory-import"
      width="lg"
      stepKey={receipt !== null ? 'applied' : current === undefined ? 'form' : 'preview'}
      footer={<>
        {receipt !== null ? (
          <>
            <button type="button" data-memory-import-close onClick={onClose} className={SECONDARY_BUTTON}>{t('common.close')}</button>
            <button type="button" data-memory-import-open={receipt.entry.id} onClick={() => { onClose(); onOpenEntry(receipt.entry.id); }} className={PRIMARY_BUTTON}>{t('memory.markdown.openEntry')}</button>
          </>
        ) : (
          <>
            <button type="button" data-memory-import-cancel disabled={busy} onClick={onClose} className={SECONDARY_BUTTON}>{t('common.cancel')}</button>
            {failure?.kind === 'closed' ? null : current === undefined || needsRepreview ? (
              <button type="button" data-memory-import-preview disabled={!ready || busy || !writable} onClick={() => { if (writable) { apply.reset(); sendPreview(); } }} className={needsRepreview ? SECONDARY_BUTTON : PRIMARY_BUTTON}>
                {t(needsRepreview ? 'memory.markdown.repreview' : previewing ? 'memory.markdown.previewing' : 'memory.markdown.preview')}
              </button>
            ) : appliable ? (
              <button type="button" data-memory-import-confirm={current.action} disabled={busy || !writable} onClick={() => { if (!writable || applying.current) return; applying.current = true; apply.mutate(); }} className={PRIMARY_BUTTON}>
                {t(current.action === 'create' ? 'memory.markdown.confirmCreate' : 'memory.markdown.confirmUpdate')}
              </button>
            ) : null}
          </>
        )}
      </>}>
      <div data-memory-import={receipt === null ? (current?.action ?? 'form') : 'applied'} className="space-y-5">
        {receipt !== null ? (
          <div data-memory-import-applied={receipt.entry.id} data-memory-import-operation={receipt.operationId} className="space-y-3">
            {readback.data !== undefined ? (
              <>
                <p role="status" data-memory-import-readback={readback.data.revision} className="text-[13px] text-ink-soft">{t('memory.markdown.appliedLead')}</p>
                <VersionBlock label={t('memory.markdown.current')} entry={parseMemoryEntry(readback.data)} raw={undefined} revision={readback.data.revision} />
                <EntryMeta scope={target} id={readback.data.id} revision={readback.data.revision} pinned={readback.data.pinned} />
              </>
            ) : readback.isError ? (
              <div role="alert" data-memory-import-readback-failed className="space-y-2">
                <p className="text-[13px] text-ink">{t('memory.markdown.savedUnread', { revision: shortRevision(receipt.entry.revision) })}</p>
                <p className="text-[12px] text-danger">{t('memory.markdown.readbackFailed', { detail: errorText(locale, readback.error) })}</p>
                <button type="button" data-memory-import-reread disabled={readback.isFetching} onClick={() => { void readback.refetch(); }} className={`${SECONDARY_BUTTON} pointer-coarse:py-3`}>
                  {t('memory.markdown.reread')}
                </button>
              </div>
            ) : (
              <p role="status" className="text-[13px] text-ink-faint">{t('memory.markdown.savedReading')}</p>
            )}
          </div>
        ) : (
          <>
            <ImportFields
              file={file} fileError={fileError} locator={locator} reason={reason} disabled={busy}
              fileInput={fileInput}
              onPick={(picked) => { void pick(picked); }}
              onLocator={(value) => { dropPreview(); setLocator(value); }}
              onReason={(value) => { dropPreview(); setReason(value); }}
            />
            {previewError !== null ? (
              <p role="alert" data-memory-import-refused={detailCode(previewError) ?? 'error'} className="text-[12px] leading-relaxed text-danger">
                {refusal === null ? t('memory.markdown.previewFailed', { detail: errorText(locale, previewError) }) : t(refusal)}
              </p>
            ) : null}
            {current !== undefined ? (
              <ImportPreview
                target={target} preview={current} reason={reason.trim()}
                onOpenEntry={(id) => { onClose(); onOpenEntry(id); }}
              />
            ) : null}
            {needsRepreview ? (
              <p role="alert" data-memory-import-stale={moved ? 'moved' : expired ? 'expired' : 'refused'} className="text-[12px] leading-relaxed text-amber-ink">
                {failure?.kind === 'stale' ? failure.text : t(moved ? 'memory.markdown.stale.moved' : 'memory.markdown.stale.expired')}
              </p>
            ) : null}
            {failure?.kind === 'closed' ? (
              <p role="alert" data-memory-import-closed className="text-[12px] leading-relaxed text-danger">{t('memory.markdown.refused.forgotten')}</p>
            ) : null}
            {failure?.kind === 'failed' ? (
              <p role="alert" data-memory-import-failed className="text-[12px] leading-relaxed text-danger">{t('memory.markdown.applyFailed', { detail: errorText(locale, failure.error) })}</p>
            ) : null}
            {!writable && !apply.isPending ? (
              <p role="status" data-memory-import-held={kind} className="text-[12px] leading-relaxed text-amber-ink">
                {t(kind === 'migrating' ? 'memory.store.migratingBanner' : 'memory.store.readonlyBanner')}
              </p>
            ) : null}
          </>
        )}
      </div>
    </SidePanel>
  );
}

function ImportFields({ file, fileError, locator, reason, disabled, fileInput, onPick, onLocator, onReason }: {
  readonly file: PickedFile | null;
  readonly fileError: string | null;
  readonly locator: string;
  readonly reason: string;
  readonly disabled: boolean;
  readonly fileInput: RefObject<HTMLInputElement | null>;
  readonly onPick: (file: File | undefined) => void;
  readonly onLocator: (value: string) => void;
  readonly onReason: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-1.5 md:col-span-2">
        <span className={LABEL}>{t('memory.markdown.file')}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <button type="button" data-memory-import-pick disabled={disabled} onClick={() => { fileInput.current?.click(); }} className={`${SECONDARY_BUTTON} pointer-coarse:py-3`}>
            {t(file === null ? 'memory.markdown.choose' : 'memory.markdown.chooseOther')}
          </button>
          <span data-memory-import-file={file?.name ?? ''} className={`min-w-0 truncate text-[13px] ${file === null ? 'text-ink-faint' : 'text-ink'}`}>
            {file?.name ?? t('memory.markdown.noFile')}
          </span>
          <input ref={fileInput} type="file" accept=".md,.markdown,text/markdown,text/plain" className="sr-only" tabIndex={-1} aria-hidden
            onChange={(event) => { onPick(event.target.files?.[0]); event.target.value = ''; }} />
        </div>
        {fileError !== null ? <p role="alert" className="text-[12px] text-danger">{fileError}</p> : null}
      </div>
      <label className="space-y-1.5">
        <span className={LABEL}>{t('memory.markdown.source')}</span>
        <input type="text" data-memory-import-locator value={locator} maxLength={LOCATOR_LIMIT} disabled={disabled}
          placeholder={t('memory.markdown.sourcePlaceholder')} onChange={(event) => { onLocator(event.target.value); }} className={INPUT} />
      </label>
      <label className="space-y-1.5">
        <span className={LABEL}>{t('memory.field.reason')}</span>
        <input type="text" data-memory-import-reason value={reason} maxLength={REASON_LIMIT} disabled={disabled}
          placeholder={t('memory.markdown.reasonPlaceholder')} onChange={(event) => { onReason(event.target.value); }} className={INPUT} />
      </label>
    </div>
  );
}
const ACTION_TEXT = {
  create: 'memory.markdown.action.create',
  update: 'memory.markdown.action.update',
  unchanged: 'memory.markdown.action.unchanged',
  retained: 'memory.markdown.action.retained',
} as const;

/**
 * What the store would do with the file, and both complete versions. A
 * preview that cannot be applied says why and offers the way forward instead
 * of a confirm button.
 */
function ImportPreview({ target, preview, reason, onOpenEntry }: {
  readonly target: MemoryTarget;
  readonly preview: MemoryImportPreview;
  readonly reason: string;
  readonly onOpenEntry: (id: string) => void;
}) {
  const { t } = useI18n();
  const exporter = useMemoryMarkdownExport(target);
  const issue = preview.issue === undefined ? undefined : ISSUE_TEXT[preview.issue.code as keyof typeof ISSUE_TEXT] ?? 'memory.markdown.issue.other';
  const currentEntry = preview.current;
  const tone = preview.canApply ? 'text-ink' : 'text-amber-ink';
  return (
    <section data-memory-import-preview-result={preview.action} data-memory-import-can-apply={preview.canApply ? 'true' : 'false'} className="space-y-4 pt-4">
      <div className="space-y-1">
        <p className={`text-[14px] font-medium ${tone}`}>{t(ACTION_TEXT[preview.action])}</p>
        {issue !== undefined ? <p data-memory-import-issue={preview.issue!.code} className="text-[12px] leading-relaxed text-amber-ink">{t(issue)}</p> : null}
        {preview.canApply && preview.expiresAt !== undefined ? (
          <p className="text-[12px] text-ink-faint">{t('memory.markdown.expires', { time: new Date(preview.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })}</p>
        ) : null}
      </div>
      {!preview.canApply && currentEntry !== null ? (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {preview.issue?.code === 'revision_conflict' ? (
            <button type="button" data-memory-import-export-current disabled={exporter.isPending} onClick={() => { exporter.mutate(currentEntry.id); }} className={`${SECONDARY_BUTTON} pointer-coarse:py-3`}>
              {t('memory.markdown.exportCurrent')}
            </button>
          ) : null}
          <button type="button" data-memory-import-open-current={currentEntry.id} onClick={() => { onOpenEntry(currentEntry.id); }} className={`${SECONDARY_BUTTON} pointer-coarse:py-3`}>
            {t('memory.markdown.openCurrent')}
          </button>
        </div>
      ) : null}
      <div className="grid gap-6 md:grid-cols-2">
        <div data-memory-import-current className="min-w-0">
          {currentEntry === null ? (
            <section className="space-y-2">
              <h4 className="text-[12px] font-medium text-ink-soft">{t('memory.markdown.current')}</h4>
              <p className="text-[13px] text-ink-faint">{t('memory.markdown.noCurrent')}</p>
            </section>
          ) : (
            <>
              <VersionBlock label={t('memory.markdown.current')} entry={parseMemoryEntry(currentEntry)} raw={undefined} revision={currentEntry.revision} />
              <EntryMeta scope={target} id={currentEntry.id} revision={currentEntry.revision} pinned={currentEntry.pinned} />
            </>
          )}
        </div>
        <div data-memory-import-incoming className="min-w-0">
          <VersionBlock label={t('memory.markdown.incoming')} entry={documentView(preview.incoming, reason)} raw={undefined} revision={preview.incoming.revision ?? 'new'} />
          <EntryMeta
            scope={preview.incoming.scope} id={preview.incoming.id} revision={preview.incoming.revision} pinned={preview.incoming.pinned}
            basedOn pinnedChanged={currentEntry !== null && currentEntry.pinned !== preview.incoming.pinned}
          />
        </div>
      </div>
    </section>
  );
}

type MetaScope = MemoryTarget | MemoryMarkdownDocument['scope'];

function scopeText(scope: MetaScope, t: ReturnType<typeof useI18n>['t']): string {
  const kind = 'kind' in scope ? scope.kind : scope.scope;
  const parts = [t(kind === 'global' ? 'memory.scope.global' : kind === 'persona' ? 'memory.scope.persona' : 'memory.scope.workspace')];
  if ('workspaceId' in scope && scope.workspaceId !== undefined) parts.push(scope.workspaceId);
  if ('personaId' in scope && scope.personaId !== undefined) parts.push(scope.personaId);
  return parts.join(' / ');
}

/**
 * Which object and revision one side of the comparison is, and whether it is
 * pinned: the parts of a file the content view does not show, so a change to
 * them is visible before it is confirmed.
 */
function EntryMeta({ scope, id, revision, pinned, basedOn = false, pinnedChanged = false }: {
  readonly scope: MetaScope;
  readonly id: string;
  readonly revision: string | null;
  readonly pinned: boolean;
  readonly basedOn?: boolean;
  readonly pinnedChanged?: boolean;
}) {
  const { t } = useI18n();
  return (
    <dl data-memory-import-meta className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 pt-2 text-[12px]">
      <dt className="text-ink-faint">{t('memory.markdown.meta.scope')}</dt>
      <dd data-memory-import-meta-scope className="min-w-0 truncate text-ink-soft">{scopeText(scope, t)}</dd>
      <dt className="text-ink-faint">{t('memory.markdown.meta.id')}</dt>
      <dd data-memory-import-meta-id={id} className="min-w-0 truncate font-mono text-[11px] text-ink-soft">{id === 'new' ? t('memory.markdown.meta.newEntry') : id}</dd>
      <dt className="text-ink-faint">{t(basedOn ? 'memory.markdown.meta.basedOn' : 'memory.markdown.meta.revision')}</dt>
      <dd data-memory-import-meta-revision={revision ?? ''} className="min-w-0 truncate font-mono text-[11px] text-ink-soft" title={revision ?? undefined}>{revision === null ? '—' : shortRevision(revision)}</dd>
      <dt className="text-ink-faint">{t('memory.markdown.meta.pinned')}</dt>
      <dd data-memory-import-meta-pinned={pinned ? 'true' : 'false'} data-memory-import-meta-changed={pinnedChanged ? 'pinned' : undefined}
        className={pinnedChanged ? 'font-medium text-accent-ink' : 'text-ink-soft'}>
        {t(pinned ? 'memory.markdown.meta.pinnedYes' : 'memory.markdown.meta.pinnedNo')}{pinnedChanged ? ` · ${t('memory.markdown.meta.changed')}` : ''}
      </dd>
    </dl>
  );
}

/** Opens the import dialog from the list header; governed stores only. */
export function MemoryImportButton({ target, onOpenEntry }: { readonly target: MemoryTarget; readonly onOpenEntry: (id: string) => void }) {
  const { t } = useI18n();
  const { writable, governed } = useMemoryAuthority();
  const [open, setOpen] = useState(false);
  if (!governed) return null;
  return (
    <>
      <button type="button" data-memory-import-open disabled={!writable} onClick={() => { setOpen(true); }} className={SECONDARY_BUTTON}>
        {t('memory.markdown.import')}
      </button>
      {open ? <MemoryImportDialog target={target} onClose={() => { setOpen(false); }} onOpenEntry={onOpenEntry} /> : null}
    </>
  );
}

