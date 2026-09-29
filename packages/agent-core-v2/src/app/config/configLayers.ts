import { deepMerge, isPlainObject } from './configPure';
import type { ConfigOrigin } from './config';

export function mergeConfigLayers(base: Record<string, unknown>, home: Record<string, unknown>): Record<string, unknown> {
  return deepMerge(base, home);
}

export function leafOrigins(
  value: unknown,
  base: unknown,
  home: unknown,
  validated: unknown,
  memory: unknown,
  envFields: ReadonlySet<string>,
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
    result[key] = hasMemory ? 'memory' : fromEnv ? 'env' : at(home, path) !== undefined ? 'home' : at(base, path) !== undefined ? 'base' : 'default';
  };
  visit(value, []);
  return result;
}
