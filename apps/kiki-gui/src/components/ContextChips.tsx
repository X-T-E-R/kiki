/**
 * Context chips — the quote / image language shared by the composer's tray
 * (what rides along with the next prompt) and the sent user bubble (what rode
 * along). Same tiles in both places, so a carried-over selection looks the
 * same before and after it is sent:
 *
 *   - QuoteChip       a quotation mark + the quoted text on one line;
 *   - ImageTile       a rounded thumbnail; clicking opens the lightbox.
 *
 * (Sent annotations fold into SentAnnotationsBubble instead of chips.)
 * Remove buttons are optional: the composer passes them, the bubble does not.
 */

import { Suspense, useState, type MouseEvent, type ReactNode } from 'react';

import { useI18n } from '../i18n';
import { Icon } from './icons';
import { useMessageImageMenu } from './mediaParts';
import {
  LazyMediaLightbox,
  LightboxLoadFailure,
  LightboxLoadingShell,
  PreviewLoadBoundary,
} from './preview/PreviewLoadBoundary';

export type ContextChipVariant = 'compact' | 'shelf';

const TILE = 'context-chip anim-enter relative flex h-8 min-w-0 items-center gap-1.5 rounded-[10px] text-[12px]';
const SHELF_CAPSULE =
  'context-chip anim-enter relative flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-ink/[0.05] text-[12px] font-normal text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.08] hover:text-ink pointer-coarse:h-9';
const SHELF_CARD =
  'context-chip anim-enter relative flex h-11 min-w-0 max-w-[180px] shrink-0 items-center gap-2 rounded-[10px] border border-hairline bg-canvas/65 py-1 pl-2.5 pr-1.5 text-left';

function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onRemove}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
    >
      <Icon name="close" size={12} />
    </button>
  );
}

/** One line of the quoted text (newlines fold to spaces for the chip). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function QuoteChip({
  quote,
  onRemove,
  variant = 'compact',
}: {
  quote: string;
  onRemove?: () => void;
  variant?: ContextChipVariant;
}) {
  const { t } = useI18n();
  if (variant === 'shelf') {
    return (
      <div
        data-quote-chip
        data-chip-variant="shelf"
        title={quote}
        className={`${SHELF_CAPSULE} max-w-[16rem] pl-3 ${onRemove === undefined ? 'pr-3' : 'pr-1'}`}
      >
        <span aria-hidden className="context-chip-quote-mark shrink-0">“</span>
        <span className="min-w-0 truncate">{oneLine(quote)}</span>
        {onRemove !== undefined ? <RemoveButton label={t('composer.removeQuote')} onRemove={onRemove} /> : null}
      </div>
    );
  }
  return (
    <div
      data-quote-chip
      title={quote}
      className={`${TILE} max-w-[22rem] bg-ink/[0.045] ${onRemove === undefined ? 'pr-3' : 'pr-1'} pl-2`}
    >
      <span aria-hidden className="context-chip-quote-mark shrink-0">“</span>
      <span className="min-w-0 truncate text-ink-soft">{oneLine(quote)}</span>
      {onRemove !== undefined ? <RemoveButton label={t('composer.removeQuote')} onRemove={onRemove} /> : null}
    </div>
  );
}

/** Square thumbnail with shared image actions and an optional gallery opener. */
export function ImageTile({
  src,
  name,
  detail,
  onOpen,
  onRemove,
  removeLabel,
  variant = 'compact',
}: {
  src: string;
  name: string;
  detail?: string;
  onOpen?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  variant?: ContextChipVariant;
}) {
  const { t } = useI18n();
  const [viewing, setViewing] = useState(false);
  const imageMenu = useMessageImageMenu({ kind: 'image', url: src, name }, src, name);
  const title = detail === undefined ? name : `${name} · ${detail}`;
  const isShelf = variant === 'shelf';
  return (
    <div
      data-image-tile
      data-chip-variant={isShelf ? 'shelf' : undefined}
      className={`context-chip anim-enter group relative shrink-0 ${isShelf ? 'h-11 w-11' : 'h-12 w-12'}`}
    >
      <button
        type="button"
        title={title}
        aria-label={`${t('media.viewImage')}: ${name}`}
        onClick={onOpen ?? (() => { setViewing(true); })}
        onContextMenu={imageMenu.openMenu}
        className={`context-image block h-full w-full cursor-zoom-in overflow-hidden rounded-[10px] focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none ${
          isShelf ? 'bg-canvas ring-1 ring-inset ring-ink/10' : ''
        }`}
      >
        <img src={src} alt={name} referrerPolicy="no-referrer" className="h-full w-full object-cover" draggable={false} />
      </button>
      {imageMenu.menuElement}
      {viewing ? (
        <PreviewLoadBoundary
          resetKey={src}
          renderFailure={(error) => (
            <LightboxLoadFailure
              error={error}
              label={name}
              onClose={() => { setViewing(false); }}
            />
          )}
        >
          <Suspense fallback={<LightboxLoadingShell label={name} onClose={() => { setViewing(false); }} />}>
            <LazyMediaLightbox src={src} name={name} onClose={() => { setViewing(false); }} />
          </Suspense>
        </PreviewLoadBoundary>
      ) : null}
      {onRemove !== undefined ? (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className={`absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full bg-panel text-ink-soft opacity-0 shadow-[var(--kiki-sheet-shadow)] ring-1 ring-hairline transition-opacity duration-[var(--kiki-motion-quick)] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none [@media(hover:none)]:opacity-100 ${
            isShelf ? 'h-[18px] w-[18px]' : 'h-5 w-5'
          }`}
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The skill the draft's leading `/name` token will activate — shown the same
 * whether it was typed through `/` or picked from ＋ → Skills. The token stays
 * in the text (it carries the args); removing the chip strips it.
 */
export function SkillChip({
  name,
  description,
  onRemove,
  variant = 'compact',
}: {
  name: string;
  description?: string;
  onRemove?: () => void;
  variant?: ContextChipVariant;
}) {
  const { t } = useI18n();
  if (variant === 'shelf') {
    return (
      <div
        data-skill-chip={name}
        data-chip-variant="shelf"
        title={description}
        className={`${SHELF_CAPSULE} max-w-[14rem] pl-3 ${onRemove === undefined ? 'pr-3' : 'pr-1'}`}
      >
        <span aria-hidden className="flex shrink-0 text-accent-ink/80">
          <Icon name="skill" size={12} />
        </span>
        <span className="min-w-0 truncate">{name}</span>
        {onRemove !== undefined ? (
          <RemoveButton label={t('composer.removeSkill', { name })} onRemove={onRemove} />
        ) : null}
      </div>
    );
  }
  return (
    <div
      data-skill-chip={name}
      title={description}
      className={`${TILE} max-w-[18rem] bg-ink/[0.05] ${onRemove === undefined ? 'pr-3' : 'pr-1'} pl-2`}
    >
      <span aria-hidden className="flex shrink-0 text-accent-ink/80">
        <Icon name="skill" size={12} />
      </span>
      <span className="text-ink-faint">{t('composer.skillChip')}</span>
      <span className="min-w-0 truncate font-normal text-ink">{name}</span>
      {onRemove !== undefined ? (
        <RemoveButton label={t('composer.removeSkill', { name })} onRemove={onRemove} />
      ) : null}
    </div>
  );
}

/** A text tile for non-image attachments (files, uploads, reading placeholders). */
export function TextTile({
  children,
  title,
  subtitle,
  leading,
  mono = false,
  onRemove,
  onContextMenu,
  removeLabel,
  ariaLabel,
  dataAttrs,
  variant = 'compact',
}: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  leading?: ReactNode;
  mono?: boolean;
  onRemove?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLSpanElement>) => void;
  removeLabel?: string;
  ariaLabel?: string;
  /** State markers other code keys on (`data-attachment-reading`, …). */
  dataAttrs?: Readonly<Record<string, string | undefined>>;
  variant?: ContextChipVariant;
}) {
  if (variant === 'shelf') {
    return (
      <span
        {...dataAttrs}
        data-chip-variant="shelf"
        title={title}
        aria-label={ariaLabel}
        onContextMenu={onContextMenu}
        className={`${SHELF_CARD} ${onRemove === undefined ? 'pr-2.5' : 'pr-1'} ${mono ? 'font-mono' : ''}`}
      >
        {leading !== undefined ? <span className="flex shrink-0 items-center text-ink-faint">{leading}</span> : null}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1 truncate text-[12px] leading-4 font-normal text-ink">
            {children}
          </span>
          {subtitle !== undefined && subtitle !== '' ? (
            <span className="block truncate font-sans text-[10.5px] leading-3.5 text-ink-faint tabular-nums">
              {subtitle}
            </span>
          ) : null}
        </span>
        {onRemove !== undefined && removeLabel !== undefined ? <RemoveButton label={removeLabel} onRemove={onRemove} /> : null}
      </span>
    );
  }
  return (
    <span
      {...dataAttrs}
      title={title}
      aria-label={ariaLabel}
      onContextMenu={onContextMenu}
      className={`${TILE} max-w-[16rem] bg-ink/[0.045] pl-2 text-ink-soft ${onRemove === undefined ? 'pr-3' : 'pr-1'} ${mono ? 'font-mono' : ''}`}
    >
      {leading}
      {children}
      {onRemove !== undefined && removeLabel !== undefined ? <RemoveButton label={removeLabel} onRemove={onRemove} /> : null}
    </span>
  );
}
