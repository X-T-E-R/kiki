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
import { formatCostUsd } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { usePhoneMode } from '../../lib/layoutHooks';
import {
  derivedGranularityForRange,
  totalTokensOf,
  USAGE_SOURCE_KEY_UNKNOWN,
  type UsageRangePreset,
  type UsageResponseWire,
} from '../../lib/usageV2';
import { useConnection } from '../../state/connection';
import { Toggle } from '../controls';
import { DisclosureChevron, Icon, type IconName } from '../icons';
import { ActionSheet } from '../overlays/ActionSheet';
import { AnchoredPopover } from '../overlays/AnchoredPopover';
import {
  CalendarIcon,
  formatCompactDateRange,
  nextLocalDayStart,
  startOfLocalDay,
  UsageCalendarPopover,
} from './UsageCalendarPopover';
import {
  buildFacetCatalog,
  clearScopeFilters,
  countActiveScopeFilters,
  toggleFacetValue,
  type FacetOption,
  type NamedProfileSummary,
  type UsageFacetKind,
  type UsageMultiFilters,
} from './usageFilterModel';

const FACET_ORDER: readonly UsageFacetKind[] = ['model', 'provider', 'workspace', 'profile'];

const FACET_ICON: Record<UsageFacetKind, IconName> = {
  model: 'usage',
  provider: 'web',
  workspace: 'folder',
  profile: 'agent',
};

const QUICK_RANGE_PRESETS: readonly ('last_24_hours' | 'last_7_days' | 'last_30_days' | 'all')[] = [
  'last_24_hours',
  'last_7_days',
  'last_30_days',
  'all',
];

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

interface FacetMetric {
  costUsd: number;
  tokens: number;
}

interface FacetSignals {
  readonly metrics: ReadonlyMap<string, Readonly<FacetMetric>>;
  readonly completeFacets: ReadonlySet<UsageFacetKind>;
  readonly workspaceActivity: ReadonlyMap<string, { hits: number; latestAt: number }>;
}

function computeFacetSignals(
  response: UsageResponseWire | undefined,
  modelResponse: UsageResponseWire | undefined,
): FacetSignals {
  const metrics = new Map<string, FacetMetric>();
  const completeFacets = new Set<UsageFacetKind>();
  const workspaceActivity = new Map<string, { hits: number; latestAt: number }>();

  const add = (facet: UsageFacetKind, value: string | null | undefined, cost: number, tokens: number) => {
    if (!value || value === 'unknown' || value === USAGE_SOURCE_KEY_UNKNOWN) return;
    const key = `${facet}:${value}`;
    const prev = metrics.get(key);
    if (prev !== undefined) {
      prev.costUsd += cost;
      prev.tokens += tokens;
    } else {
      metrics.set(key, { costUsd: cost, tokens });
    }
  };

  // Model attribution prefers dedicated modelResponse when groupBy !== 'model'
  const modelSrc = modelResponse ?? response;
  if (modelSrc !== undefined) {
    if (modelSrc.query.dimension === 'model') completeFacets.add('model');
    for (const bucket of modelSrc.trend) {
      for (const group of bucket.groups) {
        const modelKey =
          group.model_alias ??
          (modelSrc.query.dimension === 'model' &&
          !group.key.startsWith('provider:') &&
          !group.key.startsWith('profile:')
            ? group.key
            : null);
        add('model', modelKey, group.cost_usd_estimated, totalTokensOf(group));
      }
    }
  }

  if (response !== undefined) {
    const dim = response.query.dimension;
    if (dim === 'provider') completeFacets.add('provider');
    if (dim === 'profile') completeFacets.add('profile');
    if (dim === 'project') completeFacets.add('workspace');

    let sawProvider = false;
    let sawProfile = false;
    for (const bucket of response.trend) {
      for (const group of bucket.groups) {
        const tokens = totalTokensOf(group);
        const providerKey =
          group.provider ??
          (dim === 'provider' && group.key.startsWith('provider:')
            ? group.key.slice('provider:'.length)
            : dim === 'provider'
              ? group.key
              : null);
        if (providerKey) sawProvider = true;
        add('provider', providerKey, group.cost_usd_estimated, tokens);

        const profileKey =
          group.profile_name ??
          (dim === 'profile' && group.key.startsWith('profile:')
            ? group.key.slice('profile:'.length)
            : dim === 'profile'
              ? group.key
              : null);
        if (profileKey) sawProfile = true;
        add('profile', profileKey, group.cost_usd_estimated, tokens);

        if (dim === 'project' && group.key !== 'unknown') {
          add('workspace', group.key, group.cost_usd_estimated, tokens);
        }
      }
    }

    if (sawProvider) completeFacets.add('provider');
    if (sawProfile) completeFacets.add('profile');

    // When dimension !== 'project', response.sessions.items is only a partial page (first 25 sessions).
    // Never fabricate partial $ totals or fold remaining workspaces into "unused"; only float recently active ones.
    if (dim !== 'project') {
      for (const session of response.sessions.items) {
        if (!session.workspace_id) continue;
        const prev = workspaceActivity.get(session.workspace_id);
        const ts = session.updated_at ?? session.created_at ?? 0;
        if (prev !== undefined) {
          prev.hits += 1;
          if (ts > prev.latestAt) prev.latestAt = ts;
        } else {
          workspaceActivity.set(session.workspace_id, { hits: 1, latestAt: ts });
        }
      }
    }
  }

  return { metrics, completeFacets, workspaceActivity };
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
  drilldownBack,
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
  readonly drilldownBack?: { readonly label: string; readonly onBack: () => void };
  readonly reliabilitySlot?: ReactNode;
  readonly utilitySlot?: ReactNode;
}) {
  const { t, time, locale } = useI18n();
  const { scopeId } = useConnection();
  const phone = usePhoneMode();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedFacet, setSelectedFacet] = useState<UsageFacetKind | null>(null);
  const [unusedOpen, setUnusedOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const calendarTriggerRef = useRef<HTMLButtonElement>(null);
  const addFilterRef = useRef<HTMLButtonElement>(null);
  const activeTriggerRef = useRef<HTMLElement | null>(null);
  const chipTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const calendarId = `usage-calendar-${useId().replace(/:/g, '')}`;
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

  const { metrics: facetMetrics, completeFacets, workspaceActivity } = useMemo(
    () => computeFacetSignals(response, modelResponse),
    [response, modelResponse],
  );

  const labelLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of catalog.all) {
      map.set(`${option.facet}:${option.value}`, option.label);
    }
    return map;
  }, [catalog.all]);

  const activeScopeCount = countActiveScopeFilters(filters);

  const openFacetPopover = (facet: UsageFacetKind | null, trigger?: HTMLElement | null) => {
    activeTriggerRef.current = trigger ?? addFilterRef.current;
    setSelectedFacet(facet);
    setUnusedOpen(false);
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
    setUnusedOpen(false);
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

  const selectedCountForFacet = (facet: UsageFacetKind): number => {
    switch (facet) {
      case 'workspace':
        return filters.workspaceIds.length;
      case 'model':
        return filters.models.length;
      case 'provider':
        return filters.providers.length;
      case 'profile':
        return filters.profiles.length;
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
  const isCategoryStage = selectedFacet === null && needle === '';

  const { primaryOptions, unusedOptions } = useMemo(() => {
    if (isCategoryStage) {
      return { primaryOptions: [] as readonly FacetOption[], unusedOptions: [] as readonly FacetOption[] };
    }
    const basePool = selectedFacet !== null ? catalog[selectedFacet] : catalog.all;
    const filtered = needle === ''
      ? basePool
      : basePool.filter((option) => {
          const hay = `${option.label} ${option.value} ${option.hint ?? ''} ${option.keywords ?? ''}`.toLocaleLowerCase();
          return hay.includes(needle);
        });

    const rankOption = (a: FacetOption, b: FacetOption) => {
      const aComplete = completeFacets.has(a.facet);
      const bComplete = completeFacets.has(b.facet);
      const mA = aComplete ? facetMetrics.get(`${a.facet}:${a.value}`) : undefined;
      const mB = bComplete ? facetMetrics.get(`${b.facet}:${b.value}`) : undefined;
      const usedA = (mA?.costUsd ?? 0) > 0 || (mA?.tokens ?? 0) > 0 ? 1 : 0;
      const usedB = (mB?.costUsd ?? 0) > 0 || (mB?.tokens ?? 0) > 0 ? 1 : 0;
      if (usedA !== usedB) return usedB - usedA;
      const costDiff = (mB?.costUsd ?? 0) - (mA?.costUsd ?? 0);
      if (Math.abs(costDiff) > 1e-9) return costDiff;
      const tokDiff = (mB?.tokens ?? 0) - (mA?.tokens ?? 0);
      if (tokDiff !== 0) return tokDiff;
      if (a.facet === 'workspace' && b.facet === 'workspace' && !aComplete) {
        const wA = workspaceActivity.get(a.value);
        const wB = workspaceActivity.get(b.value);
        const hitsDiff = (wB?.hits ?? 0) - (wA?.hits ?? 0);
        if (hitsDiff !== 0) return hitsDiff;
        const tsDiff = (wB?.latestAt ?? 0) - (wA?.latestAt ?? 0);
        if (tsDiff !== 0) return tsDiff;
      }
      return a.label.localeCompare(b.label);
    };

    const sorted = [...filtered].sort(rankOption);
    if (needle !== '' || selectedFacet === null || !completeFacets.has(selectedFacet)) {
      return { primaryOptions: sorted, unusedOptions: [] as readonly FacetOption[] };
    }

    const withActivity: FacetOption[] = [];
    const idle: FacetOption[] = [];
    for (const opt of sorted) {
      const m = facetMetrics.get(`${opt.facet}:${opt.value}`);
      const hasUsage = (m?.costUsd ?? 0) > 0 || (m?.tokens ?? 0) > 0;
      const checked =
        (opt.facet === 'workspace' && filters.workspaceIds.includes(opt.value)) ||
        (opt.facet === 'model' && filters.models.includes(opt.value)) ||
        (opt.facet === 'provider' && filters.providers.includes(opt.value)) ||
        (opt.facet === 'profile' && filters.profiles.includes(opt.value));
      if (hasUsage || checked) withActivity.push(opt);
      else idle.push(opt);
    }

    // If nothing in this facet has recorded usage yet, show all options directly rather than hiding everything.
    if (withActivity.length === 0) {
      return { primaryOptions: idle, unusedOptions: [] as readonly FacetOption[] };
    }
    return { primaryOptions: withActivity, unusedOptions: idle };
  }, [catalog, completeFacets, facetMetrics, filters, isCategoryStage, needle, selectedFacet, workspaceActivity]);

  const displayedOptions = useMemo(
    () => (unusedOpen ? [...primaryOptions, ...unusedOptions] : primaryOptions),
    [primaryOptions, unusedOpen, unusedOptions],
  );

  const showCustomProfile =
    trimmedQuery !== '' &&
    (selectedFacet === null || selectedFacet === 'profile') &&
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
    summarize('workspace', filters.workspaceIds, () => { onChange({ ...filters, workspaceIds: [] }); });
    summarize('profile', filters.profiles, () => { onChange({ ...filters, profiles: [] }); });

    return list;
  }, [filters, labelLookup, locale, onChange, t]);

  const selectPresetRange = (range: UsageRangePreset) => {
    if (range === 'custom') {
      const today = startOfLocalDay(Date.now());
      const defaultStart = today - 6 * 86_400_000;
      const nextStart = filters.startAt ?? defaultStart;
      const nextEnd = filters.endAt ?? nextLocalDayStart(today);
      onChange({
        ...filters,
        range: 'custom',
        granularity: derivedGranularityForRange('custom', nextStart, nextEnd),
        startAt: nextStart,
        endAt: nextEnd,
      });
      return;
    }
    onChange({
      ...filters,
      range,
      granularity: derivedGranularityForRange(range),
      startAt: undefined,
      endAt: undefined,
    });
  };

  const navItemCount = isCategoryStage
    ? FACET_ORDER.length
    : displayedOptions.length + (showCustomProfile ? 1 : 0);
  const clampedIndex = navItemCount === 0 ? -1 : Math.min(activeIndex, navItemCount - 1);

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    const drivesListbox =
      target !== null &&
      (target.hasAttribute('data-usage-filter-search') ||
        target.getAttribute('role') === 'dialog' ||
        target.closest('[role="listbox"]') !== null);
    if (!drivesListbox) return;

    if (
      (event.key === 'Backspace' || event.key === 'ArrowLeft') &&
      query === '' &&
      selectedFacet !== null
    ) {
      event.preventDefault();
      const idx = FACET_ORDER.indexOf(selectedFacet);
      setSelectedFacet(null);
      setUnusedOpen(false);
      setActiveIndex(Math.max(0, idx));
      return;
    }

    if (navItemCount === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = (clampedIndex + 1) % navItemCount;
      setActiveIndex(next);
      optionRefs.current[next]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (clampedIndex - 1 + navItemCount) % navItemCount;
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
      const last = navItemCount - 1;
      setActiveIndex(last);
      optionRefs.current[last]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if ((event.key === 'Enter' || (event.key === 'ArrowRight' && isCategoryStage)) && clampedIndex >= 0) {
      event.preventDefault();
      if (isCategoryStage) {
        const facet = FACET_ORDER[clampedIndex];
        if (facet !== undefined) {
          setSelectedFacet(facet);
          setUnusedOpen(false);
          setActiveIndex(0);
        }
        return;
      }
      if (clampedIndex < displayedOptions.length) {
        const option = displayedOptions[clampedIndex]!;
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
        {selectedFacet !== null && needle === '' ? (
          <button
            type="button"
            data-usage-filter-back
            aria-label={t('usage.filter.back')}
            onClick={() => {
              const idx = FACET_ORDER.indexOf(selectedFacet);
              setSelectedFacet(null);
              setUnusedOpen(false);
              setActiveIndex(Math.max(0, idx));
            }}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink"
          >
            <Icon name="arrowLeft" size={12} />
            <span>{facetLabel(selectedFacet)}</span>
          </button>
        ) : (
          <Icon name="search" size={14} className="shrink-0 text-ink-faint" />
        )}
        <input
          type="text"
          data-autofocus
          data-usage-filter-search
          aria-activedescendant={clampedIndex >= 0 ? `${composerId}-opt-${clampedIndex}` : undefined}
          value={query}
          placeholder={selectedFacet !== null ? t('usage.filter.searchShort') : t('usage.filter.searchPlaceholder')}
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

      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-multiselectable={!isCategoryStage}>
        {isCategoryStage ? (
          FACET_ORDER.map((facet, idx) => {
            const selectedCount = selectedCountForFacet(facet);
            const activeUsedCount = completeFacets.has(facet)
              ? catalog[facet].filter((opt) => {
                  const m = facetMetrics.get(`${facet}:${opt.value}`);
                  return (m?.costUsd ?? 0) > 0 || (m?.tokens ?? 0) > 0;
                }).length
              : 0;
            const highlighted = idx === clampedIndex;

            return (
              <button
                key={facet}
                id={`${composerId}-opt-${idx}`}
                ref={(el) => { optionRefs.current[idx] = el; }}
                type="button"
                role="option"
                aria-selected={selectedCount > 0}
                data-usage-filter-category={facet}
                onMouseEnter={() => { setActiveIndex(idx); }}
                onClick={() => {
                  setSelectedFacet(facet);
                  setUnusedOpen(false);
                  setActiveIndex(0);
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors pointer-coarse:min-h-11 ${
                  highlighted ? 'bg-ink/[0.06]' : 'hover:bg-ink/[0.04]'
                }`}
              >
                <Icon name={FACET_ICON[facet]} size={14} className="shrink-0 text-ink-soft" />
                <span className="min-w-0 flex-1 font-medium text-ink">{facetLabel(facet)}</span>
                {selectedCount > 0 ? (
                  <span className="rounded-full bg-selected px-1.5 py-px text-[11px] font-medium text-selected-ink tabular-nums">
                    {selectedCount}
                  </span>
                ) : activeUsedCount > 0 ? (
                  <span className="text-[11.5px] text-ink-faint tabular-nums">{activeUsedCount}</span>
                ) : null}
                <DisclosureChevron open={false} className="text-ink-faint" />
              </button>
            );
          })
        ) : displayedOptions.length === 0 && !showCustomProfile ? (
          <p className="px-3 py-5 text-center text-[12px] text-ink-faint">
            {trimmedQuery === '' ? t('select.empty') : t('select.noMatches', { query: trimmedQuery })}
          </p>
        ) : (
          <>
            {(() => {
              const renderOptionButton = (option: FacetOption, index: number) => {
                const checked = isSelected(option.facet, option.value);
                const highlighted = index === clampedIndex;
                const usage = completeFacets.has(option.facet)
                  ? facetMetrics.get(`${option.facet}:${option.value}`)
                  : undefined;
                const usageText =
                  usage !== undefined && usage.costUsd > 0
                    ? formatCostUsd(usage.costUsd)
                    : usage !== undefined && usage.tokens > 0
                      ? time.formatTokens(usage.tokens)
                      : undefined;

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
                      {option.hint !== undefined && option.hint !== option.label ? (
                        <span className="block truncate font-mono text-[10.5px] text-ink-faint">
                          {option.hint}
                        </span>
                      ) : null}
                    </span>
                    {selectedFacet === null ? (
                      <span className="shrink-0 rounded bg-ink/[0.04] px-1.5 py-px text-[10.5px] text-ink-faint">
                        {facetLabel(option.facet)}
                      </span>
                    ) : null}
                    {usageText !== undefined ? (
                      <span className="shrink-0 text-[11.5px] text-ink-soft tabular-nums">
                        {usageText}
                      </span>
                    ) : null}
                  </button>
                );
              };

              return (
                <>
                  {primaryOptions.map((option, index) => renderOptionButton(option, index))}

                  {unusedOptions.length > 0 && needle === '' ? (
                    <button
                      type="button"
                      data-usage-filter-unused-toggle
                      aria-expanded={unusedOpen}
                      onClick={() => { setUnusedOpen((prev) => !prev); }}
                      className="mt-1 flex w-full items-center gap-1.5 border-t border-hairline/70 px-2.5 pt-2 pb-1 text-left text-[11.5px] text-ink-faint transition-colors hover:text-ink"
                    >
                      <DisclosureChevron open={unusedOpen} />
                      <span>{t('usage.filter.unusedInPeriod', { count: unusedOptions.length })}</span>
                    </button>
                  ) : null}

                  {unusedOpen && needle === ''
                    ? unusedOptions.map((option, offset) => renderOptionButton(option, primaryOptions.length + offset))
                    : null}
                </>
              );
            })()}

            {showCustomProfile ? (
              <button
                id={`${composerId}-opt-${displayedOptions.length}`}
                ref={(el) => { optionRefs.current[displayedOptions.length] = el; }}
                type="button"
                role="option"
                aria-selected={isSelected('profile', trimmedQuery)}
                data-usage-facet-custom-profile={trimmedQuery}
                onMouseEnter={() => { setActiveIndex(displayedOptions.length); }}
                onClick={() => {
                  toggleOption('profile', trimmedQuery);
                  setQuery('');
                  setActiveIndex(0);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[12px] text-ink transition-colors pointer-coarse:min-h-11 ${
                  clampedIndex === displayedOptions.length ? 'bg-ink/[0.06]' : 'hover:bg-ink/[0.04]'
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
        <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft">
          <Toggle
            layout="bare"
            label={t('usage.includeArchived')}
            checked={filters.includeArchived}
            onChange={(includeArchived) => { onChange({ ...filters, includeArchived }); }}
          />
          <span>{t('usage.includeArchived')}</span>
        </span>
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

  const isCalendarPreset =
    filters.range === 'today' ||
    filters.range === 'this_week' ||
    filters.range === 'this_month';
  const customRangeLabel =
    filters.range === 'custom'
      ? (formatCompactDateRange(filters.startAt, filters.endAt, locale) ?? t('usage.range.custom'))
      : isCalendarPreset
        ? t(`usage.rangeShort.${filters.range}`)
        : t('usage.range.custom');
  const isCustomOrCalendarPreset = filters.range === 'custom' || isCalendarPreset;

  return (
    <div data-anchor="usage-filter" data-usage-filters className="space-y-2 pt-0.5">
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        {drilldownBack !== undefined ? (
          <button
            type="button"
            data-usage-drilldown-back
            onClick={drilldownBack.onBack}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-hairline bg-paper px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:border-hairline-strong hover:bg-ink/[0.03] focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          >
            <Icon name="arrowLeft" size={12} />
            <span>{drilldownBack.label}</span>
          </button>
        ) : null}
        <div
          role="group"
          aria-label={t('usage.axis.range')}
          data-axis="range"
          className="inline-flex max-w-full flex-wrap items-center rounded-lg border border-hairline bg-panel/60 p-0.5"
        >
          {QUICK_RANGE_PRESETS.map((preset) => {
            const active = filters.range === preset;
            return (
              <button
                key={preset}
                type="button"
                data-axis-value={preset}
                aria-pressed={active}
                onClick={() => { selectPresetRange(preset); }}
                className={`inline-flex h-7 items-center justify-center rounded-md px-2 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink sm:px-2.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
                  active
                    ? 'bg-paper font-medium text-ink shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06)]'
                    : 'text-ink-soft hover:text-ink'
                }`}
              >
                {t(`usage.rangeShort.${preset}`)}
              </button>
            );
          })}

          <span aria-hidden className="mx-0.5 h-4 w-px bg-hairline" />

          <button
            ref={calendarTriggerRef}
            type="button"
            data-axis-value="custom"
            data-usage-custom-range-trigger
            aria-label={customRangeLabel}
            aria-haspopup="dialog"
            aria-expanded={calendarOpen}
            aria-pressed={isCustomOrCalendarPreset}
            onClick={() => { setCalendarOpen((open) => !open); }}
            className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-[12.5px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink sm:px-2.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
              isCustomOrCalendarPreset
                ? 'bg-paper font-medium text-ink shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06)]'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className={isCustomOrCalendarPreset ? undefined : 'hidden sm:inline'}>{customRangeLabel}</span>
            {comparing ? (
              <span className="rounded bg-selected px-1 py-px text-[10.5px] font-medium text-selected-ink">
                {t('usage.compare.short')}
              </span>
            ) : null}
          </button>
        </div>

        <button
          ref={addFilterRef}
          type="button"
          data-usage-add-filter
          aria-haspopup="dialog"
          aria-expanded={composerOpen}
          aria-controls={composerOpen ? composerId : undefined}
          onClick={() => {
            if (composerOpen) closeComposer();
            else openFacetPopover(null, addFilterRef.current);
          }}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink sm:px-2.5 pointer-coarse:min-h-11 ${
            activeScopeCount > 0
              ? 'border-selected-ink/40 bg-panel font-medium text-ink'
              : 'border-hairline bg-paper text-ink-soft hover:border-hairline-strong hover:text-ink'
          }`}
        >
          <Icon name="filter" size={12} />
          <span>{t('usage.filter.add')}</span>
          {activeScopeCount > 0 ? (
            <span className="rounded-full bg-selected px-1.5 text-[11px] text-selected-ink tabular-nums">
              {activeScopeCount}
            </span>
          ) : null}
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          {utilitySlot}
          {reliabilitySlot}
        </div>
      </div>

      {chips.length > 0 || comparing ? (
        <ul data-usage-filter-chips className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <li key={chip.key} className="inline-flex items-center">
              <div
                data-usage-filter-chip={chip.key}
                title={chip.title}
                className="inline-flex h-7 items-center overflow-hidden rounded-md border border-hairline-strong bg-panel text-[12px] text-ink"
              >
                <button
                  ref={(el) => { chipTriggerRefs.current[chip.key] = el; }}
                  type="button"
                  title={chip.title}
                  onClick={() => {
                    if (chip.facet !== undefined) {
                      openFacetPopover(chip.facet, chipTriggerRefs.current[chip.key]);
                    } else {
                      chip.clear();
                    }
                  }}
                  className={`inline-flex h-full items-center pr-2 pl-2.5 transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-selected-ink ${
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

          {comparing ? (
            <li className="inline-flex items-center">
              <div
                data-usage-filter-chip="compare"
                className="inline-flex h-7 items-center overflow-hidden rounded-md border border-hairline-strong bg-panel text-[12px] text-ink"
              >
                <span className="px-2.5 text-ink-soft">{t('usage.compare.enable')}</span>
                <button
                  type="button"
                  aria-label={`${t('usage.filter.clearAll')} ${t('usage.compare.short')}`}
                  onClick={() => { onCompareChange(false); }}
                  className="inline-flex h-full items-center border-l border-hairline px-1.5 text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            </li>
          ) : null}

          {chips.length > 0 ? (
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
          ) : null}
        </ul>
      ) : null}

      <UsageCalendarPopover
        id={calendarId}
        open={calendarOpen}
        phone={phone}
        anchorRef={calendarTriggerRef}
        range={filters.range}
        startAt={filters.startAt}
        endAt={filters.endAt}
        comparing={comparing}
        compareAvailable={compareAvailable}
        onSelectPreset={selectPresetRange}
        onSelectCustomRange={(startAt, endAt) => {
          onChange({
            ...filters,
            range: 'custom',
            granularity: derivedGranularityForRange('custom', startAt, endAt),
            startAt,
            endAt,
          });
        }}
        onCompareChange={onCompareChange}
        onClose={() => { setCalendarOpen(false); }}
      />

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
          widthClassName="w-[21rem]"
          className="!overflow-hidden flex flex-col"
          data={{ 'data-usage-filter-popover': '' }}
        >
          {composerBody}
        </AnchoredPopover>
      )}
    </div>
  );
}
