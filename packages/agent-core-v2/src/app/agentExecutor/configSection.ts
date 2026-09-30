import { z } from 'zod';

import { isPlainObject } from '#/app/config/toml';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import { BUILTIN_AGENT_EXECUTORS } from './builtinDescriptors';

export const AGENT_EXECUTORS_SECTION = 'agentExecutors';

const sourceId = z.string().trim().min(1);
const permissionModeValue = z.union([z.string().trim().min(1), z.boolean()]);

const AgentExecutorPermissionModeMappingSchema = z
  .object({
    configId: sourceId.optional(),
    configCategory: sourceId.optional(),
    manual: permissionModeValue,
    auto: permissionModeValue,
    yolo: permissionModeValue,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.configId === undefined) === (value.configCategory === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'exactly one of configId or configCategory is required',
      });
    }
  });

const AgentExecutorPermissionSchema = z.object({
  via: z.enum(['config_option', 'session_mode', 'argv', 'turn_param']),
  flag: z.string().min(1).optional(),
  configId: sourceId.optional(),
  configCategory: sourceId.optional(),
  manual: sourceId,
  review: sourceId.optional(),
  auto: sourceId,
  yolo: sourceId,
  trustEngineSettings: z.boolean().optional(),
}).strict();

const AgentExecutorSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    id: sourceId,
    kind: z.literal('explicit-path'),
    path: z.string().trim().min(1),
  }).strict(),
  z.object({
    id: sourceId,
    kind: z.literal('env'),
    name: z.string().trim().min(1),
  }).strict(),
  z.object({
    id: sourceId,
    kind: z.literal('glob'),
    pattern: z.string().trim().min(1),
    maxDepth: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    id: sourceId,
    kind: z.literal('path-lookup'),
    command: z.string().trim().min(1),
    requiredBasename: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    id: sourceId,
    kind: z.literal('node-script'),
    path: z.string().trim().min(1),
  }).strict(),
]);

export const AgentExecutorConfigSchema = z
  .object({
    protocol: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    sources: z.array(AgentExecutorSourceSchema).min(1).optional(),
    source: sourceId.optional(),
    versionProbe: z.object({ args: z.array(z.string()).min(1) }).strict().optional(),
    diagnostics: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('message'), severity: z.enum(['info', 'warning']), message: z.string() }).strict(),
      z.object({ kind: z.literal('env'), name: sourceId, present: z.string(), absent: z.string() }).strict(),
      z.object({ kind: z.literal('path'), path: sourceId, envHome: sourceId.optional(),
        present: z.string(), absent: z.string(), absentSeverity: z.enum(['info', 'warning']) }).strict(),
      z.object({ kind: z.literal('dependency'), command: sourceId, args: z.array(z.string()),
        unavailable: z.string(), failed: z.string(), label: sourceId.optional(),
        installHint: z.string().optional() }).strict(),
      z.object({ kind: z.literal('flag'), args: z.array(z.string()), stable: sourceId,
        fallback: sourceId, stableMessage: z.string(), fallbackMessage: z.string(), missingMessage: z.string() }).strict(),
      z.object({ kind: z.literal('version'), min: sourceId, maxExclusive: sourceId.optional(), warning: z.string(), normal: z.string() }).strict(),
    ])).optional(),
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('command-json'), command: sourceId,
        args: z.array(z.string()), loggedInKey: sourceId }).strict(),
      z.object({ kind: z.literal('codex-account') }).strict(),
      z.object({ kind: z.literal('claude-credentials'), command: sourceId,
        args: z.array(z.string()) }).strict(),
    ]).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    homeEnv: z.string().trim().min(1).optional(),
    startupTimeoutMs: z.number().int().positive().optional(),
    shutdownGraceMs: z.number().int().nonnegative().optional(),
    modelBinding: z.string().trim().min(1).optional(),
    modelArgs: z.array(z.string()).optional(),
    modelConfigCategory: z.string().trim().min(1).optional(),
    modelConfigId: sourceId.optional(),
    thoughtConfigCategory: z.string().trim().min(1).optional(),
    thoughtConfigId: sourceId.optional(),
    permissionModeMapping: AgentExecutorPermissionModeMappingSchema.optional(),
    permission: AgentExecutorPermissionSchema.optional(),
    promptDeliveries: z.array(z.enum(['append', 'replace', 'preamble'])).optional(),
    supportsMcp: z.boolean().optional(),
    mcpTransports: z.array(z.enum(['stdio', 'http', 'sse'])).min(1).optional(),
    defaultProfile: z.boolean().optional(),
    installHint: z.string().optional(),
    programLabel: z.string().trim().min(1).optional(),
    loginCommand: z.array(z.string()).optional(),
    apiKeyEnv: z.string().trim().min(1).optional(),
    steerDelivery: z.enum(['native', 'next_turn_preamble']).optional(),
    profileDelivery: z.literal('system_prompt_override').optional(),
    revision: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.command === undefined && value.sources === undefined) {
      context.addIssue({ code: 'custom', message: 'command or sources is required' });
    }
    if (
      value.source !== undefined &&
      !value.sources?.some((source) => source.id === value.source)
    ) {
      context.addIssue({ code: 'custom', message: `source "${value.source}" is not declared in sources` });
    }
    const ids = value.sources?.map((source) => source.id) ?? [];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'source ids must be unique' });
    }
  });

export const AgentExecutorsConfigSchema = z.record(
  z.string().trim().min(1),
  AgentExecutorConfigSchema,
);

export type AgentExecutorConfig = z.infer<typeof AgentExecutorConfigSchema>;
export type AgentExecutorsConfig = z.infer<typeof AgentExecutorsConfigSchema>;

const TOML_TO_RUNTIME = {
  startup_timeout_ms: 'startupTimeoutMs',
  shutdown_grace_ms: 'shutdownGraceMs',
  model_binding: 'modelBinding',
  model_args: 'modelArgs',
  model_config_category: 'modelConfigCategory',
  model_config_id: 'modelConfigId',
  thought_config_category: 'thoughtConfigCategory',
  thought_config_id: 'thoughtConfigId',
  permission_mode_mapping: 'permissionModeMapping',
  prompt_deliveries: 'promptDeliveries',
  supports_mcp: 'supportsMcp',
  mcp_transports: 'mcpTransports',
  default_profile: 'defaultProfile',
  install_hint: 'installHint',
  program_label: 'programLabel',
  login_command: 'loginCommand',
  api_key_env: 'apiKeyEnv',
  home_env: 'homeEnv',
  steer_delivery: 'steerDelivery',
  profile_delivery: 'profileDelivery',
  version_probe: 'versionProbe',
} as const;

const RUNTIME_TO_TOML = {
  startupTimeoutMs: 'startup_timeout_ms',
  shutdownGraceMs: 'shutdown_grace_ms',
  modelBinding: 'model_binding',
  modelArgs: 'model_args',
  modelConfigCategory: 'model_config_category',
  modelConfigId: 'model_config_id',
  thoughtConfigCategory: 'thought_config_category',
  thoughtConfigId: 'thought_config_id',
  permissionModeMapping: 'permission_mode_mapping',
  promptDeliveries: 'prompt_deliveries',
  supportsMcp: 'supports_mcp',
  mcpTransports: 'mcp_transports',
  defaultProfile: 'default_profile',
  installHint: 'install_hint',
  programLabel: 'program_label',
  loginCommand: 'login_command',
  apiKeyEnv: 'api_key_env',
  homeEnv: 'home_env',
  steerDelivery: 'steer_delivery',
  profileDelivery: 'profile_delivery',
  versionProbe: 'version_probe',
} as const;

export function agentExecutorsFromToml(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      result[id] = raw;
      continue;
    }
    const descriptor: Record<string, unknown> = { ...raw };
    for (const [tomlKey, runtimeKey] of Object.entries(TOML_TO_RUNTIME)) {
      if (Object.hasOwn(descriptor, tomlKey)) {
        descriptor[runtimeKey] = descriptor[tomlKey];
        delete descriptor[tomlKey];
      }
    }
    if (isPlainObject(descriptor['permissionModeMapping'])) {
      const mapping: Record<string, unknown> = { ...descriptor['permissionModeMapping'] };
      if (Object.hasOwn(mapping, 'config_id')) {
        mapping['configId'] = mapping['config_id'];
        delete mapping['config_id'];
      }
      if (Object.hasOwn(mapping, 'config_category')) {
        mapping['configCategory'] = mapping['config_category'];
        delete mapping['config_category'];
      }
      descriptor['permissionModeMapping'] = mapping;
    }
    if (isPlainObject(descriptor['permission'])) {
      const permission: Record<string, unknown> = { ...descriptor['permission'] };
      for (const [wire, runtime] of [
        ['config_id', 'configId'], ['config_category', 'configCategory'],
        ['trust_engine_settings', 'trustEngineSettings'],
      ] as const) {
        if (Object.hasOwn(permission, wire)) {
          permission[runtime] = permission[wire];
          delete permission[wire];
        }
      }
      descriptor['permission'] = permission;
    }
    if (isPlainObject(descriptor['auth']) && Object.hasOwn(descriptor['auth'], 'logged_in_key')) {
      const auth: Record<string, unknown> = { ...descriptor['auth'], loggedInKey: descriptor['auth']['logged_in_key'] };
      delete auth['logged_in_key'];
      descriptor['auth'] = auth;
    }
    if (Array.isArray(descriptor['diagnostics'])) {
      descriptor['diagnostics'] = descriptor['diagnostics'].map((rule) =>
        isPlainObject(rule) ? renameKey(rule, 'install_hint', 'installHint') : rule);
    }
    if (Array.isArray(descriptor['sources'])) {
      descriptor['sources'] = descriptor['sources'].map((source) => {
        if (!isPlainObject(source)) return source;
        const mapped: Record<string, unknown> = { ...source };
        if (Object.hasOwn(mapped, 'max_depth')) {
          mapped['maxDepth'] = mapped['max_depth'];
          delete mapped['max_depth'];
        }
        if (Object.hasOwn(mapped, 'required_basename')) {
          mapped['requiredBasename'] = mapped['required_basename'];
          delete mapped['required_basename'];
        }
        return mapped;
      });
    }
    result[id] = descriptor;
  }
  return result;
}

export function agentExecutorsToToml(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      result[id] = raw;
      continue;
    }
    const descriptor: Record<string, unknown> = { ...raw };
    for (const [runtimeKey, tomlKey] of Object.entries(RUNTIME_TO_TOML)) {
      if (Object.hasOwn(descriptor, runtimeKey)) {
        descriptor[tomlKey] = descriptor[runtimeKey];
        delete descriptor[runtimeKey];
      }
    }
    if (isPlainObject(descriptor['permission_mode_mapping'])) {
      const mapping: Record<string, unknown> = { ...descriptor['permission_mode_mapping'] };
      if (Object.hasOwn(mapping, 'configId')) {
        mapping['config_id'] = mapping['configId'];
        delete mapping['configId'];
      }
      if (Object.hasOwn(mapping, 'configCategory')) {
        mapping['config_category'] = mapping['configCategory'];
        delete mapping['configCategory'];
      }
      descriptor['permission_mode_mapping'] = mapping;
    }
    if (isPlainObject(descriptor['permission'])) {
      const permission: Record<string, unknown> = { ...descriptor['permission'] };
      for (const [runtime, wire] of [
        ['configId', 'config_id'], ['configCategory', 'config_category'],
        ['trustEngineSettings', 'trust_engine_settings'],
      ] as const) {
        if (Object.hasOwn(permission, runtime)) {
          permission[wire] = permission[runtime];
          delete permission[runtime];
        }
      }
      descriptor['permission'] = permission;
    }
    if (isPlainObject(descriptor['auth']) && Object.hasOwn(descriptor['auth'], 'loggedInKey')) {
      const auth: Record<string, unknown> = { ...descriptor['auth'], logged_in_key: descriptor['auth']['loggedInKey'] };
      delete auth['loggedInKey'];
      descriptor['auth'] = auth;
    }
    if (Array.isArray(descriptor['diagnostics'])) {
      descriptor['diagnostics'] = descriptor['diagnostics'].map((rule) =>
        isPlainObject(rule) ? renameKey(rule, 'installHint', 'install_hint') : rule);
    }
    if (Array.isArray(descriptor['sources'])) {
      descriptor['sources'] = descriptor['sources'].map((source) => {
        if (!isPlainObject(source)) return source;
        const mapped: Record<string, unknown> = { ...source };
        if (Object.hasOwn(mapped, 'maxDepth')) {
          mapped['max_depth'] = mapped['maxDepth'];
          delete mapped['maxDepth'];
        }
        if (Object.hasOwn(mapped, 'requiredBasename')) {
          mapped['required_basename'] = mapped['requiredBasename'];
          delete mapped['requiredBasename'];
        }
        return mapped;
      });
    }
    result[id] = descriptor;
  }
  return result;
}

function renameKey(value: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  if (!Object.hasOwn(value, from)) return value;
  const mapped: Record<string, unknown> = { ...value, [to]: value[from] };
  delete mapped[from];
  return mapped;
}

registerConfigSection(AGENT_EXECUTORS_SECTION, AgentExecutorsConfigSchema, {
  defaultValue: BUILTIN_AGENT_EXECUTORS,
  fromToml: agentExecutorsFromToml,
  toToml: agentExecutorsToToml,
});
