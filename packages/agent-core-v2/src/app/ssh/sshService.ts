import { createHash } from 'node:crypto';
import { join } from 'pathe';
import type { SSHKaos } from '@kiki/kaos/ssh';
import {
  SshConnectionManager,
  SshKnownHosts,
  type SshKnownHostsInspection,
  type SshConnectionHost,
  type SshConnectionReceipt,
  type SshConnectionStatus,
  type TrustUnknownKey,
} from '@kiki/kaos/ssh-connection';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { SshCredentialStore } from '#/persistence/backends/node-fs/sshCredentialStore';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISshCredentialStore } from '#/persistence/interface/sshCredentialStore';
import { ISshHostDocumentStore } from '#/persistence/interface/sshHostDocumentStore';

import { NATIVE_SSH_FLAG_ID } from './flag';
import { SshHostStore, normalizeHost, type SshConfigSyncSettings, type SshHostInput, type SshHostRecord } from './sshHosts';
import { parseTransientSshTarget, resolveSshConfig, type ResolvedSshConfig } from './sshConfig';
import type { SshCredentialSubmission } from '#/session/approval/approval';

export interface SshHostStatus extends SshConnectionStatus {
  readonly workspaceId?: string;
}

export interface SshHostReceipt extends SshConnectionReceipt {
  readonly workspaceId?: string;
}

export interface SshHostKeys extends SshKnownHostsInspection {
  readonly hostId: string;
  readonly workspaceId?: string;
}

export interface ISshHostService {
  readonly _serviceBrand: undefined;
  list(workspaceId?: string, sessionId?: string): Promise<readonly SshHostRecord[]>;
  listRuntimeHosts(workspaceId: string): Promise<readonly SshHostRecord[]>;
  refreshRuntimeHosts(workspaceId: string): Promise<void>;
  addTransient(id: string, workspaceId: string, sessionId: string): Promise<void>;
  removeTransient(id: string, workspaceId: string, sessionId: string): Promise<void>;
  removeSessionTransients(sessionId: string): Promise<void>;
  resolveTarget(id: string, workspaceId?: string): Promise<ResolvedSshConfig>;
  discover(): Promise<readonly SshHostRecord[]>;
  configSync(): Promise<SshConfigSyncSettings>;
  hostKeys(id: string, workspaceId?: string): Promise<SshHostKeys>;
  setSyncSshConfig(enabled: boolean): Promise<void>;
  connectionApprovalEnabled(): Promise<boolean>;
  setConnectionApproval(enabled: boolean): Promise<void>;
  copySharedCredentialsToIsolated(targets: readonly { hostId: string; workspaceId?: string }[]): Promise<readonly { hostId: string; workspaceId?: string; copied: number }[]>;
  upsert(host: SshHostInput, workspaceId?: string): Promise<void>;
  remove(id: string, workspaceId?: string): Promise<void>;
  writeBack(id: string, workspaceId?: string): Promise<void>;
  connect(id: string, workspaceId?: string, trustUnknown?: TrustUnknownKey, autoTrustFirstKey?: boolean, approvedFingerprint?: string, credential?: SshCredentialSubmission, keyboardInteractive?: (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]>): Promise<SSHKaos>;
  disconnect(id: string, workspaceId?: string): Promise<void>;
  status(id: string, workspaceId?: string): SshHostStatus;
  onStatus(listener: (status: SshHostStatus) => void): () => void;
  onReceipt(listener: (receipt: SshHostReceipt) => void): () => void;
  onHostsChanged(listener: (workspaceId?: string) => void | Promise<void>): () => void;
}

export const ISshHostService: ServiceIdentifier<ISshHostService> = createDecorator<ISshHostService>('sshHostService');

type TrustPolicy = { trustUnknown?: TrustUnknownKey; autoTrustFirstKey?: boolean; credential?: SshCredentialSubmission; keyboardInteractive?: (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]> };

export class SshHostService extends Disposable implements ISshHostService {
  declare readonly _serviceBrand: undefined;
  private readonly hosts: SshHostStore;
  private readonly connections: SshConnectionManager;
  private readonly trust = new Map<string, TrustPolicy>();
  private readonly activeTargets = new Map<string, string>();
  private readonly hostListeners = new Set<(workspaceId?: string) => void | Promise<void>>();
  private readonly transient = new Map<string, { workspaceId: string; sessionId: string; record: SshHostRecord }>();

  constructor(
    @ISshHostDocumentStore documents: IAtomicTomlDocumentStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ISshCredentialStore private readonly credentials: ISshCredentialStore,
  ) {
    super();
    const shared = bootstrap.baseHomeDir !== undefined && bootstrap.space?.inherit.credentials === 'shared';
    this.hosts = new SshHostStore(documents, join(bootstrap.osHomeDir, '.ssh', 'config'), shared ? bootstrap.baseConfigDocumentStore : undefined);
    this.connections = new SshConnectionManager((key) => this.resolveConnection(key));
    this._register(toDisposable(() => { void this.connections.dispose(); }));
  }

  private key(id: string, workspaceId?: string): string {
    return JSON.stringify([workspaceId ?? '', id]);
  }

  async list(workspaceId?: string, sessionId?: string): Promise<readonly SshHostRecord[]> {
    const configured = await this.hosts.list(workspaceId);
    if (sessionId === undefined || workspaceId === undefined) return configured;
    return [...configured, ...[...this.transient.entries()]
      .filter(([key, entry]) => key.startsWith(`${JSON.stringify(workspaceId)}:`) && entry.sessionId === sessionId)
      .map(([, entry]) => entry.record)];
  }

  async listRuntimeHosts(workspaceId: string): Promise<readonly SshHostRecord[]> {
    return [...await this.hosts.list(workspaceId), ...[...this.transient.entries()]
      .filter(([key]) => key.startsWith(`${JSON.stringify(workspaceId)}:`))
      .map(([, entry]) => entry.record)];
  }

  async refreshRuntimeHosts(workspaceId: string): Promise<void> {
    await this.notifyHostsChanged(workspaceId);
  }

  async addTransient(id: string, workspaceId: string, sessionId: string): Promise<void> {
    const parsed = parseTransientSshTarget(id);
    if (parsed === undefined) throw new Error('Invalid temporary SSH target; expected user@host[:port]');
    if ((await this.hosts.list(workspaceId)).some((entry) => entry.id === id)) return;
    const key = `${JSON.stringify(workspaceId)}:${id}`;
    const existing = this.transient.get(key);
    if (existing !== undefined) {
      if (existing.sessionId !== sessionId) throw new Error('Temporary SSH target belongs to another session');
      return;
    }
    this.transient.set(key, { workspaceId, sessionId, record: { id, name: id, source: 'session',
      hostname: parsed.hostname, user: parsed.user, port: parsed.port } });
    await this.notifyHostsChanged(workspaceId);
  }

  async removeTransient(id: string, workspaceId: string, sessionId: string): Promise<void> {
    const key = `${JSON.stringify(workspaceId)}:${id}`;
    if (this.transient.get(key)?.sessionId !== sessionId) return;
    this.transient.delete(key);
    await this.disconnect(id, workspaceId);
    await this.notifyHostsChanged(workspaceId);
  }

  async removeSessionTransients(sessionId: string): Promise<void> {
    for (const entry of Array.from(this.transient.values())) {
      if (entry.sessionId !== sessionId) continue;
      await this.removeTransient(entry.record.id, entry.workspaceId, sessionId);
    }
  }

  async resolveTarget(id: string, workspaceId?: string): Promise<ResolvedSshConfig> {
    const transient = this.transient.get(`${JSON.stringify(workspaceId ?? '')}:${id}`);
    if (transient === undefined) return this.hosts.resolve(id, workspaceId);
    const parsed = parseTransientSshTarget(id)!;
    const configured = await resolveSshConfig(parsed.hostname);
    return { ...configured, hostname: parsed.hostname, user: parsed.user, port: parsed.port,
      identityFiles: [], proxyJump: undefined, proxyCommand: undefined };
  }

  discover(): Promise<readonly SshHostRecord[]> {
    return this.hosts.discover();
  }

  configSync(): Promise<SshConfigSyncSettings> {
    return this.hosts.configSync();
  }

  private knownHostsFiles(resolved: ResolvedSshConfig): readonly string[] {
    return resolved.userKnownHostsFiles
      .filter((file) => file !== 'none' && file !== '/dev/null')
      .map((file) => file.startsWith('~/') ? join(this.bootstrap.osHomeDir, file.slice(2)) : file);
  }

  async hostKeys(id: string, workspaceId?: string): Promise<SshHostKeys> {
    const resolved = await this.hosts.resolve(id, workspaceId);
    const files = this.knownHostsFiles(resolved);
    return { hostId: id, workspaceId, ...await new SshKnownHosts(files).inspect(resolved.hostname, resolved.port) };
  }

  async setSyncSshConfig(enabled: boolean): Promise<void> {
    await this.hosts.setSyncSshConfig(enabled);
    await this.notifyHostsChanged();
  }

  connectionApprovalEnabled(): Promise<boolean> {
    return this.hosts.connectionApprovalEnabled();
  }

  setConnectionApproval(enabled: boolean): Promise<void> {
    return this.hosts.setConnectionApproval(enabled);
  }

  async copySharedCredentialsToIsolated(targets: readonly { hostId: string; workspaceId?: string }[]): Promise<readonly { hostId: string; workspaceId?: string; copied: number }[]> {
    const base = this.bootstrap.baseHomeDir;
    const spaceId = this.bootstrap.spaceId;
    if (base === undefined || spaceId === undefined || this.bootstrap.space?.inherit.credentials !== 'shared') {
      throw new Error('SSH credential copying requires a space that currently shares credentials');
    }
    const shared = new SshCredentialStore(base);
    const isolated = new SshCredentialStore(this.bootstrap.homeDir, undefined, spaceId);
    const result: { hostId: string; workspaceId?: string; copied: number }[] = [];
    for (const target of targets) {
      const record = (await this.hosts.list(target.workspaceId)).find((host) => host.id === target.hostId);
      if (record?.source !== 'kiki') throw new Error(`Unknown Kiki SSH host: ${target.hostId}`);
      const account = this.key(target.hostId, target.workspaceId);
      let copied = 0;
      for (const kind of ['password', 'passphrase'] as const) {
        const value = await shared.read(account, kind);
        if (value === undefined) continue;
        await isolated.save(account, kind, value);
        copied++;
      }
      result.push({ hostId: target.hostId, workspaceId: target.workspaceId, copied });
    }
    return result;
  }

  private async forgetCredentials(id: string, workspaceId: string | undefined,
    kinds: readonly ('password' | 'passphrase' | 'identityFile')[]): Promise<void> {
    await Promise.all(kinds.map((kind) => this.credentials.forget(this.key(id, workspaceId), kind)));
  }

  async upsert(host: SshHostInput, workspaceId?: string): Promise<void> {
    normalizeHost(host);
    const previous = (await this.hosts.list(workspaceId)).find((entry) => entry.id === host.id);
    const all = ['password', 'passphrase', 'identityFile'] as const;
    if (previous?.source !== 'kiki' || previous.user !== host.user || previous.hostname !== host.hostname ||
        host.identityFile !== undefined && previous.identityFile !== host.identityFile) {
      await this.forgetCredentials(host.id, workspaceId, all);
    } else if (previous.identityFile !== host.identityFile) {
      await this.forgetCredentials(host.id, workspaceId, ['passphrase', 'identityFile']);
    }
    await this.hosts.upsert(host, workspaceId);
    this.activeTargets.delete(this.key(host.id, workspaceId));
    await this.connections.disconnect(this.key(host.id, workspaceId));
    await this.notifyHostsChanged(workspaceId);
  }

  async remove(id: string, workspaceId?: string): Promise<void> {
    await this.forgetCredentials(id, workspaceId, ['password', 'passphrase', 'identityFile']);
    await this.hosts.remove(id, workspaceId);
    this.activeTargets.delete(this.key(id, workspaceId));
    await this.connections.disconnect(this.key(id, workspaceId));
    await this.notifyHostsChanged(workspaceId);
  }

  writeBack(id: string, workspaceId?: string): Promise<void> {
    return this.hosts.writeBack(id, workspaceId);
  }

  async connect(
    id: string, workspaceId?: string, trustUnknown?: TrustUnknownKey, autoTrustFirstKey = false,
    approvedFingerprint?: string, credential?: SshCredentialSubmission,
    keyboardInteractive?: (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]>,
  ): Promise<SSHKaos> {
    if (!this.flags.enabled(NATIVE_SSH_FLAG_ID)) throw new Error('Native SSH is disabled');
    const key = this.key(id, workspaceId);
    const fingerprint = await this.fingerprint(id, workspaceId);
    if (approvedFingerprint !== undefined && fingerprint !== approvedFingerprint) {
      throw new Error(`SSH host "${id}" changed after connection approval`);
    }
    if (this.activeTargets.get(key) !== fingerprint) {
      this.activeTargets.set(key, fingerprint);
      await this.connections.disconnect(key);
    }
    const policy = { trustUnknown, autoTrustFirstKey, credential, keyboardInteractive };
    if (!this.trust.has(key)) this.trust.set(key, policy);
    try {
      const connection = await this.connections.get(key);
      if (this.activeTargets.get(key) !== fingerprint) throw new Error(`SSH host "${id}" changed during connection`);
      if (credential !== undefined && credential.save !== 'session') {
        const persistentId = parseTransientSshTarget(id) === undefined
          ? id : `ssh-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
        const account = this.key(persistentId, credential.save === 'global' ? undefined : workspaceId);
        if (credential.password !== undefined) await this.credentials.save(account, 'password', credential.password);
        if (credential.passphrase !== undefined) await this.credentials.save(account, 'passphrase', credential.passphrase);
        const identityFile = credential.privateKeyContents === undefined ? credential.privateKeyPath
          : await this.credentials.savePrivateKey(account, credential.privateKeyContents);
        if (identityFile !== undefined) await this.credentials.save(account, 'identityFile', identityFile);
        const record = (await this.listRuntimeHosts(workspaceId ?? '')).find((host) => host.id === id);
        if (record?.source === 'session') {
          const scope = credential.save === 'global' ? undefined : workspaceId;
          await this.hosts.upsert({ ...record, id: persistentId, source: 'kiki',
            identityFile: identityFile ?? record.identityFile }, scope);
          await this.notifyHostsChanged(scope);
        }
      }
      return connection;
    } finally {
      if (this.trust.get(key) === policy) this.trust.delete(key);
    }
  }

  async disconnect(id: string, workspaceId?: string): Promise<void> {
    const key = this.key(id, workspaceId);
    this.activeTargets.delete(key);
    await this.connections.disconnect(key);
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

  onReceipt(listener: (receipt: SshHostReceipt) => void): () => void {
    return this.connections.onReceipt(({ hostId: key, ...receipt }) => {
      const [workspace, hostId] = JSON.parse(key) as [string, string];
      listener({ hostId, workspaceId: workspace || undefined, ...receipt });
    });
  }

  onHostsChanged(listener: (workspaceId?: string) => void | Promise<void>): () => void {
    this.hostListeners.add(listener);
    return () => { this.hostListeners.delete(listener); };
  }

  private async notifyHostsChanged(workspaceId?: string): Promise<void> {
    await Promise.all([...this.hostListeners].map((listener) => Promise.resolve(listener(workspaceId))));
  }

  private async fingerprint(id: string, workspaceId?: string): Promise<string> {
    const record = (await this.listRuntimeHosts(workspaceId ?? '')).find((host) => host.id === id);
    if (record === undefined) throw new Error(`Unknown SSH host "${id}"`);
    return JSON.stringify({ record, target: await this.resolveTarget(id, workspaceId) });
  }

  private async resolveConnection(key: string): Promise<SshConnectionHost> {
    const [workspace, id] = JSON.parse(key) as [string, string];
    const workspaceId = workspace || undefined;
    const record = (await this.listRuntimeHosts(workspaceId ?? '')).find((host) => host.id === id);
    if (record === undefined) throw new Error(`Unknown SSH host "${id}"`);
    const resolved = await this.resolveTarget(id, workspaceId);
    if (this.activeTargets.get(key) !== JSON.stringify({ record, target: resolved })) {
      throw new Error(`SSH host "${id}" changed during connection`);
    }
    const policy = this.trust.get(key);
    const savedPassword = await this.credentials.read(key, 'password') ??
      await this.credentials.read(this.key(id), 'password');
    const savedPassphrase = await this.credentials.read(key, 'passphrase') ??
      await this.credentials.read(this.key(id), 'passphrase');
    const savedIdentityFile = await this.credentials.read(key, 'identityFile') ??
      await this.credentials.read(this.key(id), 'identityFile');
    const knownHostsFiles = this.knownHostsFiles(resolved);
    return {
      hostname: resolved.hostname,
      port: resolved.port,
      username: resolved.user,
      password: policy?.credential?.password ?? savedPassword,
      passphrase: policy?.credential?.passphrase ?? savedPassphrase,
      keyContents: policy?.credential?.privateKeyContents === undefined ? undefined : [policy.credential.privateKeyContents],
      keyPaths: [
        ...(policy?.credential?.privateKeyPath === undefined ? [] : [policy.credential.privateKeyPath]),
        ...(savedIdentityFile === undefined ? [] : [savedIdentityFile]),
        ...resolved.identityFiles.map((file) => file.startsWith('~/') ? join(this.bootstrap.osHomeDir, file.slice(2)) : file),
      ],
      keyboardInteractive: policy?.keyboardInteractive,
      agent: resolved.identityAgent?.startsWith('~/')
        ? join(this.bootstrap.osHomeDir, resolved.identityAgent.slice(2)) : resolved.identityAgent,
      knownHostsFiles,
      proxyJump: resolved.proxyJump,
      proxyCommand: resolved.proxyCommand,
      configFile: join(this.bootstrap.osHomeDir, '.ssh', 'config'),
      trustUnknown: policy?.trustUnknown,
      autoTrustFirstKey: policy?.autoTrustFirstKey,
    };
  }
}

registerScopedService(LifecycleScope.App, ISshHostService, SshHostService, ScopeActivation.OnDemand, 'ssh');
