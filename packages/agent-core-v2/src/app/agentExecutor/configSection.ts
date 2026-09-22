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
]);

export const AgentExecutorConfigSchema = z
  .object({
    protocol: z.string().trim().min(1),
    command: z.string().trim().min(1).optional(),
    sources: z.array(AgentExecutorSourceSchema).min(1).optional(),
    source: sourceId.optional(),
    versionProbe: z.object({ args: z.array(z.string()).min(1) }).strict().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    startupTimeoutMs: z.number().int().positive().optional(),
    shutdownGraceMs: z.number().int().nonnegative().optional(),
    modelBinding: z.string().trim().min(1).optional(),
    modelArgs: z.array(z.string()).optional(),
    modelConfigCategory: z.string().trim().min(1).optional(),
    modelConfigId: sourceId.optional(),
    thoughtConfigCategory: z.string().trim().min(1).optional(),
    thoughtConfigId: sourceId.optional(),
    permissionModeMapping: AgentExecutorPermissionModeMappingSchema.optional(),
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

registerConfigSection(AGENT_EXECUTORS_SECTION, AgentExecutorsConfigSchema, {
  defaultValue: BUILTIN_AGENT_EXECUTORS,
  fromToml: agentExecutorsFromToml,
  toToml: agentExecutorsToToml,
});
