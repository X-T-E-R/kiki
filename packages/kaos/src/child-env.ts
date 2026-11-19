export function mergeChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  defaults: Readonly<Record<string, string>> = {},
  overrides: Readonly<Record<string, string>> = {},
  unset: readonly string[] = [],
  windows = process.platform === 'win32',
): Record<string, string> {
  const env: Record<string, string> = {};
  const spelling = new Map<string, string>();
  const identity = windows ? (name: string): string => name.toLowerCase() : (name: string): string => name;
  const remove = (id: string): void => {
    const key = spelling.get(id);
    if (key === undefined) return;
    delete env[key];
    spelling.delete(id);
  };
  for (const layer of [parent, defaults, overrides]) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      const id = identity(key);
      remove(id);
      env[key] = value;
      spelling.set(id, key);
    }
  }
  for (const key of unset) remove(identity(key));
  return env;
}
