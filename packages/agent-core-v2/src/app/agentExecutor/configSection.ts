import { z } from 'zod';

import { isPlainObject } from '#/app/config/toml';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const AGENT_EXECUTORS_SECTION = 'agentExecutors';

export const AgentExecutorConfigSchema = z
  .object({
    protocol: z.string().trim().min(1),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    startupTimeoutMs: z.number().int().positive().optional(),
    shutdownGraceMs: z.number().int().nonnegative().optional(),
    modelBinding: z.string().trim().min(1).optional(),
    modelConfigCategory: z.string().trim().min(1).optional(),
    thoughtConfigCategory: z.string().trim().min(1).optional(),
  })
  .strict();

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
  model_config_category: 'modelConfigCategory',
  thought_config_category: 'thoughtConfigCategory',
} as const;

const RUNTIME_TO_TOML = {
  startupTimeoutMs: 'startup_timeout_ms',
  shutdownGraceMs: 'shutdown_grace_ms',
  modelBinding: 'model_binding',
  modelConfigCategory: 'model_config_category',
  thoughtConfigCategory: 'thought_config_category',
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
    result[id] = descriptor;
  }
  return result;
}

registerConfigSection(AGENT_EXECUTORS_SECTION, AgentExecutorsConfigSchema, {
  defaultValue: {},
  fromToml: agentExecutorsFromToml,
  toToml: agentExecutorsToToml,
});
