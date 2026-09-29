/**
 * Context chips — the quote / annotation / image language shared by the
 * composer's tray (what rides along with the next prompt) and the sent user
 * bubble (what rode along). Same tiles in both places, so a carried-over
 * selection looks the same before and after it is sent:
 *
 *   - QuoteChip       a quotation mark + the quoted text on one line;
 *   - AnnotationChip  the annotated passage (faint, short) + the comment, on the
 *                     same warm wash the transcript uses for annotation marks;
 *                     hover/focus reveals both in full;
 *   - ImageTile       a rounded thumbnail; clicking opens the lightbox.
 *
 * Remove buttons are optional: the composer passes them, the bubble does not.
 */

import type { ReactNode } from 'react';

import { useI18n } from '../i18n';
import { Icon } from './icons';

const TILE = 'context-chip anim-enter relative flex h-8 min-w-0 items-center gap-1.5 rounded-[10px] text-[12px]';

function RemoveButton({ label, onRemove, tone = 'ink' }: { label: string; onRemove: () => void; tone?: 'ink' | 'warm' }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onRemove}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none ${
        tone === 'warm'
          ? 'text-accent-ink/60 hover:bg-accent-ink/10 hover:text-accent-ink'
          : 'text-ink-faint hover:bg-ink/[0.07] hover:text-ink'
      }`}
    >
      <Icon name="close" size={12} />
    </button>
  );
}

/** One line of the quoted text (newlines fold to spaces for the chip). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function QuoteChip({ quote, onRemove }: { quote: string; onRemove?: () => void }) {
  const { t } = useI18n();
  return (
    <div
      data-quote-chip
      title={quote}
      className={`${TILE} max-w-[22rem] bg-ink/[0.045] ${onRemove === undefined ? 'pr-2.5' : 'pr-1'} pl-2`}
    >
      <span aria-hidden className="context-chip-quote-mark shrink-0">“</span>
      <span className="min-w-0 truncate text-ink-soft">{oneLine(quote)}</span>
      {onRemove !== undefined ? <RemoveButton label={t('composer.removeQuote')} onRemove={onRemove} /> : null}
    </div>
  );
}

export function AnnotationChip({
  quote,
  comment,
  onRemove,
}: {
  quote: string;
  comment: string;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-annotation-chip
      tabIndex={0}
      aria-label={t('composer.annotationChipAria', { quote: oneLine(quote), comment })}
      className={`group ${TILE} max-w-[24rem] bg-accent-soft/80 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        onRemove === undefined ? 'pr-2.5' : 'pr-1'
      } pl-2`}
    >
      <span aria-hidden className="flex shrink-0 text-accent-ink/80">
        <Icon name="edit" size={12} />
      </span>
      <span className="max-w-[8rem] min-w-0 shrink-[2] truncate text-ink-faint">“{oneLine(quote)}”</span>
      <span className="min-w-0 truncate text-ink">{comment}</span>
      {onRemove !== undefined ? (
        <RemoveButton label={t('composer.removeAnnotation')} onRemove={onRemove} tone="warm" />
      ) : null}
      {/* Hover/focus reveal: the full passage and the full comment. */}
      <div className="pointer-events-none absolute bottom-full left-0 z-40 mb-1.5 hidden w-72 max-w-[calc(100vw-48px)] rounded-[12px] bg-panel p-2.5 text-left shadow-[var(--kiki-sheet-shadow)] group-hover:block group-focus-within:block">
        <p className="max-h-16 overflow-hidden border-l-2 border-accent/50 pl-2 text-[11.5px] leading-snug whitespace-pre-wrap text-ink-soft">
          {quote}
        </p>
        <p className="mt-1.5 text-[12px] leading-snug whitespace-pre-wrap text-ink">{comment}</p>
      </div>
    </div>
  );
}

/** Square rounded thumbnail; `onOpen` makes it a button that opens the lightbox. */
export function ImageTile({
  src,
  name,
  detail,
  onOpen,
  onRemove,
  removeLabel,
}: {
  src: string;
  name: string;
  detail?: string;
  onOpen?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const { t } = useI18n();
  const title = detail === undefined ? name : `${name} · ${detail}`;
  const image = <img src={src} alt={name} className="h-full w-full object-cover" draggable={false} />;
  return (
    <div data-image-tile className="context-chip anim-enter group relative h-12 w-12 shrink-0">
      {onOpen !== undefined ? (
        <button
          type="button"
          title={title}
          aria-label={`${t('media.viewImage')}: ${name}`}
          onClick={onOpen}
          className="context-image block h-full w-full cursor-zoom-in overflow-hidden rounded-[10px] focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
        >
          {image}
        </button>
      ) : (
        <span title={title} className="context-image block h-full w-full overflow-hidden rounded-[10px]">{image}</span>
      )}
      {onRemove !== undefined ? (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-panel text-ink-soft opacity-0 shadow-[var(--kiki-sheet-shadow)] transition-opacity duration-[var(--kiki-motion-quick)] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none [@media(hover:none)]:opacity-100"
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
export function SkillChip({ name, description, onRemove }: { name: string; description?: string; onRemove?: () => void }) {
  const { t } = useI18n();
  return (
    <div
      data-skill-chip={name}
      title={description}
      className={`${TILE} max-w-[18rem] bg-accent-soft/70 ${onRemove === undefined ? 'pr-2.5' : 'pr-1'} pl-2`}
    >
      <span aria-hidden className="flex shrink-0 text-accent-ink/80">
        <Icon name="skill" size={12} />
      </span>
      <span className="text-ink-faint">{t('composer.skillChip')}</span>
      <span className="min-w-0 truncate font-medium text-ink">{name}</span>
      {onRemove !== undefined ? (
        <RemoveButton label={t('composer.removeSkill', { name })} onRemove={onRemove} tone="warm" />
      ) : null}
    </div>
  );
}

/** A text tile for non-image attachments (files, uploads, reading placeholders). */
export function TextTile({
  children,
  title,
  mono = false,
  onRemove,
  removeLabel,
  ariaLabel,
  dataAttrs,
}: {
  children: ReactNode;
  title?: string;
  mono?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  ariaLabel?: string;
  /** State markers other code keys on (`data-attachment-reading`, …). */
  dataAttrs?: Readonly<Record<string, string | undefined>>;
}) {
  return (
    <span
      {...dataAttrs}
      title={title}
      aria-label={ariaLabel}
      className={`${TILE} max-w-[16rem] bg-ink/[0.045] pl-2 text-ink-soft ${onRemove === undefined ? 'pr-2.5' : 'pr-1'} ${mono ? 'font-mono' : ''}`}
    >
      {children}
      {onRemove !== undefined && removeLabel !== undefined ? <RemoveButton label={removeLabel} onRemove={onRemove} /> : null}
    </span>
  );
}
