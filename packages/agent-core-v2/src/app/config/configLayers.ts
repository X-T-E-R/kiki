import { deepMerge, isPlainObject } from './configPure';
import type { ConfigOrigin } from './config';

export function mergeConfigLayers(base: Record<string, unknown>, home: Record<string, unknown>): Record<string, unknown> {
  return deepMerge(base, home);
}

export function selectSpaceBaseConfig(base: Record<string, unknown>, follow: boolean, selections?: Record<string, { mode: 'follow' | 'fixed' }>): Record<string, unknown> {
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
): Record<string, ConfigOrigin> {
  const result: Record<string, ConfigOrigin> = {};
  const at = (root: unknown, path: readonly string[]): unknown => path.reduce<unknown>((current, part) => isPlainObject(current) ? current[part] : undefined, root);
  const visit = (entry: unknown, path: string[]): void => {
    if (isPlainObject(entry) && Object.keys(entry).length > 0) {
      for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
      return;
    }
    const key = path.join('.');
    const hasMemory = at(memory, path) !== undefined;
    const fromEnv = envFields.has(key) || (at(validated, path) !== undefined && at(validated, path) !== entry && !hasMemory);
    result[key] = hasMemory ? 'memory' : fromEnv ? 'env' : at(home, path) !== undefined ? 'home' : at(base, path) !== undefined ? 'base' : at(preset, path) !== undefined ? 'preset' : 'default';
  };
  visit(value, []);
  return result;
}
