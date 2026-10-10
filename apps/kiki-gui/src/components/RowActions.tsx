/**
 * RowActions — hover-revealed per-message operations (liveagent's
 * RowActions.tsx pattern): copy and copy-link on every message row, edit-resend on settled
 * user messages, regenerate on the latest completed turn's final assistant
 * reply, fork on either anchor. Buttons hide until the row is hovered or
 * focused-within; on touch layouts (`hover: none`) a tap on the row's quiet
 * surface summons them (`useMessageRowTapActions`).
 *
 * The strip is an overlay, not a flow row: it hangs under the answer (flush
 * left) or under the user bubble (flush right) from the row's bottom edge,
 * reserves no height of its own, and revealing it never moves the text. It
 * only takes the pointer while revealed, so the rows it hangs over keep their
 * clicks and their selection. Copy / edit / regenerate — the three that are
 * used on a normal pass through a conversation — are flat 28px tiles;
 * copy-link and fork sit behind the trailing `⋯`. Below `sm` the tiles fold
 * into that same `⋯` menu so the strip never crowds a narrow lane.
 *
 * The inline user-message editor also lives here: it replaces the bubble in
 * place (anything-llm's EditMessageForm shape), prefills the original text,
 * and carries the edited text and attachments through full-replacement edit-resend.
 */

import { createContext, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { registerOverlay } from '../lib/uiBusy';
import { Icon } from './icons';
import type { ComposerAttachment } from '@kiki/session-core/composer';
import { Composer } from './Composer';
import { useTranscriptTarget } from './transcriptDetail';

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

/**
 * Touch summon for a message row's action strip. Coarse pointers have no
 * hover, so a tap on the row's quiet surface (its text, its padding — never a
 * link, a button, an annotation mark, media, or an active selection) toggles
 * `data-actions-open` on the row, and a tap anywhere outside the row closes
 * it. Fine pointers never reach this: hover reveals the strip, and the
 * `(hover: none)` check keeps desktop clicks inert.
 */
export function useMessageRowTapActions<T extends HTMLElement>() {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const row = rowRef.current;
      if (row === null || !(event.target instanceof Node) || !row.contains(event.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => { window.removeEventListener('pointerdown', onPointerDown, true); };
  }, [open]);

  const onClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(hover: none)').matches) return;
    if (!(event.target instanceof Element)) return;
    if (
      event.target.closest(
        'a, button, [role="button"], input, textarea, select, summary, [contenteditable], [data-row-actions], [data-annotation-ref], img, video, audio',
      ) !== null
    ) {
      return;
    }
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    setOpen((value) => !value);
  };

  return { rowRef, open, onClick };
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
  /**
   * Which side of the lane the strip hangs on: an assistant answer is prose, so
   * its icons sit under the text flush left; a user bubble carries them flush
   * right. The `⋯` popover opens from the same edge.
   */
  align?: 'left' | 'right';
  onEdit?: () => void;
  onRegenerate?: () => void;
  onFork?: () => void;
}

/** A row-action target: 14px glyph in a 28px box — no border, no pill. */
const TILE =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-40';
const MENU_ITEM =
  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40';

/**
 * `regenerate`: the two chasing arcs the Capabilities panel draws for a reload.
 * `icons.tsx` is outside this change's file set, so the glyph is mirrored at the
 * row-action size here instead of being added as another `IconName`.
 */
function RegenerateIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      <path d="M12.8 6.6A5 5 0 0 0 3.6 5.4M3.2 9.4a5 5 0 0 0 9.2 1.2" />
      <path d="M3.4 2.8v2.8h2.8M12.6 13.2v-2.8H9.8" />
    </svg>
  );
}

export function MessageRowActions({
  copyText,
  linkHref,
  canEdit = false,
  canRegenerate = false,
  canFork = false,
  disabled = false,
  align = 'left',
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
  const showEdit = canEdit && onEdit !== undefined;
  const showRegenerate = canRegenerate && onRegenerate !== undefined;
  const showFork = canFork && onFork !== undefined;
  if (!showCopy && !showLink && !showEdit && !showRegenerate && !showFork) return null;

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
    if (!menuOpen) return;
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
  }, [menuOpen]);

  // Revealed by the row's hover / focus-within, or by the tap toggle a touch
  // row publishes as `data-actions-open`. The pointer gate rides the same
  // conditions: hidden icons never catch a click, and whatever the overlay
  // hangs over keeps its clicks and its text selection.
  const visibility =
    'pointer-events-none opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 group-data-[actions-open]/msg:pointer-events-auto group-data-[actions-open]/msg:opacity-100';

  // Only copy-link and fork are menu-only, so the `⋯` trigger is needed at every
  // width while one of them exists; a strip of tiled actions alone folds it away
  // above `sm`, where those tiles are already on screen.
  const menuOnly = showLink || showFork;

  // `absolute top-full`: the strip hangs from the row's bottom edge into the
  // gap under the message, so it reserves no height and revealing it moves
  // nothing. It spans the row's full width: any path down from the text stays
  // over a row descendant, so the row's hover holds all the way to the icons
  // (a tile-width box would drop diagonal approaches mid-glide). `z-20` keeps
  // the open `⋯` above the row's own chrome (a rotated chevron on a collapsed
  // message paints like a positioned box and would otherwise show through the
  // panel).
  return (
    <span
      ref={menuContainerRef}
      data-row-actions
      data-row-actions-align={align}
      className={`${visibility} absolute top-full right-0 left-0 z-20 flex h-7 items-center gap-0.5 ${
        align === 'right' ? 'justify-end' : 'justify-start'
      }`}
    >
      <span data-row-action-tiles className="hidden items-center gap-0.5 sm:flex">
        {showCopy ? (
          <button
            type="button"
            data-row-action="copy"
            title={t('transcript.copyTitle')}
            aria-label={t('transcript.copyTitle')}
            onClick={() => { copy('text', copyText); }}
            className={TILE}
          >
            {copied === 'text'
              ? <Icon name="check" size={14} className="text-success" />
              : <Icon name="copy" size={14} />}
          </button>
        ) : null}
        {showEdit ? (
          <button
            type="button"
            data-row-action="edit"
            title={disabled ? t('transcript.actionsBusyTitle') : t('transcript.editTitle')}
            aria-label={t('transcript.editTitle')}
            disabled={disabled}
            onClick={onEdit}
            className={TILE}
          >
            <Icon name="edit" size={14} />
          </button>
        ) : null}
        {showRegenerate ? (
          <button
            type="button"
            data-row-action="regenerate"
            title={disabled ? t('transcript.actionsBusyTitle') : t('transcript.regenerateTitle')}
            aria-label={t('transcript.regenerateTitle')}
            disabled={disabled}
            onClick={onRegenerate}
            className={TILE}
          >
            <RegenerateIcon />
          </button>
        ) : null}
      </span>
      <button
        ref={triggerRef}
        type="button"
        data-row-more
        aria-label={t('transcript.moreActions')}
        title={t('transcript.moreActions')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={toggleMenu}
        className={`${TILE} ${menuOnly ? '' : 'sm:hidden'}`}
      >
        <Icon name="more" size={14} />
      </button>
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('transcript.moreActions')}
        className={`${
          menuOpen ? 'flex anim-enter' : 'hidden'
        } pointer-events-auto absolute ${align === 'right' ? 'right-0' : 'left-0'} ${
          openUp ? 'bottom-full mb-1' : 'top-full mt-1'
        } min-w-[124px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]`}
      >
        {/* Below `sm` the tiles fold in here (`sm:hidden`): a narrow lane keeps
            the one `⋯` and every action stays a tap away. */}
        {showCopy ? (
          <button
            type="button"
            role="menuitem"
            data-row-action-menu="copy"
            title={t('transcript.copyTitle')}
            aria-label={t('transcript.copyTitle')}
            onClick={() => {
              copy('text', copyText);
              setMenuOpen(false);
            }}
            className={`${MENU_ITEM} sm:hidden`}
          >
            <span>{t('transcript.copy')}</span>
            {copied === 'text' ? <Icon name="check" size={12} className="text-success" /> : null}
          </button>
        ) : null}
        {showEdit ? (
          <button
            type="button"
            role="menuitem"
            data-row-action-menu="edit"
            title={disabled ? t('transcript.actionsBusyTitle') : t('transcript.editTitle')}
            aria-label={t('transcript.editTitle')}
            disabled={disabled}
            onClick={() => {
              setMenuOpen(false);
              onEdit();
            }}
            className={`${MENU_ITEM} sm:hidden`}
          >
            {t('transcript.edit')}
          </button>
        ) : null}
        {showRegenerate ? (
          <button
            type="button"
            role="menuitem"
            data-row-action-menu="regenerate"
            title={disabled ? t('transcript.actionsBusyTitle') : t('transcript.regenerateTitle')}
            aria-label={t('transcript.regenerateTitle')}
            disabled={disabled}
            onClick={() => {
              setMenuOpen(false);
              onRegenerate();
            }}
            className={`${MENU_ITEM} sm:hidden`}
          >
            {t('transcript.regenerate')}
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
            className={MENU_ITEM}
          >
            <span>{t('transcript.copyLink')}</span>
            {copied === 'link' ? <Icon name="check" size={12} className="text-success" /> : null}
          </button>
        ) : null}
        {showFork ? (
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
            className={MENU_ITEM}
          >
            {t('transcript.fork')}
          </button>
        ) : null}
      </div>
    </span>
  );
}

/** Inline edit-resend with the same attachment pipeline as the main composer. */
export function UserMessageEditor({
  initialText,
  loadAttachments,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  loadAttachments?: () => Promise<readonly ComposerAttachment[]>;
  onSubmit: (text: string, attachments: readonly ComposerAttachment[], presentation?: import('@kiki/transcript').TextPresentation) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const target = useTranscriptTarget();
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [loading, setLoading] = useState(loadAttachments !== undefined);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const loaderRef = useRef(loadAttachments);
  useEffect(() => {
    const load = loaderRef.current;
    if (load === undefined) return;
    let active = true;
    setLoading(true);
    setLoadError(false);
    void load().then((media) => { if (active) setAttachments(media); })
      .catch(() => { if (active) setLoadError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  const cancel = () => { if (!submitting) onCancel(); };
  return (
    <div data-edit-editor className="w-full max-w-[85%] rounded-2xl rounded-br-md border border-accent/40 bg-panel p-2">
      <Composer
        busy={false} disabled={loading} sendDisabled={loadError}
        variant="subagent" messageEditing autoFocus
        sessionId={target?.sessionId} agentId={target?.agentId}
        value={text} onChange={setText}
        attachments={attachments} onChangeAttachments={setAttachments}
        model={undefined} defaultModel={undefined} serverDefaultModel={undefined}
        modelSource="server-default" agentProfileCatalogMode={{ mode: 'global' }}
        permissionMode="manual" planMode={false} efforts={undefined} effort={undefined}
        onChangeModel={() => {}} onChangePermissionMode={() => {}}
        onChangePlanMode={() => {}} onChangeEffort={() => {}}
        onQueueEditCancel={cancel}
        onSend={async (body, media, options) => {
          setSubmitting(true);
          try { await onSubmit(body, media, options?.presentation); } finally { setSubmitting(false); }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-3 px-1">
        {loadError ? <button type="button" onClick={() => { setAttempt((value) => value + 1); }} className="text-[11px] text-danger">{t('preview.failed')} · {t('transcript.detail.retry')}</button> :
          <span className="text-[11px] leading-snug text-ink-faint">{t('transcript.editAttachmentsNote')}</span>}
        <button type="button" data-edit-cancel disabled={submitting} onClick={cancel} className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-soft hover:border-hairline-strong disabled:opacity-40">{t('common.cancel')}</button>
      </div>
    </div>
  );
}
