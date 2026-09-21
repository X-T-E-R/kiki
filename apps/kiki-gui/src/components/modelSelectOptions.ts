import type { ModelCatalogItem } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { SearchableSelectOption } from './SearchableSelect';

/**
 * Construct SearchableSelect options for catalog models, following Composer's
 * provider grouping, hint, capability/effort badges, and search keywords pattern.
 */
export function buildCatalogModelOptions(
  models: readonly ModelCatalogItem[],
  t: (key: I18nKey, params?: Record<string, string | number>) => string,
): SearchableSelectOption[] {
  return models.map((item) => ({
    value: item.id,
    label: item.display_name ?? item.id,
    // The hint names the local alias when display name differs, else remote id.
    hint:
      item.display_name !== undefined && item.display_name !== item.id
        ? item.id
        : item.remote_id,
    group: item.provider_id,
    badges: [
      ...(item.capabilities ?? []).map((capability) => ({ label: capability })),
      ...(item.support_efforts ?? []).map((level) => ({
        label:
          level === item.default_effort
            ? t('composer.modelEffortDefaultBadge', { effort: level })
            : level,
        accent: level === item.default_effort,
      })),
    ],
    keywords: `${item.id} ${item.remote_id}`,
    title: item.id,
  }));
}
