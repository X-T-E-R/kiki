export function mergeChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  defaults: Readonly<Record<string, string>> = {},
  overrides: Readonly<Record<string, string>> = {},
  unset: readonly string[] = [],
  windows = process.platform === 'win32',
): Record<string, string> {
  const env: Record<string, string> = {};
  const remove = (name: string): void => {
    for (const key of Object.keys(env)) {
      if (windows ? key.toLowerCase() === name.toLowerCase() : key === name) delete env[key];
    }
  };
  for (const layer of [parent, defaults, overrides]) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      remove(key);
      env[key] = value;
    }
  }
  for (const key of unset) remove(key);
  return env;
}
