import { PromptOverridesSchema } from '@kiki/agent-profiles/promptOverrides';
import { modelBehaviorConfigSchema, modelSteeringCadenceSchema } from '@kiki/protocol';
import { OAuthRefSchema } from '#/kosong/provider/oauthRef';
import { z } from 'zod';

import {
  type ConfigDiagnostic,
  type ConfigStripEnv,
  envBindings,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  setDefined,
  snakeToCamel,
  transformPlainObject,
} from '#/app/config/toml';
import { type AssertExact, type Equal } from '#/_base/utils/typeEquality';
import type {
  CognitionConfig,
  ModelOverride,
  ModelRecord,
  ModelsSection,
  ModelUsageParameters,
  ModelUsagePolicy,
} from '#/kosong/model/model';
import type { GenerationParameters } from '#/kosong/model/parameters';
import type { ThinkingConfig } from '#/kosong/model/thinking';
import { ENV_MODEL_PROVIDER_KEY, type OAuthRef, type ProviderConfig, type ProvidersSection } from '#/kosong/provider/provider';
import type { ImagePolicyConfig } from '#/kosong/provider/providerImagePolicy';
import { ProtocolSchema } from '#/kosong/protocol/protocol';
import { RequestIdentityPolicySchema } from '#/kosong/requestIdentity/requestIdentityPolicy';

export { ENV_MODEL_PROVIDER_KEY } from '#/kosong/provider/provider';

export const PROVIDERS_SECTION = 'providers';

export const DEFAULT_PROVIDER_SECTION = 'defaultProvider';

export const ProviderTypeSchema = z.string();

export { OAuthRefSchema };

export const ModelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);

const ImageMimeSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  },
  z.enum([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/heic',
    'image/heif',
    'image/avif',
    'image/tiff',
    'image/x-icon',
  ]),
);

export const ImagePolicyConfigSchema = z.object({
  acceptedTypes: z.array(ImageMimeSchema).min(1).optional(),
  convertUnsupported: z.enum(['off', 'auto', 'png', 'jpeg']).optional(),
});

const StringRecordSchema = z.record(z.string(), z.string());

const ApiDefaultSchema = z.object({ kind: z.literal('api_default') }).strict();
export const GenerationParametersSchema = z.object({
  temperature: z.union([z.number().finite().min(0), ApiDefaultSchema]).optional(),
  topP: z.union([z.number().finite().min(0).max(1), ApiDefaultSchema]).optional(),
  maxCompletionTokens: z.number().int().positive().finite().optional(),
  thinkingEffort: z.string().trim().min(1).optional(),
  serviceTier: z.union([z.enum(['auto', 'default', 'flex', 'priority']), ApiDefaultSchema]).optional(),
});
type _AssertGenerationParameters = AssertExact<Equal<z.infer<typeof GenerationParametersSchema>, GenerationParameters>>;

export const ModelUsageParametersSchema = GenerationParametersSchema.pick({ thinkingEffort: true, serviceTier: true, maxCompletionTokens: true }).extend({
  autoCompact: z.number().int().positive().safe().optional(),
  contextBudget: z.number().int().positive().safe().optional(),
}).strict();
export const ModelUsagePolicySchema = z.object({
  main: ModelUsageParametersSchema.optional(),
  independent: ModelUsageParametersSchema.optional(),
}).strict();
type _AssertModelUsageParameters = AssertExact<Equal<z.infer<typeof ModelUsageParametersSchema>, ModelUsageParameters>>;
type _AssertModelUsagePolicy = AssertExact<Equal<z.infer<typeof ModelUsagePolicySchema>, ModelUsagePolicy>>;

const ProviderConfigObjectSchema = z.object({
  modelSource: ModelSourceSchema.optional(),

  baseUrl: z.string().optional(),
  customHeaders: StringRecordSchema.optional(),
  defaultModel: z.string().optional(),
  defaults: GenerationParametersSchema.optional(),
  requestIdentity: RequestIdentityPolicySchema.optional(),
  images: ImagePolicyConfigSchema.optional(),

  type: ProviderTypeSchema.optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export const ProviderConfigSchema = z.preprocess((value, ctx) => {
  if (isPlainObject(value)) {
    for (const removed of ['requestAttribution', 'requestOriginator'] as const) {
      if (removed in value) {
        ctx.addIssue({
          code: 'custom',
          message: `${removed} was removed; use requestIdentity`,
          path: [removed],
        });
      }
    }
  }
  return value;
}, ProviderConfigObjectSchema);

export const ProvidersSectionSchema = z.record(z.string(), ProviderConfigSchema);

type _AssertOAuthRef = AssertExact<Equal<z.infer<typeof OAuthRefSchema>, OAuthRef>>;
type _AssertImagePolicyConfig = AssertExact<
  Equal<z.infer<typeof ImagePolicyConfigSchema>, ImagePolicyConfig>
>;
type _AssertProviderConfig = AssertExact<
  Equal<z.infer<typeof ProviderConfigSchema>, ProviderConfig>
>;
type _AssertProvidersSection = AssertExact<
  Equal<z.infer<typeof ProvidersSectionSchema>, ProvidersSection>
>;

export const providersEnvBindings = envBindings(ProvidersSectionSchema, {
  [ENV_MODEL_PROVIDER_KEY]: envBindings(ProviderConfigSchema, {
    apiKey: 'KIKI_MODEL_API_KEY',
    type: 'KIKI_MODEL_PROVIDER_TYPE',
    baseUrl: 'KIKI_MODEL_BASE_URL',
  }),
});

export const stripProvidersEnv: ConfigStripEnv<Record<string, unknown>> = (value) => {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (!(ENV_MODEL_PROVIDER_KEY in value)) return value;
  const out = { ...value };
  delete out[ENV_MODEL_PROVIDER_KEY];
  return out;
};

export const providersFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(rawSnake)) {
    out[name] = isPlainObject(entry) ? providerEntryFromToml(entry) : entry;
  }
  return out;
};

function providerEntryFromToml(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? deepSnakeToCamel(value) : value;
    } else if (targetKey === 'requestIdentity' || targetKey === 'images' || targetKey === 'defaults') {
      out[targetKey] = isPlainObject(value) ? deepSnakeToCamel(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = isPlainObject(value) ? cloneRecord(value) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

export const providersToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    out[name] = isPlainObject(entry) ? providerEntryToToml(entry, rawSub[name]) : entry;
  }
  return out;
};

function providerEntryToToml(
  provider: Record<string, unknown>,
  rawProvider: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawProvider);
  delete out['request_attribution'];
  delete out['request_originator'];
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'oauth' && isPlainObject(value)) {
      out[camelToSnake(key)] = deepCamelToSnake(value);
    } else if ((key === 'requestIdentity' || key === 'images' || key === 'defaults') && isPlainObject(value)) {
      out[camelToSnake(key)] = deepCamelToSnake(value);
    } else if ((key === 'env' || key === 'customHeaders') && value !== undefined) {
      out[camelToSnake(key)] = cloneRecord(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function deepSnakeToCamel(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      snakeToCamel(key),
      isPlainObject(entry) ? deepSnakeToCamel(entry) : entry,
    ]),
  );
}

function deepCamelToSnake(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      camelToSnake(key),
      isPlainObject(entry) ? deepCamelToSnake(entry) : entry,
    ]),
  );
}

registerConfigSection(PROVIDERS_SECTION, ProvidersSectionSchema, {
  defaultValue: {},
  env: providersEnvBindings,
  stripEnv: stripProvidersEnv,
  fromToml: providersFromToml,
  toToml: providersToToml,
  entryKeyed: ProviderConfigSchema,
});

export const REQUEST_IDENTITY_SECTION = 'requestIdentity';

export const requestIdentityFromToml = (rawSnake: unknown): unknown =>
  isPlainObject(rawSnake) ? deepSnakeToCamel(rawSnake) : rawSnake;

export const requestIdentityToToml = (value: unknown): unknown =>
  isPlainObject(value) ? deepCamelToSnake(value) : value;

registerConfigSection(REQUEST_IDENTITY_SECTION, RequestIdentityPolicySchema, {
  fromToml: requestIdentityFromToml,
  toToml: requestIdentityToToml,
});

export const MODELS_SECTION = 'models';

export const DEFAULT_MODEL_SECTION = 'defaultModel';

const ModelBaseSchema = z.object({
  providerId: z.string().optional(),

  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),

  protocol: ProtocolSchema.optional(),

  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),

  provider: z.string().optional(),
  model: z.string().optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  betaApi: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
  contextBudget: z.number().int().min(1).optional(),
  autoCompact: z.number({ error: 'model auto_compact must be an absolute positive integer token count, not a percentage' }).int().positive().safe().optional(),
  maxCompletionTokens: z.number().int().min(1).optional(),
  serviceTier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  requestParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  parameters: GenerationParametersSchema.optional(),
  images: ImagePolicyConfigSchema.optional(),
});

export const ModelOverrideSchema = ModelBaseSchema.omit({
  providerId: true,
  baseUrl: true,
  apiKey: true,
  oauth: true,
  protocol: true,
  name: true,
  aliases: true,
  provider: true,
  model: true,
  betaApi: true,
  images: true,
  parameters: true,
}).partial();

const CognitionPathSchema = z.string().min(1).refine((ref) => {
  const path = ref.trim().replaceAll('\\', '/');
  if (path.length === 0 || path.startsWith('/') || /^[a-z]:/i.test(path)) return false;
  let depth = 0;
  for (const part of path.split('/')) {
    if (part === '..') depth--;
    else if (part !== '' && part !== '.') depth++;
    if (depth < 0) return false;
  }
  return true;
}, { message: 'Cognition paths must be non-empty paths relative to and inside the Kiki home directory' });
const CognitionPathRefSchema = z.union([
  CognitionPathSchema,
  z.array(CognitionPathSchema).min(1).readonly(),
]);

const CognitionContentSchema = z.object({
  overlay: CognitionPathRefSchema.optional(),
  steering: CognitionPathRefSchema.optional(),
  anchor: CognitionPathRefSchema.optional(),
  overlayMode: z.enum(['append', 'prepend', 'wrap', 'persona', 'replace']).optional(),
  anchorSteps: z.number().int().min(1).optional(),
  anchorScope: z.enum(['session', 'turn']).optional(),
  steeringOnTurn: modelSteeringCadenceSchema.shape.steering_on_turn,
  steeringOnInput: modelSteeringCadenceSchema.shape.steering_on_input,
  steeringIntervalSteps: modelSteeringCadenceSchema.shape.steering_interval_steps,
}).strict();
const CognitionBranchSchema = z.union([
  z.enum(['same', 'off']),
  CognitionContentSchema.refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'An independent cognition configuration must set at least one field; use off to disable it',
  }),
]);
export const CognitionConfigSchema = CognitionContentSchema.extend({
  main: CognitionBranchSchema.optional(),
  independent: CognitionBranchSchema.optional(),
}).superRefine((value, ctx) => {
  const hasCommon = Object.entries(value).some(([key, field]) => key !== 'main' && key !== 'independent' && field !== undefined);
  for (const position of ['main', 'independent'] as const) {
    if (value[position] === 'same' && !hasCommon) {
      ctx.addIssue({ code: 'custom', path: [position], message: 'same requires common cognition fields; omit the branch when there is no common content' });
    }
  }
});

export const ModelRecordSchema = ModelBaseSchema.extend({
  pricingModel: z.string().trim().min(1).optional(),
  serviceTier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  overrides: ModelOverrideSchema.optional(),
  usage: ModelUsagePolicySchema.optional(),
  behavior: modelBehaviorConfigSchema.optional(),
  recipe: z.string().min(1).optional(),
  cognition: CognitionConfigSchema.optional(),
  promptOverrides: PromptOverridesSchema.optional(),
  requestIdentity: RequestIdentityPolicySchema.optional(),
}).passthrough();

export const ModelsSectionSchema = z.record(z.string(), ModelRecordSchema);

type _AssertModelOverride = AssertExact<
  Equal<z.infer<typeof ModelOverrideSchema>, ModelOverride>
>;
type _AssertCognitionConfig = AssertExact<
  Equal<z.infer<typeof CognitionConfigSchema>, CognitionConfig>
>;
type _AssertModelRecord = AssertExact<Equal<z.infer<typeof ModelRecordSchema>, ModelRecord>>;
type _AssertModelsSection = AssertExact<
  Equal<z.infer<typeof ModelsSectionSchema>, ModelsSection>
>;

const MODEL_OBJECT_FIELDS = new Set(
  Object.entries(ModelRecordSchema.shape)
    .filter(([, field]) => unwrapWrapperSchema(field as z.ZodTypeAny) instanceof z.ZodObject)
    .map(([key]) => camelToSnake(key)),
);

function unwrapWrapperSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current.unwrap() as z.ZodTypeAny;
  }
  return current;
}

function collectMalformedModelEntries(rawModels: unknown): ConfigDiagnostic[] {
  if (!isPlainObject(rawModels)) return [];
  const diagnostics: ConfigDiagnostic[] = [];
  for (const [alias, entry] of Object.entries(rawModels)) {
    if (!isPlainObject(entry)) continue;
    if (entry['model'] !== undefined || entry['name'] !== undefined) continue;
    diagnostics.push({
      domain: MODELS_SECTION,
      severity: 'warning',
      message: malformedModelMessage(alias, entry),
    });
  }
  return diagnostics;
}

function malformedModelMessage(alias: string, entry: Record<string, unknown>): string {
  const base = `[models] entry '${alias}' is missing the 'model' field and cannot be used as a model`;
  const dottedAlias = dottedAliasSuffix(alias, entry);
  if (dottedAlias === undefined) return `${base}.`;
  return `${base}; if the alias contains dots, quote the table name (e.g. [models."${dottedAlias}"]).`;
}

function dottedAliasSuffix(alias: string, entry: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(entry)) {
    if (MODEL_OBJECT_FIELDS.has(key) || !isPlainObject(value)) continue;
    return dottedAliasSuffix(`${alias}.${key}`, value) ?? `${alias}.${key}`;
  }
  return undefined;
}

export const modelsFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(rawSnake)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const converted = transformPlainObject(entry);
    if (isPlainObject(converted['overrides'])) {
      converted['overrides'] = transformPlainObject(converted['overrides']);
    }
    if (isPlainObject(converted['cognition'])) {
      converted['cognition'] = cognitionFromToml(converted['cognition']);
    }
    if (isPlainObject(converted['requestIdentity'])) {
      converted['requestIdentity'] = deepSnakeToCamel(converted['requestIdentity']);
    }
    if (isPlainObject(converted['images'])) {
      converted['images'] = deepSnakeToCamel(converted['images']);
    }
    if (isPlainObject(converted['parameters'])) {
      converted['parameters'] = deepSnakeToCamel(converted['parameters']);
    }
    if (isPlainObject(converted['oauth'])) converted['oauth'] = deepSnakeToCamel(converted['oauth']);
    if (isPlainObject(converted['usage'])) {
      converted['usage'] = deepSnakeToCamel(converted['usage']);
    }
    if (isPlainObject(converted['behavior'])) converted['behavior'] = deepSnakeToCamel(converted['behavior']);
    out[id] = converted;
  }
  return out;
};

export const modelsToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const merged = cloneRecord(rawSub[id]);
    for (const [key, field] of Object.entries(entry)) {
      if (key === 'capabilities' && Array.isArray(field)) {
        merged[camelToSnake(key)] = [...field];
      } else if (key === 'overrides' && isPlainObject(field)) {
        merged['overrides'] = modelOverridesToToml(field, merged['overrides']);
      } else if (key === 'cognition' && isPlainObject(field)) {
        merged['cognition'] = cognitionToToml(field, merged['cognition']);
      } else if (key === 'requestIdentity' && isPlainObject(field)) {
        merged['request_identity'] = deepCamelToSnake(field);
      } else if (key === 'images' && isPlainObject(field)) {
        merged['images'] = deepCamelToSnake(field);
      } else if ((key === 'parameters' || key === 'usage' || key === 'oauth' || key === 'behavior') && isPlainObject(field)) {
        merged[key] = deepCamelToSnake(field);
      } else {
        setDefined(merged, camelToSnake(key), field);
      }
    }
    out[id] = merged;
  }
  return out;
};

function modelOverridesToToml(
  overrides: Record<string, unknown>,
  rawSnake: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawSnake);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

export function cognitionFromToml(value: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(value);
  for (const position of ['main', 'independent']) {
    if (isPlainObject(out[position])) out[position] = transformPlainObject(out[position]);
  }
  return out;
}

export function cognitionToToml(
  cognition: Record<string, unknown>,
  rawSnake?: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawSnake);
  for (const [key, value] of Object.entries(cognition)) {
    if ((key === 'overlay' || key === 'steering' || key === 'anchor') && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else if ((key === 'main' || key === 'independent') && isPlainObject(value)) {
      out[key] = cognitionToToml(value, out[key]);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

registerConfigSection(MODELS_SECTION, ModelsSectionSchema, {
  defaultValue: {},
  fromToml: modelsFromToml,
  toToml: modelsToToml,
  collectDiagnostics: collectMalformedModelEntries,
  entryKeyed: ModelRecordSchema,
});

export const THINKING_SECTION = 'thinking';

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  forcedEffort: z.string().optional(),
  keep: z.string().optional(),
});

type _AssertThinkingConfig = AssertExact<
  Equal<z.infer<typeof ThinkingConfigSchema>, ThinkingConfig>
>;

export const thinkingEnvBindings = envBindings(ThinkingConfigSchema, {
  forcedEffort: 'KIKI_MODEL_THINKING_EFFORT',
});

export const stripThinkingEnv: ConfigStripEnv<ThinkingConfig> = (value) => {
  const result = { ...value };
  delete result.forcedEffort;
  return result;
};

registerConfigSection(THINKING_SECTION, ThinkingConfigSchema, {
  env: thinkingEnvBindings,
  stripEnv: stripThinkingEnv,
});
