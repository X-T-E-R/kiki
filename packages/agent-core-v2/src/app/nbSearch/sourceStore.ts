import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import type { NbSearchConfigSourceStatus } from '@kiki/protocol';
import { parseConfigPatch, type CanonicalConfigPatch } from '@nb-corp/nb-search';

import { NbSearchCredentialFileStore, NbSearchLocalFileError } from './credentialFileStore';
import { Error2, ErrorCodes } from '#/errors';
import { nbSearchConfigIssues, nbSearchConfigRevision, nbSearchPaths, pinnedNbSearchConfig, resolveNbSearchConfig } from './donorConfig';
import { applyLocalCredentials, LocalCredentialError, localSecretSchema } from './localCredentials';
import { copyNbSearchEnvironment, nbSearchEnvironmentName } from './environment';
import { NbSearchManagedCredentials, ManagedCredentialError, managedBinding, managedBindingVersion, managedEntryMatches } from './managedCredentials';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const isolatedConfigBytes = new TextEncoder().encode('{}');
let isolatedConfigSequence = 0;

export interface NbSearchSource {
  readonly env: NodeJS.ProcessEnv;
  readonly status: NbSearchConfigSourceStatus;
  readonly config?: CanonicalConfigPatch;
  readonly expectedRevision?: string;
  readonly managedSlots?: readonly string[];
}

export interface ManagedCredentialView {
  readonly instance_id: string;
  readonly slot_id: string;
  readonly stored: boolean;
  readonly active: boolean;
  readonly source: 'environment' | 'local' | 'managed' | 'none';
  readonly version: string;
  readonly binding_version: string;
  readonly value?: string;
}

export interface INbSearchSourceStore {
  readonly _serviceBrand: undefined;
  withSource<T>(reuseLocalConfig: boolean, config: CanonicalConfigPatch | undefined, use: (source: NbSearchSource) => T | Promise<T>): Promise<T>;
  readManaged(source: NbSearchSource, instanceId: string, reveal: boolean): Promise<ManagedCredentialView>;
  writeManaged(source: NbSearchSource, currentConfig: () => { config: CanonicalConfigPatch | undefined; reuseLocalConfig: boolean; generation: number }, instanceId: string, value: string | null, expectedVersion: string, expectedBinding: string): Promise<ManagedCredentialView>;
}

export const INbSearchSourceStore: ServiceIdentifier<INbSearchSourceStore> =
  createDecorator<INbSearchSourceStore>('nbSearchSourceStore');

/**
 * Adapts nb-search 0.2's public environment-based file loader without changing
 * the daemon environment or the local nb-search file. Isolation uses a real
 * empty canonical document in Kiki storage, with Kiki-owned default job paths;
 * explicit Kiki canonical path settings still take precedence over defaults.
 *
 * Credential precedence is a single ordered chain: process environment, then
 * the local nb-search CLI file, then Kiki-managed values. A managed value only
 * enters a slot no earlier layer supplies. An unreadable managed document, or a
 * stored slot whose binding no longer matches, drops only the affected managed
 * credential and reports it; the base source and unrelated lanes stay available.
 *
 * An invalid or unreadable local CLI secrets file is ignored the same way: the
 * source stays available, no managed value is substituted for a slot the file
 * could have supplied, and unrelated keyless or explicitly env-provided lanes
 * keep running. A CLI file whose imported binding no longer matches stays
 * fail-closed so a stored credential is never redirected to another account.
 */
export class NbSearchSourceStore implements INbSearchSourceStore {
  declare readonly _serviceBrand: undefined;

  readonly #credentialFiles: NbSearchCredentialFileStore;
  readonly #managed: NbSearchManagedCredentials;
  readonly #isolatedConfigKey = `isolated-config.${process.pid}.${isolatedConfigSequence += 1}.json`;
  #isolatedConfigPathPromise?: Promise<string | undefined>;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {
    this.#credentialFiles = new NbSearchCredentialFileStore(fs);
    this.#managed = new NbSearchManagedCredentials(storage);
  }

  async withSource<T>(reuseLocalConfig: boolean, config: CanonicalConfigPatch | undefined, use: (source: NbSearchSource) => T | Promise<T>): Promise<T> {
    if (typeof use !== 'function') throw new Error2(ErrorCodes.REQUEST_INVALID, 'nb-search source access requires an in-process consumer.');
    return use(await this.#resolve(reuseLocalConfig, config));
  }

  async readManaged(source: NbSearchSource, instanceId: string, reveal: boolean): Promise<ManagedCredentialView> {
    const { slotId, config } = this.#target(source, instanceId);
    const { entry, version } = await this.#managed.read(slotId);
    const matches = managedEntryMatches(entry, config, slotId, source.env);
    const name = config.credential_slots[slotId]!.env;
    const normalized = nbSearchEnvironmentName(source.env, name);
    const fromProcess = Object.keys(process.env).some((key) => nbSearchEnvironmentName(source.env, key) === normalized);
    const fromManaged = source.managedSlots?.includes(slotId) ?? false;
    const managedAlias = source.managedSlots?.some((id) => {
      const other = config.credential_slots[id];
      return other !== undefined && nbSearchEnvironmentName(source.env, other.env) === normalized;
    }) ?? false;
    const sourceName = fromProcess ? 'environment'
      : managedAlias ? 'managed'
        : Object.keys(source.env).some((key) => nbSearchEnvironmentName(source.env, key) === normalized) ? 'local' : 'none';
    return {
      instance_id: instanceId, slot_id: slotId, stored: entry !== undefined, active: matches && fromManaged && sourceName === 'managed',
      source: sourceName, version, binding_version: managedBindingVersion(config, slotId, source.env),
      value: reveal && matches ? entry!.value : undefined,
    };
  }

  async writeManaged(source: NbSearchSource, currentConfig: () => { config: CanonicalConfigPatch | undefined; reuseLocalConfig: boolean; generation: number }, instanceId: string, value: string | null, expectedVersion: string, expectedBinding: string): Promise<ManagedCredentialView> {
    const { slotId, config } = this.#target(source, instanceId);
    const slot = config.credential_slots[slotId]!;
    if (managedBindingVersion(config, slotId, source.env) !== expectedBinding) throw new ManagedCredentialError('changed');
    const name = nbSearchEnvironmentName(source.env, slot.env);
    if (value !== null && ['NB_SEARCH_CONFIG', 'NB_SEARCH_HOME', 'NB_SEARCH_JOBS_ROOT', 'NB_SEARCH_RETENTION_HOURS', 'NB_SEARCH_LOG_LEVEL'].includes(name.toUpperCase())) {
      throw new ManagedCredentialError('binding');
    }
    const entry = value === null ? undefined : {
      provider_id: slot.provider_id, env: slot.env, binding: managedBinding(config, slotId, source.env), value,
    };
    let refreshed: NbSearchSource | undefined;
    const verifyBinding = async () => {
      const latest = currentConfig();
      if (latest.reuseLocalConfig !== source.status.reuse_local_config) return false;
      try {
        const next = await this.#resolve(latest.reuseLocalConfig, latest.config);
        const target = this.#target(next, instanceId);
        if (target.slotId !== slotId || (entry === undefined
          ? managedBindingVersion(target.config, slotId, next.env)
          : managedBinding(target.config, slotId, next.env)) !== expectedBinding
          || currentConfig().generation !== latest.generation) return false;
        refreshed = next;
        return true;
      } catch {
        return false;
      }
    };
    await this.#managed.set(slotId, entry, expectedVersion, verifyBinding);
    return this.readManaged(refreshed!, instanceId, false);
  }

  #target(source: NbSearchSource, instanceId: string) {
    if (source.status.availability !== 'ready') throw new ManagedCredentialError('unavailable');
    const config = resolveNbSearchConfig(source.env, source.config, undefined);
    const instance = config.provider_instances[instanceId];
    const slotId = instance?.credential_slot_id;
    if (instance === undefined || slotId === undefined || ['__proto__', 'constructor', 'prototype'].includes(slotId)
      || !Object.hasOwn(config.credential_slots, slotId) || config.credential_slots[slotId]?.provider_id !== instance.provider_id) {
      throw new ManagedCredentialError('binding');
    }
    return { config, slotId };
  }

  async #resolve(reuseLocalConfig: boolean, config?: CanonicalConfigPatch): Promise<NbSearchSource> {
    const env = copyNbSearchEnvironment(process.env);
    const status: NbSearchConfigSourceStatus = {
      reuse_local_config: reuseLocalConfig,
      layers: reuseLocalConfig ? ['defaults', 'local', 'environment', 'kiki'] : ['defaults', 'environment', 'kiki'],
      local_config: reuseLocalConfig ? 'missing' : 'ignored',
      local_credentials: reuseLocalConfig ? undefined : 'ignored',
      credential_source: 'environment',
      availability: 'ready',
      issues: [],
    };
    if (!reuseLocalConfig) {
      const path = await this.#isolatedConfigPath();
      if (path === undefined) return this.unavailable(env, status, 'ISOLATED_STORAGE_UNAVAILABLE');
      env['NB_SEARCH_CONFIG'] = path;
      env['NB_SEARCH_HOME'] = dirname(path);
      env['NB_SEARCH_JOBS_ROOT'] = resolve(dirname(path), 'jobs');
      let effective;
      try {
        effective = resolveNbSearchConfig(env, undefined, config);
      } catch (error) {
        return this.unavailable(env, status, nbSearchConfigIssues(error, config));
      }
      const managed = await this.#withManaged(env, status, effective);
      return { ...managed, config: pinnedNbSearchConfig(effective), expectedRevision: nbSearchConfigRevision(effective) };
    }
    const home = resolve(nonempty(env['NB_SEARCH_HOME']) ?? resolve(homedir(), '.nb-search'));
    const explicitPath = nonempty(env['NB_SEARCH_CONFIG']);
    const path = resolve(explicitPath ?? resolve(home, 'config.json'));
    try {
      const stat = await this.fs.stat(path);
      status.local_config = stat.isFile ? 'present' : 'unreadable';
      if (!stat.isFile) return this.unavailable(env, status, 'LOCAL_CONFIG_UNREADABLE');
    } catch (error) {
      if (isNotFound(error)) {
        if (explicitPath !== undefined) return this.unavailable(env, status, 'LOCAL_CONFIG_NOT_FOUND');
      } else {
        status.local_config = 'unreadable';
        return this.unavailable(env, status, 'LOCAL_CONFIG_UNREADABLE');
      }
    }
    return this.#withLocalCredentials(env, status, config);
  }

  async #withLocalCredentials(env: NodeJS.ProcessEnv, status: NbSearchConfigSourceStatus, config: CanonicalConfigPatch | undefined): Promise<NbSearchSource> {
    const paths = nbSearchPaths(env);
    try {
      await this.#credentialFiles.assertUnlocked(paths.home);
      const canonicalRaw = await this.#credentialFiles.read(paths.canonical);
      if (canonicalRaw === undefined && status.local_config === 'present') return this.unavailable(env, status, 'LOCAL_CONFIG_CHANGED');
      let canonical: CanonicalConfigPatch | undefined;
      try {
        canonical = canonicalRaw === undefined ? undefined : parseConfigPatch(JSON.parse(canonicalRaw), 'local nb-search configuration');
      } catch (error) {
        return await this.#withoutInvalidLocalConfig(env, status, config, error);
      }
      let effective;
      try {
        effective = resolveNbSearchConfig(env, canonical, config);
      } catch (error) {
        if (canonical !== undefined) return await this.#withoutInvalidLocalConfig(env, status, config, error);
        return this.unavailable(env, status, nbSearchConfigIssues(error, config));
      }
      let raw: string | undefined;
      try {
        raw = await this.#credentialFiles.read(paths.secrets);
      } catch (error) {
        if (!(error instanceof NbSearchLocalFileError) || error.issue !== 'LOCAL_CREDENTIALS_UNREADABLE') throw error;
        return await this.#withoutLocalCredentials(env, status, effective, 'unreadable', 'LOCAL_CREDENTIALS_UNREADABLE');
      }
      if (raw === undefined) {
        status.local_credentials = 'missing';
        return await this.#readyWithCapturedConfig(env, status, effective);
      }
      status.local_credentials = 'present';
      let secrets;
      try {
        secrets = localSecretSchema.parse(JSON.parse(raw));
      } catch {
        return await this.#withoutLocalCredentials(env, status, effective, 'invalid', 'LOCAL_CREDENTIALS_INVALID');
      }
      const prepared = applyLocalCredentials(env, secrets, canonical, config);
      if (Object.values(prepared.config.credential_slots).some((slot) => nbSearchEnvironmentName(prepared.env, slot.env) === nbSearchEnvironmentName(prepared.env, 'NB_SEARCH_CONFIG'))) {
        return this.unavailable(env, status, 'LOCAL_CREDENTIAL_CONFIG_OVERRIDE');
      }
      if (await this.#credentialFiles.read(paths.secrets) !== raw
        || await this.#credentialFiles.read(paths.canonical) !== canonicalRaw) {
        return this.unavailable(env, status, 'LOCAL_CONFIG_CHANGED');
      }
      await this.#credentialFiles.assertUnlocked(paths.home);
      status.credential_source = prepared.usedLocalCredentials ? 'environment+local' : 'environment';
      return await this.#readyWithCapturedConfig(prepared.env, status, prepared.config);
    } catch (error) {
      if (error instanceof LocalCredentialError) {
        status.local_credentials = 'rejected';
        return this.unavailable(env, status, error.issue);
      }
      if (error instanceof NbSearchLocalFileError) {
        if (error.issue.startsWith('LOCAL_CREDENTIALS_')) status.local_credentials = 'unreadable';
        return this.unavailable(env, status, error.issue);
      }
      return this.unavailable(env, status, nbSearchConfigIssues(error, config));
    }
  }

  async #withoutLocalCredentials(env: NodeJS.ProcessEnv, status: NbSearchConfigSourceStatus, config: ReturnType<typeof resolveNbSearchConfig>, kind: 'invalid' | 'unreadable', issue: string): Promise<NbSearchSource> {
    status.local_credentials = kind;
    status.issues = [...new Set([...status.issues, issue])];
    return this.#readyWithCapturedConfig(env, status, config, true);
  }

  async #withoutInvalidLocalConfig(env: NodeJS.ProcessEnv, status: NbSearchConfigSourceStatus, config: CanonicalConfigPatch | undefined, localError: unknown): Promise<NbSearchSource> {
    let effective;
    try {
      effective = resolveNbSearchConfig(env, undefined, config);
    } catch (error) {
      return this.unavailable(env, status, nbSearchConfigIssues(error, config));
    }
    status.local_config = 'invalid';
    status.local_credentials = 'ignored';
    status.issues = [...new Set([
      ...status.issues,
      'LOCAL_CONFIG_INVALID_IGNORED',
      ...nbSearchConfigIssues(localError).filter((issue) => issue !== 'EFFECTIVE_CONFIG_INVALID'),
    ])];
    return this.#readyWithCapturedConfig(env, status, effective);
  }

  async #readyWithCapturedConfig(env: NodeJS.ProcessEnv, status: NbSearchConfigSourceStatus, config: ReturnType<typeof resolveNbSearchConfig>, suppressManaged = false): Promise<NbSearchSource> {
    const isolated = await this.#isolatedConfigPath();
    if (isolated === undefined) return this.unavailable(env, status, 'ISOLATED_STORAGE_UNAVAILABLE');
    env['NB_SEARCH_CONFIG'] = isolated;
    const managed: NbSearchSource = suppressManaged ? { env, status, managedSlots: [] } : await this.#withManaged(env, status, config);
    return { ...managed, config: pinnedNbSearchConfig(config), expectedRevision: nbSearchConfigRevision(config) };
  }

  async #withManaged(env: NodeJS.ProcessEnv, status: NbSearchConfigSourceStatus, config: ReturnType<typeof resolveNbSearchConfig>): Promise<NbSearchSource> {
    const records = await this.#managed.all().catch(() => undefined);
    if (records === undefined) {
      status.issues = [...new Set([...status.issues, 'MANAGED_CREDENTIALS_UNAVAILABLE'])];
      return { env, status, managedSlots: [] };
    }
    const copy = copyNbSearchEnvironment(env);
    const injected: string[] = [];
    const managedSlots: string[] = [];
    for (const [slotId, entry] of Object.entries(records)) {
      const slot = config.credential_slots[slotId];
      if (slot === undefined) continue;
      if (!managedEntryMatches(entry, config, slotId, env)) {
        status.issues = [...new Set([...status.issues, `MANAGED_CREDENTIALS_MISMATCH:${slotId}`])];
        continue;
      }
      const name = nbSearchEnvironmentName(env, slot.env);
      if (['NB_SEARCH_CONFIG', 'NB_SEARCH_HOME', 'NB_SEARCH_JOBS_ROOT', 'NB_SEARCH_RETENTION_HOURS', 'NB_SEARCH_LOG_LEVEL'].includes(name.toUpperCase())) continue;
      if (Object.keys(copy).some((key) => nbSearchEnvironmentName(copy, key) === name)) continue;
      Object.defineProperty(copy, slot.env, { value: entry.value, enumerable: true, configurable: true, writable: true });
      injected.push(slot.env);
      managedSlots.push(slotId);
    }
    if (injected.length > 0 && (nbSearchPaths(copy).canonical !== nbSearchPaths(env).canonical
      || nbSearchConfigRevision(resolveNbSearchConfig(copy, pinnedNbSearchConfig(config), undefined)) !== nbSearchConfigRevision(config))) {
      status.issues = [...new Set([...status.issues, 'MANAGED_CREDENTIALS_UNAVAILABLE'])];
      return { env, status, managedSlots: [] };
    }
    if (managedSlots.length > 0) {
      status.credential_source = status.credential_source === 'environment+local'
        ? 'environment+local+managed'
        : 'environment+managed';
    }
    return { env: copy, status, managedSlots };
  }

  async #isolatedConfigPath(): Promise<string | undefined> {
    const pending = this.#isolatedConfigPathPromise ??= this.#writeIsolatedConfig();
    const path = await pending;
    if (path === undefined && this.#isolatedConfigPathPromise === pending) this.#isolatedConfigPathPromise = undefined;
    return path;
  }

  async #writeIsolatedConfig(): Promise<string | undefined> {
    const scope = 'cache/nb-search';
    const path = this.storage.pathFor(scope, this.#isolatedConfigKey);
    if (path === undefined) return undefined;
    try {
      await this.storage.write(scope, this.#isolatedConfigKey, isolatedConfigBytes, { atomic: true });
      return path;
    } catch {
      return undefined;
    }
  }

  private unavailable(env: NodeJS.ProcessEnv, status: NbSearchConfigSourceStatus, issue: string | readonly string[]): NbSearchSource {
    const issues = typeof issue === 'string' ? [issue] : issue;
    return { env, status: { ...status, availability: 'unavailable', issues: [...new Set(issues)] } };
  }
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && error.code === 'os.fs.not_found';
}

registerScopedService(LifecycleScope.App, INbSearchSourceStore, NbSearchSourceStore, ScopeActivation.OnDemand);
