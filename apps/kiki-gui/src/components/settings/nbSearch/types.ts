import type { NbSearchCapabilities, NbSearchConfigPatch, NbSearchTestStatus } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { NbSearchDraft } from '@kiki/session-core/settings';

export type NbSearchTab = 'overview' | 'search' | 'fetch' | 'providers' | 'advanced';

export const NB_SEARCH_TABS: readonly NbSearchTab[] = [
  'overview',
  'search',
  'fetch',
  'providers',
  'advanced',
] as const;

export interface ExtendedNbSearchDraft {
  readonly nbSearch: NbSearchDraft;
  readonly reuseLocalConfig: boolean;
}

export interface NbSearchEditorBaseline {
  readonly config: NbSearchConfigPatch | undefined;
  readonly sourceConfig: { reuse_local_config?: boolean } | undefined;
  readonly capabilities: NbSearchCapabilities;
  readonly draft: ExtendedNbSearchDraft;
}

export type ReadinessState = 'ready' | 'degraded' | 'unconfigured' | 'unavailable';

export function webSearchState(readiness: NbSearchTestStatus['search']): ReadinessState {
  if (!readiness.configured) return 'unconfigured';
  return readiness.available ? 'ready' : 'unavailable';
}

export function fetchUrlState(readiness: NbSearchTestStatus['search']): ReadinessState {
  if (!readiness.configured) return 'unconfigured';
  if (!readiness.available) return 'unavailable';
  return readiness.issues.length > 0 ? 'degraded' : 'ready';
}

export const CARD_ID_TO_TAB: Record<string, NbSearchTab> = {
  'st-card-search-status': 'overview',
  'st-card-search-source': 'overview',
  'st-card-search-defaults': 'search',
  'st-card-search-fetch': 'fetch',
  'st-card-search-providers': 'providers',
  'st-card-search-execution': 'advanced',
  'st-card-search-diagnostics': 'advanced',
};

/**
 * Config-source issue codes with a localized recovery hint in the shared
 * dictionary. Codes without an entry stay raw so future backend codes still
 * surface verbatim.
 */
const SOURCE_ISSUE_MESSAGE_KEYS: Readonly<Record<string, I18nKey>> = {
  LOCAL_CONFIG_NOT_FOUND: 'st.nbSearch.source.issue.LOCAL_CONFIG_NOT_FOUND',
  LOCAL_CONFIG_UNREADABLE: 'st.nbSearch.source.issue.LOCAL_CONFIG_UNREADABLE',
  LOCAL_CONFIG_BUSY: 'st.nbSearch.source.issue.LOCAL_CONFIG_BUSY',
  LOCAL_CONFIG_CHANGED: 'st.nbSearch.source.issue.LOCAL_CONFIG_CHANGED',
  LOCAL_CONFIG_RESOLVER_MISMATCH: 'st.nbSearch.source.issue.LOCAL_CONFIG_RESOLVER_MISMATCH',
  LOCAL_CREDENTIALS_INVALID: 'st.nbSearch.source.issue.LOCAL_CREDENTIALS_INVALID',
  LOCAL_CREDENTIALS_UNREADABLE: 'st.nbSearch.source.issue.LOCAL_CREDENTIALS_UNREADABLE',
  LOCAL_CREDENTIALS_TIMEOUT: 'st.nbSearch.source.issue.LOCAL_CREDENTIALS_TIMEOUT',
  LOCAL_CREDENTIALS_UNSAFE: 'st.nbSearch.source.issue.LOCAL_CREDENTIALS_UNSAFE',
  LOCAL_CREDENTIAL_CONFIG_OVERRIDE: 'st.nbSearch.source.issue.LOCAL_CREDENTIAL_CONFIG_OVERRIDE',
  LOCAL_CREDENTIAL_BINDING_MISMATCH: 'st.nbSearch.source.issue.LOCAL_CREDENTIAL_BINDING_MISMATCH',
  EFFECTIVE_CONFIG_INVALID: 'st.nbSearch.source.issue.EFFECTIVE_CONFIG_INVALID',
  ISOLATED_STORAGE_UNAVAILABLE: 'st.nbSearch.source.issue.ISOLATED_STORAGE_UNAVAILABLE',
  LOCAL_CONFIG_INVALID_IGNORED: 'st.nbSearch.source.issue.LOCAL_CONFIG_INVALID_IGNORED',
};

export function sourceIssueMessageKey(code: string): I18nKey | undefined {
  return SOURCE_ISSUE_MESSAGE_KEYS[code];
}

/**
 * Lane / pipeline / provider issue codes with a plain-language explanation.
 * Unlike config-source codes these keep the raw code visible next to the
 * sentence, so the entry stays traceable to server logs.
 */
const GENERAL_ISSUE_MESSAGE_KEYS: Readonly<Record<string, I18nKey>> = {
  CREDENTIAL_NOT_CONFIGURED: 'st.nbSearch.issue.CREDENTIAL_NOT_CONFIGURED',
  PROVIDER_DISABLED: 'st.nbSearch.issue.PROVIDER_DISABLED',
  ENDPOINT_NOT_CONFIGURED: 'st.nbSearch.issue.ENDPOINT_NOT_CONFIGURED',
  RATE_LIMIT_UNAUTHENTICATED: 'st.nbSearch.issue.RATE_LIMIT_UNAUTHENTICATED',
  LANE_NOT_CONFIGURED: 'st.nbSearch.issue.LANE_NOT_CONFIGURED',
  LANE_NOT_REGISTERED: 'st.nbSearch.issue.LANE_NOT_REGISTERED',
  DEFAULT_NOT_CONFIGURED: 'st.nbSearch.issue.DEFAULT_NOT_CONFIGURED',
  FETCH_CHAIN_UNAVAILABLE: 'st.nbSearch.issue.FETCH_CHAIN_UNAVAILABLE',
  FETCH_DEFAULT_NOT_CONFIGURED: 'st.nbSearch.issue.FETCH_DEFAULT_NOT_CONFIGURED',
};

export function generalIssueMessageKey(code: string): I18nKey | undefined {
  return GENERAL_ISSUE_MESSAGE_KEYS[code];
}

const LATENCY_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  fast: 'st.nbSearch.latency.fast',
  medium: 'st.nbSearch.latency.medium',
  slow: 'st.nbSearch.latency.slow',
};

const COST_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  free: 'st.nbSearch.cost.free',
  cheap: 'st.nbSearch.cost.cheap',
  expensive: 'st.nbSearch.cost.expensive',
};

export function latencyLabelKey(value: string): I18nKey | undefined {
  return LATENCY_LABEL_KEYS[value];
}

export function costLabelKey(value: string): I18nKey | undefined {
  return COST_LABEL_KEYS[value];
}

const PINNED_LANES_KEY = 'kiki.nb_search.pinned_lanes';

export function loadPinnedLanes(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_LANES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed;
      }
    }
  } catch {
    // Storage unavailable or invalid JSON
  }
  return [];
}

export function savePinnedLanes(lanes: readonly string[]): void {
  try {
    localStorage.setItem(PINNED_LANES_KEY, JSON.stringify(lanes));
  } catch {
    // Storage unavailable
  }
}
