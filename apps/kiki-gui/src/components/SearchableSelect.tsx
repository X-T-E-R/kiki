/**
 * SearchableSelect — a single-value combobox for long option lists (workspace
 * and model pickers), following the QuickSwitcher's keyboard idiom: the
 * trigger opens a panel with a filter input, ↑/↓ cycles the active row, Enter
 * commits it, Esc closes, and the list scrolls inside a bounded max-height.
 *
 * ARIA: the trigger is a button with aria-haspopup="listbox"; the filter
 * input carries role="combobox" with aria-activedescendant pointing at the
 * active option, which is also scrolled into view while arrowing.
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { filterSelectOptions } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { Icon } from './icons';

/**
 * The one floating-surface look shared by composer pickers and popovers:
 * 10px radius, hairline edge, the soft two-layer elevation. Callers add
 * their own position/size classes.
 */
export const POPOVER_SURFACE_CLASS =
  'rounded-[10px] border border-hairline bg-panel shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]';

export interface SearchableSelectOptionBadge {
  readonly label: string;
  /** Accent tint for the one fact worth spotting (e.g. the default effort). */
  readonly accent?: boolean;
}

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
  /** Secondary line (e.g. a workspace root), rendered mono and truncated. */
  readonly hint?: string;
  /** Prose line under the label (a profile description), clamped to two lines. */
  readonly description?: string;
  /** Small pills under the text lines — capabilities, effort, provenance. */
  readonly badges?: readonly SearchableSelectOptionBadge[];
  /**
   * Group header label. Headers render between runs of the same group, and
   * only when the option set spans more than one group.
   */
  readonly group?: string;
  /** Tooltip for the truncated trigger label; defaults to the label. */
  readonly title?: string;
  /** Extra match text the filter sees but the row never renders (e.g. a model id). */
  readonly keywords?: string;
}

export function SearchableSelect({
  id,
  options,
  value,
  onChange,
  ariaLabel,
  title,
  disabled = false,
  emptyText,
  searchPlaceholder,
  noMatchText,
  buttonClassName,
  panelClassName,
  placement = 'below',
  triggerLabel,
  triggerIcon,
  triggerSuffix,
  hideChevron = false,
  panelHeader,
  panelFooter,
  hideFilter = false,
  allowCustomValue = false,
  customValueLabel,
  density = 'comfortable',
}: {
  id?: string;
  readonly options: readonly SearchableSelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  readonly title?: string;
  readonly disabled?: boolean;
  /** Row shown when there are no options at all. */
  readonly emptyText?: string;
  readonly searchPlaceholder?: string;
  /** Rendered with the trimmed query when filtering removes every option. */
  readonly noMatchText?: (query: string) => string;
  readonly buttonClassName?: string;
  readonly panelClassName?: string;
  /** 'above' for triggers docked near the viewport bottom (the composer). */
  readonly placement?: 'below' | 'above';
  /**
   * Replaces the selected option's label on the trigger (a short form of a
   * long row label); the panel rows keep the full label.
   */
  readonly triggerLabel?: ReactNode;
  /** Rendered before the (truncating) trigger label, never truncated (a kind icon). */
  readonly triggerIcon?: ReactNode;
  /** Rendered after the (truncating) trigger label without truncating itself. */
  readonly triggerSuffix?: ReactNode;
  /** Drops the trigger chevron (quiet text triggers such as the composer status line). */
  readonly hideChevron?: boolean;
  /** Rows above the filter input — related settings that share this trigger. */
  readonly panelHeader?: ReactNode;
  /** Rows below the option list — related settings that share this trigger. */
  readonly panelFooter?: ReactNode;
  /**
   * Drops the filter input for option sets short enough to read at a glance;
   * with no options at all the list goes too, leaving a slot-only panel.
   */
  readonly hideFilter?: boolean;
  /** Adds the trimmed search text as a final selectable row when no option has that exact value. */
  readonly allowCustomValue?: boolean;
  readonly customValueLabel?: (value: string) => string;
  /**
   * `compact`: one line per option (label, badges as faint inline text, hint
   * on the right edge) for long pickers opened from a tight spot such as the
   * composer status line. Descriptions stay in the row tooltip.
   */
  readonly density?: 'comfortable' | 'compact';
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  const visible = useMemo(() => filterSelectOptions(options, query), [options, query]);
  const customValue = query.trim();
  const customRow = allowCustomValue
    && customValue !== ''
    && !options.some((option) => option.value === customValue)
    ? customValue
    : undefined;
  const rowCount = visible.length + (customRow === undefined ? 0 : 1);
  // Group headers earn their row only when the set actually spans groups.
  const showGroups = useMemo(
    () => new Set(options.map((option) => option.group)).size > 1,
    [options],
  );

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  // Clicking anywhere outside the root dismisses the panel.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); };
  }, [open]);

  // Keep the active row visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    // jsdom (unit tests) lacks scrollIntoView; browsers all have it.
    (row as HTMLElement | null | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  const commit = (option: SearchableSelectOption | undefined) => {
    if (option === undefined) return;
    onChange(option.value);
    close();
  };

  const commitRow = (index: number) => {
    const option = visible[index];
    if (option !== undefined) {
      commit(option);
      return;
    }
    if (customRow !== undefined && index === visible.length) {
      onChange(customRow);
      close();
    }
  };

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (rowCount === 0 ? 0 : (index + 1) % rowCount));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        rowCount === 0 ? 0 : (index - 1 + rowCount) % rowCount,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitRow(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const listId = `${id ?? 'searchable-select'}-list`;

  return (
    <div
      ref={rootRef}
      className="relative"
      data-searchable-select
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape for the open panel, which can hold slot rows outside the filter input
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return;
        event.preventDefault();
        // Keep the global Escape handler (turn abort) out of a panel dismissal.
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? selected?.title ?? selected?.label}
        onClick={() => {
          if (open) {
            close();
          } else {
            setActiveIndex(0);
            setOpen(true);
          }
        }}
        className={
          buttonClassName ??
          'flex max-w-full items-center gap-1.5 rounded-md border border-hairline bg-paper px-2 py-1 text-[12px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint'
        }
      >
        {triggerIcon}
        <span className="min-w-0 truncate">
          {/* A value outside the option set (e.g. a session-bound model absent
              from the catalog) still displays verbatim instead of the empty text. */}
          {triggerLabel ?? selected?.label ?? (value !== '' ? value : (emptyText ?? t('select.empty')))}
        </span>
        {triggerSuffix}
        {hideChevron ? null : (
          <svg
            width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden
            className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open ? (
        <div
          className={
            panelClassName ??
            `anim-enter absolute z-40 w-64 max-w-[calc(100vw-48px)] overflow-hidden ${POPOVER_SURFACE_CLASS} ${
              placement === 'above' ? 'bottom-full mb-1 left-0' : 'top-full mt-1 left-0'
            }`
          }
        >
          {panelHeader}
          {hideFilter ? null : (
          <div className="border-b border-hairline px-2.5 py-2">
            <input
              type="text"
              data-autofocus
              ref={(input) => { input?.focus(); }}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={searchPlaceholder ?? t('select.search')}
              aria-label={ariaLabel}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                rowCount > 0 ? `${listId}-option-${activeIndex}` : undefined
              }
              className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          )}
          {hideFilter && options.length === 0 ? null : (
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-[min(340px,55vh)] overflow-y-auto p-1.5"
          >
            {rowCount === 0 ? (
              <p className="px-2 py-4 text-center text-[12px] text-ink-faint">
                {options.length === 0
                  ? (emptyText ?? t('select.empty'))
                  : (noMatchText ?? ((q: string) => t('select.noMatches', { query: q })))(query.trim())}
              </p>
            ) : (
              <>
                {visible.map((option, index) => {
                  const active = index === activeIndex;
                  const isSelected = option.value === value;
                  const previousGroup = index > 0 ? visible[index - 1]?.group : undefined;
                  const groupHeader =
                    showGroups && option.group !== undefined && option.group !== previousGroup
                      ? option.group
                      : undefined;
                  return (
                    <div key={`${option.value}-${index}`} role="presentation">
                      {groupHeader !== undefined ? (
                        <p
                          className={`px-2.5 pb-0.5 text-[12px] font-medium text-ink-faint ${index === 0 ? 'pt-1' : 'pt-2.5'}`}
                        >
                          {groupHeader}
                        </p>
                      ) : null}
                      {density === 'compact' ? (
                        <CompactOptionRow
                          id={`${listId}-option-${index}`}
                          index={index}
                          option={option}
                          active={active}
                          selected={isSelected}
                          onCommit={() => { commit(option); }}
                          onHover={() => { if (!active) setActiveIndex(index); }}
                        />
                      ) : (
                      <button
                        type="button"
                        id={`${listId}-option-${index}`}
                        data-index={index}
                        role="option"
                        aria-selected={isSelected}
                        title={option.title ?? option.label}
                        onClick={() => { commit(option); }}
                        onMouseMove={() => { if (!active) setActiveIndex(index); }}
                        className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] ${
                          isSelected
                            ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]'
                            : active ? 'bg-ink/[0.04]' : ''
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={`min-w-0 truncate text-[13px] text-ink ${
                              isSelected ? 'font-medium' : ''
                            }`}
                          >
                            {option.label}
                          </span>
                          {isSelected ? (
                            <Icon name="check" size={12} className="ml-auto text-ink-soft" />
                          ) : null}
                        </span>
                        {option.description !== undefined ? (
                          <span className="line-clamp-2 text-[12px] leading-snug text-ink-faint">
                            {option.description}
                          </span>
                        ) : null}
                        {option.hint !== undefined ? (
                          <span className="truncate font-mono text-[11px] text-ink-faint">
                            {option.hint}
                          </span>
                        ) : null}
                        {option.badges !== undefined && option.badges.length > 0 ? (
                          <span className="mt-0.5 flex flex-wrap items-center gap-1">
                            {option.badges.map((badge) => (
                              <span
                                key={badge.label}
                                className={`rounded-[4px] py-px text-[11px] leading-4 ${
                                  badge.accent === true
                                    ? 'font-medium text-accent-ink'
                                    : 'bg-ink/[0.05] px-1.5 text-ink-faint'
                                }`}
                              >
                                {badge.label}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </button>
                      )}
                    </div>
                  );
                })}
                {customRow !== undefined ? (
                  <button
                    type="button"
                    id={`${listId}-option-${visible.length}`}
                    data-index={visible.length}
                    role="option"
                    aria-selected={customRow === value}
                    title={customRow}
                    onClick={() => { onChange(customRow); close(); }}
                    onMouseMove={() => { setActiveIndex(visible.length); }}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left font-mono text-[12px] text-ink transition-colors duration-[var(--kiki-motion-quick)] ${
                      activeIndex === visible.length ? 'bg-ink/[0.04]' : 'hover:bg-ink/[0.04]'
                    }`}
                  >
                    <Icon name="plus" size={12} className="text-ink-faint" />
                    <span className="min-w-0 truncate">
                      {(customValueLabel ?? ((custom) => custom))(customRow)}
                    </span>
                  </button>
                ) : null}
              </>
            )}
          </div>
          )}
          {panelFooter}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One-line option row (`density="compact"`): the label leads, badges follow as
 * faint inline words (an accent badge keeps its accent), and the hint sits on
 * the right edge in mono. Everything truncates before the row wraps, so a long
 * catalog reads as a list instead of a stack of cards.
 */
function CompactOptionRow({
  id,
  index,
  option,
  active,
  selected,
  onCommit,
  onHover,
}: {
  readonly id: string;
  readonly index: number;
  readonly option: SearchableSelectOption;
  readonly active: boolean;
  readonly selected: boolean;
  readonly onCommit: () => void;
  readonly onHover: () => void;
}) {
  const badges = option.badges ?? [];
  const tooltip = [option.title ?? option.label, option.description].filter((part) => part !== undefined && part !== '').join('\n');
  return (
    <button
      type="button"
      id={id}
      data-index={index}
      data-option-density="compact"
      role="option"
      aria-selected={selected}
      title={tooltip}
      onClick={onCommit}
      onMouseMove={onHover}
      className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left transition-colors duration-[var(--kiki-motion-quick)] pointer-coarse:h-10 ${
        selected ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : active ? 'bg-ink/[0.04]' : ''
      }`}
    >
      <span className={`min-w-0 shrink truncate text-[13px] text-ink ${selected ? 'font-medium' : ''}`}>
        {option.label}
      </span>
      {badges.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-ink-faint">
          {badges.map((badge) => (
            <span key={badge.label} className={`shrink-0 ${badge.accent === true ? 'text-accent-ink' : ''}`}>
              {badge.label}
            </span>
          ))}
        </span>
      ) : null}
      <span className="ml-auto flex min-w-0 shrink-[3] items-center gap-2 pl-2">
        {option.hint !== undefined ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint">{option.hint}</span>
        ) : null}
        <Icon name="check" size={12} className={`shrink-0 ${selected ? 'text-ink-soft' : 'text-transparent'}`} />
      </span>
    </button>
  );
}
