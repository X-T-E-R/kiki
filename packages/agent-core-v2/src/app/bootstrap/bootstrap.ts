import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { dirname, join, normalize } from 'pathe';
import { FSWatcher } from 'chokidar';

import { resolveKikiHome, type KimiHostIdentity } from '@kiki/oauth';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { createAppScope, type Scope, type ScopeSeed } from '#/_base/di/scope';
import { DisposableStore, combinedDisposable, toDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import {
  IFileSystemStorageService,
  StorageError,
  StorageErrors,
} from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { cleanupExpiredSessionLocks } from '#/persistence/backends/node-fs/fileLock';
import { cleanupOrphanedEphemeralSessions } from '#/persistence/backends/node-fs/ephemeralCleanup';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { readSpaceHome, type SpaceHome } from './spaceHome';
import { prepareSpaceResourceProjection, readSpaceSourceSelections } from '#/persistence/backends/node-fs/spaceResourceProjection';

export interface HostArgs {
  readonly browserDriverPath?: string;
  readonly agentFiles?: readonly string[];
  readonly skillDirs?: readonly string[];
  readonly userSkillDir?: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly displayName?: string;
  readonly replyStyleGuide?: string;
}

export interface HostArgsInput {
  readonly browserDriverPath?: string;
  readonly agentFiles?: readonly string[];
  readonly skillDirs?: readonly string[];
  readonly userSkillDir?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly displayName?: string;
  readonly replyStyleGuide?: string;
}

export function resolveHostArgs(input: HostArgsInput | undefined): HostArgs {
  return {
    browserDriverPath: input?.browserDriverPath,
    agentFiles: input?.agentFiles,
    skillDirs: input?.skillDirs,
    userSkillDir: input?.userSkillDir,
    requestHeaders: input?.requestHeaders ?? {},
    displayName: input?.displayName,
    replyStyleGuide: input?.replyStyleGuide,
  };
}

export interface IBootstrapOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly configReadOnly: boolean;
  readonly userAgentProfileHomeDir: string;
  readonly modelAccountHomeDir: string;
  readonly baseHomeDir?: string;
  readonly credentialsHomeDir: string;
  readonly spaceId?: string;
  readonly space?: SpaceHome;
  readonly homeDiagnostic?: string;
  readonly osHomeDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clientIdentity: KimiHostIdentity;
  readonly args: HostArgs;
  readonly interactive?: boolean;
}

export const IBootstrapOptions: ServiceIdentifier<IBootstrapOptions> =
  createDecorator<IBootstrapOptions>('bootstrapOptions');

export type PersistenceScopeName =
  | 'config'
  | 'sessions'
  | 'ephemeral'
  | 'blobs'
  | 'store'
  | 'logs'
  | 'cache'
  | 'credentials'
  | 'cron';

export interface IBootstrapService {
  readonly _serviceBrand: undefined;

  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly configReadOnly: boolean;
  readonly userAgentProfileHomeDir: string;
  readonly modelAccountHomeDir: string;
  readonly baseHomeDir?: string;
  readonly credentialsHomeDir: string;
  readonly spaceId?: string;
  readonly space?: SpaceHome;
  readonly homeDiagnostic?: string;
  readonly baseConfigDocumentStore?: IAtomicTomlDocumentStore;
  readonly clientIdentity: KimiHostIdentity;
  readonly args: HostArgs;
  readonly interactive?: boolean;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  getEnv(name: string): string | undefined;
  scope(name: PersistenceScopeName): string;
  readonly configKey: string;
}

export const IBootstrapService: ServiceIdentifier<IBootstrapService> =
  createDecorator<IBootstrapService>('bootstrapService');

export interface BootstrapInput {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly configReadOnly?: boolean;
  readonly userAgentProfileHomeDir?: string;
  readonly modelAccountHomeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly osHomeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly cwd?: string;
  readonly clientIdentity: KimiHostIdentity;
  readonly args?: HostArgsInput;
  readonly interactive?: boolean;
}

export function resolveBootstrapOptions(input: BootstrapInput): IBootstrapOptions {
  const env = input.env ?? process.env;
  const osHomeDir = input.osHomeDir ?? homedir();
  const homeDir = resolveKikiHome(input.homeDir, env, osHomeDir);
  const parsed = readSpaceHome(homeDir);
  let space = parsed.space;
  const diagnostic = parsed.diagnostic;
  const baseHomeDir = space?.baseHomeDir;
  if (space !== undefined && baseHomeDir !== undefined) {
    const sourceSelections = readSpaceSourceSelections(homeDir);
    const hasResourceSelections = Object.keys(sourceSelections?.selections ?? {}).some((id) => id.startsWith('resource:')) || Object.keys(sourceSelections?.groups ?? {}).some((domain) => !['config', 'credentials', 'generic_roots'].includes(domain));
    const resourceBaseHomeDir = sourceSelections === undefined || !hasResourceSelections ? undefined
      : prepareSpaceResourceProjection(homeDir, baseHomeDir, sourceSelections, space.inherit as unknown as Record<string, unknown>);
    space = { ...space, sourceSelections, resourceBaseHomeDir };
  }
  const credentialsHomeDir = baseHomeDir !== undefined && space?.inherit.credentials === 'shared' ? baseHomeDir : homeDir;
  const configPath = input.configPath ?? join(homeDir, 'config.toml');
  return {
    homeDir,
    configPath,
    configReadOnly: input.configReadOnly ?? false,
    baseHomeDir,
    credentialsHomeDir,
    spaceId: space?.id,
    space,
    homeDiagnostic: diagnostic,
    userAgentProfileHomeDir: input.userAgentProfileHomeDir ?? homeDir,
    modelAccountHomeDir: input.modelAccountHomeDir ?? credentialsHomeDir,
    osHomeDir,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    cwd: input.cwd ?? process.cwd(),
    env,
    clientIdentity: input.clientIdentity,
    args: resolveHostArgs(input.args),
    interactive: input.interactive ?? true,
  };
}

export function bootstrapSeed(input: BootstrapInput): ScopeSeed {
  return [
    [
      IBootstrapOptions as ServiceIdentifier<unknown>,
      resolveBootstrapOptions(input),
    ],
  ];
}

export interface BootstrapResult {
  readonly app: Scope;
}

export function bootstrap(input: BootstrapInput, extraSeeds: ScopeSeed = []): BootstrapResult {
  const options = resolveBootstrapOptions(input);
  const app = createAppScope({
    seeds: [[IBootstrapOptions as ServiceIdentifier<unknown>, options], ...storageSeed(options), ...skillSeed(), ...extraSeeds],
  });
  void cleanupOrphanedEphemeralSessions(options.homeDir).catch(() => undefined);
  void cleanupExpiredSessionLocks(options.homeDir).catch(() => undefined);
  return { app };
}

function storageSeed(options: IBootstrapOptions): ScopeSeed {
  const file = (): SyncDescriptor<IFileSystemStorageService> =>
    new SyncDescriptor(FileStorageService, [options.homeDir, 0o700, 0o600]);
  const configStorage = new FileStorageService(dirname(options.configPath), 0o700, 0o600, !options.configReadOnly);
  const configDocuments: IAtomicTomlDocumentStore = new TomlAtomicDocumentStore(configStorage);
  return [
    [IFileSystemStorageService as ServiceIdentifier<unknown>, file()],
    [
      IAtomicTomlDocumentStore as ServiceIdentifier<unknown>,
      options.configReadOnly
        ? new ReadOnlyAtomicDocumentStore(configDocuments)
        : configDocuments,
    ],
  ];
}

export function createBaseConfigDocumentStore(baseHomeDir: string): IAtomicTomlDocumentStore {
  const storage = new FileStorageService(baseHomeDir, 0o700, 0o600, false);
  return new ReadOnlyAtomicDocumentStore(new TomlAtomicDocumentStore(storage), baseHomeDir);
}

class ReadOnlyAtomicDocumentStore implements IAtomicTomlDocumentStore {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly delegate: IAtomicTomlDocumentStore, private readonly watchRoot?: string) {}

  get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.delegate.get<T>(scope, key);
  }

  getText(scope: string, key: string): Promise<string | undefined> {
    return this.delegate.getText(scope, key);
  }

  setText(_scope: string, _key: string, _text: string): Promise<void> {
    return Promise.reject(readOnlyConfigError());
  }

  compareAndSetText(_scope: string, _key: string, _expected: string | undefined, _next: string | undefined): Promise<boolean> {
    return Promise.reject(readOnlyConfigError());
  }

  set<T>(_scope: string, _key: string, _value: T): Promise<void> {
    return Promise.reject(readOnlyConfigError());
  }

  update<T>(
    _scope: string,
    _key: string,
    _updater: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined> {
    return Promise.reject(readOnlyConfigError());
  }

  delete(_scope: string, _key: string): Promise<void> {
    return Promise.reject(readOnlyConfigError());
  }

  list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.delegate.list(scope, prefix);
  }

  watch(scope: string, key: string): Event<void> {
    const root = this.watchRoot;
    if (root === undefined) return this.delegate.watch(scope, key);
    const target = normalize(join(root, scope, key));
    return (listener, thisArg, disposables) => {
      const emitter = new Emitter<void>();
      const watcher = new FSWatcher({ ignoreInitial: true, depth: 1 });
      watcher.on('all', (_event, changedPath) => {
        if (normalize(changedPath).toLowerCase() === target.toLowerCase()) emitter.fire();
      });
      watcher.add(root);
      const subscription = emitter.event(listener, thisArg);
      const combined = combinedDisposable(subscription, toDisposable(() => {
        void watcher.close().catch(() => undefined);
        emitter.dispose();
      }));
      if (disposables instanceof DisposableStore) disposables.add(combined);
      else if (disposables !== undefined) disposables.push(combined);
      return combined;
    };
  }

  acquire(scope: string, key: string) {
    return this.delegate.acquire(scope, key);
  }
}

function readOnlyConfigError(): StorageError {
  return new StorageError(
    StorageErrors.codes.STORAGE_PERMISSION_DENIED,
    'the configured runtime source is read-only',
  );
}

function skillSeed(): ScopeSeed {
  return [
    [
      ISkillDiscovery as ServiceIdentifier<unknown>,
      new SyncDescriptor(FileSkillDiscovery, []),
    ],
  ];
}

export { resolveKikiHome };

export function resolveConfigPath(input: {
  readonly homeDir?: string;
  readonly configPath?: string;
}): string {
  return input.configPath ?? join(resolveKikiHome(input.homeDir), 'config.toml');
}

export function ensureKikiHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}
