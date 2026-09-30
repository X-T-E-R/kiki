/**
 * CCv3 card import, two steps: pick a file → read the full preview → import.
 *
 * The preview never folds the description (design §10): a card's text becomes
 * system prompt, and the only defense against a poisoned card is a person
 * reading it. Everything the import will create is listed — identity, face,
 * greeting, example dialogue, how many persona memories the lorebook becomes —
 * and anything the card carries that Kiki drops is named, not hidden.
 */

import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { PersonaImportPreview } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { ApiError, PERSONA_ALREADY_EXISTS } from '../../lib/client';
import { pushToast } from '../../lib/toasts';
import { useConnection } from '../../state/connection';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { Icon } from '../icons';
import { FieldIssue, FORM_LABEL } from '../settings/SettingsPrimitives';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { PersonaAvatar } from './PersonaAvatar';
import { PERSONA_ID_PATTERN } from './personaDraft';
import { invalidatePersonas } from './usePersonas';

const CARD_ACCEPT = '.png,.json,.charx,image/png,application/json';

export function PersonaImportDialog({ takenIds, onClose, onImported }: {
  readonly takenIds: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onImported: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PersonaImportPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [id, setId] = useState('');

  const read = useMutation({
    mutationFn: (picked: File) => client.previewPersonaImport(picked),
    onSuccess: (next) => {
      setPreview(next);
      setReadError(null);
      setId(uniqueId(next.definition.id, takenIds));
    },
    onError: (error: unknown) => { setPreview(null); setReadError(errorText(locale, error)); },
  });
  const commit = useMutation({
    mutationFn: () => client.importPersonaCard(file!, { id: id.trim() }),
    onSuccess: (result) => {
      void invalidatePersonas(queryClient, result.snapshot.definition.id, { avatar: true });
      pushToast({
        tone: result.memory.status === 'failed' ? 'error' : 'success',
        text: t(result.memory.status === 'committed' ? 'persona.importedToast' : 'persona.importMemoryPending', { name: result.snapshot.definition.name }),
      });
      onImported(result.snapshot.definition.id);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === PERSONA_ALREADY_EXISTS) return;
      pushToast({ tone: 'error', text: t('persona.actionFailed', { detail: errorText(locale, error) }) });
    },
  });

  const pick = (picked: File | undefined) => {
    if (picked === undefined) return;
    setFile(picked);
    setPreview(null);
    read.mutate(picked);
  };
  const idIssue = preview === null ? null
    : !PERSONA_ID_PATTERN.test(id.trim()) ? t('persona.idInvalid')
    : takenIds.has(id.trim()) || (commit.error instanceof ApiError && commit.error.code === PERSONA_ALREADY_EXISTS) ? t('persona.idTaken')
    : null;
  const definition = preview?.definition;
  const avatar = preview?.avatar === undefined || definition === undefined ? undefined
    : { id: definition.id, name: definition.name, avatarUrl: `data:${preview.avatar.mimeType};base64,${preview.avatar.data}` };

  return (
    <Dialog
      onClose={() => { if (!commit.isPending) onClose(); }}
      ariaLabel={t('persona.importPreview')}
      overlayId="persona-import"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} flex max-h-[min(88vh,860px)] flex-col !p-0`}
      overlayData={{ 'data-persona-import-dialog': preview === null ? 'pick' : 'preview' }}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3">
        <h2 className="min-w-0 flex-1 truncate font-display text-[18px] font-semibold text-ink">{t('persona.importPreview')}</h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11">
          <Icon name="close" size={14} />
        </button>
      </div>
      <input ref={inputRef} type="file" accept={CARD_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ''; }} />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {preview === null || definition === undefined ? (
          <DropZone
            busy={read.isPending}
            error={readError === null ? null : t('persona.importFailed', { detail: readError })}
            fileName={file?.name}
            onPick={() => { inputRef.current?.click(); }}
            onDrop={pick}
          />
        ) : (
          <div data-persona-import-preview className="space-y-5">
            <div className="flex min-w-0 items-start gap-4">
              <PersonaAvatar persona={avatar ?? { id: definition.id, name: definition.name }} size={56} decorative />
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-[18px] leading-7 font-semibold text-ink">{definition.name}</p>
                <p className="truncate text-[13px] text-ink-soft">{[definition.title, definition.job].filter(Boolean).join(' · ') || file?.name}</p>
                <p className="mt-1 text-[12px] text-ink-faint">
                  {preview.memoryEntries.length > 0 ? t('persona.importMemories', { count: preview.memoryEntries.length }) : t('persona.importMemoryNone')}
                </p>
              </div>
            </div>

            <p role="note" data-persona-import-warning className="flex items-start gap-2 rounded-lg border border-amber-rule/60 bg-amber-card px-3 py-2 text-[12.5px] leading-relaxed text-amber-ink">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              {t('persona.importWarning')}
            </p>

            <PreviewBlock label={t('persona.importBody')} text={definition.description} dataAttr="description" />
            {definition.greeting !== undefined && definition.greeting.trim() !== '' ? (
              <PreviewBlock label={t('persona.importGreeting')} text={definition.greeting} dataAttr="greeting" />
            ) : null}
            {preview.examples !== undefined && preview.examples.trim() !== '' ? (
              <PreviewBlock label={t('persona.importExamples')} text={preview.examples} dataAttr="examples" />
            ) : null}
            {preview.ignoredFields.length > 0 ? (
              <p data-persona-import-dropped className="text-[12px] leading-relaxed text-ink-faint">
                {t('persona.importDropped', { fields: preview.ignoredFields.join('、') })}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor={`${formId}-id`} className={FORM_LABEL}>{t('persona.importIdLabel')}</label>
              <input id={`${formId}-id`} data-persona-import-id value={id} onChange={(event) => { commit.reset(); setId(event.target.value.toLowerCase()); }} aria-invalid={idIssue !== null} aria-describedby={idIssue !== null ? `${formId}-id-issue` : undefined} className={`${INPUT} max-w-xs font-mono`} spellCheck={false} autoComplete="off" />
              <FieldIssue id={`${formId}-id-issue`} text={idIssue} />
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline px-5 py-3">
        {preview !== null ? (
          <>
            <button type="button" data-persona-import-confirm disabled={commit.isPending || idIssue !== null} onClick={() => { commit.mutate(); }} className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}>
              {commit.isPending ? t('common.saving') : t('persona.importConfirm')}
            </button>
            <button type="button" disabled={commit.isPending} onClick={() => { inputRef.current?.click(); }} className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}>
              {t('persona.importChooseOther')}
            </button>
          </>
        ) : null}
        <button type="button" onClick={onClose} disabled={commit.isPending} className={`${SECONDARY_BUTTON} ml-auto pointer-coarse:min-h-11`}>{t('common.cancel')}</button>
      </div>
    </Dialog>
  );
}

/** Full text, never clamped: the preview's whole point is being read. */
function PreviewBlock({ label, text, dataAttr }: { readonly label: string; readonly text: string; readonly dataAttr: string }) {
  return (
    <section className="space-y-1.5">
      <h3 className={FORM_LABEL}>{label}</h3>
      <pre data-persona-import-block={dataAttr} className="max-w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-ink">
        {text}
      </pre>
    </section>
  );
}

function DropZone({ busy, error, fileName, onPick, onDrop }: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly fileName?: string;
  readonly onPick: () => void;
  readonly onDrop: (file: File | undefined) => void;
}) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  return (
    <div className="space-y-3">
      <button
        type="button"
        data-persona-import-pick
        onClick={onPick}
        disabled={busy}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => { setOver(false); }}
        onDrop={(event) => { event.preventDefault(); setOver(false); onDrop(event.dataTransfer.files[0]); }}
        className={`flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink ${
          over ? 'border-selected-ink bg-selected/40' : 'border-hairline-strong bg-paper hover:border-ink-faint'
        }`}
      >
        <span className="text-[14px] font-medium text-ink">{busy ? t('persona.importReading') : t('persona.importPick')}</span>
        <span className="text-[12px] text-ink-faint">{busy && fileName !== undefined ? fileName : t('persona.importFormats')}</span>
      </button>
      {error !== null ? <p role="alert" className="text-[12.5px] leading-relaxed text-danger">{error}</p> : null}
    </div>
  );
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
