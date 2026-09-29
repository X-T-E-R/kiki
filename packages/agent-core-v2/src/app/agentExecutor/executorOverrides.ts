import { createHash } from 'node:crypto';
import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { deepMerge } from '#/app/config/configPure';
import { isPlainObject } from '#/app/config/toml';

import type {
  AgentExecutorBinarySource,
  AgentExecutorDescriptor,
} from './agentExecutor';

/** Config section carrying per-engine launch overrides, keyed by executor id. */
export const AGENT_EXECUTOR_OVERRIDES_SECTION = 'agentExecutorOverrides';

/** Source id an explicit `bin_path` reports through, so the check can say where the program came from. */
export const EXECUTOR_OVERRIDE_SOURCE_ID = 'override';

export const AgentExecutorOverrideSchema = z.object({
  binPath: z.string().trim().min(1).optional(),
  homeDir: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  args: z.array(z.string()).optional(),
}).strict();

export const AgentExecutorOverridesSchema = z.record(z.string(), AgentExecutorOverrideSchema);
export type AgentExecutorOverride = z.infer<typeof AgentExecutorOverrideSchema>;
export type AgentExecutorOverridesConfig = z.infer<typeof AgentExecutorOverridesSchema>;

/**
 * Config PATCH uses null to remove a nested override without replacing other
 * engine entries. Strip those tombstones before the entry schema sees the
 * merged value, and treat an empty args/env patch as clearing that field.
 */
function mergeAgentExecutorOverrides(
  base: AgentExecutorOverridesConfig | undefined,
  patch: unknown,
): AgentExecutorOverridesConfig {
  const merged = deepMerge(base, patch) as Record<string, unknown>;
  if (!isPlainObject(patch)) return merged as AgentExecutorOverridesConfig;
  for (const [id, raw] of Object.entries(patch)) {
    if (!isPlainObject(raw) || !isPlainObject(merged[id])) continue;
    const entry = { ...merged[id] };
    if (raw['binPath'] === null) delete entry['binPath'];
    if (raw['homeDir'] === null) delete entry['homeDir'];
    if (raw['args'] === null || (Array.isArray(raw['args']) && raw['args'].length === 0)) delete entry['args'];
    const envPatch = raw['env'];
    if (envPatch === null) {
      delete entry['env'];
    } else if (isPlainObject(envPatch) && isPlainObject(entry['env'])) {
      const env = { ...entry['env'] };
      for (const [key, value] of Object.entries(envPatch)) {
        if (value === null) delete env[key];
      }
      if (Object.keys(env).length === 0) delete entry['env'];
      else entry['env'] = env;
    }
    merged[id] = entry;
  }
  return merged as AgentExecutorOverridesConfig;
}

const TOML_TO_RUNTIME = {
  bin_path: 'binPath',
  home_dir: 'homeDir',
} as const;

const RUNTIME_TO_TOML = {
  binPath: 'bin_path',
  homeDir: 'home_dir',
} as const;

export function agentExecutorOverridesFromToml(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      result[id] = raw;
      continue;
    }
    const entry: Record<string, unknown> = { ...raw };
    for (const [tomlKey, runtimeKey] of Object.entries(TOML_TO_RUNTIME)) {
      if (Object.hasOwn(entry, tomlKey)) {
        entry[runtimeKey] = entry[tomlKey];
        delete entry[tomlKey];
      }
    }
    result[id] = entry;
  }
  return result;
}

export function agentExecutorOverridesToToml(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) {
      result[id] = raw;
      continue;
    }
    const entry: Record<string, unknown> = { ...raw };
    for (const [runtimeKey, tomlKey] of Object.entries(RUNTIME_TO_TOML)) {
      if (Object.hasOwn(entry, runtimeKey)) {
        entry[tomlKey] = entry[runtimeKey];
        delete entry[runtimeKey];
      }
    }
    result[id] = entry;
  }
  return result;
}

/**
 * Reads a user override as an executable source. A `.js`/`.mjs`/`.cjs` entry
 * launches through node the way a managed adapter does; anything with a path
 * shape is probed in place; a bare name is looked up on PATH, so a user can
 * type either `claude-agent-acp` or an absolute path.
 */
export function executorOverrideSource(binPath: string): AgentExecutorBinarySource {
  const value = binPath.trim();
  if (/\.[cm]?js$/i.test(value)) return { id: EXECUTOR_OVERRIDE_SOURCE_ID, kind: 'node-script', path: value };
  const pathLike = value.startsWith('~') || value.includes('${') || /%[^%]+%/.test(value) ||
    /[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
  return pathLike
    ? { id: EXECUTOR_OVERRIDE_SOURCE_ID, kind: 'explicit-path', path: value }
    : { id: EXECUTOR_OVERRIDE_SOURCE_ID, kind: 'path-lookup', command: value };
}

function mergeEnv(
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (override === undefined || Object.keys(override).length === 0) return base;
  return { ...base, ...override };
}

function overrideRevision(base: string, override: AgentExecutorOverride): string {
  const canonical = JSON.stringify({
    binPath: override.binPath,
    homeDir: override.homeDir,
    args: override.args,
    env: override.env === undefined
      ? undefined
      : Object.fromEntries(Object.entries(override.env).toSorted(([left], [right]) => left.localeCompare(right))),
  });
  return createHash('sha256').update(`${base}\n${canonical}`).digest('hex');
}

/**
 * Folds a user override into an engine descriptor. An explicit `binPath`
 * REPLACES discovery — the user asked for that program, so a probe failure is
 * reported instead of silently falling back to another candidate.
 */
export function applyExecutorOverride(
  descriptor: AgentExecutorDescriptor,
  override: AgentExecutorOverride | undefined,
): AgentExecutorDescriptor {
  if (override === undefined) return descriptor;
  const env = mergeEnv(descriptor.env, override.env);
  if (
    override.binPath === undefined && env === descriptor.env &&
    override.homeDir === undefined && override.args === undefined
  ) {
    return descriptor;
  }
  return {
    ...descriptor,
    sources: override.binPath === undefined ? descriptor.sources : [executorOverrideSource(override.binPath)],
    env,
    homeDir: override.homeDir,
    extraArgs: override.args,
    revision: overrideRevision(descriptor.revision, override),
  };
}

/**
 * The environment a launched engine process needs on top of its inherited one:
 * the configured home directory mapped onto the engine's own variable, then the
 * user's extra variables over it. `undefined` means "inherit unchanged", which
 * is what keeps `~/.claude` and friends readable when nothing is configured.
 */
export function executorProcessEnv(
  descriptor: AgentExecutorDescriptor,
): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};
  const home = descriptor.homeDir;
  if (home !== undefined && home.trim().length > 0 && descriptor.homeEnv !== undefined) {
    overrides[descriptor.homeEnv] = home.trim();
  }
  if (descriptor.env !== undefined) Object.assign(overrides, descriptor.env);
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

/** Launch arguments after the descriptor's own, so extra flags never displace the resolved ones. */
export function executorLaunchArgs(
  descriptor: AgentExecutorDescriptor,
  args: readonly string[],
): readonly string[] {
  return descriptor.extraArgs === undefined || descriptor.extraArgs.length === 0
    ? args
    : [...args, ...descriptor.extraArgs];
}

/** One environment lookup for everything that runs before the child does: extra variables win, then the host environment. */
export function executorEnvLookup(
  descriptor: AgentExecutorDescriptor,
  host: (name: string) => string | undefined,
): (name: string) => string | undefined {
  const overrides = executorProcessEnv(descriptor);
  return (name) => overrides?.[name] ?? host(name);
}

registerConfigSection(AGENT_EXECUTOR_OVERRIDES_SECTION, AgentExecutorOverridesSchema, {
  entryKeyed: AgentExecutorOverrideSchema,
  merge: mergeAgentExecutorOverrides,
  fromToml: agentExecutorOverridesFromToml,
  toToml: agentExecutorOverridesToToml,
});
