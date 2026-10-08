import type { ExecutorModelCatalogResponse } from '@kiki/protocol';

export const EXECUTOR_CAPABILITY_STALE_AFTER_MS = 60_000;

export type ExecutorCapabilityKind = 'absent' | 'loading' | 'ready' | 'partial' | 'unavailable' | 'unknown';
export type ExecutorCapabilityFreshness = 'absent' | 'fresh' | 'stale';

type CatalogDimension = ExecutorModelCatalogResponse['effective']['models'];
type CatalogContext = ExecutorModelCatalogResponse['effective']['context'];
type CatalogControl = ExecutorModelCatalogResponse['effective']['controls']['model_switch'];

export interface ExecutorCapabilityDimensionState {
  readonly kind: ExecutorCapabilityKind;
  readonly values?: readonly string[];
  readonly diagnostic?: string;
}

export interface ExecutorContextState extends ExecutorCapabilityDimensionState {
  readonly context_window?: CatalogContext['context_window'];
  readonly max_input_tokens?: CatalogContext['max_input_tokens'];
  readonly max_output_tokens?: CatalogContext['max_output_tokens'];
  readonly compaction_threshold?: CatalogContext['compaction_threshold'];
}

export interface ExecutorControlState {
  readonly kind: ExecutorCapabilityKind;
  readonly advertised?: CatalogControl['advertised'];
  readonly applicability?: CatalogControl['applicability'];
  readonly apply_state?: CatalogControl['apply_state'];
  readonly diagnostic?: CatalogControl['diagnostic'];
}

export interface ExecutorCapabilityPresentation {
  readonly freshness: ExecutorCapabilityFreshness;
  readonly observed_at?: number;
  readonly source?: ExecutorModelCatalogResponse['source'];
  readonly provenance?: ExecutorModelCatalogResponse['provenance'];
  readonly engine_version?: ExecutorModelCatalogResponse['executor_version'];
  readonly models: ExecutorCapabilityDimensionState;
  readonly thinking_levels: ExecutorCapabilityDimensionState;
  readonly context: ExecutorContextState;
  readonly controls: {
    readonly model_switch: ExecutorControlState;
    readonly thinking_switch: ExecutorControlState;
    readonly manual_compact: ExecutorControlState;
  };
}

function mapDimension(dimension: CatalogDimension, stale: boolean): ExecutorCapabilityDimensionState {
  return {
    kind: stale ? 'unknown' : dimension.state,
    values: dimension.values,
    diagnostic: dimension.diagnostic,
  };
}

function mapContext(context: CatalogContext, stale: boolean): ExecutorContextState {
  return {
    ...mapDimension(context, stale),
    context_window: context.context_window,
    max_input_tokens: context.max_input_tokens,
    max_output_tokens: context.max_output_tokens,
    compaction_threshold: context.compaction_threshold,
  };
}

function mapControl(control: CatalogControl, stale: boolean): ExecutorControlState {
  const kind = stale
    ? 'unknown'
    : control.advertised === false || control.applicability === 'unsupported' || control.apply_state === 'unsupported'
      ? 'unavailable'
      : control.applicability === 'unknown' || control.apply_state === 'unknown'
        ? 'unknown'
        : control.apply_state === 'pending' ? 'loading' : 'ready';
  return {
    kind,
    advertised: control.advertised,
    applicability: control.applicability,
    apply_state: control.apply_state,
    diagnostic: control.diagnostic,
  };
}

function absentDimension(): ExecutorCapabilityDimensionState {
  return { kind: 'absent' };
}

function absentContext(): ExecutorContextState {
  return { kind: 'absent' };
}

function absentControl(): ExecutorControlState {
  return { kind: 'absent' };
}

export function mapExecutorCapabilities(
  response: ExecutorModelCatalogResponse | undefined,
  now = Date.now(),
): ExecutorCapabilityPresentation {
  if (response === undefined) {
    return {
      freshness: 'absent',
      models: absentDimension(),
      thinking_levels: absentDimension(),
      context: absentContext(),
      controls: {
        model_switch: absentControl(),
        thinking_switch: absentControl(),
        manual_compact: absentControl(),
      },
    };
  }
  const stale = now - response.observed_at >= EXECUTOR_CAPABILITY_STALE_AFTER_MS;
  return {
    freshness: stale ? 'stale' : 'fresh',
    observed_at: response.observed_at,
    source: response.source,
    provenance: response.provenance,
    engine_version: response.executor_version,
    models: mapDimension(response.effective.models, stale),
    thinking_levels: mapDimension(response.effective.thinking_levels, stale),
    context: mapContext(response.effective.context, stale),
    controls: {
      model_switch: mapControl(response.effective.controls.model_switch, stale),
      thinking_switch: mapControl(response.effective.controls.thinking_switch, stale),
      manual_compact: mapControl(response.effective.controls.manual_compact, stale),
    },
  };
}

export function isExecutorActionAvailable(
  dimension: Pick<ExecutorCapabilityDimensionState, 'kind'> | Pick<ExecutorControlState, 'kind'> | undefined,
): boolean {
  return dimension?.kind === 'ready';
}
