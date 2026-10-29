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
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { VersionBlock } from '../MemoryHistory';
import { downloadBlob } from '../persona/usePersonas';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { memoryOperationId } from './MemoryGovernance';
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
    reader.onload = () => { resolve(String(reader.result ?? '')); };
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')); };
    reader.readAsText(file);
  });
}

interface IssuedPreview {
  readonly preview: MemoryImportPreview;
  /** What the token was issued for; any difference drops it. */
  readonly inputs: string;
  readonly client: unknown;
  readonly epoch: number | undefined;
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
  const [failure, setFailure] = useState<ApplyFailure | null>(null);
  const [expired, setExpired] = useState(false);
  const [applied, setApplied] = useState<MemoryEntry | null>(null);
  const targetKey = JSON.stringify([target.scope, target.workspaceId ?? null, target.personaId ?? null]);
  const inputs = JSON.stringify([targetKey, file?.text ?? null, locator.trim(), reason.trim()]);

  /** Any edit to what a preview was issued for makes it history. */
  const dropPreview = () => { setIssued(null); setFailure(null); setExpired(false); };

  const pick = async (picked: File | undefined) => {
    if (picked === undefined) return;
    dropPreview();
    const text = await readText(picked);
    if (text.length > MARKDOWN_LIMIT) { setFile(null); setFileError(t('memory.markdown.fileTooLarge')); return; }
    setFileError(null);
    setFile({ name: picked.name, text });
    setLocator((value) => value.trim() === '' ? picked.name : value);
  };

  const preview = useMutation({
    mutationFn: () => client.previewMemoryImport(target, { markdown: file!.text, sourceLocator: locator.trim(), reason: reason.trim() }),
    onSuccess: (result) => { setFailure(null); setExpired(false); setIssued({ preview: result, inputs, client, epoch }); },
    onError: () => { setIssued(null); },
  });
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
    mutationFn: async () => {
      const result = await client.applyMemoryImport(target, current!.previewToken!, operationId);
      // Read back what the store now holds rather than trusting the preview.
      return client.getMemory(target, result.entry.id).catch(() => result.entry);
    },
    onSuccess: (entry) => {
      setApplied(entry);
      pushToast({ tone: 'success', text: t('memory.markdown.imported', { title: entry.title }) });
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

  const refusal = preview.isError ? (REFUSAL_TEXT[detailCode(preview.error) as keyof typeof REFUSAL_TEXT] ?? null) : null;
  const busy = preview.isPending || apply.isPending;
  const ready = file !== null && locator.trim() !== '' && reason.trim() !== '';
  const appliable = current?.canApply === true && current.previewToken !== undefined && !expired && (failure === null || failure.kind === 'failed');
  const needsRepreview = moved || expired || failure?.kind === 'stale';

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} dismissible={!busy && file === null} ariaLabel={t('memory.markdown.importTitle')} overlayId="memory-import"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.lg} flex max-h-[88dvh] flex-col max-md:max-w-none`}>
      <div data-memory-import={applied === null ? (current?.action ?? 'form') : 'applied'} className="min-h-0 flex-1 space-y-5 overflow-y-auto">
        <h3 className="font-display text-[18px] font-semibold text-ink">{t('memory.markdown.importTitle')}</h3>
        {applied !== null ? (
          <div data-memory-import-applied={applied.id} className="space-y-3">
            <p role="status" className="text-[13px] text-ink-soft">{t('memory.markdown.appliedLead')}</p>
            <VersionBlock label={t('memory.markdown.current')} entry={parseMemoryEntry(applied)} raw={undefined} revision={applied.revision} />
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
            {preview.isError ? (
              <p role="alert" data-memory-import-refused={detailCode(preview.error) ?? 'error'} className="text-[12px] leading-relaxed text-danger">
                {refusal === null ? t('memory.markdown.previewFailed', { detail: errorText(locale, preview.error) }) : t(refusal)}
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
      <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-2">
        {applied !== null ? (
          <>
            <button type="button" data-memory-import-close onClick={onClose} className={`${SECONDARY_BUTTON} pointer-coarse:py-3`}>{t('common.close')}</button>
            <button type="button" data-memory-import-open={applied.id} onClick={() => { onClose(); onOpenEntry(applied.id); }} className={`${PRIMARY_BUTTON} pointer-coarse:py-3`}>{t('memory.markdown.openEntry')}</button>
          </>
        ) : (
          <>
            <button type="button" data-memory-import-cancel disabled={busy} onClick={onClose} className={`${SECONDARY_BUTTON} pointer-coarse:py-3`}>{t('common.cancel')}</button>
            {failure?.kind === 'closed' ? null : current === undefined || needsRepreview ? (
              <button type="button" data-memory-import-preview disabled={!ready || busy || !writable} onClick={() => { if (writable) { apply.reset(); preview.mutate(); } }} className={`${needsRepreview ? SECONDARY_BUTTON : PRIMARY_BUTTON} pointer-coarse:py-3`}>
                {t(needsRepreview ? 'memory.markdown.repreview' : preview.isPending ? 'memory.markdown.previewing' : 'memory.markdown.preview')}
              </button>
            ) : appliable ? (
              <button type="button" data-memory-import-confirm={current.action} disabled={busy || !writable} onClick={() => { if (!writable || applying.current) return; applying.current = true; apply.mutate(); }} className={`${PRIMARY_BUTTON} pointer-coarse:py-3`}>
                {t(current.action === 'create' ? 'memory.markdown.confirmCreate' : 'memory.markdown.confirmUpdate')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
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
    <section data-memory-import-preview-result={preview.action} data-memory-import-can-apply={preview.canApply ? 'true' : 'false'} className="space-y-4 border-t border-hairline pt-4">
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
          ) : <VersionBlock label={t('memory.markdown.current')} entry={parseMemoryEntry(currentEntry)} raw={undefined} revision={currentEntry.revision} />}
        </div>
        <div data-memory-import-incoming className="min-w-0">
          <VersionBlock label={t('memory.markdown.incoming')} entry={documentView(preview.incoming, reason)} raw={undefined} revision={preview.incoming.revision ?? 'new'} />
        </div>
      </div>
    </section>
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

