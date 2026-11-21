export function lazyContract<T extends object>(create: () => T, ...keys: readonly (keyof T)[]): T {
  let contract: T | undefined;
  const entry = {} as T;
  for (const key of keys) {
    Object.defineProperty(entry, key, {
      enumerable: true,
      get: () => (contract ??= create())[key],
    });
  }
  return entry;
}
