import type { ModelCatalogItem, WorkspaceCatalogEntry } from '@kiki/protocol';

import {
  derivedGranularityForRange,
  sanitizeGranularity,
  USAGE_FILTER_DEFAULTS,
  USAGE_GROUPINGS,
  USAGE_GROUP_BY_DIMENSION,
  USAGE_RANGE_PRESETS,
  type UsageApiQueryOptions,
  type UsageFilters,
  type UsageGranularity,
  type UsageGroupBy,
  type UsageLegacyDimension,
  type UsageRangePreset,
  type UsageResponseWire,
  type UsageSourceFilter,
} from '../../lib/usageV2';

export { searchHasUsageParams as searchHasUsageMultiParams } from '../../lib/usageV2';

export interface UsageMultiFilters {
  readonly granularity: UsageGranularity;
  readonly range: UsageRangePreset;
  readonly groupBy: UsageGroupBy;
  readonly advancedDimension: UsageLegacyDimension | undefined;
  readonly workspaceIds: readonly string[];
  readonly models: readonly string[];
  readonly providers: readonly string[];
  readonly profiles: readonly string[];
  readonly agentIds: readonly string[];
  readonly includeArchived: boolean;
  readonly startAt: number | undefined;
  readonly endAt: number | undefined;
}

export type UsageFacetKind = 'workspace' | 'model' | 'provider' | 'profile';

export interface FacetOption {
  readonly facet: UsageFacetKind;
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly keywords?: string;
}

export interface FacetCatalog {
  readonly workspace: readonly FacetOption[];
  readonly model: readonly FacetOption[];
  readonly provider: readonly FacetOption[];
  readonly profile: readonly FacetOption[];
  readonly all: readonly FacetOption[];
}

export const USAGE_MULTI_FILTER_DEFAULTS: UsageMultiFilters = {
  granularity: USAGE_FILTER_DEFAULTS.granularity,
  range: USAGE_FILTER_DEFAULTS.range,
  groupBy: USAGE_FILTER_DEFAULTS.groupBy,
  advancedDimension: USAGE_FILTER_DEFAULTS.advancedDimension,
  workspaceIds: [],
  models: [],
  providers: [],
  profiles: [],
  agentIds: [],
  includeArchived: USAGE_FILTER_DEFAULTS.includeArchived,
  startAt: undefined,
  endAt: undefined,
};

function dedupeNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isRangePreset(value: string): value is UsageRangePreset {
  return (USAGE_RANGE_PRESETS as readonly string[]).includes(value);
}

function isGroupBy(value: string): value is UsageGroupBy {
  return (USAGE_GROUPINGS as readonly string[]).includes(value);
}

function parseNonnegativeInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseUsageMultiFilters(search: string): UsageMultiFilters {
  const params = new URLSearchParams(search);
  const granularity = params.get('granularity');
  const range = params.get('range');
  const groupBy = params.get('group_by');
  const dimension = params.get('dimension');
  const archived = params.get('include_archived');
  const parsedRange = range !== null && isRangePreset(range) ? range : USAGE_MULTI_FILTER_DEFAULTS.range;
  const startAt = parseNonnegativeInt(params.get('start_at'));
  const endAt = parseNonnegativeInt(params.get('end_at'));
  const customBoundsValid =
    parsedRange === 'custom' && startAt !== undefined && endAt !== undefined && startAt < endAt;
  const effectiveRange = parsedRange === 'custom' && !customBoundsValid ? USAGE_MULTI_FILTER_DEFAULTS.range : parsedRange;
  const effectiveStartAt = customBoundsValid ? startAt : undefined;
  const effectiveEndAt = customBoundsValid ? endAt : undefined;

  return {
    granularity: sanitizeGranularity(granularity, effectiveRange, effectiveStartAt, effectiveEndAt),
    range: effectiveRange,
    groupBy:
      groupBy !== null && isGroupBy(groupBy)
        ? groupBy
        : dimension === 'project'
          ? 'workspace'
          : dimension !== null && isGroupBy(dimension)
            ? dimension
            : USAGE_MULTI_FILTER_DEFAULTS.groupBy,
    advancedDimension: dimension === 'agent' || dimension === 'session' ? dimension : undefined,
    workspaceIds: dedupeNonEmpty(params.getAll('workspace')),
    models: dedupeNonEmpty(params.getAll('model')),
    providers: dedupeNonEmpty(params.getAll('provider')),
    profiles: dedupeNonEmpty(params.getAll('profile')),
    agentIds: dedupeNonEmpty(params.getAll('agent.id')),
    includeArchived: archived === null ? USAGE_MULTI_FILTER_DEFAULTS.includeArchived : archived === 'true',
    startAt: effectiveStartAt,
    endAt: effectiveEndAt,
  };
}

export function toSingleUsageFilters(filters: UsageMultiFilters): UsageFilters {
  return {
    granularity: filters.granularity,
    range: filters.range,
    groupBy: filters.groupBy,
    advancedDimension: filters.advancedDimension,
    workspaceId: filters.workspaceIds[0],
    model: filters.models[0],
    provider: filters.providers[0],
    profiles: filters.profiles,
    agentIds: filters.agentIds,
    includeArchived: filters.includeArchived,
    startAt: filters.startAt,
    endAt: filters.endAt,
  };
}

export function usageMultiFiltersHaveScope(filters: UsageMultiFilters): boolean {
  return (
    filters.workspaceIds.length > 0 ||
    filters.models.length > 0 ||
    filters.providers.length > 0 ||
    filters.profiles.length > 0 ||
    filters.agentIds.length > 0
  );
}

export function countActiveScopeFilters(filters: UsageMultiFilters): number {
  return (
    filters.workspaceIds.length +
    filters.models.length +
    filters.providers.length +
    filters.profiles.length +
    filters.agentIds.length +
    (filters.includeArchived ? 0 : 1)
  );
}

export function usageMultiFiltersToSearch(filters: UsageMultiFilters, existing?: string): string {
  const params = new URLSearchParams(existing ?? '');
  params.set('panel', 'history');
  for (const key of [
    'granularity',
    'range',
    'group_by',
    'dimension',
    'workspace',
    'model',
    'provider',
    'profile',
    'agent.id',
    'include_archived',
    'start_at',
    'end_at',
  ]) {
    params.delete(key);
  }
  const derivedGranularity = derivedGranularityForRange(filters.range, filters.startAt, filters.endAt);
  const sanitizedGranularity = sanitizeGranularity(filters.granularity, filters.range, filters.startAt, filters.endAt);
  if (sanitizedGranularity !== derivedGranularity) {
    params.set('granularity', sanitizedGranularity);
  }
  if (filters.range !== USAGE_MULTI_FILTER_DEFAULTS.range) {
    params.set('range', filters.range);
  }
  if (filters.advancedDimension !== undefined) {
    params.set('dimension', filters.advancedDimension);
  } else if (filters.groupBy !== USAGE_MULTI_FILTER_DEFAULTS.groupBy) {
    params.set('group_by', filters.groupBy);
  }
  for (const id of filters.workspaceIds) params.append('workspace', id);
  for (const model of filters.models) params.append('model', model);
  for (const provider of filters.providers) params.append('provider', provider);
  for (const profile of filters.profiles) params.append('profile', profile);
  for (const agentId of filters.agentIds) params.append('agent.id', agentId);
  if (filters.includeArchived !== USAGE_MULTI_FILTER_DEFAULTS.includeArchived) {
    params.set('include_archived', String(filters.includeArchived));
  }
  if (filters.range === 'custom' && filters.startAt !== undefined && filters.endAt !== undefined) {
    params.set('start_at', String(filters.startAt));
    params.set('end_at', String(filters.endAt));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

function wireScalarOrArray(values: readonly string[]): string | string[] | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : [...values];
}

export function buildUsageMultiApiQuery(
  filters: UsageMultiFilters,
  options: UsageApiQueryOptions,
): Record<string, string | number | boolean | string[] | undefined> {
  const window = options.window;
  const customWindow = window ?? (
    filters.range === 'custom' && filters.startAt !== undefined && filters.endAt !== undefined
      ? { startAt: filters.startAt, endAt: filters.endAt }
      : undefined
  );
  return {
    granularity: filters.granularity,
    sort_by: options.sortBy,
    range: window !== undefined ? 'custom' : filters.range === 'all' ? undefined : filters.range,
    dimension: filters.advancedDimension ?? USAGE_GROUP_BY_DIMENSION[filters.groupBy],
    'workspace.id': wireScalarOrArray(filters.workspaceIds),
    model: wireScalarOrArray(filters.models),
    provider: wireScalarOrArray(filters.providers),
    profile: filters.profiles.length > 0 ? [...filters.profiles] : undefined,
    'agent.id': filters.agentIds.length > 0 ? [...filters.agentIds] : undefined,
    include_archived: filters.includeArchived ? 'true' : 'false',
    start_at: customWindow?.startAt,
    end_at: customWindow?.endAt,
    timezone_offset_minutes: options.timezoneOffsetMinutes,
    page_size: options.pageSize,
    page_token: options.pageToken,
  };
}

export function toggleFacetValue(list: readonly string[], value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '') return [...list];
  return list.includes(trimmed)
    ? list.filter((entry) => entry !== trimmed)
    : [...list, trimmed];
}

export function clearScopeFilters(filters: UsageMultiFilters): UsageMultiFilters {
  return {
    ...filters,
    workspaceIds: [],
    models: [],
    providers: [],
    profiles: [],
    agentIds: [],
    includeArchived: USAGE_MULTI_FILTER_DEFAULTS.includeArchived,
  };
}

export function isSourceRowFilterActive(
  filters: UsageMultiFilters,
  rowFilter: UsageSourceFilter | null | undefined,
): boolean {
  if (rowFilter === null || rowFilter === undefined) return false;
  switch (rowFilter.field) {
    case 'model':
      return filters.models.includes(rowFilter.value);
    case 'provider':
      return filters.providers.includes(rowFilter.value);
    case 'profile':
      return filters.profiles.includes(rowFilter.value);
    case 'workspace.id':
      return filters.workspaceIds.includes(rowFilter.value);
  }
}

export function toggleSourceRowFilter(
  filters: UsageMultiFilters,
  rowFilter: UsageSourceFilter,
): UsageMultiFilters {
  switch (rowFilter.field) {
    case 'model':
      return { ...filters, models: toggleFacetValue(filters.models, rowFilter.value) };
    case 'provider':
      return { ...filters, providers: toggleFacetValue(filters.providers, rowFilter.value) };
    case 'profile':
      return { ...filters, profiles: toggleFacetValue(filters.profiles, rowFilter.value) };
    case 'workspace.id':
      return { ...filters, workspaceIds: toggleFacetValue(filters.workspaceIds, rowFilter.value) };
  }
}

export interface NamedProfileSummary {
  readonly name: string;
  readonly description?: string | null;
}

export function buildFacetCatalog({
  workspaces,
  models,
  providers,
  namedProfiles = [],
  response,
  filters,
}: {
  readonly workspaces: readonly WorkspaceCatalogEntry[];
  readonly models: readonly ModelCatalogItem[];
  readonly providers: readonly { readonly id: string }[];
  readonly namedProfiles?: readonly NamedProfileSummary[];
  readonly response?: UsageResponseWire;
  readonly filters: UsageMultiFilters;
}): FacetCatalog {
  const workspaceMap = new Map<string, FacetOption>();
  for (const ws of workspaces) {
    workspaceMap.set(ws.id, {
      facet: 'workspace',
      value: ws.id,
      label: ws.name,
      hint: ws.root,
      keywords: `${ws.name} ${ws.id} ${ws.root}`,
    });
  }
  const addObservedWorkspace = (id: string) => {
    if (id === '' || id === 'unknown' || workspaceMap.has(id)) return;
    workspaceMap.set(id, { facet: 'workspace', value: id, label: id, keywords: id });
  };
  for (const id of filters.workspaceIds) addObservedWorkspace(id);
  for (const item of response?.sessions.items ?? []) addObservedWorkspace(item.workspace_id);
  if (response?.query.dimension === 'project') {
    for (const bucket of response.trend) {
      for (const group of bucket.groups) addObservedWorkspace(group.key);
    }
  }

  const modelMap = new Map<string, FacetOption>();
  for (const model of models) {
    const label = model.display_name && model.display_name !== model.id ? model.display_name : model.id;
    modelMap.set(model.id, {
      facet: 'model',
      value: model.id,
      label,
      hint: label !== model.id ? model.id : model.provider_id,
      keywords: `${model.id} ${model.display_name ?? ''} ${model.provider_id ?? ''} ${model.remote_id ?? ''}`,
    });
  }
  const addObservedModel = (id: string | null | undefined) => {
    if (id === null || id === undefined || id === '' || id === 'unknown' || modelMap.has(id)) return;
    modelMap.set(id, { facet: 'model', value: id, label: id, keywords: id });
  };
  for (const id of filters.models) addObservedModel(id);
  for (const id of response?.reliability.unknown_price_models ?? []) addObservedModel(id);
  for (const item of response?.sessions.items ?? []) addObservedModel(item.primary_model);
  for (const bucket of response?.trend ?? []) {
    for (const group of bucket.groups) addObservedModel(group.model_alias);
  }

  const providerMap = new Map<string, FacetOption>();
  for (const provider of providers) {
    providerMap.set(provider.id, {
      facet: 'provider',
      value: provider.id,
      label: provider.id,
      keywords: provider.id,
    });
  }
  const addObservedProvider = (id: string | null | undefined) => {
    if (id === null || id === undefined || id === '' || id === 'unknown' || providerMap.has(id)) return;
    providerMap.set(id, { facet: 'provider', value: id, label: id, keywords: id });
  };
  for (const id of filters.providers) addObservedProvider(id);
  for (const bucket of response?.trend ?? []) {
    for (const group of bucket.groups) addObservedProvider(group.provider);
  }

  const profileMap = new Map<string, FacetOption>();
  for (const profile of namedProfiles) {
    profileMap.set(profile.name, {
      facet: 'profile',
      value: profile.name,
      label: profile.name,
      hint: profile.description ?? undefined,
      keywords: `${profile.name} ${profile.description ?? ''}`,
    });
  }
  const addObservedProfile = (name: string | null | undefined) => {
    if (name === null || name === undefined || name === '' || name === 'unknown' || profileMap.has(name)) return;
    profileMap.set(name, { facet: 'profile', value: name, label: name, keywords: name });
  };
  for (const name of filters.profiles) addObservedProfile(name);
  for (const item of response?.sessions.items ?? []) {
    for (const name of item.profile_names ?? []) addObservedProfile(name);
  }
  for (const bucket of response?.trend ?? []) {
    for (const group of bucket.groups) addObservedProfile(group.profile_name);
  }

  const byLabel = (left: FacetOption, right: FacetOption) => left.label.localeCompare(right.label);
  const workspace = [...workspaceMap.values()].toSorted(byLabel);
  const model = [...modelMap.values()].toSorted(byLabel);
  const provider = [...providerMap.values()].toSorted(byLabel);
  const profile = [...profileMap.values()].toSorted(byLabel);

  return {
    workspace,
    model,
    provider,
    profile,
    all: [...model, ...provider, ...profile, ...workspace],
  };
}
