import { resolve } from 'node:path';

import { stableFingerprint, type CanonicalConfig, type CanonicalConfigPatch } from '@nb-corp/nb-search';
import { z } from 'zod';

import { nbSearchPaths, resolveNbSearchConfig } from './donorConfig';
import { copyNbSearchEnvironment, nbSearchEnvironmentName } from './environment';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const bindingSchema = z.object({ instance: z.string(), provider: z.string(), slot: z.string(), env: envName, base_url: z.string().nullable() }).strict();

/** nb-search CLI secrets schema; values never leave the server-side source adapter. */
export const localSecretSchema = z.object({
  schema_version: z.literal('1'),
  values: z.record(envName, z.string()),
  bindings: z.record(envName, z.array(bindingSchema).min(1)).optional(),
}).strict();

export type LocalSecretFile = z.infer<typeof localSecretSchema>;

export class LocalCredentialError extends Error {
  constructor(readonly issue: 'LOCAL_CREDENTIAL_CONFIG_OVERRIDE' | 'LOCAL_CREDENTIAL_BINDING_MISMATCH') {
    super(issue);
    this.name = 'LocalCredentialError';
  }
}

/**
 * Applies nb-search CLI allowset, explicit-environment precedence and imported
 * bindings, additionally prohibiting Kiki overlays from redirecting credentials
 * even when an older CLI secret file does not carry binding metadata.
 */
export function applyLocalCredentials(
  env: NodeJS.ProcessEnv,
  secrets: LocalSecretFile,
  canonical: CanonicalConfigPatch | undefined,
  kiki: CanonicalConfigPatch | undefined,
): { env: NodeJS.ProcessEnv; config: CanonicalConfig; usedLocalCredentials: boolean } {
  env = copyNbSearchEnvironment(env);
  assertDistinctEnvironmentNames(env, secrets.values);
  assertDistinctEnvironmentNames(env, secrets.bindings ?? {});
  const original = resolveNbSearchConfig(env, canonical, undefined);
  const effective = resolveNbSearchConfig(env, canonical, kiki);
  const allowed = new Set(Object.values(original.credential_slots).map((slot) => nbSearchEnvironmentName(env, slot.env)));
  const copy = copyNbSearchEnvironment(env);
  const injected: string[] = [];
  for (const [name, value] of Object.entries(secrets.values)) {
    if (allowed.has(nbSearchEnvironmentName(env, name)) && !Object.hasOwn(env, name)) {
      Object.defineProperty(copy, name, { value, enumerable: true, configurable: true, writable: true });
      injected.push(name);
    }
  }
  if (!samePath(nbSearchPaths(copy).canonical, nbSearchPaths(env).canonical)) {
    throw new LocalCredentialError('LOCAL_CREDENTIAL_CONFIG_OVERRIDE');
  }
  let withCredentials: CanonicalConfig;
  try {
    const originalWithCredentials = resolveNbSearchConfig(copy, canonical, undefined);
    withCredentials = resolveNbSearchConfig(copy, canonical, kiki);
    if (stableFingerprint(originalWithCredentials) !== stableFingerprint(original)
      || stableFingerprint(withCredentials) !== stableFingerprint(effective)) {
      throw new LocalCredentialError('LOCAL_CREDENTIAL_CONFIG_OVERRIDE');
    }
  } catch {
    throw new LocalCredentialError('LOCAL_CREDENTIAL_CONFIG_OVERRIDE');
  }
  const paths = nbSearchPaths(env);
  for (const [name, expected] of Object.entries(secrets.bindings ?? {})) {
    if (Object.hasOwn(env, name)) continue;
    if (!samePath(paths.canonical, resolve(paths.home, 'config.json'))
      || bindingFingerprint(bindings(original, name, env), env) !== bindingFingerprint(expected, env)
      || bindingFingerprint(bindings(withCredentials, name, env), env) !== bindingFingerprint(expected, env)) {
      throw new LocalCredentialError('LOCAL_CREDENTIAL_BINDING_MISMATCH');
    }
  }
  for (const name of injected) {
    if (bindingFingerprint(bindings(original, name, env), env) !== bindingFingerprint(bindings(withCredentials, name, env), env)) {
      throw new LocalCredentialError('LOCAL_CREDENTIAL_BINDING_MISMATCH');
    }
  }
  return { env: copy, config: withCredentials, usedLocalCredentials: injected.length > 0 };
}

function bindings(config: CanonicalConfig, name: string, env: NodeJS.ProcessEnv): z.infer<typeof bindingSchema>[] {
  const normalized = nbSearchEnvironmentName(env, name);
  return Object.entries(config.provider_instances).flatMap(([id, instance]) => {
    const slot = instance.credential_slot_id;
    const binding = slot === undefined ? undefined : config.credential_slots[slot];
    return binding !== undefined && slot !== undefined && nbSearchEnvironmentName(env, binding.env) === normalized
      ? [{ instance: id, provider: instance.provider_id, slot, env: binding.env, base_url: instance.base_url ?? null }]
      : [];
  });
}

function bindingFingerprint(value: z.infer<typeof bindingSchema>[], env: NodeJS.ProcessEnv): string {
  return stableFingerprint(value
    .map((binding) => ({ ...binding, env: nbSearchEnvironmentName(env, binding.env) }))
    .toSorted((a, b) => a.instance.localeCompare(b.instance)));
}

function assertDistinctEnvironmentNames(env: NodeJS.ProcessEnv, record: Readonly<Record<string, unknown>>): void {
  const names = new Set<string>();
  for (const name of Object.keys(record)) {
    const normalized = nbSearchEnvironmentName(env, name);
    if (names.has(normalized)) throw new LocalCredentialError('LOCAL_CREDENTIAL_BINDING_MISMATCH');
    names.add(normalized);
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
