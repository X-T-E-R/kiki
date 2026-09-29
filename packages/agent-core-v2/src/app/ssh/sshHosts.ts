import { homedir } from 'node:os';
import { isAbsolute, normalize } from 'node:path/posix';
import { join } from 'pathe';
import { parse, stringify } from 'smol-toml';

import type { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { appendSshHost, discoverSshAliases, resolveSshConfig, validateSshAlias, workspaceSshKey, type ResolvedSshConfig } from './sshConfig';

export interface SshHostRecord {
  readonly id: string;
  readonly name: string;
  readonly source: 'kiki' | 'ssh-config' | 'session';
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly roots?: readonly string[];
  readonly description?: string;
  readonly agentAccess?: 'offered' | 'hidden';
}

export interface SshHostInput extends Omit<SshHostRecord, 'source'> {
  readonly source?: 'kiki';
}

interface HostDocument {
  sync_ssh_config?: boolean;
  connection_approval?: boolean;
  hosts?: Record<string, Omit<SshHostInput, 'id'>>;
}

const GLOBAL_KEY = 'ssh/hosts.toml';
const STORE_SCOPE = '';

function parseDocument(text: string | undefined): HostDocument {
  if (text === undefined || text.trim() === '') return {};
  const value = parse(text) as HostDocument;
  if (value.hosts !== undefined && (typeof value.hosts !== 'object' || Array.isArray(value.hosts))) {
    throw new Error('Invalid SSH hosts document');
  }
  return value;
}

export function normalizeHost(host: SshHostInput): SshHostRecord {
  validateSshAlias(host.id);
  if (!host.name.trim()) throw new Error('SSH host name is required');
  if (host.hostname !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,253}$/.test(host.hostname)) {
    throw new Error('Invalid SSH hostname');
  }
  if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) {
    throw new Error('Invalid SSH port');
  }
  if (host.agentAccess !== undefined && !['offered', 'hidden'].includes(host.agentAccess)) {
    throw new Error('Invalid SSH agent access');
  }
  if (host.roots !== undefined && (!Array.isArray(host.roots) || host.roots.length === 0 ||
    host.roots.some((root) => typeof root !== 'string' || !isAbsolute(root) || root.includes('\\') || root.includes('\0')))) {
    throw new Error('SSH roots must be absolute POSIX paths');
  }
  return {
    id: host.id,
    name: host.name,
    source: 'kiki',
    hostname: host.hostname,
    user: host.user,
    port: host.port,
    identityFile: host.identityFile,
    roots: host.roots?.map((root) => normalize(root)),
    description: host.description,
    agentAccess: host.agentAccess,
  };
}

export class SshHostStore {
  constructor(
    private readonly documents: IAtomicTomlDocumentStore,
    private readonly sshConfigFile = join(homedir(), '.ssh', 'config'),
    private readonly baseDocuments?: IAtomicTomlDocumentStore,
  ) {}

  private async baseGlobal(): Promise<HostDocument> {
    if (this.baseDocuments === undefined) return {};
    return parseDocument(await this.baseDocuments.getText(STORE_SCOPE, GLOBAL_KEY, { recoverMissing: false }));
  }

  private async read(key: string): Promise<{ document: HostDocument; text: string | undefined }> {
    const text = await this.documents.getText(STORE_SCOPE, key, { recoverMissing: false });
    return { document: parseDocument(text), text };
  }

  private async change(key: string, update: (document: HostDocument) => HostDocument): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { document, text } = await this.read(key);
      const next = `${stringify(update(document) as Record<string, unknown>)}\n`;
      if (await this.documents.compareAndSetText(STORE_SCOPE, key, text, next)) return;
    }
    throw new Error('SSH hosts document changed concurrently');
  }

  async setSyncSshConfig(enabled: boolean): Promise<void> {
    await this.change(GLOBAL_KEY, (document) => ({ ...document, sync_ssh_config: enabled }));
  }

  async connectionApprovalEnabled(): Promise<boolean> {
    const home = (await this.read(GLOBAL_KEY)).document;
    return (home.connection_approval ?? (await this.baseGlobal()).connection_approval) !== false;
  }

  async setConnectionApproval(enabled: boolean): Promise<void> {
    await this.change(GLOBAL_KEY, (document) => ({ ...document, connection_approval: enabled }));
  }

  async list(workspaceId?: string): Promise<readonly SshHostRecord[]> {
    const base = await this.baseGlobal();
    const global = (await this.read(GLOBAL_KEY)).document;
    const workspace = workspaceId === undefined ? {} : (await this.read(workspaceSshKey(workspaceId))).document;
    const hosts = new Map<string, SshHostRecord>();
    if ((global.sync_ssh_config ?? base.sync_ssh_config) !== false) {
      for (const alias of await discoverSshAliases(this.sshConfigFile)) {
        hosts.set(alias, { id: alias, name: alias, source: 'ssh-config' });
      }
    }
    for (const document of [base, global, workspace]) {
      for (const [id, input] of Object.entries(document.hosts ?? {})) {
        hosts.set(id, normalizeHost({ ...input, id }));
      }
    }
    return [...hosts.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async discover(): Promise<readonly SshHostRecord[]> {
    return (await discoverSshAliases(this.sshConfigFile)).map((alias) => ({
      id: alias, name: alias, source: 'ssh-config' as const,
    }));
  }

  async upsert(host: SshHostInput, workspaceId?: string): Promise<void> {
    const normalized = normalizeHost(host);
    const { id, source: _source, ...input } = normalized;
    const key = workspaceId === undefined ? GLOBAL_KEY : workspaceSshKey(workspaceId);
    await this.change(key, (document) => ({ ...document, hosts: { ...document.hosts, [id]: input } }));
  }

  async remove(id: string, workspaceId?: string): Promise<void> {
    validateSshAlias(id);
    const key = workspaceId === undefined ? GLOBAL_KEY : workspaceSshKey(workspaceId);
    await this.change(key, (document) => {
      const hosts = { ...document.hosts };
      delete hosts[id];
      return { ...document, hosts };
    });
  }

  async resolve(id: string, workspaceId?: string): Promise<ResolvedSshConfig> {
    const host = (await this.list(workspaceId)).find((item) => item.id === id);
    if (host === undefined) throw new Error('Unknown SSH host');
    const configured = await resolveSshConfig(id, this.sshConfigFile);
    return {
      ...configured,
      hostname: host.hostname ?? configured.hostname,
      user: host.user ?? configured.user,
      port: host.port ?? configured.port,
      identityFiles: host.identityFile === undefined ? configured.identityFiles : [host.identityFile],
    };
  }

  async writeBack(id: string, workspaceId?: string): Promise<void> {
    const host = (await this.list(workspaceId)).find((item) => item.id === id);
    if (host === undefined || host.source !== 'kiki' || host.hostname === undefined || host.user === undefined) {
      throw new Error('Only Kiki hosts with an explicit hostname and user may be written to ssh config');
    }
    await appendSshHost(this.sshConfigFile, host.id, host.hostname, host.user, host.port ?? 22);
  }
}
