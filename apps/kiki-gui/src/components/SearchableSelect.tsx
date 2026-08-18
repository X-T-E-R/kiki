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

import { useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '../i18n';
import { filterSelectOptions } from '../lib/sorting';

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
  /** Secondary line (e.g. a workspace root), rendered mono and truncated. */
  readonly hint?: string;
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
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  const visible = useMemo(() => filterSelectOptions(options, query), [options, query]);

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

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (visible.length === 0 ? 0 : (index + 1) % visible.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        visible.length === 0 ? 0 : (index - 1 + visible.length) % visible.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(visible[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const listId = `${id ?? 'searchable-select'}-list`;

  return (
    <div ref={rootRef} className="relative" data-searchable-select>
      <button
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
        <span className="min-w-0 truncate">
          {/* A value outside the option set (e.g. a session-bound model absent
              from the catalog) still displays verbatim instead of the empty text. */}
          {selected?.label ?? (value !== '' ? value : (emptyText ?? t('select.empty')))}
        </span>
        <svg
          width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          className={
            panelClassName ??
            `anim-enter absolute z-40 w-64 max-w-[calc(100vw-48px)] overflow-hidden rounded-xl border border-hairline bg-panel shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)] ${
              placement === 'above' ? 'bottom-full mb-1 left-0' : 'top-full mt-1 left-0'
            }`
          }
        >
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
                visible.length > 0 ? `${listId}-option-${activeIndex}` : undefined
              }
              className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-[260px] overflow-y-auto p-1.5"
          >
            {visible.length === 0 ? (
              <p className="px-2 py-4 text-center text-[11.5px] text-ink-faint">
                {options.length === 0
                  ? (emptyText ?? t('select.empty'))
                  : (noMatchText ?? ((q: string) => t('select.noMatches', { query: q })))(query.trim())}
              </p>
            ) : (
              visible.map((option, index) => {
                const active = index === activeIndex;
                const isSelected = option.value === value;
                return (
                  <button
                    type="button"
                    key={`${option.value}-${index}`}
                    id={`${listId}-option-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    title={option.title ?? option.label}
                    onClick={() => { commit(option); }}
                    onMouseMove={() => { if (!active) setActiveIndex(index); }}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                      active ? 'bg-accent-soft' : 'hover:bg-paper'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`min-w-0 truncate text-[12px] ${
                          isSelected ? 'font-medium text-accent' : 'text-ink'
                        }`}
                      >
                        {option.label}
                      </span>
                      {isSelected ? (
                        <span aria-hidden className="ml-auto shrink-0 text-[11px] text-accent">✓</span>
                      ) : null}
                    </span>
                    {option.hint !== undefined ? (
                      <span className="truncate font-mono text-[10px] text-ink-faint">
                        {option.hint}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
