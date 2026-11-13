/**
 * SearchableSelect — single- and multi-value select base for option lists
 * (workspace and model pickers), following the QuickSwitcher's keyboard idiom:
 * the trigger opens a panel, ↑/↓ cycles the active row, Enter commits or
 * toggles it, Esc closes, and the list scrolls inside a bounded max-height.
 *
 * Search visibility: unless `hideFilter` overrides it, the filter input renders
 * once `options.length >= LIST_TOOLS_MIN_ITEMS` (8) or `allowCustomValue` is on.
 *
 * Container: in phone mode (`usePhoneMode`) an owned panel opens as a bottom
 * sheet over a scrim with thumb-sized rows, closing on scrim tap, Escape, and
 * the phone's back gesture (one layer-history entry). On desktop, unless a
 * caller passes `panelClassName` (the composer, which anchors its panel
 * itself), the panel is portaled to <body> and positioned against the viewport.
 */

import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { filterSelectOptions } from '@kiki/session-core/sessions';
import { useI18n } from '../i18n';
import { useLayerHistory } from '../lib/layerHistory';
import { isCoarsePointer, usePhoneMode } from '../lib/layoutHooks';
import { isImeKeyEvent } from '../lib/shortcuts';
import { unzoomedRect, unzoomedViewport } from '../lib/uiZoom';
import {
  containsOrOwnsFloatingTarget,
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  hasOpenOwnedFloatingPortal,
  MODAL_BASE_Z_INDEX,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
} from '../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from './Dialog';
import { Icon } from './icons';
import { LIST_TOOLS_MIN_ITEMS } from './settings/list';

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
  /** Extra `data-*` attributes attached to the rendered option button. */
  readonly dataAttrs?: Readonly<Record<string, string | boolean | undefined>>;
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
      const rect = unzoomedRect(trigger.getBoundingClientRect());
      const { width: viewportWidth, height: viewportHeight } = unzoomedViewport();
      const width = Math.min(Math.max(rect.width, PANEL_MIN_WIDTH), viewportWidth - VIEWPORT_MARGIN * 2);
      const preferredLeft = align === 'end' ? rect.right - width : rect.left;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, viewportWidth - width - VIEWPORT_MARGIN));
      const below = viewportHeight - rect.bottom - PANEL_GAP - VIEWPORT_MARGIN;
      const above = rect.top - PANEL_GAP - VIEWPORT_MARGIN;
      const openBelow = prefer === 'below'
        ? below >= Math.min(PANEL_MAX_HEIGHT, 200) || below >= above
        : below > above;
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

export interface SearchableSelectBaseProps {
  id?: string;
  readonly options: readonly SearchableSelectOption[];
  readonly ariaLabel?: string;
  readonly ariaLabelledBy?: string;
  readonly ariaInvalid?: boolean;
  readonly ariaDescribedBy?: string;
  readonly title?: string;
  readonly disabled?: boolean;
  /** Row shown when there are no options at all (and on an empty multi trigger). */
  readonly emptyText?: string;
  readonly searchPlaceholder?: string;
  /** Rendered with the trimmed query when filtering removes every option. */
  readonly noMatchText?: (query: string) => string;
  readonly rootClassName?: string;
  readonly buttonClassName?: string;
  readonly labelClassName?: string;
  readonly triggerData?: Readonly<Record<string, string | boolean | undefined>>;
  readonly panelData?: Readonly<Record<string, string | boolean | undefined>>;
  /**
   * Hands panel positioning to the caller: the panel then renders inline, in
   * the trigger's own flow, with these classes verbatim. The composer uses it
   * to anchor the panel to its card through inherited CSS variables. Leave it
   * unset to get the shared popover (or bottom sheet on phones).
   */
  readonly panelClassName?: string;
  /**
   * Which side of the trigger the panel prefers. `above` for triggers docked
   * near the viewport bottom (the composer).
   */
  readonly placement?: 'below' | 'above' | 'auto';
  /**
   * Which trigger edge the panel hangs from. `end` for triggers that sit at
   * the right edge of their row (settings controls).
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
   * Overrides automatic search visibility (`options.length >= LIST_TOOLS_MIN_ITEMS`
   * or `allowCustomValue`). Pass `true` to hide search even on long lists, or
   * `false` to show search even below 8 items.
   */
  readonly hideFilter?: boolean;
  /** Adds the trimmed search text as a final selectable row when no option has that exact value. */
  readonly allowCustomValue?: boolean;
  readonly customValueLabel?: (value: string) => string;
  /** Bump to open the panel from outside. */
  readonly openSignal?: number;
  /** Bump to close the panel from inside a header/footer slot. */
  readonly closeSignal?: number;
  /**
   * `compact`: a dense two-line row (label, then badges as faint inline facts
   * followed by the mono hint) for long pickers opened from a tight spot.
   */
  readonly density?: 'comfortable' | 'compact';
}

export interface SearchableSingleSelectProps extends SearchableSelectBaseProps {
  readonly multiple?: false;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly values?: never;
}

export interface SearchableMultiSelectProps extends SearchableSelectBaseProps {
  readonly multiple: true;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly value?: never;
}

export type SearchableSelectProps = SearchableSingleSelectProps | SearchableMultiSelectProps;

export function SearchableSelect(props: SearchableSelectProps) {
  const {
    id,
    options,
    ariaLabel,
    ariaLabelledBy,
    ariaInvalid,
    ariaDescribedBy,
    title,
    disabled = false,
    emptyText,
    searchPlaceholder,
    noMatchText,
    rootClassName,
    buttonClassName,
    labelClassName,
    triggerData,
    panelData,
    panelClassName,
    placement = 'below',
    align = 'start',
    triggerLabel,
    triggerIcon,
    triggerSuffix,
    hideChevron = false,
    panelHeader,
    panelFooter,
    hideFilter,
    allowCustomValue = false,
    customValueLabel,
    openSignal,
    closeSignal,
    density = 'comfortable',
  } = props;
  const isMultiple = props.multiple === true;
  const singleValue = isMultiple ? '' : props.value;
  const multiValues = isMultiple ? props.values : [];

  const { t } = useI18n();
  const phoneMode = usePhoneMode();
  const selectUid = useId().replace(/:/g, '');
  const surfaceOwnerId = `select:${id ?? selectUid}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const ownsPanel = panelClassName === undefined;
  const asSheet = phoneMode;
  const isPortaled = ownsPanel || asSheet;

  const ownerId = open && isPortaled ? owningModalId(triggerRef.current) : undefined;
  const floatingOwners = open && isPortaled ? resolveFloatingOwners(triggerRef.current) : undefined;
  const openSignalRef = useRef(openSignal);
  useEffect(() => {
    if (openSignal === undefined || openSignal === openSignalRef.current) return;
    openSignalRef.current = openSignal;
    if (disabled) return;
    setActiveIndex(0);
    setOpen(true);
  }, [openSignal, disabled]);
  const closeSignalRef = useRef(closeSignal);
  useEffect(() => {
    if (closeSignal === undefined || closeSignal === closeSignalRef.current) return;
    closeSignalRef.current = closeSignal;
    setOpen(false);
    setQuery('');
  }, [closeSignal]);

  const panelStyle = useViewportPlacement(
    ownsPanel && !asSheet && open,
    triggerRef,
    align,
    placement === 'above' ? 'above' : 'below',
  );

  const [panelZIndex, setPanelZIndex] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!open) { setPanelZIndex(undefined); return; }
    setPanelZIndex(floatingSurfaceZIndex(triggerRef.current));
  }, [open]);

  const showFilter = hideFilter !== undefined
    ? !hideFilter
    : (options.length >= LIST_TOOLS_MIN_ITEMS || allowCustomValue);

  const selectedSet = useMemo(
    () => new Set(isMultiple ? multiValues : (singleValue !== '' ? [singleValue] : [])),
    [isMultiple, multiValues, singleValue],
  );
  const isValueSelected = (candidate: string) =>
    isMultiple ? selectedSet.has(candidate) : candidate === singleValue;

  const selected = isMultiple ? undefined : options.find((option) => option.value === singleValue);
  const multiSummary = useMemo(() => {
    if (!isMultiple || multiValues.length === 0) return undefined;
    const labelFor = (val: string) => options.find((opt) => opt.value === val)?.label ?? val;
    const first = labelFor(multiValues[0]!);
    return multiValues.length === 1
      ? first
      : t('select.summaryMore', { first, count: multiValues.length - 1 });
  }, [isMultiple, multiValues, options, t]);
  const multiTooltip = useMemo(() => {
    if (!isMultiple || multiValues.length === 0) return undefined;
    return multiValues.map((val) => options.find((opt) => opt.value === val)?.label ?? val).join(', ');
  }, [isMultiple, multiValues, options]);

  const visible = useMemo(
    () => (showFilter ? filterSelectOptions(options, query) : options),
    [options, query, showFilter],
  );
  const customValue = query.trim();
  const customRow = showFilter
    && allowCustomValue
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

  const showGroups = useMemo(
    () => new Set(options.map((option) => option.group)).size > 1,
    [options],
  );

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  useLayerHistory(surfaceOwnerId, open && asSheet, () => {
    close();
    triggerRef.current?.focus();
  });

  // Focus listbox on open when there is no filter input so keyboard navigation works immediately.
  useLayoutEffect(() => {
    if (!open || showFilter) return;
    if (isCoarsePointer() && !asSheet) return;
    listRef.current?.focus();
  }, [open, showFilter, asSheet]);

  useEffect(() => {
    if (!open) return;
    const release = registerOverlay(surfaceOwnerId);
    const onPointerDown = (event: PointerEvent) => {
      if (asSheet) return;
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      if (containsOrOwnsFloatingTarget(panelRef.current, event.target, surfaceOwnerId)) return;
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (
        (event.target instanceof Node && rootRef.current?.contains(event.target) === true) ||
        containsOrOwnsFloatingTarget(panelRef.current, event.target, surfaceOwnerId) ||
        hasOpenOwnedFloatingPortal(surfaceOwnerId)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      release();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, surfaceOwnerId, asSheet]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    (row as HTMLElement | null | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  const toggleMultiValue = (val: string) => {
    if (!props.multiple) return;
    const next = props.values.includes(val)
      ? props.values.filter((entry) => entry !== val)
      : [...props.values, val];
    props.onChange(next);
  };

  const commit = (option: SearchableSelectOption | undefined) => {
    if (option === undefined || option.disabled === true) return;
    if (props.multiple) {
      toggleMultiValue(option.value);
      return;
    }
    props.onChange(option.value);
    close();
  };

  const commitCustom = (val: string) => {
    if (props.multiple) {
      toggleMultiValue(val);
      setQuery('');
      return;
    }
    props.onChange(val);
    close();
  };

  const commitRow = (index: number) => {
    const option = visible[index];
    if (option !== undefined) {
      commit(option);
      return;
    }
    if (customRow !== undefined && index === visible.length) {
      commitCustom(customRow);
    }
  };

  const onNavKeyDown = (event: React.KeyboardEvent) => {
    if (isImeKeyEvent(event)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => nextEnabledIndex(index, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => nextEnabledIndex(index, -1));
    } else if (event.key === 'Enter') {
      if (!showFilter && event.target instanceof HTMLElement && event.target.getAttribute('role') === 'option') {
        const indexAttr = Number(event.target.getAttribute('data-index'));
        if (Number.isInteger(indexAttr)) {
          event.preventDefault();
          commitRow(indexAttr);
          return;
        }
      }
      event.preventDefault();
      commitRow(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    }
  };

  const listId = `${id ?? 'searchable-select'}-list`;
  const rowPadClass = asSheet ? 'min-h-11 py-2.5 text-[14px]' : 'py-1.5 text-[13px]';

  const panel = (
    <>
      {panelHeader}
      {!showFilter ? null : (
      <div className="border-b border-hairline px-3 py-2">
        <input
          type="text"
          data-autofocus
          ref={(input) => { if (!isCoarsePointer()) input?.focus(); }}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onNavKeyDown}
          placeholder={searchPlaceholder ?? t('select.search')}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel === undefined ? ariaLabelledBy : undefined}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={
            rowEnabled(activeIndex) ? `${listId}-option-${activeIndex}` : undefined
          }
          className={`w-full bg-transparent text-ink outline-none placeholder:text-ink-faint ${asSheet ? 'min-h-8 text-[15px]' : 'text-[13px]'}`}
        />
      </div>
      )}
      {hideFilter === true && options.length === 0 && (panelHeader !== undefined || panelFooter !== undefined) ? null : (
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        tabIndex={showFilter ? undefined : -1}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel === undefined ? ariaLabelledBy : undefined}
        aria-multiselectable={isMultiple ? true : undefined}
        aria-activedescendant={!showFilter && rowEnabled(activeIndex) ? `${listId}-option-${activeIndex}` : undefined}
        onKeyDown={showFilter ? undefined : onNavKeyDown}
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1.5 outline-none ${
          isPortaled ? '' : 'max-h-[min(340px,55vh)]'
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
              const isSelected = isValueSelected(option.value);
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
                  {density === 'compact' && !asSheet ? (
                    <CompactOptionRow
                      id={`${listId}-option-${index}`}
                      index={index}
                      option={option}
                      active={active}
                      selected={isSelected}
                      multiple={isMultiple}
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
                    {...option.dataAttrs}
                    aria-selected={isSelected}
                    aria-disabled={option.disabled ? true : undefined}
                    disabled={option.disabled}
                    title={option.title ?? option.label}
                    onClick={() => { commit(option); }}
                    onMouseMove={() => { if (!active && !option.disabled) setActiveIndex(index); }}
                    className={`flex w-full flex-col justify-center gap-0.5 rounded-md px-3 text-left transition-colors duration-[var(--kiki-motion-quick)] pointer-coarse:min-h-11 disabled:cursor-not-allowed ${rowPadClass} ${
                      isSelected && !isMultiple
                        ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]'
                        : isSelected && isMultiple
                          ? 'bg-ink/[0.05]'
                          : active ? 'bg-ink/[0.04]' : ''
                    }`}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      {isMultiple ? (
                        <span
                          aria-hidden
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                            isSelected ? 'border-ink bg-ink text-paper' : 'border-hairline-strong bg-paper text-transparent'
                          }`}
                        >
                          <Icon name="check" size={12} />
                        </span>
                      ) : null}
                      <span
                        className={`min-w-0 flex-1 truncate ${option.disabled ? 'text-ink-faint' : 'text-ink'} ${
                          isSelected ? 'font-medium' : ''
                        }`}
                      >
                        {option.label}
                      </span>
                      {!isMultiple && isSelected ? (
                        <Icon name="check" size={12} className="ml-auto shrink-0 text-ink-soft" />
                      ) : null}
                    </span>
                    {option.description !== undefined ? (
                      <span className={`line-clamp-2 text-[12px] leading-snug text-ink-faint ${isMultiple ? 'pl-6' : ''}`}>
                        {option.description}
                      </span>
                    ) : null}
                    {option.hint !== undefined ? (
                      <span className={`truncate font-mono text-[11px] text-ink-faint ${isMultiple ? 'pl-6' : ''}`}>
                        {option.hint}
                      </span>
                    ) : null}
                    {option.badges !== undefined && option.badges.length > 0 ? (
                      <span className={`mt-0.5 flex flex-wrap items-center gap-1 ${isMultiple ? 'pl-6' : ''}`}>
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
                aria-selected={isValueSelected(customRow)}
                title={customRow}
                onClick={() => { commitCustom(customRow); }}
                onMouseMove={() => { setActiveIndex(visible.length); }}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left font-mono text-[12px] text-ink transition-colors duration-[var(--kiki-motion-quick)] pointer-coarse:min-h-11 ${
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

  const resolvedTriggerText = triggerLabel ?? (
    isMultiple
      ? (multiSummary ?? (emptyText ?? t('select.empty')))
      : (selected?.label ?? (singleValue !== '' ? singleValue : (emptyText ?? t('select.empty'))))
  );

  return (
    <div
      ref={rootRef}
      className={rootClassName ?? 'relative'}
      data-searchable-select
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape for the open panel, which can hold slot rows outside the filter input
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape' || isImeKeyEvent(event)) return;
        event.preventDefault();
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
        aria-labelledby={ariaLabelledBy}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        {...triggerData}
        title={title ?? (isMultiple ? multiTooltip : (selected?.title ?? selected?.label))}
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
        <span className={`min-w-0 truncate ${isMultiple && multiValues.length === 0 && triggerLabel === undefined ? 'text-ink-faint font-sans' : ''} ${labelClassName ?? ''}`.trim()}>
          {resolvedTriggerText}
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
        ? asSheet
          ? createPortal(
            <div
              data-select-sheet
              className="kiki-action-sheet-layer"
              style={{ zIndex: panelZIndex ?? MODAL_BASE_Z_INDEX }}
              onClick={(event) => { event.stopPropagation(); }}
            >
              <div
                aria-hidden
                data-select-scrim
                className="kiki-action-sheet-scrim"
                onClick={() => { close(); triggerRef.current?.focus(); }}
              />
              <div
                ref={panelRef}
                data-select-panel
                {...panelData}
                {...{
                  [FLOATING_OWNER_ATTRIBUTE]: surfaceOwnerId,
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: floatingOwners,
                  [MODAL_ESCAPE_ATTRIBUTE]: ownerId,
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyEvent(event)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                  triggerRef.current?.focus();
                }}
                className="kiki-action-sheet flex flex-col overflow-hidden"
              >
                {panel}
              </div>
            </div>,
            document.body,
          )
          : ownsPanel
            ? createPortal(
              <div
                ref={panelRef}
                data-select-panel
                {...panelData}
                {...{
                  [FLOATING_OWNER_ATTRIBUTE]: surfaceOwnerId,
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: floatingOwners,
                  [MODAL_ESCAPE_ATTRIBUTE]: ownerId,
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyEvent(event)) return;
                  event.preventDefault();
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
                {...panelData}
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
 * facts that never shrink.
 */
function CompactOptionRow({
  id,
  index,
  option,
  active,
  selected,
  multiple,
  onCommit,
  onHover,
}: {
  readonly id: string;
  readonly index: number;
  readonly option: SearchableSelectOption;
  readonly active: boolean;
  readonly selected: boolean;
  readonly multiple: boolean;
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
      {...option.dataAttrs}
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled ? true : undefined}
      disabled={option.disabled}
      title={tooltip}
      onClick={onCommit}
      onMouseMove={onHover}
      className={`flex w-full min-w-0 flex-col justify-center gap-px rounded-md px-3 text-left transition-colors duration-[var(--kiki-motion-quick)] disabled:cursor-not-allowed ${
        hasSecondLine ? 'min-h-10 py-1 pointer-coarse:min-h-12' : 'h-8 pointer-coarse:h-10'
      } ${selected && !multiple ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : selected && multiple ? 'bg-ink/[0.05]' : active ? 'bg-ink/[0.04]' : ''}`}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        {multiple ? (
          <span
            aria-hidden
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${
              selected ? 'border-ink bg-ink text-paper' : 'border-hairline-strong bg-paper text-transparent'
            }`}
          >
            <Icon name="check" size={12} />
          </span>
        ) : null}
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
        {!multiple ? (
          <Icon name="check" size={12} className={`shrink-0 ${selected ? 'text-ink-soft' : 'text-transparent'}`} />
        ) : null}
      </span>
      {hasSecondLine ? (
        <span data-option-meta className={`flex w-full min-w-0 items-center gap-2 text-[11.5px] leading-4 text-ink-faint ${multiple ? 'pl-6' : ''}`}>
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
