import { useQuery } from '@tanstack/react-query';
import type { ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';
import type { OAuthMethodStatus } from '@kiki/klient';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useConnection } from '../state/connection';
import { vendorLabelFor } from './providerPresets';
import type { SearchableSelectOption, SearchableSelectOptionBadge } from './SearchableSelect';

const OAUTH_METHODS_QUERY_KEY = ['oauth-methods'] as const;

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

/** Picker-scale context size: 262144 → "262k", 1048576 → "1M", 1500000 → "1.5M". */
export function formatContextSize(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * The facts that change which model to pick: the context window, the model's
 * own auto-compaction point, and a missing vision input. Thinking, tool use and
 * effort levels stay out — the effort control owns depth, and tool use is on
 * for every model the agent can drive. Vision is flagged only when the catalog
 * declares capabilities without `image_in`; an undeclared list is unknown.
 */
export function modelFactBadges(item: ModelCatalogItem, t: Translate): SearchableSelectOptionBadge[] {
  const badges: SearchableSelectOptionBadge[] = [];
  if (item.max_context_size > 0) badges.push({ label: formatContextSize(item.max_context_size) });
  if (item.auto_compact !== undefined) {
    badges.push({ label: t('composer.modelCompactAt', { tokens: formatContextSize(item.auto_compact) }) });
  }
  const capabilities = item.effective_capabilities ?? item.capabilities;
  if (capabilities !== undefined && !capabilities.includes('image_in')) {
    badges.push({ label: t('composer.modelNoVision'), tone: 'caution' });
  }
  return badges;
}

/** Local alias and remote id, minus whatever the label already says. */
function modelIdHint(item: ModelCatalogItem, label: string): string | undefined {
  const parts = [...new Set([item.id, item.remote_id])].filter((part) => part !== label);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Row tooltip: the full name, then the alias → remote id it sends upstream. */
export function modelTooltip(item: ModelCatalogItem): string {
  const label = item.display_name ?? item.id;
  const ids = item.remote_id === item.id ? item.id : `${item.id} → ${item.remote_id}`;
  return label === item.id ? ids : `${label}\n${ids}`;
}

const identityGroupLabel = (providerId: string): string => providerId;

interface CachedCatalogOptionsEntry {
  readonly t: Translate;
  readonly groupLabel: (providerId: string) => string;
  readonly currentId: string | undefined;
  readonly options: readonly SearchableSelectOption[];
}

const catalogOptionsCache = new WeakMap<readonly ModelCatalogItem[], CachedCatalogOptionsEntry[]>();

/**
 * Construct SearchableSelect options for catalog models: provider grouping,
 * an id hint, the decision facts as badges, and ids as search keywords.
 */
export function buildCatalogModelOptions(
  models: readonly ModelCatalogItem[],
  t: Translate,
  {
    groupLabel = identityGroupLabel,
    currentId,
  }: {
    /** Provider display label for group headers; defaults to the provider id. */
    readonly groupLabel?: (providerId: string) => string;
    /** Marks the row the session is already using. */
    readonly currentId?: string;
  } = {},
): SearchableSelectOption[] {
  const bucket = catalogOptionsCache.get(models);
  const hit = bucket?.find(
    (entry) => entry.t === t && entry.groupLabel === groupLabel && entry.currentId === currentId,
  );
  if (hit !== undefined) {
    return [...hit.options];
  }

  const built = models.map((item) => {
    const label = item.display_name ?? item.id;
    return {
      value: item.id,
      label,
      hint: modelIdHint(item, label),
      group: groupLabel(item.provider_id),
      badges: [
        ...(item.id === currentId ? [{ label: t('composer.modelCurrentBadge'), accent: true }] : []),
        ...modelFactBadges(item, t),
      ],
      keywords: `${item.id} ${item.remote_id} ${item.provider_id}`,
      title: modelTooltip(item),
    };
  });

  if (models.length > 0) {
    const nextBucket = bucket === undefined ? [] : bucket.slice(-3);
    nextBucket.push({ t, groupLabel, currentId, options: built });
    catalogOptionsCache.set(models, nextBucket);
  }
  return [...built];
}

let cachedGroupLabelSource: {
  providers: readonly ProviderCatalogItem[] | undefined;
  methods: readonly OAuthMethodStatus[] | undefined;
  fn: (providerId: string) => string;
} | null = null;

function resolveProviderGroupLabel(
  providers: readonly ProviderCatalogItem[] | undefined,
  methods: readonly OAuthMethodStatus[] | undefined,
): (providerId: string) => string {
  if (
    cachedGroupLabelSource !== null
    && cachedGroupLabelSource.providers === providers
    && cachedGroupLabelSource.methods === methods
  ) {
    return cachedGroupLabelSource.fn;
  }
  const labels = new Map<string, string>();
  for (const method of methods ?? []) labels.set(method.provider, method.label);
  const vendor = new Map<string, string>();
  for (const provider of providers ?? []) {
    const label = vendorLabelFor(provider.base_url);
    if (label !== undefined && !labels.has(provider.id)) vendor.set(provider.id, label);
  }
  const counts = new Map<string, number>();
  for (const label of vendor.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const [id, label] of vendor) if (counts.get(label) === 1) labels.set(id, label);
  const fn = (providerId: string) => labels.get(providerId) ?? providerId;
  cachedGroupLabelSource = { providers, methods, fn };
  return fn;
}

/**
 * Provider id → display label for model group headers: an account sign-in
 * label, else the vendor its base URL points at, else the id. A vendor label
 * two providers would share falls back to the ids so groups stay distinct.
 */
export function useProviderGroupLabel(): (providerId: string) => string {
  const { client } = useConnection();
  const providersQuery = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.listProviders(),
    staleTime: 60_000,
    enabled: typeof client.listProviders === 'function',
  });
  const methodsQuery = useQuery({
    queryKey: OAUTH_METHODS_QUERY_KEY,
    queryFn: () => client.listOAuthMethods(),
    staleTime: 60_000,
    enabled: typeof client.listOAuthMethods === 'function',
  });
  return resolveProviderGroupLabel(providersQuery.data?.items, methodsQuery.data);
}
