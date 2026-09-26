import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import type { NbSearchConfigSourceStatus } from '@kiki/protocol';
import { parseConfigPatch, type CanonicalConfigPatch } from '@nb-corp/nb-search';

import { NbSearchCredentialFileStore, NbSearchLocalFileError } from './credentialFileStore';
import { Error2, ErrorCodes } from '#/errors';
import { nbSearchConfigIssues, nbSearchConfigRevision, nbSearchPaths, pinnedNbSearchConfig, resolveNbSearchConfig } from './donorConfig';
import { applyLocalCredentials, LocalCredentialError, localSecretSchema } from './localCredentials';
import { copyNbSearchEnvironment, nbSearchEnvironmentName } from './environment';

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
}

export interface INbSearchSourceStore {
  readonly _serviceBrand: undefined;
  withSource<T>(reuseLocalConfig: boolean, config: CanonicalConfigPatch | undefined, use: (source: NbSearchSource) => T | Promise<T>): Promise<T>;
}

export const INbSearchSourceStore: ServiceIdentifier<INbSearchSourceStore> =
  createDecorator<INbSearchSourceStore>('nbSearchSourceStore');

/**
 * Adapts nb-search 0.2's public environment-based file loader without changing
 * the daemon environment or the local nb-search file. Isolation uses a real
 * empty canonical document in Kiki storage, with Kiki-owned default job paths;
 * explicit Kiki canonical path settings still take precedence over defaults.
 */
export class NbSearchSourceStore implements INbSearchSourceStore {
  declare readonly _serviceBrand: undefined;

  readonly #credentialFiles: NbSearchCredentialFileStore;
  readonly #isolatedConfigKey = `isolated-config.${process.pid}.${isolatedConfigSequence += 1}.json`;
  #isolatedConfigPathPromise?: Promise<string | undefined>;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {
    this.#credentialFiles = new NbSearchCredentialFileStore(fs);
  }

  async withSource<T>(reuseLocalConfig: boolean, config: CanonicalConfigPatch | undefined, use: (source: NbSearchSource) => T | Promise<T>): Promise<T> {
    if (typeof use !== 'function') throw new Error2(ErrorCodes.REQUEST_INVALID, 'nb-search source access requires an in-process consumer.');
    return use(await this.#resolve(reuseLocalConfig, config));
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
      return { env, status };
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
      const raw = await this.#credentialFiles.read(paths.secrets);
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
      if (raw === undefined) {
        status.local_credentials = 'missing';
        return await this.#readyWithCapturedConfig(env, status, effective);
      }
      status.local_credentials = 'present';
      let secrets;
      try {
        secrets = localSecretSchema.parse(JSON.parse(raw));
      } catch {
        status.local_credentials = 'invalid';
        return this.unavailable(env, status, 'LOCAL_CREDENTIALS_INVALID');
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

  async #readyWithCapturedConfig(env: NodeJS.ProcessEnv, status: NbSearchConfigSourceStatus, config: ReturnType<typeof resolveNbSearchConfig>): Promise<NbSearchSource> {
    const isolated = await this.#isolatedConfigPath();
    if (isolated === undefined) return this.unavailable(env, status, 'ISOLATED_STORAGE_UNAVAILABLE');
    env['NB_SEARCH_CONFIG'] = isolated;
    return { env, status, config: pinnedNbSearchConfig(config), expectedRevision: nbSearchConfigRevision(config) };
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
