/**
 * RowActions — hover-revealed per-message operations (liveagent's
 * RowActions.tsx pattern): copy on every message row, edit-resend on settled
 * user messages, regenerate on the latest completed turn's final assistant
 * reply, fork on either anchor. Buttons hide until the row is hovered or
 * focused-within; touch layouts (`hover: none`) always show them.
 *
 * The inline user-message editor also lives here: it replaces the bubble in
 * place (anything-llm's EditMessageForm shape), prefills the original text,
 * and warns that attachments are not carried over by a full-replacement edit.
 */

import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n';

export interface MessageRowActionsProps {
  /** Copy target; the copy button renders only when this is a non-empty string. */
  copyText?: string;
  canEdit?: boolean;
  canRegenerate?: boolean;
  canFork?: boolean;
  /** Turn running / resync in flight — mutating actions disable with a hint. */
  disabled?: boolean;
  /** Bordered floating chip (assistant rows, absolute top-right). */
  framed?: boolean;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onFork?: () => void;
}

function ActionButton({
  label,
  title,
  action,
  disabled,
  disabledTitle,
  onClick,
}: {
  label: string;
  title: string;
  action: string;
  disabled?: boolean;
  disabledTitle?: string;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const gated = disabled === true;
  return (
    <button
      type="button"
      data-row-action={action}
      title={gated ? (disabledTitle ?? t('transcript.actionsBusyTitle')) : title}
      aria-label={title}
      disabled={gated}
      onClick={onClick}
      className="rounded px-1 py-px text-[10.5px] font-medium text-ink-faint transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

export function MessageRowActions({
  copyText,
  canEdit = false,
  canRegenerate = false,
  canFork = false,
  disabled = false,
  framed = false,
  onEdit,
  onRegenerate,
  onFork,
}: MessageRowActionsProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const showCopy = copyText !== undefined && copyText !== '';
  if (!showCopy && !canEdit && !canRegenerate && !canFork) return null;
  const visibility =
    'opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100';
  return (
    <span
      data-row-actions
      className={
        framed
          ? `${visibility} absolute -top-1 right-0 inline-flex items-center gap-0.5 rounded-md border border-hairline bg-panel px-1.5 py-0.5`
          : `${visibility} inline-flex items-center gap-0.5`
      }
    >
      {showCopy ? (
        <button
          type="button"
          data-row-action="copy"
          title={t('transcript.copyTitle')}
          aria-label={t('transcript.copyTitle')}
          onClick={() => {
            void navigator.clipboard
              .writeText(copyText)
              .then(() => {
                setCopied(true);
                setTimeout(() => { setCopied(false); }, 1400);
              })
              .catch(() => undefined);
          }}
          className={`rounded px-1 py-px font-mono text-[10px] transition-colors ${
            copied ? 'text-success' : 'text-ink-faint hover:text-accent'
          }`}
        >
          {copied ? '✓' : t('transcript.copy')}
        </button>
      ) : null}
      {canEdit && onEdit !== undefined ? (
        <ActionButton
          label={t('transcript.edit')}
          title={t('transcript.editTitle')}
          action="edit"
          disabled={disabled}
          onClick={onEdit}
        />
      ) : null}
      {canRegenerate && onRegenerate !== undefined ? (
        <ActionButton
          label={t('transcript.regenerate')}
          title={t('transcript.regenerateTitle')}
          action="regenerate"
          disabled={disabled}
          onClick={onRegenerate}
        />
      ) : null}
      {canFork && onFork !== undefined ? (
        <ActionButton
          label={t('transcript.fork')}
          title={t('transcript.forkTitle')}
          action="fork"
          disabled={disabled}
          onClick={onFork}
        />
      ) : null}
    </span>
  );
}

/**
 * Inline editor for a user bubble (edit-resend). Esc cancels; the submit
 * button is disabled for blank text. The parent owns submission — the editor
 * closes itself on submit, and failures surface as toasts upstream.
 */
export function UserMessageEditor({
  initialText,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(initialText);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    area.focus();
    // Cursor to the end, like liveagent's EditableUserMessageBubble.
    area.selectionStart = area.selectionEnd = area.value.length;
  }, []);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    onSubmit(text);
  };

  return (
    <div
      data-edit-editor
      className="w-full max-w-[85%] rounded-2xl rounded-br-md border border-accent/40 bg-panel px-3.5 py-2"
    >
      <textarea
        ref={areaRef}
        value={text}
        rows={Math.min(12, Math.max(2, text.split('\n').length))}
        onChange={(event) => { setText(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        className="w-full resize-y bg-transparent text-[13.5px] leading-relaxed text-ink outline-none"
      />
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[10.5px] text-ink-faint/80">
          {t('transcript.editAttachmentsNote')}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            data-edit-cancel
            onClick={onCancel}
            className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-hairline-strong"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-edit-submit
            disabled={text.trim() === ''}
            onClick={submit}
            title={t('transcript.editSubmitTitle')}
            className="rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('transcript.editSubmit')}
          </button>
        </span>
      </div>
    </div>
  );
}
