export const BINDING_ADVISORY_VERSION = 1 as const;

export type BindingAdvisoryCode =
  | 'model_not_allowed'
  | 'model_denied'
  | 'effort_not_allowed'
  | 'model_pin_overridden'
  | 'effort_pin_overridden';

export type BindingAdvisoryDimension = 'model' | 'thinking_effort';

export type BindingValueSource =
  | 'dispatch-explicit'
  | 'runtime-explicit'
  | 'resume-existing'
  | 'route-default'
  | 'caller-lease-default'
  | 'profile-default'
  | 'model-profile-default'
  | 'model-default'
  | 'config-default'
  | 'executor-normalized'
  | 'environment-forced';

export interface BindingAdvisory {
  readonly version: typeof BINDING_ADVISORY_VERSION;
  readonly code: BindingAdvisoryCode;
  readonly dimension: BindingAdvisoryDimension;
  readonly ruleSource: string;
  readonly ruleValue?: string;
  readonly ruleValues?: readonly string[];
  readonly requestedValue?: string;
  readonly effectiveValue: string;
  readonly valueSource: BindingValueSource;
  readonly model?: string;
  readonly message: string;
}

export function bindingAdvisoryKey(advisory: BindingAdvisory): string {
  return [
    advisory.version,
    advisory.code,
    advisory.ruleSource,
    advisory.model ?? '',
    advisory.effectiveValue,
  ].join('\u0000');
}
