/**
 * SearchableSelect — a single-value combobox for long option lists (workspace
 * and model pickers), following the QuickSwitcher's keyboard idiom: the
 * trigger opens a panel with a filter input, ↑/↓ cycles the active row, Enter
 * commits it, Esc closes, and the list scrolls inside a bounded max-height.
 *
 * Container: unless a caller passes `panelClassName` (the composer, which
 * anchors its panel itself), the panel is portaled to <body> and positioned
 * against the viewport. It is never laid out inside the trigger, so a scrolling
 * sheet, a scrolling page column or an `overflow-hidden` shell frame can no
 * longer clip it or trap it behind a page edge.
 *
 * ARIA: the trigger is a button with aria-haspopup="listbox"; the filter
 * input carries role="combobox" with aria-activedescendant pointing at the
 * active option, which is also scrolled into view while arrowing.
 */

import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { filterSelectOptions } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { floatingSurfaceZIndex, MODAL_BASE_Z_INDEX, owningModalId } from '../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from './Dialog';
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
  /** Accent tint for the one fact worth spotting (e.g. the current model). */
  readonly accent?: boolean;
  /** Caution tint for a missing capability that changes what the row can do. */
  readonly tone?: 'caution';
}

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
  /** Visible for diagnosis, but skipped by selection and keyboard navigation. */
  readonly disabled?: boolean;
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

const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;
const PANEL_MIN_WIDTH = 224;
const PANEL_MAX_HEIGHT = 340;

/**
 * Viewport-fixed placement for a panel this component owns.
 *
 * The panel is portaled to <body>, so its coordinates are viewport
 * coordinates and no clipping or transformed ancestor of the trigger can
 * capture it: the profile editor's scrolling sheet, the settings page's scroll
 * column and the app shell's `overflow-hidden` frame all stop mattering. It is
 * at least as wide as its trigger, hangs from the trigger edge `align` names,
 * is clamped inside the viewport horizontally, and takes whichever side has
 * room, with its height capped to that room. Recomputed on scroll and resize
 * so it follows the trigger instead of floating over neighbours.
 */
function useViewportPlacement(
  active: boolean,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  align: 'start' | 'end',
  prefer: 'below' | 'above',
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!active) {
      setStyle(undefined);
      return;
    }
    const place = () => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(Math.max(rect.width, PANEL_MIN_WIDTH), viewportWidth - VIEWPORT_MARGIN * 2);
      const preferredLeft = align === 'end' ? rect.right - width : rect.left;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, viewportWidth - width - VIEWPORT_MARGIN));
      const below = viewportHeight - rect.bottom - PANEL_GAP - VIEWPORT_MARGIN;
      const above = rect.top - PANEL_GAP - VIEWPORT_MARGIN;
      // `prefer` names the side to take when the other is no better: on a tie
      // the preference wins, which is what keeps a picker docked near the
      // bottom (the composer) opening upward. The default also takes below
      // whenever it holds a usable list, so a short trigger does not flip.
      const openBelow = prefer === 'below'
        ? below >= Math.min(PANEL_MAX_HEIGHT, 200) || below >= above
        : below > above;
      // Never taller than the room actually there: a floor here would push the
      // panel past the viewport edge on a trigger that has almost no space.
      const room = openBelow ? below : above;
      const maxHeight = Math.max(0, Math.min(PANEL_MAX_HEIGHT, room));
      setStyle(openBelow
        ? { left, width, top: rect.bottom + PANEL_GAP, maxHeight }
        : { left, width, bottom: viewportHeight - rect.top + PANEL_GAP, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [active, triggerRef, align, prefer]);
  return style;
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
  align = 'start',
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
  /**
   * Hands panel positioning to the caller: the panel then renders inline, in
   * the trigger's own flow, with these classes verbatim. The composer uses it
   * to anchor the panel to its card through inherited CSS variables. Leave it
   * unset to get the shared popover, which is portaled to <body> and placed
   * against the viewport.
   */
  readonly panelClassName?: string;
  /**
   * Which side of the trigger the panel prefers. `above` for triggers docked
   * near the viewport bottom (the composer). A portaled panel measures the
   * room on both sides and keeps the preferred one unless the other holds
   * strictly more, so it never runs past a viewport edge.
   */
  readonly placement?: 'below' | 'above' | 'auto';
  /**
   * Which trigger edge the panel hangs from. `end` for triggers that sit at
   * the right edge of their row (settings controls), so the panel opens
   * inward instead of past the container.
   */
  readonly align?: 'start' | 'end';
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
   * `compact`: a dense two-line row (label, then badges as faint inline facts
   * followed by the mono hint) for long pickers opened from a tight spot such
   * as the composer status line. Descriptions stay in the row tooltip.
   */
  readonly density?: 'comfortable' | 'compact';
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * A `panelClassName` means the caller positions the panel itself — the
   * composer anchors it to its card through inherited CSS variables — so that
   * panel stays inline, in the trigger's own flow. Otherwise this component
   * owns the placement and portals the panel to <body>.
   */
  const ownsPanel = panelClassName === undefined;
  /**
   * Which dialog owns this picker, read from the trigger rather than the
   * panel: the panel renders in <body> and has no dialog ancestor left to
   * ask. The id goes on the portaled panel so an enclosing dialog's focus trap
   * accepts this surface and only this one — a picker under a lower dialog, or
   * on the page behind one, is not exempt while another dialog is on top.
   */
  const [ownerId, setOwnerId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!open) { setOwnerId(undefined); return; }
    setOwnerId(owningModalId(triggerRef.current));
  }, [open]);
  const panelStyle = useViewportPlacement(
    ownsPanel && open,
    triggerRef,
    align,
    placement === 'above' ? 'above' : 'below',
  );
  /**
   * The panel renders in `<body>`, so its stacking is decided here rather than
   * by where the trigger sits. Opening it from inside a dialog has to clear
   * that dialog's own overlay: a first-run wizard sits one depth up, and a
   * panel at the page-level z-index painted *under* it — present in the DOM,
   * invisible on screen, and unclickable. Resolved from the trigger's owning
   * modal so any nesting depth is covered, and re-read when the panel opens
   * because that is when a dialog above it may have appeared.
   */
  const [panelZIndex, setPanelZIndex] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!open) { setPanelZIndex(undefined); return; }
    setPanelZIndex(floatingSurfaceZIndex(triggerRef.current));
  }, [open]);

  const selected = options.find((option) => option.value === value);
  const visible = useMemo(() => filterSelectOptions(options, query), [options, query]);
  const customValue = query.trim();
  const customRow = allowCustomValue
    && customValue !== ''
    && !options.some((option) => option.value === customValue)
    ? customValue
    : undefined;
  const rowCount = visible.length + (customRow === undefined ? 0 : 1);
  const rowEnabled = (index: number) => index >= 0 && (visible[index] !== undefined
    ? visible[index].disabled !== true : customRow !== undefined && index === visible.length);
  const nextEnabledIndex = (index: number, direction: 1 | -1) => {
    for (let step = 1; step <= rowCount; step++) {
      const next = (index + direction * step + rowCount) % rowCount;
      if (rowEnabled(next)) return next;
    }
    return -1;
  };
  useEffect(() => {
    if (!open) return;
    setActiveIndex((index) => rowEnabled(index) ? index : nextEnabledIndex(-1, 1));
  }, [open, visible, customRow]);
  // Group headers earn their row only when the set actually spans groups.
  const showGroups = useMemo(
    () => new Set(options.map((option) => option.group)).size > 1,
    [options],
  );

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  // Clicking anywhere outside the trigger root or the panel dismisses it. A
  // portaled panel is outside the root, so it is checked explicitly: clicking
  // an option is a commit, not a dismissal.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
      close();
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
    if (option === undefined || option.disabled === true) return;
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
      setActiveIndex((index) => nextEnabledIndex(index, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => nextEnabledIndex(index, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitRow(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const listId = `${id ?? 'searchable-select'}-list`;

  // The panel body, shared by both hosts: a caller-owned inline panel and the
  // portaled one render exactly the same children, so search, the custom-value
  // row, grouping and density cannot drift between the two paths.
  const panel = (
    <>
      {panelHeader}
      {hideFilter ? null : (
      <div className="border-b border-hairline px-3 py-2">
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
            rowEnabled(activeIndex) ? `${listId}-option-${activeIndex}` : undefined
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
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1.5 ${
          // A caller-owned panel keeps the trigger-flow height cap; the
          // portaled one is capped by the placement's own maxHeight.
          ownsPanel ? '' : 'max-h-[min(340px,55vh)]'
        }`}
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
                      className={`px-3 pb-0.5 text-[12px] font-medium text-ink-faint ${index === 0 ? 'pt-1' : 'pt-3'}`}
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
                      onHover={() => { if (!active && !option.disabled) setActiveIndex(index); }}
                    />
                  ) : (
                  <button
                    type="button"
                    id={`${listId}-option-${index}`}
                    data-index={index}
                    role="option"
                    data-option-value={option.value}
                    aria-selected={isSelected}
                    aria-disabled={option.disabled ? true : undefined}
                    disabled={option.disabled}
                    title={option.title ?? option.label}
                    onClick={() => { commit(option); }}
                    onMouseMove={() => { if (!active && !option.disabled) setActiveIndex(index); }}
                    className={`flex w-full flex-col gap-0.5 rounded-md px-3 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] disabled:cursor-not-allowed ${
                      isSelected
                        ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]'
                        : active ? 'bg-ink/[0.04]' : ''
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`min-w-0 truncate text-[13px] ${option.disabled ? 'text-ink-faint' : 'text-ink'} ${
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
                                : badge.tone === 'caution'
                                  ? 'bg-amber-ink/10 px-1.5 text-amber-ink'
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
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left font-mono text-[12px] text-ink transition-colors duration-[var(--kiki-motion-quick)] ${
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
    </>
  );

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
      {open
        ? ownsPanel
          // The panel carries its own Escape handler because it is no longer a
          // DOM child of this root: the root's keydown never sees its keys.
          ? createPortal(
            <div
              ref={panelRef}
              data-select-panel
              // Names the dialog this surface belongs to (its `overlayId`, or
              // absent outside a dialog), so that dialog's focus trap can tell
              // its own picker from one belonging to another dialog.
              {...(ownerId === undefined ? {} : { [MODAL_ESCAPE_ATTRIBUTE]: ownerId })}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                // Keep the global Escape handler (turn abort) and the dialog's
                // own close-out of a panel dismissal.
                event.stopPropagation();
                close();
                triggerRef.current?.focus();
              }}
              className={`anim-enter fixed flex flex-col overflow-hidden ${POPOVER_SURFACE_CLASS}`}
              style={{ ...panelStyle, zIndex: panelZIndex ?? MODAL_BASE_Z_INDEX }}
            >
              {panel}
            </div>,
            document.body,
          )
          : (
            <div
              ref={panelRef}
              data-select-panel
              className={panelClassName}
            >
              {panel}
            </div>
          )
        : null}
    </div>
  );
}

/**
 * Two-line option row (`density="compact"`). Line one is the label (it owns
 * the width and truncates last-resort) with any accent badge and the check;
 * line two is the mono hint, truncating, then the plain badges as short faint
 * facts that never shrink. Nothing wraps sideways, so the list cannot scroll
 * horizontally however long a name, id, or fact set gets.
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
  const accents = (option.badges ?? []).filter((badge) => badge.accent === true);
  const facts = (option.badges ?? []).filter((badge) => badge.accent !== true);
  const hasSecondLine = option.hint !== undefined || facts.length > 0;
  const tooltip = [option.title ?? option.label, option.description].filter((part) => part !== undefined && part !== '').join('\n');
  return (
    <button
      type="button"
      id={id}
      data-index={index}
      data-option-density="compact"
      data-option-value={option.value}
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled ? true : undefined}
      disabled={option.disabled}
      title={tooltip}
      onClick={onCommit}
      onMouseMove={onHover}
      className={`flex w-full min-w-0 flex-col justify-center gap-px rounded-md px-3 text-left transition-colors duration-[var(--kiki-motion-quick)] disabled:cursor-not-allowed ${
        hasSecondLine ? 'min-h-10 py-1 pointer-coarse:min-h-12' : 'h-8 pointer-coarse:h-10'
      } ${selected ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : active ? 'bg-ink/[0.04]' : ''}`}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span
          data-option-label
          className={`min-w-0 flex-1 truncate text-[13px] leading-[18px] ${option.disabled ? 'text-ink-faint' : 'text-ink'} ${selected ? 'font-medium' : ''}`}
        >
          {option.label}
        </span>
        {accents.map((badge) => (
          <span key={badge.label} className="shrink-0 text-[11.5px] font-medium text-accent-ink">
            {badge.label}
          </span>
        ))}
        <Icon name="check" size={12} className={`shrink-0 ${selected ? 'text-ink-soft' : 'text-transparent'}`} />
      </span>
      {hasSecondLine ? (
        <span data-option-meta className="flex w-full min-w-0 items-center gap-2 text-[11.5px] leading-4 text-ink-faint">
          {option.hint !== undefined ? (
            <span className="min-w-0 truncate font-mono text-[11px]">{option.hint}</span>
          ) : null}
          {facts.length > 0 ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums">
              {facts.map((badge, factIndex) => (
                <span key={badge.label} className="flex items-center gap-1.5">
                  {factIndex > 0 ? <span aria-hidden>·</span> : null}
                  <span
                    data-option-fact={badge.tone ?? 'plain'}
                    className={badge.tone === 'caution' ? 'text-amber-ink' : undefined}
                  >
                    {badge.label}
                  </span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
