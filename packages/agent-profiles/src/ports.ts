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
