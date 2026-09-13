const platforms = new WeakMap<object, NodeJS.Platform>();

/** The credential-name equality rule used by both lookup and binding validation. */
export function nbSearchEnvironmentName(env: NodeJS.ProcessEnv, name: string): string {
  return normalizeName(name, platforms.get(env) ?? process.platform);
}

function normalizeName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/** Copies environment values without losing Windows lookup and own-key semantics. */
export function copyNbSearchEnvironment(env: NodeJS.ProcessEnv, platform = platforms.get(env) ?? process.platform): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = Object.create(null);
  const key = (name: PropertyKey): PropertyKey => typeof name === 'string' ? normalizeName(name, platform) : name;
  for (const [name, value] of Object.entries(env)) copy[key(name) as string] = value;
  if (platform !== 'win32') {
    platforms.set(copy, platform);
    return copy;
  }
  const result = new Proxy(copy, {
    get: (target, name) => Reflect.get(target, key(name)),
    has: (target, name) => Reflect.has(target, key(name)),
    getOwnPropertyDescriptor: (target, name) => Reflect.getOwnPropertyDescriptor(target, key(name)),
    set: (target, name, value) => Reflect.set(target, key(name), value),
    defineProperty: (target, name, descriptor) => Reflect.defineProperty(target, key(name), descriptor),
    deleteProperty: (target, name) => Reflect.deleteProperty(target, key(name)),
  });
  platforms.set(result, platform);
  return result;
}
