/**
 * Centralized, configurable scale budgets for subagent-heavy GUI surfaces.
 *
 * Defaults are calibrated to match the backend `[subagent]` bounded-window
 * contract so all active / waiting / unsealed-branch rows stay visible ahead
 * of settled history without mounting unbounded DOM trees or scattering magic
 * numbers across components.
 */

export interface SubagentScaleConfig {
  /** Max newest settled rows shown per expanded group / popover / tree section (~3.5 screenfuls). */
  readonly settledRosterWindow: number;
  /** Default server-backed search result page size (`controller.searchSubagents`). */
  readonly searchResultLimit: number;
  /** Initial visible members in a single-turn inline subagent batch before incremental expansion. */
  readonly inlineBatchPreviewLimit: number;
  /** Row count above which subagent lists/trees switch to virtualized scrolling. */
  readonly virtualizeThreshold: number;
  /** Debounce interval (ms) before issuing a remote `searchSubagents` request. */
  readonly searchDebounceMs: number;
}

export const DEFAULT_SUBAGENT_SCALE_CONFIG: SubagentScaleConfig = {
  settledRosterWindow: 64,
  searchResultLimit: 32,
  inlineBatchPreviewLimit: 24,
  virtualizeThreshold: 24,
  searchDebounceMs: 120,
};

function readPositiveIntEnv(key: string, fallback: number, min = 1, max = 10_000): number {
  const env = (import.meta as { readonly env?: Readonly<Record<string, unknown>> }).env;
  const raw = env?.[key];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function resolveBaseConfig(): SubagentScaleConfig {
  return {
    settledRosterWindow: readPositiveIntEnv(
      'VITE_KIKI_SUBAGENT_SETTLED_ROSTER_WINDOW',
      DEFAULT_SUBAGENT_SCALE_CONFIG.settledRosterWindow,
    ),
    searchResultLimit: readPositiveIntEnv(
      'VITE_KIKI_SUBAGENT_SEARCH_RESULT_LIMIT',
      DEFAULT_SUBAGENT_SCALE_CONFIG.searchResultLimit,
    ),
    inlineBatchPreviewLimit: readPositiveIntEnv(
      'VITE_KIKI_SUBAGENT_INLINE_BATCH_PREVIEW_LIMIT',
      DEFAULT_SUBAGENT_SCALE_CONFIG.inlineBatchPreviewLimit,
    ),
    virtualizeThreshold: readPositiveIntEnv(
      'VITE_KIKI_SUBAGENT_VIRTUALIZE_THRESHOLD',
      DEFAULT_SUBAGENT_SCALE_CONFIG.virtualizeThreshold,
    ),
    searchDebounceMs: readPositiveIntEnv(
      'VITE_KIKI_SUBAGENT_SEARCH_DEBOUNCE_MS',
      DEFAULT_SUBAGENT_SCALE_CONFIG.searchDebounceMs,
      0,
      5_000,
    ),
  };
}

let runtimeOverrides: Partial<SubagentScaleConfig> = {};

/**
 * Current resolved subagent scale configuration (`DEFAULT` <- `VITE_KIKI_*` <- runtime override).
 */
export function getSubagentScaleConfig(): SubagentScaleConfig {
  const base = resolveBaseConfig();
  return {
    settledRosterWindow: runtimeOverrides.settledRosterWindow ?? base.settledRosterWindow,
    searchResultLimit: runtimeOverrides.searchResultLimit ?? base.searchResultLimit,
    inlineBatchPreviewLimit: runtimeOverrides.inlineBatchPreviewLimit ?? base.inlineBatchPreviewLimit,
    virtualizeThreshold: runtimeOverrides.virtualizeThreshold ?? base.virtualizeThreshold,
    searchDebounceMs: runtimeOverrides.searchDebounceMs ?? base.searchDebounceMs,
  };
}

/**
 * Apply runtime overrides (for app settings wiring or tests). Passing `null`
 * resets all runtime overrides back to env/default values.
 */
export function configureSubagentScale(patch: Partial<SubagentScaleConfig> | null): SubagentScaleConfig {
  runtimeOverrides = patch === null ? {} : { ...runtimeOverrides, ...patch };
  return getSubagentScaleConfig();
}

/**
 * Centralized, configurable scale budgets for pickers, popovers, command/mention
 * completion menus, and settings catalogs (`10,000`-model / `1,000+`-skill /
 * `10,000`-session safe).
 */
export interface PickerScaleConfig {
  /** Option/row count above which SearchableSelect and popover lists switch to virtualized scrolling. */
  readonly selectVirtualizeThreshold: number;
  /** Row count above which settings catalogs / rails switch to virtualized scrolling. */
  readonly catalogVirtualizeThreshold: number;
  /** Overscan rows rendered above and below the visible viewport in picker virtualizers. */
  readonly virtualOverscan: number;
  /** Cap for top-K quick-filter buffers before full rendering / virtualizing. */
  readonly suggestionTopK: number;
  /** Candidate count above which switchers and menus use pre-indexed top-K filtering. */
  readonly fastFilterThreshold: number;
}

export const DEFAULT_PICKER_SCALE_CONFIG: PickerScaleConfig = {
  selectVirtualizeThreshold: 40,
  catalogVirtualizeThreshold: 40,
  virtualOverscan: 6,
  suggestionTopK: 40,
  fastFilterThreshold: 120,
};

function resolveBasePickerConfig(): PickerScaleConfig {
  return {
    selectVirtualizeThreshold: readPositiveIntEnv(
      'VITE_KIKI_SELECT_VIRTUALIZE_THRESHOLD',
      DEFAULT_PICKER_SCALE_CONFIG.selectVirtualizeThreshold,
    ),
    catalogVirtualizeThreshold: readPositiveIntEnv(
      'VITE_KIKI_CATALOG_VIRTUALIZE_THRESHOLD',
      DEFAULT_PICKER_SCALE_CONFIG.catalogVirtualizeThreshold,
    ),
    virtualOverscan: readPositiveIntEnv(
      'VITE_KIKI_PICKER_VIRTUAL_OVERSCAN',
      DEFAULT_PICKER_SCALE_CONFIG.virtualOverscan,
      1,
      64,
    ),
    suggestionTopK: readPositiveIntEnv(
      'VITE_KIKI_PICKER_SUGGESTION_TOP_K',
      DEFAULT_PICKER_SCALE_CONFIG.suggestionTopK,
    ),
    fastFilterThreshold: readPositiveIntEnv(
      'VITE_KIKI_PICKER_FAST_FILTER_THRESHOLD',
      DEFAULT_PICKER_SCALE_CONFIG.fastFilterThreshold,
    ),
  };
}

let pickerRuntimeOverrides: Partial<PickerScaleConfig> = {};

/**
 * Current resolved picker & catalog scale configuration (`DEFAULT` <- `VITE_KIKI_*` <- runtime override).
 */
export function getPickerScaleConfig(): PickerScaleConfig {
  const base = resolveBasePickerConfig();
  return {
    selectVirtualizeThreshold: pickerRuntimeOverrides.selectVirtualizeThreshold ?? base.selectVirtualizeThreshold,
    catalogVirtualizeThreshold: pickerRuntimeOverrides.catalogVirtualizeThreshold ?? base.catalogVirtualizeThreshold,
    virtualOverscan: pickerRuntimeOverrides.virtualOverscan ?? base.virtualOverscan,
    suggestionTopK: pickerRuntimeOverrides.suggestionTopK ?? base.suggestionTopK,
    fastFilterThreshold: pickerRuntimeOverrides.fastFilterThreshold ?? base.fastFilterThreshold,
  };
}

/**
 * Apply runtime overrides for picker/catalog virtualization thresholds. Passing
 * `null` resets all overrides back to env/default values.
 */
export function configurePickerScale(patch: Partial<PickerScaleConfig> | null): PickerScaleConfig {
  pickerRuntimeOverrides = patch === null ? {} : { ...pickerRuntimeOverrides, ...patch };
  return getPickerScaleConfig();
}
