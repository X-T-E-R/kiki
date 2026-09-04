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
}

export type ExecutorValidationResult =
  | { readonly ok: true; readonly binding: ExecutorBinding }
  | { readonly ok: false; readonly diagnostic: string };

export interface ExecutorValidator {
  validateExecutor(
    id: string,
    options: ExecutorOptions | undefined,
    binding: ExecutorBinding,
  ): ExecutorValidationResult | string;
}
