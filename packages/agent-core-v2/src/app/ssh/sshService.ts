import { join } from 'pathe';
import type { SSHKaos } from '@kiki/kaos/ssh';
import { SshConnectionManager, type SshConnectionHost, type SshConnectionStatus, type TrustUnknownKey } from '@kiki/kaos/ssh-connection';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISshCredentialStore } from '#/persistence/interface/sshCredentialStore';
import { ISshHostDocumentStore } from '#/persistence/interface/sshHostDocumentStore';

import { NATIVE_SSH_FLAG_ID } from './flag';
import { SshHostStore, type SshHostInput, type SshHostRecord } from './sshHosts';

export interface SshHostStatus extends SshConnectionStatus {
  readonly workspaceId?: string;
}

export interface ISshHostService {
  readonly _serviceBrand: undefined;
  list(workspaceId?: string): Promise<readonly SshHostRecord[]>;
  discover(): Promise<readonly SshHostRecord[]>;
  setSyncSshConfig(enabled: boolean): Promise<void>;
  upsert(host: SshHostInput, workspaceId?: string): Promise<void>;
  remove(id: string, workspaceId?: string): Promise<void>;
  writeBack(id: string, workspaceId?: string): Promise<void>;
  connect(id: string, workspaceId?: string, trustUnknown?: TrustUnknownKey, autoTrustFirstKey?: boolean): Promise<SSHKaos>;
  disconnect(id: string, workspaceId?: string): Promise<void>;
  status(id: string, workspaceId?: string): SshHostStatus;
  onStatus(listener: (status: SshHostStatus) => void): () => void;
}

export const ISshHostService: ServiceIdentifier<ISshHostService> = createDecorator<ISshHostService>('sshHostService');

type TrustPolicy = { trustUnknown?: TrustUnknownKey; autoTrustFirstKey?: boolean };

export class SshHostService extends Disposable implements ISshHostService {
  declare readonly _serviceBrand: undefined;
  private readonly hosts: SshHostStore;
  private readonly connections: SshConnectionManager;
  private readonly trust = new Map<string, TrustPolicy>();

  constructor(
    @ISshHostDocumentStore documents: IAtomicTomlDocumentStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ISshCredentialStore private readonly credentials: ISshCredentialStore,
  ) {
    super();
    this.hosts = new SshHostStore(documents, join(bootstrap.osHomeDir, '.ssh', 'config'));
    this.connections = new SshConnectionManager((key) => this.resolveConnection(key));
    this._register(toDisposable(() => { void this.connections.dispose(); }));
  }

  private key(id: string, workspaceId?: string): string {
    return JSON.stringify([workspaceId ?? '', id]);
  }

  list(workspaceId?: string): Promise<readonly SshHostRecord[]> {
    return this.hosts.list(workspaceId);
  }

  discover(): Promise<readonly SshHostRecord[]> {
    return this.hosts.discover();
  }

  setSyncSshConfig(enabled: boolean): Promise<void> {
    return this.hosts.setSyncSshConfig(enabled);
  }

  async upsert(host: SshHostInput, workspaceId?: string): Promise<void> {
    await this.hosts.upsert(host, workspaceId);
    await this.connections.disconnect(this.key(host.id, workspaceId));
  }

  async remove(id: string, workspaceId?: string): Promise<void> {
    await this.hosts.remove(id, workspaceId);
    await this.connections.disconnect(this.key(id, workspaceId));
  }

  writeBack(id: string, workspaceId?: string): Promise<void> {
    return this.hosts.writeBack(id, workspaceId);
  }

  async connect(id: string, workspaceId?: string, trustUnknown?: TrustUnknownKey, autoTrustFirstKey = false): Promise<SSHKaos> {
    if (!this.flags.enabled(NATIVE_SSH_FLAG_ID)) throw new Error('Native SSH is disabled');
    const key = this.key(id, workspaceId);
    const policy = { trustUnknown, autoTrustFirstKey };
    if (!this.trust.has(key)) this.trust.set(key, policy);
    try {
      return await this.connections.get(key);
    } finally {
      if (this.trust.get(key) === policy) this.trust.delete(key);
    }
  }

  disconnect(id: string, workspaceId?: string): Promise<void> {
    return this.connections.disconnect(this.key(id, workspaceId));
  }

  status(id: string, workspaceId?: string): SshHostStatus {
    const { hostId: _key, ...status } = this.connections.status(this.key(id, workspaceId));
    return { hostId: id, workspaceId, ...status };
  }

  onStatus(listener: (status: SshHostStatus) => void): () => void {
    return this.connections.onStatus(({ hostId: key, ...status }) => {
      const [workspace, hostId] = JSON.parse(key) as [string, string];
      listener({ hostId, workspaceId: workspace || undefined, ...status });
    });
  }

  private async resolveConnection(key: string): Promise<SshConnectionHost> {
    const [workspace, id] = JSON.parse(key) as [string, string];
    const workspaceId = workspace || undefined;
    const resolved = await this.hosts.resolve(id, workspaceId);
    const policy = this.trust.get(key);
    const knownHostsFiles = resolved.userKnownHostsFiles
      .filter((file) => file !== 'none' && file !== '/dev/null')
      .map((file) => file.startsWith('~/') ? join(this.bootstrap.osHomeDir, file.slice(2)) : file);
    return {
      hostname: resolved.hostname,
      port: resolved.port,
      username: resolved.user,
      password: await this.credentials.read(key, 'password'),
      keyPaths: resolved.identityFiles.map((file) => file.startsWith('~/') ? join(this.bootstrap.osHomeDir, file.slice(2)) : file),
      agent: resolved.identityAgent?.startsWith('~/')
        ? join(this.bootstrap.osHomeDir, resolved.identityAgent.slice(2)) : resolved.identityAgent,
      knownHostsFiles: knownHostsFiles.length > 0 ? knownHostsFiles : [join(this.bootstrap.osHomeDir, '.ssh', 'known_hosts')],
      proxyJump: resolved.proxyJump,
      proxyCommand: resolved.proxyCommand,
      configFile: join(this.bootstrap.osHomeDir, '.ssh', 'config'),
      trustUnknown: policy?.trustUnknown,
      autoTrustFirstKey: policy?.autoTrustFirstKey,
    };
  }
}

registerScopedService(LifecycleScope.App, ISshHostService, SshHostService, ScopeActivation.OnDemand, 'ssh');
