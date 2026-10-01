/**
 * RowActions — hover-revealed per-message operations (liveagent's
 * RowActions.tsx pattern): copy and copy-link on every message row, edit-resend on settled
 * user messages, regenerate on the latest completed turn's final assistant
 * reply, fork on either anchor. Buttons hide until the row is hovered or
 * focused-within; touch layouts (`hover: none`) always show them.
 *
 * The inline user-message editor also lives here: it replaces the bubble in
 * place (anything-llm's EditMessageForm shape), prefills the original text,
 * and warns that attachments are not carried over by a full-replacement edit.
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { registerOverlay } from '../lib/uiBusy';
import { Icon } from './icons';

/**
 * The in-app deep link to a message row, in the `?block=` shape SessionView's
 * locator reads. Provided by the Transcript that owns the rows (it knows the
 * session and agent); absent, rows offer no link.
 */
export const MessageLinkContext = createContext<((blockId: string) => string) | undefined>(undefined);

export function useMessageLink(): ((blockId: string) => string) | undefined {
  return useContext(MessageLinkContext);
}

/** `/s/{id}?block=…`, or the agent tab's route for a child timeline. */
export function messageLinkHref(sessionId: string, agentId: string, blockId: string): string {
  const base = agentId === 'main'
    ? `/s/${sessionId}`
    : `/s/${sessionId}/agent/${encodeURIComponent(agentId)}`;
  return `${base}?${new URLSearchParams({ block: blockId }).toString()}`;
}

export interface MessageRowActionsProps {
  /** Copy target; the copy button renders only when this is a non-empty string. */
  copyText?: string;
  /** In-app link to this message (`/s/{id}?block={blockId}`); renders "link" when set. */
  linkHref?: string;
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
      className="rounded px-1 py-px text-[10.5px] font-medium text-ink-faint transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

export function MessageRowActions({
  copyText,
  linkHref,
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
  const [copied, setCopied] = useState<'text' | 'link' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const menuContainerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const showCopy = copyText !== undefined && copyText !== '';
  const showLink = linkHref !== undefined && linkHref !== '';
  if (!showCopy && !showLink && !canEdit && !canRegenerate && !canFork) return null;

  const copy = (what: 'text' | 'link', text: string) => {
    void copyTextToClipboard(text)
      .then(() => {
        setCopied(what);
        setTimeout(() => { setCopied(null); }, 1400);
      })
      .catch(() => undefined);
  };

  const toggleMenu = () => {
    if (!menuOpen) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect !== undefined) {
        // Dropdown menu height is ~160px. If space below is constrained and space above is larger, flip upward.
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        setOpenUp(spaceBelow < 180 && spaceAbove > spaceBelow);
      }
      setMenuOpen(true);
    } else {
      setMenuOpen(false);
    }
  };

  useEffect(() => {
    if (!framed || !menuOpen) return;
    const unregister = registerOverlay('row-actions-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenuOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
        if (buttons.length === 0) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown'
          ? (index + 1) % buttons.length
          : (index - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        !menuContainerRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onScrollOrResize = () => {
      setMenuOpen(false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [framed, menuOpen]);

  const visibility =
    'opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100';

  if (framed) {
    return (
      <span
        ref={menuContainerRef}
        data-row-actions
        className={`${visibility} absolute top-0 right-0 z-20 inline-flex flex-col items-end`}
      >
        <button
          ref={triggerRef}
          type="button"
          data-row-more
          aria-label={t('transcript.moreActions')}
          title={t('transcript.moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={toggleMenu}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-hairline bg-panel text-ink-faint shadow-xs transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          <Icon name="more" size={14} />
        </button>

        <div
          ref={menuRef}
          role="menu"
          aria-label={t('transcript.moreActions')}
          className={`${
            menuOpen ? 'flex anim-enter' : 'hidden'
          } absolute right-0 ${
            openUp ? 'bottom-full mb-1' : 'top-full mt-1'
          } min-w-[124px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]`}
        >
          {showCopy ? (
            <button
              type="button"
              role="menuitem"
              data-row-action="copy"
              title={t('transcript.copyTitle')}
              aria-label={t('transcript.copyTitle')}
              onClick={() => {
                copy('text', copyText);
                setMenuOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span>{t('transcript.copy')}</span>
              {copied === 'text' ? <Icon name="check" size={12} className="text-success" /> : null}
            </button>
          ) : null}
          {showLink ? (
            <button
              type="button"
              role="menuitem"
              data-row-action="link"
              title={t('transcript.copyLinkTitle')}
              aria-label={t('transcript.copyLinkTitle')}
              onClick={() => {
                copy('link', linkHref);
                setMenuOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span>{t('transcript.copyLink')}</span>
              {copied === 'link' ? <Icon name="check" size={12} className="text-success" /> : null}
            </button>
          ) : null}
          {canEdit && onEdit !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-row-action="edit"
              title={disabled ? t('transcript.actionsBusyTitle') : t('transcript.editTitle')}
              aria-label={t('transcript.editTitle')}
              disabled={disabled}
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
              className="w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('transcript.edit')}
            </button>
          ) : null}
          {canRegenerate && onRegenerate !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-row-action="regenerate"
              title={disabled ? t('transcript.actionsBusyTitle') : t('transcript.regenerateTitle')}
              aria-label={t('transcript.regenerateTitle')}
              disabled={disabled}
              onClick={() => {
                setMenuOpen(false);
                onRegenerate();
              }}
              className="w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('transcript.regenerate')}
            </button>
          ) : null}
          {canFork && onFork !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-row-action="fork"
              title={disabled ? t('transcript.actionsBusyTitle') : t('transcript.forkTitle')}
              aria-label={t('transcript.forkTitle')}
              disabled={disabled}
              onClick={() => {
                setMenuOpen(false);
                onFork();
              }}
              className="w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('transcript.fork')}
            </button>
          ) : null}
        </div>
      </span>
    );
  }

  const copyClass = (what: 'text' | 'link') =>
    `rounded px-1 py-px font-mono text-[10px] transition-colors ${
      copied === what ? 'text-success' : 'text-ink-faint hover:text-ink'
    }`;

  return (
    <span
      data-row-actions
      className={`${visibility} inline-flex items-center gap-0.5`}
    >
      {showCopy ? (
        <button
          type="button"
          data-row-action="copy"
          title={t('transcript.copyTitle')}
          aria-label={t('transcript.copyTitle')}
          onClick={() => { copy('text', copyText); }}
          className={copyClass('text')}
        >
          {copied === 'text' ? <Icon name="check" size={12} /> : t('transcript.copy')}
        </button>
      ) : null}
      {showLink ? (
        <button
          type="button"
          data-row-action="link"
          title={t('transcript.copyLinkTitle')}
          aria-label={t('transcript.copyLinkTitle')}
          onClick={() => { copy('link', linkHref); }}
          className={copyClass('link')}
        >
          {copied === 'link' ? <Icon name="check" size={12} /> : t('transcript.copyLink')}
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
      className="w-full max-w-[85%] rounded-2xl rounded-br-md border border-accent/40 bg-panel px-3 py-2"
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
            className="rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-on-accent transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('transcript.editSubmit')}
          </button>
        </span>
      </div>
    </div>
  );
}
