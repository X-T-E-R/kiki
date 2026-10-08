import { posix as posixPath, win32 as win32Path } from 'node:path';
import type { SSHKaos } from '@kiki/kaos/ssh';
import type { TrustUnknownKey } from '@kiki/kaos/ssh-connection';
import type { SshCredentialSubmission } from '#/session/approval/approval';

import { Emitter } from '#/_base/event';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { ISshHostService } from '#/app/ssh/sshService';
import type { SshHostRecord } from '#/app/ssh/sshHosts';
import { SshHostFileSystem, SshHostProcessService } from '#/os/backends/ssh/sshHostServices';

import type { Runtime, RuntimePath, RuntimeStatus } from './runtime';
import type { RuntimeProviderAttachment, RuntimeProviderContext, RuntimeProviderFactory } from './runtimeProvider';
import type { RuntimeProviderHost, RuntimeProviderRuntimeHandle } from './runtimeUnitHost';

const windowsPath: RuntimePath = {
  separator: '/', delimiter: ';',
  isAbsolute: (value) => win32Path.isAbsolute(value),
  join: (...parts) => win32Path.join(...parts).replaceAll('\\', '/'),
  relative: (from, to) => win32Path.relative(from, to).replaceAll('\\', '/'),
  resolve: (...parts) => {
    const native = parts.map((part) => part.replace(/^\/([A-Za-z]:[\\/])/, '$1'));
    if (!native.some((part) => /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(part))) {
      throw new Error('Remote Windows paths require an absolute drive or UNC working directory');
    }
    return win32Path.resolve(...native).replaceAll('\\', '/');
  },
  basename: (value) => win32Path.basename(value),
  dirname: (value) => win32Path.dirname(value).replaceAll('\\', '/'),
};
const path: RuntimePath = { ...posixPath, separator: '/' };

export class SshRuntime implements Runtime {
  readonly capabilities = new Set(['fs', 'process'] as const);
  get path(): RuntimePath { return this.environment.pathClass === 'win32' ? windowsPath : path; }
  readonly fs;
  readonly process;
  readonly workspace: Runtime['workspace'];
  readonly identity;
  private readonly emitter = new Emitter<RuntimeStatus>();
  readonly onDidChangeStatus = this.emitter.event;
  private readonly unsubscribe: () => void;
  private connection?: SSHKaos;
  private probed?: SSHKaos;
  private disposed = false;

  constructor(
    workspaceId: string,
    private readonly host: SshHostRecord,
    private readonly hosts: ISshHostService,
  ) {
    this.identity = {
      workspaceId,
      runtimeId: `ssh:${host.id}`,
      get generation() { return `ssh-${hosts.status(host.id, workspaceId).generation}`; },
    };
    const connect = () => this.connect();
    this.fs = new SshHostFileSystem(connect);
    this.process = new SshHostProcessService(connect);
    this.workspace = {
      supportsExternalPaths: true,
      mapRoots: () => ({
        workDir: this.host.roots?.[0] ?? this.connection?.gethome() ?? '/__ssh_connection_required__',
        additionalDirs: this.host.roots?.slice(1),
      }),
    };
    this.unsubscribe = hosts.onStatus((status) => {
      if (status.hostId === host.id && status.workspaceId === workspaceId && !this.disposed) {
        if (status.state !== 'ready') this.connection = undefined;
        this.emitter.fire(this.status);
      }
    });
  }

  get environment(): HostEnvironmentInfo {
    const remote = this.connection?.osEnv;
    return {
      osKind: remote?.osKind ?? 'POSIX',
      osArch: remote?.osArch ?? 'unknown',
      osVersion: remote?.osVersion ?? 'unknown',
      shellName: remote?.shellName ?? 'sh',
      shellPath: remote?.shellPath ?? '/bin/sh',
      pathClass: remote?.osKind === 'Windows' ? 'win32' : 'posix',
      homeDir: this.connection?.gethome() ?? '/__ssh_connection_required__',
    };
  }

  get status(): RuntimeStatus {
    if (this.disposed) return 'disposed';
    const state = this.hosts.status(this.host.id, this.identity.workspaceId).state;
    return state === 'connecting' ? 'connecting' : state === 'failed' ? 'disconnected' : 'ready';
  }

  async connect(autoTrustFirstKey = false, approvedFingerprint?: string, trustUnknown?: TrustUnknownKey,
    credential?: SshCredentialSubmission,
    keyboardInteractive?: (prompts: readonly { prompt: string; echo: boolean }[]) => Promise<readonly string[]>): Promise<SSHKaos> {
    if (this.disposed) throw new Error('SSH runtime has been disposed');
    const ssh = await this.hosts.connect(this.host.id, this.identity.workspaceId, trustUnknown, autoTrustFirstKey,
      approvedFingerprint, credential, keyboardInteractive);
    if (ssh !== this.probed) {
      await ssh.probeEnvironment();
      this.probed = ssh;
    }
    if (this.disposed) throw new Error('SSH runtime has been disposed');
    this.connection = ssh;
    return ssh;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.connection = undefined;
    this.emitter.fire('disposed');
    this.emitter.dispose();
  }
}

export class SshRuntimeProviderFactory implements RuntimeProviderFactory {
  readonly id = 'ssh';
  readonly imports = { root: [ISshHostService], imports: [], local: [] };

  async attach(context: RuntimeProviderContext, host: RuntimeProviderHost): Promise<RuntimeProviderAttachment> {
    const hosts = host.get(ISshHostService);
    const registered = new Map<string, { handle: RuntimeProviderRuntimeHandle; fingerprint: string }>();
    let disposed = false;
    let tail = Promise.resolve();
    const reconcile = async (): Promise<void> => {
      const current = await hosts.listRuntimeHosts(context.id);
      if (disposed) return;
      const ids = new Set(current.map((item) => item.id));
      for (const [id, entry] of registered) {
        if (ids.has(id)) continue;
        registered.delete(id);
        await entry.handle.remove();
      }
      for (const item of current) {
        const fingerprint = JSON.stringify(item);
        const existing = registered.get(item.id);
        if (existing === undefined) {
          registered.set(item.id, { fingerprint, handle: host.registerRuntime(new SshRuntime(context.id, item, hosts)) });
        } else if (existing.fingerprint !== fingerprint) {
          await existing.handle.update(() => new SshRuntime(context.id, item, hosts));
          existing.fingerprint = fingerprint;
        }
      }
    };
    const unsubscribe = hosts.onHostsChanged((workspaceId) => {
      if (workspaceId !== undefined && workspaceId !== context.id) return;
      tail = tail.then(reconcile, reconcile);
      return tail;
    });
    try {
      await reconcile();
    } catch (error) {
      unsubscribe();
      for (const { handle } of registered.values()) await handle.remove();
      throw error;
    }
    return {
      dispose: async () => {
        disposed = true;
        unsubscribe();
        await tail;
        for (const { handle } of registered.values()) await handle.remove();
        registered.clear();
      },
    };
  }
}
