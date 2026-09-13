import {
  builtInProviderRegistrations,
  parseConfigPatch,
  type CanonicalConfigPatch,
} from '@nb-corp/nb-search';
import { findUnknownNbSearchProviderOptions } from '@kiki/protocol';
import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const NB_SEARCH_SECTION = 'nbSearch';

const providerOptionDescriptors = builtInProviderRegistrations().map(
  (registration) => registration.descriptor,
);

export const NbSearchConfigSchema = z.custom<CanonicalConfigPatch>(
  (value) => {
    try {
      const config = parseConfigPatch(value, 'Kiki nb_search configuration');
      const unknownOptions = findUnknownNbSearchProviderOptions(config, providerOptionDescriptors);
      if (unknownOptions.length > 0) {
        const issue = unknownOptions[0]!;
        throw new Error(
          issue.option_key === undefined
            ? `provider_instances.${issue.provider_instance_id}.provider_id is not registered`
            : `provider_instances.${issue.provider_instance_id}.options.${issue.option_key} is not supported`,
        );
      }
      return true;
    } catch {
      return false;
    }
  },
  { error: 'Invalid nb_search configuration.' },
).transform((value) => parseConfigPatch(value, 'Kiki nb_search configuration'));

export type NbSearchConfig = CanonicalConfigPatch;

const preserveCanonicalKeys = (value: unknown): unknown => value;

export function mergeNbSearchConfig(
  base: NbSearchConfig | undefined,
  patch: unknown,
): NbSearchConfig {
  if (!isRecord(patch)) return (patch ?? base) as NbSearchConfig;
  return mergeCanonicalPatch((base ?? {}) as Record<string, unknown>, patch) as NbSearchConfig;
}

function mergeCanonicalPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (isRecord(value)) {
      result[key] = mergeCanonicalPatch(isRecord(result[key]) ? result[key] : {}, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

registerConfigSection(NB_SEARCH_SECTION, NbSearchConfigSchema, {
  merge: mergeNbSearchConfig,
  fromToml: preserveCanonicalKeys,
  toToml: preserveCanonicalKeys,
});

export const NB_SEARCH_SOURCE_SECTION = 'nbSearchSource';
export const NbSearchSourceConfigSchema = z.object({ reuse_local_config: z.boolean().default(true) }).strict();
export type NbSearchSourceConfig = z.infer<typeof NbSearchSourceConfigSchema>;

registerConfigSection(NB_SEARCH_SOURCE_SECTION, NbSearchSourceConfigSchema, {
  defaultValue: { reuse_local_config: true },
  fromToml: preserveCanonicalKeys,
  toToml: preserveCanonicalKeys,
});
