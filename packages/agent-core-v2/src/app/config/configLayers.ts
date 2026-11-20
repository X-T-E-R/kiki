import { deepMerge, isPlainObject } from './configPure';
import type { ConfigOrigin, ConfigSyncScope, IConfigRegistry } from './config';
import { snakeToCamel } from './toml';

export const LOCAL_CONFIG_KEY = 'config.local.toml';

const PORTABLE_DEFAULT_DOMAINS = new Set([
  'defaultModel',
  'defaultProvider',
  'thinking',
  'prompt',
  'modelSwitchPreferences',
  'requestIdentity',
  'requestCompression',
  'responsesWebSocket',
  'anthropicMessageThreads',
  'models',
  'providers',
  'notifications',
  'toolPolicy',
  'permissionRules',
]);

const MACHINE_ONLY_DOMAINS = new Set([
  'credentials',
  'cpuWorkers',
  'sessionManager',
  'ssh',
  'browser',
  'computer',
  'search',
  'agentExecutorInstances',
  'log',
  'gateway',
  'worktrees',
]);

const MACHINE_KEY_PATTERN =
  /(?:^|_|-)(?:path|dir|root|bin|binary|executable|socket|port|host|hostname|listen|bind|address|cwd|home|gpu|cuda|metal|vulkan|hardware|device|display|workers|threads|heap|rss|memory_mb|driver|proxy|cert|key_file|identity_file)(?:$|_|-)/i;

const SECRET_KEY_PATTERN =
  /(?:apikey|accesskey|token|secret|password|authorization|privatekey)$/i;

export function mergeConfigLayers(
  base: Record<string, unknown>,
  home: Record<string, unknown>,
  local?: Record<string, unknown>,
): Record<string, unknown> {
  const merged = deepMerge(base, home);
  return local === undefined || Object.keys(local).length === 0 ? merged : deepMerge(merged, local);
}

export function selectSpaceBaseConfig(
  base: Record<string, unknown>,
  follow: boolean,
  selections?: Record<string, { mode: 'follow' | 'fixed' }>,
): Record<string, unknown> {
  const result = structuredClone(follow ? base : {});
  for (const [id, selection] of Object.entries(selections ?? {})) {
    if (!id.startsWith('config:')) continue;
    const path = id.slice(7).split('.');
    let target = result;
    let source: unknown = base;
    for (const key of path.slice(0, -1)) {
      if (!isPlainObject(target[key])) target[key] = {};
      target = target[key] as Record<string, unknown>;
      source = isPlainObject(source) ? source[key] : undefined;
    }
    const key = path.at(-1)!;
    const value = isPlainObject(source) ? source[key] : undefined;
    if (selection.mode === 'follow' && value !== undefined) target[key] = value;
    else delete target[key];
  }
  return result;
}

export function leafOrigins(
  value: unknown,
  base: unknown,
  home: unknown,
  validated: unknown,
  memory: unknown,
  envFields: ReadonlySet<string>,
  preset?: unknown,
  local?: unknown,
): Record<string, ConfigOrigin> {
  const result: Record<string, ConfigOrigin> = {};
  const at = (root: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>(
      (current, part) => (isPlainObject(current) ? current[part] : undefined),
      root,
    );
  const visit = (entry: unknown, path: string[]): void => {
    if (isPlainObject(entry) && Object.keys(entry).length > 0) {
      for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
      return;
    }
    const key = path.join('.');
    const hasMemory = at(memory, path) !== undefined;
    const fromEnv =
      envFields.has(key) ||
      (at(validated, path) !== undefined && at(validated, path) !== entry && !hasMemory);
    result[key] = hasMemory
      ? 'memory'
      : fromEnv
        ? 'env'
        : at(local, path) !== undefined
          ? 'local'
          : at(home, path) !== undefined
            ? 'home'
            : at(base, path) !== undefined
              ? 'base'
              : at(preset, path) !== undefined
                ? 'preset'
                : 'default';
  };
  visit(value, []);
  return result;
}

/** Classifies whether a config domain/path is portable or machine-local, failing closed to `machine`. */
export function classifyConfigSyncScope(
  domain: string,
  keyPath: readonly string[] = [],
  registry?: Pick<IConfigRegistry, 'getSection'>,
): ConfigSyncScope {
  const camelDomain = snakeToCamel(domain);
  for (const segment of keyPath) {
    const compact = segment.replaceAll(/[_-]/g, '').toLowerCase();
    if (SECRET_KEY_PATTERN.test(compact)) return 'machine';
    const snakeSegment = segment.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (MACHINE_KEY_PATTERN.test(snakeSegment)) return 'machine';
  }
  if (MACHINE_ONLY_DOMAINS.has(camelDomain)) return 'machine';
  const section = registry?.getSection(camelDomain);
  if (section?.syncScope !== undefined) return section.syncScope;
  if (PORTABLE_DEFAULT_DOMAINS.has(camelDomain)) return 'portable';
  return 'machine';
}

function isMachineSpecificStringValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|opt|var|etc|tmp|Volumes)\/)/.test(value.trim());
}

function filterConfigBySyncScope(
  rawSnake: Record<string, unknown>,
  targetScope: ConfigSyncScope,
  registry?: Pick<IConfigRegistry, 'getSection'>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (domain: string, value: unknown, path: readonly string[]): unknown => {
    if (isPlainObject(value)) {
      const childOut: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        const filtered = visit(domain, entry, [...path, key]);
        if (filtered !== undefined) childOut[key] = filtered;
      }
      return Object.keys(childOut).length > 0 ? childOut : undefined;
    }
    const baseScope = classifyConfigSyncScope(domain, path, registry);
    const effectiveScope: ConfigSyncScope =
      baseScope === 'portable' && isMachineSpecificStringValue(value) ? 'machine' : baseScope;
    return effectiveScope === targetScope ? structuredClone(value) : undefined;
  };
  for (const [key, entry] of Object.entries(rawSnake)) {
    const filtered = visit(key, entry, []);
    if (filtered !== undefined) out[key] = filtered;
  }
  return out;
}

/** Extracts only portable configuration entries suitable for cross-machine sync. */
export function extractPortableConfigLayer(
  rawSnake: Record<string, unknown>,
  registry?: Pick<IConfigRegistry, 'getSection'>,
): Record<string, unknown> {
  return filterConfigBySyncScope(rawSnake, 'portable', registry);
}

/** Extracts machine-local configuration entries that stay pinned to this host. */
export function extractMachineLocalConfigLayer(
  rawSnake: Record<string, unknown>,
  registry?: Pick<IConfigRegistry, 'getSection'>,
): Record<string, unknown> {
  return filterConfigBySyncScope(rawSnake, 'machine', registry);
}
