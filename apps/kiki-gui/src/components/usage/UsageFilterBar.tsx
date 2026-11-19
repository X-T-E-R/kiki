import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import type { ModelCatalogItem, WorkspaceCatalogEntry } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { usePhoneMode } from '../../lib/layoutHooks';
import {
  USAGE_RANGE_PRESETS,
  type UsageRangePreset,
  type UsageResponseWire,
} from '../../lib/usageV2';
import { useConnection } from '../../state/connection';
import { Toggle } from '../controls';
import { Icon } from '../icons';
import { ActionSheet } from '../overlays/ActionSheet';
import { AnchoredPopover } from '../overlays/AnchoredPopover';
import { SettingsSelect } from '../settings/SettingsPrimitives';
import {
  buildFacetCatalog,
  clearScopeFilters,
  countActiveScopeFilters,
  toggleFacetValue,
  type NamedProfileSummary,
  type UsageFacetKind,
  type UsageMultiFilters,
} from './usageFilterModel';
import { AxisGroup } from './usageShared';

type PopoverFacetTab = 'all' | UsageFacetKind;

export function toDateInputValue(ms: number | undefined): string {
  if (ms === undefined) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function toInclusiveEndDateInputValue(endAt: number | undefined): string {
  if (endAt === undefined) return '';
  return toDateInputValue(endAt - 1);
}

function parseDateParts(value: string): readonly [number, number, number] | undefined {
  if (value === '') return undefined;
  const [year, month, day] = value.split('-').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return undefined;
  }
  return [year, month, day];
}

export function fromDateInputStart(value: string): number | undefined {
  const parts = parseDateParts(value);
  if (parts === undefined) return undefined;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  return date.getTime();
}

export function fromDateInputExclusiveEnd(value: string): number | undefined {
  const parts = parseDateParts(value);
  if (parts === undefined) return undefined;
  const [year, month, day] = parts;
  const startCheck = new Date(year, month - 1, day);
  if (
    Number.isNaN(startCheck.getTime()) ||
    startCheck.getFullYear() !== year ||
    startCheck.getMonth() !== month - 1 ||
    startCheck.getDate() !== day
  ) {
    return undefined;
  }
  return new Date(year, month - 1, day + 1).getTime();
}

interface ObservedScopeFacets {
  readonly scopeId: string;
  readonly models: readonly string[];
  readonly providers: readonly string[];
  readonly profiles: readonly string[];
  readonly workspaceIds: readonly string[];
}

function emptyObserved(scopeId: string): ObservedScopeFacets {
  return { scopeId, models: [], providers: [], profiles: [], workspaceIds: [] };
}

export function UsageFilterBar({
  filters,
  workspaces,
  models,
  providers,
  namedProfiles,
  response,
  modelResponse,
  comparing,
  compareAvailable,
  onCompareChange,
  onChange,
  reliabilitySlot,
  utilitySlot,
}: {
  readonly filters: UsageMultiFilters;
  readonly workspaces: readonly WorkspaceCatalogEntry[];
  readonly models: readonly ModelCatalogItem[];
  readonly providers: readonly { readonly id: string }[];
  readonly namedProfiles: readonly NamedProfileSummary[];
  readonly response?: UsageResponseWire;
  readonly modelResponse?: UsageResponseWire;
  readonly comparing: boolean;
  readonly compareAvailable: boolean;
  readonly onCompareChange: (next: boolean) => void;
  readonly onChange: (next: UsageMultiFilters) => void;
  readonly reliabilitySlot?: ReactNode;
  readonly utilitySlot?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const { scopeId } = useConnection();
  const phone = usePhoneMode();
  const [rangeInvalid, setRangeInvalid] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PopoverFacetTab>('all');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const addFilterRef = useRef<HTMLButtonElement>(null);
  const activeTriggerRef = useRef<HTMLElement | null>(null);
  const chipTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const composerId = `usage-filter-composer-${useId().replace(/:/g, '')}`;
  const [observedState, setObservedState] = useState<ObservedScopeFacets>(() => emptyObserved(scopeId));
  const observed = observedState.scopeId === scopeId ? observedState : emptyObserved(scopeId);

  useEffect(() => {
    const sources = [response, modelResponse].filter((entry): entry is UsageResponseWire => entry !== undefined);
    setObservedState((prev) => {
      const base = prev.scopeId === scopeId ? prev : emptyObserved(scopeId);
      if (sources.length === 0) {
        return prev.scopeId === scopeId ? prev : base;
      }
      const modelsSet = new Set(base.models);
      const providersSet = new Set(base.providers);
      const profilesSet = new Set(base.profiles);
      const workspacesSet = new Set(base.workspaceIds);
      for (const src of sources) {
        for (const id of src.reliability.unknown_price_models) modelsSet.add(id);
        for (const item of src.sessions.items) {
          if (item.primary_model) modelsSet.add(item.primary_model);
          if (item.workspace_id) workspacesSet.add(item.workspace_id);
          for (const p of item.profile_names ?? []) profilesSet.add(p);
        }
        for (const bucket of src.trend) {
          for (const group of bucket.groups) {
            if (group.model_alias) modelsSet.add(group.model_alias);
            if (src.query.dimension === 'model' && group.key && group.key !== 'unknown') {
              modelsSet.add(group.key);
            }
            if (group.provider) providersSet.add(group.provider);
            if (group.profile_name) profilesSet.add(group.profile_name);
            if (src.query.dimension === 'project' && group.key && group.key !== 'unknown') {
              workspacesSet.add(group.key);
            }
          }
        }
      }
      if (
        prev.scopeId === scopeId &&
        modelsSet.size === base.models.length &&
        providersSet.size === base.providers.length &&
        profilesSet.size === base.profiles.length &&
        workspacesSet.size === base.workspaceIds.length
      ) {
        return prev;
      }
      return {
        scopeId,
        models: [...modelsSet],
        providers: [...providersSet],
        profiles: [...profilesSet],
        workspaceIds: [...workspacesSet],
      };
    });
  }, [scopeId, response, modelResponse]);

  const catalog = useMemo(
    () =>
      buildFacetCatalog({
        workspaces,
        models,
        providers,
        namedProfiles,
        response,
        filters: {
          ...filters,
          models: [...new Set([...filters.models, ...observed.models])],
          providers: [...new Set([...filters.providers, ...observed.providers])],
          profiles: [...new Set([...filters.profiles, ...observed.profiles])],
          workspaceIds: [...new Set([...filters.workspaceIds, ...observed.workspaceIds])],
        },
      }),
    [workspaces, models, providers, namedProfiles, response, filters, observed],
  );

  const labelLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of catalog.all) {
      map.set(`${option.facet}:${option.value}`, option.label);
    }
    return map;
  }, [catalog.all]);

  const activeScopeCount = countActiveScopeFilters(filters);

  const openFacetPopover = (tab: PopoverFacetTab, trigger?: HTMLElement | null) => {
    activeTriggerRef.current = trigger ?? addFilterRef.current;
    setActiveTab(tab);
    setQuery('');
    setActiveIndex(0);
    setComposerOpen(true);
  };

  const closeComposer = () => {
    if (activeTriggerRef.current !== null && !activeTriggerRef.current.isConnected) {
      activeTriggerRef.current = addFilterRef.current;
    }
    setComposerOpen(false);
    setQuery('');
    setActiveIndex(0);
  };

  if (composerOpen && activeTriggerRef.current !== null && !activeTriggerRef.current.isConnected) {
    activeTriggerRef.current = addFilterRef.current;
  }

  const isSelected = (facet: UsageFacetKind, value: string): boolean => {
    switch (facet) {
      case 'workspace':
        return filters.workspaceIds.includes(value);
      case 'model':
        return filters.models.includes(value);
      case 'provider':
        return filters.providers.includes(value);
      case 'profile':
        return filters.profiles.includes(value);
    }
  };

  const toggleOption = (facet: UsageFacetKind, value: string) => {
    switch (facet) {
      case 'workspace':
        onChange({ ...filters, workspaceIds: toggleFacetValue(filters.workspaceIds, value) });
        break;
      case 'model':
        onChange({ ...filters, models: toggleFacetValue(filters.models, value) });
        break;
      case 'provider':
        onChange({ ...filters, providers: toggleFacetValue(filters.providers, value) });
        break;
      case 'profile':
        onChange({ ...filters, profiles: toggleFacetValue(filters.profiles, value) });
        break;
    }
  };

  const trimmedQuery = query.trim();
  const needle = trimmedQuery.toLocaleLowerCase();
  const visibleOptions = useMemo(() => {
    const pool = needle !== '' || activeTab === 'all' ? catalog.all : catalog[activeTab];
    if (needle === '') return pool;
    return pool.filter((option) => {
      const hay = `${option.label} ${option.value} ${option.hint ?? ''} ${option.keywords ?? ''}`.toLocaleLowerCase();
      return hay.includes(needle);
    });
  }, [activeTab, catalog, needle]);

  const showCustomProfile =
    trimmedQuery !== '' &&
    (activeTab === 'all' || activeTab === 'profile') &&
    !catalog.profile.some((option) => option.value === trimmedQuery);

  const facetLabel = (facet: UsageFacetKind) => t(`usage.filter.facet.${facet}`);

  const chips = useMemo(() => {
    const list: Array<{
      readonly key: string;
      readonly facet?: UsageFacetKind;
      readonly label: string;
      readonly valueText: string;
      readonly title: string;
      readonly clear: () => void;
    }> = [];

    const summarize = (facet: UsageFacetKind, values: readonly string[], clear: () => void) => {
      if (values.length === 0) return;
      const firstLabel = labelLookup.get(`${facet}:${values[0]!}`) ?? values[0]!;
      const valueText =
        values.length === 1
          ? firstLabel
          : t('select.summaryMore', { first: firstLabel, count: values.length - 1 });
      const joinedValues = values
        .map((val) => labelLookup.get(`${facet}:${val}`) ?? val)
        .join(locale === 'zh' ? '、' : ', ');
      const title = t(`usage.filter.${facet}Chip`, { value: joinedValues });
      list.push({
        key: facet,
        facet,
        label: t(`usage.filter.facet.${facet}`),
        valueText,
        title,
        clear,
      });
    };

    summarize('model', filters.models, () => { onChange({ ...filters, models: [] }); });
    summarize('provider', filters.providers, () => { onChange({ ...filters, providers: [] }); });
    summarize('profile', filters.profiles, () => { onChange({ ...filters, profiles: [] }); });
    summarize('workspace', filters.workspaceIds, () => { onChange({ ...filters, workspaceIds: [] }); });

    if (!filters.includeArchived) {
      list.push({
        key: 'archived',
        label: t('usage.filter.archivedLabel'),
        valueText: t('usage.filter.archivedValue'),
        title: t('usage.filter.archivedChip'),
        clear: () => { onChange({ ...filters, includeArchived: true }); },
      });
    }
    return list;
  }, [filters, labelLookup, locale, onChange, t]);

  const changeRange = (range: UsageRangePreset) => {
    setRangeInvalid(false);
    if (range === 'custom') {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      onChange({
        ...filters,
        range,
        startAt: filters.startAt ?? start.getTime(),
        endAt: filters.endAt ?? end.getTime(),
      });
    } else {
      onChange({ ...filters, range, startAt: undefined, endAt: undefined });
    }
  };

  const facetTabs: readonly { readonly id: PopoverFacetTab; readonly label: string; readonly count: number }[] = [
    { id: 'all', label: t('usage.filter.allFacets'), count: activeScopeCount },
    { id: 'model', label: facetLabel('model'), count: filters.models.length },
    { id: 'provider', label: facetLabel('provider'), count: filters.providers.length },
    { id: 'profile', label: facetLabel('profile'), count: filters.profiles.length },
    { id: 'workspace', label: facetLabel('workspace'), count: filters.workspaceIds.length },
  ];

  const totalOptions = visibleOptions.length + (showCustomProfile ? 1 : 0);
  const clampedIndex = totalOptions === 0 ? -1 : Math.min(activeIndex, totalOptions - 1);

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    const drivesListbox =
      target !== null &&
      (target.hasAttribute('data-usage-filter-search') ||
        target.getAttribute('role') === 'dialog' ||
        target.closest('[role="listbox"]') !== null);
    if (!drivesListbox || totalOptions === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = (clampedIndex + 1) % totalOptions;
      setActiveIndex(next);
      optionRefs.current[next]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (clampedIndex - 1 + totalOptions) % totalOptions;
      setActiveIndex(next);
      optionRefs.current[next]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      optionRefs.current[0]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const last = totalOptions - 1;
      setActiveIndex(last);
      optionRefs.current[last]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && clampedIndex >= 0) {
      event.preventDefault();
      if (clampedIndex < visibleOptions.length) {
        const option = visibleOptions[clampedIndex]!;
        toggleOption(option.facet, option.value);
      } else if (showCustomProfile) {
        toggleOption('profile', trimmedQuery);
        setQuery('');
        setActiveIndex(0);
      }
    }
  };

  const composerBody = (
    <div
      className="flex max-h-[min(23rem,calc(100vh-8rem))] min-h-0 flex-col"
      onKeyDown={phone ? undefined : handleComposerKeyDown}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-2.5 pb-2">
        <Icon name="search" size={14} className="text-ink-faint" />
        <input
          type="text"
          data-autofocus
          data-usage-filter-search
          aria-activedescendant={clampedIndex >= 0 ? `${composerId}-opt-${clampedIndex}` : undefined}
          value={query}
          placeholder={t('usage.filter.searchPlaceholder')}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
        {query !== '' ? (
          <button
            type="button"
            aria-label={t('usage.filter.clearSearch')}
            onClick={() => {
              setQuery('');
              setActiveIndex(0);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-faint hover:text-ink"
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>

      {needle === '' ? (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-hairline px-2 py-1.5" role="group" aria-label={t('usage.filter.open')}>
          {facetTabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={active}
                data-usage-filter-tab={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  setActiveIndex(0);
                }}
                className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[11.5px] transition-colors ${
                  active ? 'bg-selected font-medium text-selected-ink' : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                }`}
              >
                <span>{tab.label}</span>
                {tab.count > 0 ? <span className="tabular-nums opacity-75">{tab.count}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-multiselectable="true">
        {visibleOptions.length === 0 && !showCustomProfile ? (
          <p className="px-3 py-5 text-center text-[12px] text-ink-faint">
            {trimmedQuery === '' ? t('select.empty') : t('select.noMatches', { query: trimmedQuery })}
          </p>
        ) : (
          <>
            {visibleOptions.map((option, index) => {
              const checked = isSelected(option.facet, option.value);
              const highlighted = index === clampedIndex;
              return (
                <button
                  key={`${option.facet}:${option.value}`}
                  id={`${composerId}-opt-${index}`}
                  ref={(el) => { optionRefs.current[index] = el; }}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  data-usage-facet-option={`${option.facet}:${option.value}`}
                  onMouseEnter={() => { setActiveIndex(index); }}
                  onClick={() => { toggleOption(option.facet, option.value); }}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors pointer-coarse:min-h-11 ${
                    highlighted ? 'bg-ink/[0.06]' : checked ? 'bg-ink/[0.03]' : 'hover:bg-ink/[0.04]'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                      checked ? 'border-ink bg-ink text-paper' : 'border-hairline-strong bg-paper text-transparent'
                    }`}
                  >
                    <Icon name="check" size={12} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${checked ? 'font-medium text-ink' : 'text-ink'}`}>
                      {option.label}
                    </span>
                    {option.hint !== undefined ? (
                      <span className="block truncate font-mono text-[10.5px] text-ink-faint">
                        {option.hint}
                      </span>
                    ) : null}
                  </span>
                  {(needle !== '' || activeTab === 'all') ? (
                    <span className="shrink-0 rounded bg-ink/[0.04] px-1.5 py-px text-[10.5px] text-ink-faint">
                      {facetLabel(option.facet)}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {showCustomProfile ? (
              <button
                id={`${composerId}-opt-${visibleOptions.length}`}
                ref={(el) => { optionRefs.current[visibleOptions.length] = el; }}
                type="button"
                role="option"
                aria-selected={isSelected('profile', trimmedQuery)}
                data-usage-facet-custom-profile={trimmedQuery}
                onMouseEnter={() => { setActiveIndex(visibleOptions.length); }}
                onClick={() => {
                  toggleOption('profile', trimmedQuery);
                  setQuery('');
                  setActiveIndex(0);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[12px] text-ink transition-colors pointer-coarse:min-h-11 ${
                  clampedIndex === visibleOptions.length ? 'bg-ink/[0.06]' : 'hover:bg-ink/[0.04]'
                }`}
              >
                <Icon name="plus" size={12} className="text-ink-faint" />
                <span className="min-w-0 truncate">
                  {t('usage.filter.addCustomProfile', { value: trimmedQuery })}
                </span>
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-hairline px-2.5 pt-2">
        <Toggle
          label={t('usage.includeArchived')}
          checked={filters.includeArchived}
          onChange={(includeArchived) => { onChange({ ...filters, includeArchived }); }}
        />
        {activeScopeCount > 0 ? (
          <button
            type="button"
            onClick={() => { onChange(clearScopeFilters(filters)); }}
            className="text-[12px] text-ink-soft transition-colors hover:text-ink"
          >
            {t('usage.filter.clearAll')}
          </button>
        ) : null}
      </div>
    </div>
  );

  const dateInput = 'h-8 rounded-md border border-hairline bg-paper px-2 text-[12.5px] text-ink tabular-nums outline-none focus:border-selected-ink aria-[invalid=true]:border-danger pointer-coarse:min-h-11';

  return (
    <div data-anchor="usage-filter" data-usage-filters className="space-y-2 border-b border-hairline pt-1 pb-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {phone ? (
          <label className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[13px] text-ink">{t('usage.axis.range')}</span>
            <span className="min-w-0 max-w-44">
              <SettingsSelect<UsageRangePreset>
                ariaLabel={t('usage.axis.range')}
                value={filters.range}
                dataAttr="data-usage-range-select"
                onChange={changeRange}
                choices={USAGE_RANGE_PRESETS.map((option) => ({ value: option, label: t(`usage.range.${option}`) }))}
              />
            </span>
          </label>
        ) : (
          <AxisGroup
            label={t('usage.axis.range')}
            dataAxis="range"
            options={USAGE_RANGE_PRESETS}
            value={filters.range}
            onChange={changeRange}
            labelFor={(option) => t(`usage.range.${option}`)}
          />
        )}

        {filters.range === 'custom' ? (
          <div className="flex flex-wrap items-center gap-1.5" data-usage-custom-range>
            <input
              type="date"
              aria-label={t('usage.customRange.start')}
              aria-invalid={rangeInvalid}
              value={toDateInputValue(filters.startAt)}
              max={toInclusiveEndDateInputValue(filters.endAt)}
              onChange={(event) => {
                const startAt = fromDateInputStart(event.target.value);
                if (startAt === undefined) return;
                if (filters.endAt !== undefined && startAt >= filters.endAt) {
                  setRangeInvalid(true);
                  return;
                }
                setRangeInvalid(false);
                onChange({ ...filters, startAt });
              }}
              className={dateInput}
            />
            <Icon name="arrowRight" size={12} className="text-ink-faint" />
            <input
              type="date"
              aria-label={t('usage.customRange.end')}
              aria-invalid={rangeInvalid}
              value={toInclusiveEndDateInputValue(filters.endAt)}
              min={toDateInputValue(filters.startAt)}
              onChange={(event) => {
                const endAt = fromDateInputExclusiveEnd(event.target.value);
                if (endAt === undefined) return;
                if (filters.startAt !== undefined && endAt <= filters.startAt) {
                  setRangeInvalid(true);
                  return;
                }
                setRangeInvalid(false);
                onChange({ ...filters, endAt });
              }}
              className={dateInput}
            />
            {rangeInvalid ? (
              <p role="alert" data-usage-range-error className="text-[12px] text-danger">
                {t('usage.customRange.invalid')}
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          ref={addFilterRef}
          type="button"
          data-usage-add-filter
          aria-haspopup="dialog"
          aria-expanded={composerOpen}
          aria-controls={composerOpen ? composerId : undefined}
          onClick={() => {
            if (composerOpen) closeComposer();
            else openFacetPopover('all', addFilterRef.current);
          }}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 ${
            activeScopeCount > 0
              ? 'border-selected-ink/40 bg-panel font-medium text-ink'
              : 'border-hairline bg-paper text-ink-soft hover:border-hairline-strong hover:text-ink'
          }`}
        >
          <Icon name="plus" size={12} />
          <span>{t('usage.filter.add')}</span>
          {activeScopeCount > 0 ? (
            <span className="rounded-full bg-selected px-1.5 text-[11px] text-selected-ink tabular-nums">
              {activeScopeCount}
            </span>
          ) : null}
        </button>

        <div className="flex w-full max-w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:ml-auto sm:w-auto sm:shrink-0 sm:justify-end">
          <span
            data-usage-compare-wrap
            title={compareAvailable ? undefined : t('usage.compare.unavailable')}
            className="inline-flex min-h-8 items-center gap-1.5 text-[12.5px] text-ink-soft pointer-coarse:min-h-11"
          >
            <Toggle
              layout="bare"
              label={t('usage.compare.enable')}
              checked={comparing}
              disabled={!compareAvailable}
              onChange={onCompareChange}
              dataAttr="data-usage-compare"
            />
            <span className={!compareAvailable ? 'text-ink-faint' : undefined}>
              {t('usage.compare.short')}
            </span>
          </span>
          <div className="flex items-center gap-2">
            {reliabilitySlot}
            {utilitySlot}
          </div>
        </div>
      </div>

      {chips.length > 0 ? (
        <ul data-usage-filter-chips className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {chips.map((chip) => (
            <li key={chip.key} className="inline-flex items-center">
              <div
                data-usage-filter-chip={chip.key}
                title={chip.title}
                className="inline-flex h-7 items-center overflow-hidden rounded-full border border-selected-ink/35 bg-panel text-[12px] text-ink"
              >
                <button
                  ref={(el) => { chipTriggerRefs.current[chip.key] = el; }}
                  type="button"
                  title={chip.title}
                  onClick={() => {
                    if (chip.facet !== undefined) openFacetPopover(chip.facet, chipTriggerRefs.current[chip.key]);
                    else chip.clear();
                  }}
                  className={`inline-flex h-full items-center pr-1.5 pl-2.5 transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-selected-ink ${
                    locale === 'zh' ? '' : 'gap-1'
                  }`}
                >
                  <span className="text-ink-faint">{locale === 'zh' ? `${chip.label}：` : `${chip.label}:`}</span>
                  <span className="max-w-44 truncate font-medium text-ink">{chip.valueText}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${t('usage.filter.clearAll')} ${chip.label}`}
                  onClick={chip.clear}
                  className="inline-flex h-full items-center border-l border-hairline px-1.5 text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            </li>
          ))}
          <li>
            <button
              type="button"
              data-usage-clear-filters
              onClick={() => { onChange(clearScopeFilters(filters)); }}
              className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {t('usage.filter.clearAll')}
            </button>
          </li>
        </ul>
      ) : null}

      {phone && composerOpen ? (
        <ActionSheet
          id={composerId}
          role="dialog"
          ariaLabel={t('usage.filter.open')}
          overlayId={composerId}
          onClose={closeComposer}
          dataAttribute="data-usage-filter-popover"
          autofocus={false}
          returnFocusRef={addFilterRef}
          onKeyDown={handleComposerKeyDown}
          sheetClassName="flex flex-col overflow-hidden p-3"
        >
          {composerBody}
        </ActionSheet>
      ) : (
        <AnchoredPopover
          id={composerId}
          open={composerOpen}
          onClose={closeComposer}
          anchorRef={activeTriggerRef}
          label={t('usage.filter.open')}
          widthClassName="w-[22rem]"
          className="!overflow-hidden flex flex-col"
          data={{ 'data-usage-filter-popover': '' }}
        >
          {composerBody}
        </AnchoredPopover>
      )}
    </div>
  );
}
