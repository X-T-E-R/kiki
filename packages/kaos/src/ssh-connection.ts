import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { HostVerifier } from 'ssh2';

import { SSHKaos } from './ssh';
import { SshKnownHosts, type TrustUnknownKey } from './ssh-known-hosts';

export { SshKnownHosts } from './ssh-known-hosts';
export type { TrustUnknownKey, UnknownSshKey, SshKnownHostsInspection, SshKnownHostRecord } from './ssh-known-hosts';

export interface SshConnectionHost {
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly keyPaths?: string[];
  readonly keyContents?: string[];
  readonly passphrase?: string;
  readonly keyboardInteractive?: (prompts: readonly { readonly prompt: string; readonly echo: boolean }[]) => Promise<readonly string[]>;
  readonly agent?: string;
  readonly proxyJump?: string;
  readonly proxyCommand?: string;
  readonly configFile?: string;
  readonly knownHostsFiles?: readonly string[];
  readonly trustUnknown?: TrustUnknownKey;
  readonly autoTrustFirstKey?: boolean;
}

export interface SshConnectionStatus {
  readonly hostId: string;
  readonly state: 'connecting' | 'ready' | 'disconnected' | 'idle' | 'failed';
  readonly generation: number;
}

interface ConnectionSlot {
  generation: number;
  state: SshConnectionStatus['state'];
  lastUsed: number;
  current?: SSHKaos;
  pending?: Promise<SSHKaos>;
  unsubscribe?: () => void;
  proxy?: { dispose(): void };
  controller?: AbortController;
  retryAfter: number;
  failures: number;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;

function sshAgent(explicit?: string): string | undefined {
  if (explicit === 'none') return undefined;
  return explicit ?? process.env['SSH_AUTH_SOCK'] ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
}

function openProxy(host: SshConnectionHost): { socket: Duplex; dispose(): void } | undefined {
  let proxy: ChildProcessWithoutNullStreams;
  if (host.proxyCommand && host.proxyCommand !== 'none') {
    const values: Record<string, string> = { h: host.hostname, p: String(host.port), r: host.username };
    if (Object.values(values).some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/.test(value))) {
      throw new Error('Invalid SSH ProxyCommand substitution');
    }
    const command = host.proxyCommand.replaceAll(/%%|%[hpr]/g, (token) => token === '%%' ? '%' : values[token[1]!]!);
    proxy = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } else {
    if (!host.proxyJump || host.proxyJump === 'none') return undefined;
    const jumps = host.proxyJump.split(',');
    if (jumps.some((jump) => !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(jump))) {
      throw new Error('Invalid ProxyJump target');
    }
    const last = jumps.at(-1)!;
    const args = [
      ...(host.configFile === undefined ? [] : ['-F', host.configFile]),
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      ...(jumps.length > 1 ? ['-J', jumps.slice(0, -1).join(',')] : []),
      '-W', `${host.hostname}:${host.port}`, last,
    ];
    proxy = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  const socket = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
  socket.on('error', () => undefined);
  proxy.stderr.on('error', (error) => { socket.destroy(error); });
  proxy.stderr.resume();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    socket.destroy();
    proxy.stdin.destroy();
    proxy.stdout.destroy();
    proxy.stderr.destroy();
    proxy.kill();
  };
  socket.once('close', dispose);
  proxy.once('exit', () => { socket.destroy(); });
  proxy.once('error', (error) => { socket.destroy(error); });
  return { socket, dispose };
}

export class SshConnectionManager {
  private readonly slots = new Map<string, ConnectionSlot>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<(status: SshConnectionStatus) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    private readonly resolveHost: (hostId: string) => Promise<SshConnectionHost>,
    private readonly idleMs = 10 * 60_000,
  ) {
    this.timer = setInterval(() => { void this.reapIdle(); }, Math.min(60_000, idleMs));
    this.timer.unref();
  }

  onStatus(listener: (status: SshConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(hostId: string, slot: ConnectionSlot, state: SshConnectionStatus['state']): void {
    slot.state = state;
    for (const listener of this.listeners) listener({ hostId, state, generation: slot.generation });
  }

  status(hostId: string): SshConnectionStatus {
    const slot = this.slots.get(hostId);
    return { hostId, state: slot?.state ?? 'idle', generation: slot?.generation ?? this.generations.get(hostId) ?? 0 };
  }

  async get(hostId: string): Promise<SSHKaos> {
    if (this.disposed) throw new Error('SSH connection manager is disposed');
    let slot = this.slots.get(hostId);
    if (slot === undefined) {
      slot = { generation: this.generations.get(hostId) ?? 0, state: 'idle', lastUsed: Date.now(), retryAfter: 0, failures: 0 };
      this.slots.set(hostId, slot);
    }
    slot.lastUsed = Date.now();
    if (slot.current) return slot.current;
    if (slot.pending) return slot.pending;
    if (slot.retryAfter === Infinity) throw new Error(`SSH host ${hostId} requires manual intervention before retrying`);
    if (Date.now() < slot.retryAfter) throw new Error(`SSH host ${hostId} is retrying after a connection failure`);
    const owner = slot;
    this.emit(hostId, owner, 'connecting');
    const pending = this.connect(hostId, owner);
    owner.pending = pending;
    try {
      return await pending;
    } finally {
      if (owner.pending === pending) owner.pending = undefined;
    }
  }

  private async connect(hostId: string, slot: ConnectionSlot): Promise<SSHKaos> {
    const controller = new AbortController();
    slot.controller = controller;
    let proxy: ReturnType<typeof openProxy>;
    try {
      const host = await this.resolveHost(hostId);
      controller.signal.throwIfAborted();
      const knownHosts = new SshKnownHosts(host.knownHostsFiles);
      proxy = openProxy(host);
      slot.proxy = proxy;
      let verificationError: Error | undefined;
      const connection = await SSHKaos.create({
        signal: controller.signal,
        host: host.hostname,
        port: host.port,
        username: host.username,
        password: host.password,
        keyPaths: host.keyPaths,
        keyContents: host.keyContents,
        passphrase: host.passphrase,
        keyboardInteractive: host.keyboardInteractive,
        hostVerifier: ((rawKey, done) => {
          void knownHosts.verify(host.hostname, host.port, rawKey, async (key) => {
            if (host.autoTrustFirstKey) return true;
            return host.trustUnknown?.(key) ?? false;
          }).then(done, (error: unknown) => {
            verificationError = error instanceof Error ? error : new Error('SSH host verification failed', { cause: error });
            done(false);
          });
        }) satisfies HostVerifier,
        extraOptions: {
          agent: sshAgent(host.agent),
          sock: proxy?.socket,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          readyTimeout: 15_000,
        },
      }).catch((error: unknown) => {
        if (verificationError !== undefined) throw verificationError;
        throw error;
      });
      if (this.slots.get(hostId) !== slot || this.disposed) {
        await connection.close();
        throw new Error(`SSH host ${hostId} was removed during connection`);
      }
      slot.generation += 1;
      this.generations.set(hostId, slot.generation);
      slot.failures = 0;
      slot.retryAfter = 0;
      slot.current = connection;
      slot.proxy = proxy;
      slot.unsubscribe = connection.onDidDisconnect(() => {
        if (slot.current !== connection) return;
        slot.current = undefined;
        slot.unsubscribe?.();
        slot.unsubscribe = undefined;
        slot.proxy?.dispose();
        slot.proxy = undefined;
        this.emit(hostId, slot, 'disconnected');
      });
      this.emit(hostId, slot, 'ready');
      return connection;
    } catch (error) {
      proxy?.dispose();
      if (slot.proxy === proxy) slot.proxy = undefined;
      if (this.slots.get(hostId) === slot && !this.disposed) {
        slot.failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const fatal = /host key changed|Host key verification failed|All configured authentication methods failed/i.test(message);
        slot.retryAfter = fatal || slot.failures >= 8
          ? Infinity
          : Date.now() + BACKOFF_MS[Math.min(slot.failures - 1, BACKOFF_MS.length - 1)]!;
        this.emit(hostId, slot, 'failed');
      }
      throw error;
    }
  }

  retry(hostId: string): void {
    const slot = this.slots.get(hostId);
    if (slot) {
      slot.retryAfter = 0;
      slot.failures = 0;
    }
  }

  async disconnect(hostId: string): Promise<void> {
    const slot = this.slots.get(hostId);
    if (!slot) return;
    this.slots.delete(hostId);
    slot.controller?.abort(new Error(`SSH host ${hostId} was disconnected`));
    slot.unsubscribe?.();
    slot.proxy?.dispose();
    await slot.current?.close();
    this.emit(hostId, slot, 'idle');
  }

  private async reapIdle(): Promise<void> {
    for (const [hostId, slot] of this.slots) {
      if (slot.current && slot.current.activeProcesses === 0 && Date.now() - slot.lastUsed >= this.idleMs) {
        await this.disconnect(hostId);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    await Promise.all([...this.slots.keys()].map((id) => this.disconnect(id)));
    this.listeners.clear();
  }
}
