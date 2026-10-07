import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { HostVerifier } from 'ssh2';

import { SSHKaos } from './ssh';
import {
  SshKnownHostVerificationError,
  SshKnownHosts,
  type TrustUnknownKey,
} from './ssh-known-hosts';

export { SshKnownHostVerificationError, SshKnownHosts } from './ssh-known-hosts';
export type {
  SshKnownHostVerificationReason,
  SshKnownHostVerificationStatus,
  TrustUnknownKey,
  UnknownSshKey,
  SshKnownHostsInspection,
  SshKnownHostRecord,
} from './ssh-known-hosts';

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

export type SshCallerOutcome = 'resolved' | 'rejected' | 'cancelled' | 'unknown';
export type SshCleanupOutcome = 'closed' | 'killed' | 'already_closed' | 'cleanup_failed';

export interface SshConnectionReceipt {
  readonly operationId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly stage: 'connect' | 'disconnect' | 'dispose';
  readonly callerOutcome: SshCallerOutcome;
  readonly terminalOwner: 'ssh_proxy' | 'ssh_connection';
  readonly cleanupOutcome: SshCleanupOutcome;
  readonly resourcesBefore: number;
  readonly resourcesAfter: number;
  readonly killRequested?: boolean;
  readonly exitObserved?: boolean;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly errorCode?: string | number;
  readonly settledAt: number;
}

interface ProxyResourceSnapshot {
  readonly before: number;
  readonly after: number;
  readonly killRequested: boolean;
  readonly exitObserved: boolean;
}

interface ConnectionSlot {
  generation: number;
  state: SshConnectionStatus['state'];
  lastUsed: number;
  current?: SSHKaos;
  pending?: Promise<SSHKaos>;
  unsubscribe?: () => void;
  proxy?: { dispose(): void; resources(): ProxyResourceSnapshot };
  lastResources?: ProxyResourceSnapshot;
  lastTerminalOwner?: 'ssh_proxy' | 'ssh_connection';
  controller?: AbortController;
  retryAfter: number;
  failures: number;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;

function sshAgent(explicit?: string): string | undefined {
  if (explicit === 'none') return undefined;
  return explicit ?? process.env['SSH_AUTH_SOCK'] ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
}

function openProxy(host: SshConnectionHost): {
  socket: Duplex;
  dispose(): void;
  resources(): ProxyResourceSnapshot;
} | undefined {
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
  const snapshot: ProxyResourceSnapshot = {
    before: 5,
    get after() {
      const exitObserved = proxy.exitCode !== null || proxy.signalCode !== null;
      return Number(!socket.destroyed) + Number(!proxy.stdin.destroyed) + Number(!proxy.stdout.destroyed) +
        Number(!proxy.stderr.destroyed) + Number(!exitObserved);
    },
    get killRequested() { return proxy.killed; },
    get exitObserved() { return proxy.exitCode !== null || proxy.signalCode !== null; },
  };
  const resources = (): ProxyResourceSnapshot => snapshot;
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
  return { socket, dispose, resources };
}

function errorDetails(error: unknown): Pick<SshConnectionReceipt, 'errorName' | 'errorMessage' | 'errorCode'> {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = (error as { readonly reason?: unknown }).reason;
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(code === undefined ? reason === undefined ? {} : { errorCode: String(reason) } : { errorCode: code }),
    };
  }
  return { errorName: 'Error', errorMessage: String(error) };
}

function cleanupOutcome(resources: ProxyResourceSnapshot | undefined): SshCleanupOutcome {
  if (resources === undefined || resources.after === 0 && resources.exitObserved) return 'closed';
  if (resources.killRequested && !resources.exitObserved) return 'killed';
  return 'cleanup_failed';
}

function resourceDetails(resources: ProxyResourceSnapshot | undefined): Pick<SshConnectionReceipt, 'killRequested' | 'exitObserved'> {
  if (resources === undefined) return {};
  return { killRequested: resources.killRequested, exitObserved: resources.exitObserved };
}

export class SshConnectionManager {
  private readonly slots = new Map<string, ConnectionSlot>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<(status: SshConnectionStatus) => void>();
  private readonly receiptListeners = new Set<(receipt: SshConnectionReceipt) => void>();
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

  onReceipt(listener: (receipt: SshConnectionReceipt) => void): () => void {
    this.receiptListeners.add(listener);
    return () => { this.receiptListeners.delete(listener); };
  }

  private emit(hostId: string, slot: ConnectionSlot, state: SshConnectionStatus['state']): void {
    slot.state = state;
    for (const listener of this.listeners) listener({ hostId, state, generation: slot.generation });
  }

  private emitReceipt(receipt: SshConnectionReceipt): void {
    for (const listener of this.receiptListeners) {
      try { listener(receipt); }
      catch { process.emitWarning('SSH receipt observer threw an exception', { code: 'SSH_RECEIPT_OBSERVER_FAILED' }); }
    }
  }

  status(hostId: string): SshConnectionStatus {
    const slot = this.slots.get(hostId);
    return { hostId, state: slot?.state ?? 'idle', generation: slot?.generation ?? this.generations.get(hostId) ?? 0 };
  }

  async get(hostId: string): Promise<SSHKaos> {
    const operationId = randomUUID();
    if (this.disposed) {
      const error = new Error('SSH connection manager is disposed');
      this.emitReceipt({
        operationId, hostId, generation: this.generations.get(hostId) ?? 0, stage: 'connect',
        callerOutcome: 'rejected', terminalOwner: 'ssh_connection', cleanupOutcome: 'already_closed',
        resourcesBefore: 0, resourcesAfter: 0, ...errorDetails(error), settledAt: Date.now(),
      });
      throw error;
    }
    let slot = this.slots.get(hostId);
    if (slot === undefined) {
      slot = { generation: this.generations.get(hostId) ?? 0, state: 'idle', lastUsed: Date.now(), retryAfter: 0, failures: 0 };
      this.slots.set(hostId, slot);
    }
    slot.lastUsed = Date.now();
    if (slot.current) {
      this.emitReceipt({
        operationId, hostId, generation: slot.generation, stage: 'connect',
        callerOutcome: 'resolved', terminalOwner: 'ssh_connection', cleanupOutcome: 'already_closed',
        resourcesBefore: slot.lastResources?.before ?? 0, resourcesAfter: slot.lastResources?.after ?? 0,
        settledAt: Date.now(),
      });
      return slot.current;
    }
    if (slot.pending) {
      try {
        const connection = await slot.pending;
        this.emitReceipt({
          operationId, hostId, generation: slot.generation, stage: 'connect',
          callerOutcome: 'resolved', terminalOwner: 'ssh_connection', cleanupOutcome: 'already_closed',
          resourcesBefore: slot.lastResources?.before ?? 0, resourcesAfter: slot.lastResources?.after ?? 0,
          settledAt: Date.now(),
        });
        return connection;
      } catch (error) {
        this.emitReceipt({
          operationId, hostId, generation: slot.generation, stage: 'connect',
          callerOutcome: 'rejected', terminalOwner: slot.lastTerminalOwner ?? 'ssh_connection',
          cleanupOutcome: cleanupOutcome(slot.lastResources),
          resourcesBefore: slot.lastResources?.before ?? 0, resourcesAfter: slot.lastResources?.after ?? 0,
          ...resourceDetails(slot.lastResources),
          ...errorDetails(error), settledAt: Date.now(),
        });
        throw error;
      }
    }
    if (slot.retryAfter === Infinity) {
      const error = new Error(`SSH host ${hostId} requires manual intervention before retrying`);
      this.emitReceipt({
        operationId, hostId, generation: slot.generation, stage: 'connect',
        callerOutcome: 'rejected', terminalOwner: 'ssh_connection', cleanupOutcome: 'already_closed',
        resourcesBefore: slot.lastResources?.before ?? 0, resourcesAfter: slot.lastResources?.after ?? 0,
        ...errorDetails(error), settledAt: Date.now(),
      });
      throw error;
    }
    if (Date.now() < slot.retryAfter) {
      const error = new Error(`SSH host ${hostId} is retrying after a connection failure`);
      this.emitReceipt({
        operationId, hostId, generation: slot.generation, stage: 'connect',
        callerOutcome: 'rejected', terminalOwner: 'ssh_connection', cleanupOutcome: 'already_closed',
        resourcesBefore: slot.lastResources?.before ?? 0, resourcesAfter: slot.lastResources?.after ?? 0,
        ...errorDetails(error), settledAt: Date.now(),
      });
      throw error;
    }
    const owner = slot;
    this.emit(hostId, owner, 'connecting');
    const pending = this.connect(hostId, owner);
    owner.pending = pending;
    try {
      const connection = await pending;
      this.emitReceipt({
        operationId, hostId, generation: owner.generation, stage: 'connect',
        callerOutcome: 'resolved', terminalOwner: 'ssh_connection', cleanupOutcome: 'already_closed',
        resourcesBefore: owner.lastResources?.before ?? 0, resourcesAfter: owner.lastResources?.after ?? 0,
        settledAt: Date.now(),
      });
      return connection;
    } catch (error) {
      this.emitReceipt({
        operationId, hostId, generation: owner.generation, stage: 'connect',
        callerOutcome: 'rejected', terminalOwner: owner.lastTerminalOwner ?? 'ssh_connection',
        cleanupOutcome: cleanupOutcome(owner.lastResources),
        resourcesBefore: owner.lastResources?.before ?? 0, resourcesAfter: owner.lastResources?.after ?? 0,
        ...resourceDetails(owner.lastResources),
        ...errorDetails(error), settledAt: Date.now(),
      });
      throw error;
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
      slot.lastTerminalOwner = 'ssh_connection';
      slot.lastResources = proxy?.resources();
      slot.unsubscribe = connection.onDidDisconnect(() => {
        if (slot.current !== connection) return;
        slot.current = undefined;
        slot.unsubscribe?.();
        slot.unsubscribe = undefined;
        const resourcesBefore = slot.proxy?.resources();
        slot.proxy?.dispose();
        slot.lastResources = slot.proxy?.resources() ?? slot.lastResources;
        slot.proxy = undefined;
        this.emitReceipt({
          operationId: randomUUID(), hostId, generation: slot.generation, stage: 'disconnect',
          callerOutcome: 'unknown', terminalOwner: slot.lastTerminalOwner ?? 'ssh_connection',
          cleanupOutcome: cleanupOutcome(slot.lastResources),
          resourcesBefore: resourcesBefore?.before ?? slot.lastResources?.before ?? 0,
          resourcesAfter: slot.lastResources?.after ?? 0,
          ...resourceDetails(slot.lastResources), settledAt: Date.now(),
        });
        this.emit(hostId, slot, 'disconnected');
      });
      this.emit(hostId, slot, 'ready');
      return connection;
    } catch (error) {
      slot.lastTerminalOwner = proxy === undefined ? 'ssh_connection' : 'ssh_proxy';
      slot.lastResources = proxy?.resources();
      proxy?.dispose();
      if (proxy !== undefined) slot.lastResources = proxy.resources();
      if (slot.proxy === proxy) slot.proxy = undefined;
      if (this.slots.get(hostId) === slot && !this.disposed) {
        slot.failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        const fatal = error instanceof SshKnownHostVerificationError ||
          /host key changed|Host key verification failed|All configured authentication methods failed/i.test(message);
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
    const operationId = randomUUID();
    const resourcesBefore = slot.proxy?.resources() ?? slot.lastResources;
    const terminalOwner = slot.proxy === undefined ? slot.lastTerminalOwner ?? 'ssh_connection' : 'ssh_proxy';
    const pending = slot.pending;
    const current = slot.current;
    slot.current = undefined;
    this.slots.delete(hostId);
    slot.controller?.abort(new Error(`SSH host ${hostId} was disconnected`));
    slot.unsubscribe?.();
    slot.unsubscribe = undefined;
    slot.proxy?.dispose();
    slot.lastResources = slot.proxy?.resources() ?? slot.lastResources;
    slot.proxy = undefined;
    let failure: unknown;
    try {
      await pending?.catch(() => undefined);
      await current?.close();
    } catch (error) {
      failure = error;
    }
    const resourcesAfter = slot.lastResources?.after ?? 0;
    this.emitReceipt({
      operationId, hostId, generation: slot.generation, stage: 'disconnect',
      callerOutcome: failure === undefined ? 'resolved' : 'rejected', terminalOwner,
      cleanupOutcome: failure === undefined ? cleanupOutcome(slot.lastResources) : 'cleanup_failed',
      resourcesBefore: resourcesBefore?.before ?? 0, resourcesAfter,
      ...resourceDetails(slot.lastResources),
      ...(failure === undefined ? {} : errorDetails(failure)), settledAt: Date.now(),
    });
    this.emit(hostId, slot, 'idle');
    if (failure !== undefined) throw failure;
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
    this.receiptListeners.clear();
  }
}
