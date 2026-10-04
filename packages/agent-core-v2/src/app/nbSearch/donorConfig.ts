import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { builtInProviderRegistrations, defaultConfiguration, resolveCapturedConfiguration, stableFingerprint, type CanonicalConfig, type CanonicalConfigPatch, type ResolvedConfiguration } from '@nb-corp/nb-search';
import { findUnknownNbSearchProviderOptions } from '@kiki/protocol';

export { defaultConfiguration as defaultNbSearchConfiguration } from '@nb-corp/nb-search';

export function nbSearchPaths(env: NodeJS.ProcessEnv) {
  const home = resolve(nonempty(env['NB_SEARCH_HOME']) ?? resolve(homedir(), '.nb-search'));
  return { home, canonical: resolve(nonempty(env['NB_SEARCH_CONFIG']) ?? resolve(home, 'config.json')), secrets: resolve(home, 'secrets.json'), lock: resolve(home, '.config-access.lock') };
}
export function resolveNbSearchCapturedConfig(env: NodeJS.ProcessEnv, canonical: CanonicalConfigPatch | undefined, kiki: CanonicalConfigPatch | undefined): ResolvedConfiguration {
  const paths = nbSearchPaths(env);
  return resolveCapturedConfiguration({ home: paths.home, canonicalPath: paths.canonical, canonical: canonical ?? {} }, { env, config: kiki });
}
export function resolveNbSearchConfig(env: NodeJS.ProcessEnv, canonical: CanonicalConfigPatch | undefined, kiki: CanonicalConfigPatch | undefined): CanonicalConfig { return resolveNbSearchCapturedConfig(env, canonical, kiki).config; }
export function nbSearchConfigIssues(error: unknown, config?: CanonicalConfigPatch, issue = 'EFFECTIVE_CONFIG_INVALID'): string[] {
  const unknownOption = config === undefined ? undefined : findUnknownNbSearchProviderOptions(config, builtInProviderRegistrations().map((registration) => registration.descriptor))[0];
  const diagnostic = unknownOption === undefined ? nbSearchConfigDiagnostic(error) : unknownOption.option_key === undefined ? `CONFIGURATION_ERROR:provider_instances.${unknownOption.provider_instance_id}.provider_id` : `CONFIGURATION_ERROR:provider_instances.${unknownOption.provider_instance_id}.options.${unknownOption.option_key}`;
  return diagnostic === undefined || diagnostic === issue ? [issue] : [issue, diagnostic];
}
function nbSearchConfigDiagnostic(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : 'CONFIGURATION_ERROR';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : undefined;
  const path = message?.match(/^(?:resolved configuration|local nb-search configuration|canonical configuration|host configuration) is invalid: (defaults\.(?:search_lane|fetch_chain)|fetch\.routing(?:\.[\w.]+)?):/)?.[1];
  return path === undefined ? code : `${code}:${path}`;
}
export function nbSearchConfigRevision(config: CanonicalConfig): string { return `config-4-${stableFingerprint(config).slice(0, 16)}`; }
export function pinnedNbSearchConfig(config: CanonicalConfig): CanonicalConfigPatch {
  const defaults = defaultConfiguration(config.home ?? ''); const result: Record<string, unknown> = { ...structuredClone(config) };
  for (const key of Object.keys(defaults)) if (result[key] === undefined) result[key] = null;
  for (const key of ['provider_instances', 'credential_slots', 'lanes', 'presets', 'defaults'] as const) { const value: Record<string, unknown> = { ...config[key] }; for (const inherited of Object.keys(defaults[key])) if (value[inherited] === undefined) value[inherited] = null; result[key] = value; }
  return result as CanonicalConfigPatch;
}
function nonempty(value: string | undefined): string | undefined { const trimmed = value?.trim(); return trimmed === '' ? undefined : trimmed; }
