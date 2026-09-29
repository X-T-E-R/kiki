import { basename, join, relative } from 'pathe';

import type { KimiHostIdentity } from '@kiki/oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import {
  IBootstrapOptions,
  IBootstrapService,
  createBaseConfigDocumentStore,
  type HostArgs,
  type PersistenceScopeName,
} from './bootstrap';

export class BootstrapService implements IBootstrapService {
  declare readonly _serviceBrand: undefined;

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
  readonly space: IBootstrapOptions['space'];
  readonly homeDiagnostic?: string;
  readonly baseConfigDocumentStore?: IAtomicTomlDocumentStore;
  readonly clientIdentity: KimiHostIdentity;
  readonly args: HostArgs;
  readonly interactive: boolean;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly configKey: string;

  private readonly env: NodeJS.ProcessEnv;
  private readonly scopes: Readonly<Record<PersistenceScopeName, string>>;

  constructor(@IBootstrapOptions options: IBootstrapOptions) {
    this.platform = options.platform;
    this.arch = options.arch;
    this.cwd = options.cwd;
    this.osHomeDir = options.osHomeDir;
    this.env = options.env;
    this.homeDir = options.homeDir;
    this.configPath = options.configPath;
    this.configReadOnly = options.configReadOnly;
    this.userAgentProfileHomeDir = options.userAgentProfileHomeDir;
    this.modelAccountHomeDir = options.modelAccountHomeDir;
    this.baseHomeDir = options.baseHomeDir;
    this.credentialsHomeDir = options.credentialsHomeDir;
    this.spaceId = options.spaceId;
    this.space = options.space;
    this.homeDiagnostic = options.homeDiagnostic;
    this.baseConfigDocumentStore = options.baseHomeDir === undefined ? undefined : createBaseConfigDocumentStore(options.baseHomeDir);
    this.clientIdentity = options.clientIdentity;
    this.args = options.args;
    this.interactive = options.interactive ?? true;
    this.sessionsDir = join(options.homeDir, 'sessions');
    this.blobsDir = join(options.homeDir, 'blobs');
    this.storeDir = join(options.homeDir, 'store');
    this.cacheDir = join(options.homeDir, 'cache');
    this.logsDir = join(options.homeDir, 'logs');
    this.configKey = basename(options.configPath);
    this.scopes = {
      config: '',
      sessions: relative(options.homeDir, join(options.homeDir, 'sessions')),
      ephemeral: 'ephemeral',
      blobs: relative(options.homeDir, this.blobsDir),
      store: relative(options.homeDir, this.storeDir),
      logs: relative(options.homeDir, this.logsDir),
      cache: relative(options.homeDir, this.cacheDir),
      credentials: 'credentials',
      cron: 'cron',
    };
  }

  getEnv(name: string): string | undefined {
    return this.env[name];
  }

  scope(name: PersistenceScopeName): string {
    return this.scopes[name];
  }
}

registerScopedService(LifecycleScope.App, IBootstrapService, BootstrapService, ScopeActivation.OnScopeCreated, 'bootstrap');
