export type { HostFs } from './hostFs';

export interface ModelAliasResolver {
  resolveId(alias: string): string | undefined;
}

const externalModelAliasResolver: ModelAliasResolver = {
  resolveId: (alias) => alias,
};

export function modelAliasResolverForExecutor(
  executor: string | undefined,
  native: ModelAliasResolver,
): ModelAliasResolver {
  return executor === undefined || executor === 'native' ? native : externalModelAliasResolver;
}

export type ExecutorOptions = Readonly<Record<string, string | number | boolean>>;

export const EXECUTOR_CAPABILITY_STATES = ['unknown', 'loading', 'ready', 'partial', 'unavailable'] as const;
export type ExecutorCapabilityState = (typeof EXECUTOR_CAPABILITY_STATES)[number];
export type ExecutorCapabilitySource = 'negotiated' | 'cli_probe';
export type ExecutorCapabilityProvenance = 'acp_negotiation' | 'read_only_cli_probe';

export interface ExecutorCapabilityDimension {
  readonly state: ExecutorCapabilityState;
  readonly values?: readonly string[];
  readonly diagnostic?: string;
}

export interface ExecutorContextCapabilities {
  readonly state: ExecutorCapabilityState;
  readonly contextWindow?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly compactionThreshold?: number;
  readonly diagnostic?: string;
}

export type ExecutorControlApplicability = 'live' | 'next_binding' | 'fresh_binding' | 'unsupported' | 'unknown';
export type ExecutorControlApplyState = 'applied' | 'pending' | 'unsupported' | 'unknown';

export interface ExecutorControlCapability {
  readonly advertised?: boolean;
  readonly applicability: ExecutorControlApplicability;
  readonly applyState: ExecutorControlApplyState;
  readonly diagnostic?: string;
}

export interface ExecutorCapabilityControls {
  readonly modelSwitch: ExecutorControlCapability;
  readonly thinkingSwitch: ExecutorControlCapability;
  readonly manualCompact: ExecutorControlCapability;
}

export interface ExecutorCapabilityCatalog {
  readonly executorId: string;
  readonly descriptorRevision: string;
  readonly version?: string;
  readonly catalogProgramVersion?: string;
  readonly catalogCommand?: string;
  readonly source: ExecutorCapabilitySource;
  readonly provenance: ExecutorCapabilityProvenance;
  readonly observedAt: number;
  readonly models: ExecutorCapabilityDimension;
  readonly thinkingLevels: ExecutorCapabilityDimension;
  readonly context: ExecutorContextCapabilities;
  readonly controls: ExecutorCapabilityControls;
}

export interface ExecutorCapabilityCatalogPort {
  getExecutorCapabilityCatalog(
    executorId: string,
    expected?: { readonly descriptorRevision?: string; readonly version?: string },
  ): ExecutorCapabilityCatalog | undefined;
}

export interface ExecutorBinding {
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly explicitFields?: readonly string[];
}

export interface ExecutorFieldState {
  readonly state: 'applied' | 'mapped' | 'ignored';
  readonly reason?: string;
}

export interface ExecutorFieldAdvisory {
  readonly code: 'executor_field_ignored';
  readonly field: string;
  readonly message: string;
}

export type ExecutorValidationResult =
  | { readonly ok: true; readonly binding: ExecutorBinding;
      readonly fields?: Readonly<Record<string, ExecutorFieldState>>;
      readonly advisories?: readonly ExecutorFieldAdvisory[] }
  | { readonly ok: false; readonly diagnostic: string };

export interface ExecutorValidator {
  validateExecutor(
    id: string,
    options: ExecutorOptions | undefined,
    binding: ExecutorBinding,
  ): ExecutorValidationResult | string;
}
