import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ModelCatalogItem } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import { useConnection } from '../state/connection';
import { OAUTH_METHODS_QUERY_KEY } from './AccountSignIn';
import { vendorLabelFor } from './providerPresets';
import type { SearchableSelectOption, SearchableSelectOptionBadge } from './SearchableSelect';

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
  if (item.capabilities !== undefined && !item.capabilities.includes('image_in')) {
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

/**
 * Construct SearchableSelect options for catalog models: provider grouping,
 * an id hint, the decision facts as badges, and ids as search keywords.
 */
export function buildCatalogModelOptions(
  models: readonly ModelCatalogItem[],
  t: Translate,
  {
    groupLabel = (providerId: string) => providerId,
    currentId,
  }: {
    /** Provider display label for group headers; defaults to the provider id. */
    readonly groupLabel?: (providerId: string) => string;
    /** Marks the row the session is already using. */
    readonly currentId?: string;
  } = {},
): SearchableSelectOption[] {
  return models.map((item) => {
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
  return useMemo(() => {
    const labels = new Map<string, string>();
    for (const method of methodsQuery.data ?? []) labels.set(method.provider, method.label);
    const vendor = new Map<string, string>();
    for (const provider of providersQuery.data?.items ?? []) {
      const label = vendorLabelFor(provider.base_url);
      if (label !== undefined && !labels.has(provider.id)) vendor.set(provider.id, label);
    }
    const counts = new Map<string, number>();
    for (const label of vendor.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
    for (const [id, label] of vendor) if (counts.get(label) === 1) labels.set(id, label);
    return (providerId: string) => labels.get(providerId) ?? providerId;
  }, [providersQuery.data, methodsQuery.data]);
}
