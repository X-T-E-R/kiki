export interface ProviderApiKeyConfig {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedProviderApiKey {
  readonly apiKey?: string;
  readonly envName?: string;
}

/** Resolve only an explicitly named runtime variable; legacy sources remain caller-owned. */
export function resolveConfiguredProviderApiKey(
  provider: ProviderApiKeyConfig,
  fallback: ResolvedProviderApiKey = {},
  runtimeEnv: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedProviderApiKey {
  const inline = nonEmpty(provider.apiKey);
  if (inline !== undefined) return { apiKey: inline };
  const envName = nonEmpty(provider.apiKeyEnv);
  if (envName === undefined) return { apiKey: nonEmpty(fallback.apiKey), envName: fallback.envName };
  const value = provider.env !== undefined && Object.hasOwn(provider.env, envName)
    ? provider.env[envName]
    : runtimeEnv[envName];
  return { apiKey: nonEmpty(value), envName };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
