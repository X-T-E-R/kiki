import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { LeasedPortTunnel } from '@kiki/protocol';

export interface OpenLoopbackTunnelOptions {
  readonly nodeId: string;
  readonly remoteHost?: string;
  readonly remotePort: number;
  readonly localPort?: number;
  readonly probeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export interface LoopbackTunnelHandle {
  readonly tunnel: LeasedPortTunnel;
  readonly reused: boolean;
}

export type RemoteTunnelDialer = (input: {
  readonly nodeId: string;
  readonly remoteHost: string;
  readonly remotePort: number;
}) => Duplex;

interface ManagedTunnel {
  readonly key: string;
  readonly server: Server;
  readonly sockets: Set<Socket>;
  tunnel: LeasedPortTunnel;
}

/**
 * Manages loopback TCP port forwards (`127.0.0.1:<port>`) with readiness probing
 * and idempotent reuse of healthy active tunnels per `(nodeId, remoteHost, remotePort)`.
 */
export class LoopbackPortTunnelManager {
  private readonly tunnelsById = new Map<string, ManagedTunnel>();
  private readonly tunnelIdByKey = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<LoopbackTunnelHandle>>();

  constructor(private readonly dialRemote: RemoteTunnelDialer = defaultTcpDialer) {}

  async ensureTunnel(options: OpenLoopbackTunnelOptions): Promise<LoopbackTunnelHandle> {
    const remoteHost = options.remoteHost ?? '127.0.0.1';
    const key = tunnelKey(options.nodeId, remoteHost, options.remotePort);

    const existingId = this.tunnelIdByKey.get(key);
    if (existingId !== undefined) {
      const existing = this.tunnelsById.get(existingId);
      if (existing !== undefined) {
        const probeMs = options.probeTimeoutMs ?? 1500;
        const localAlive = await probeTcpReady(existing.tunnel.localHost, existing.tunnel.localPort, probeMs);
        let upstreamAlive = false;
        if (localAlive) {
          upstreamAlive = await probeUpstreamDial(
            this.dialRemote,
            { nodeId: options.nodeId, remoteHost, remotePort: options.remotePort },
            options.connectTimeoutMs ?? probeMs,
          )
            .then(() => true)
            .catch(() => false);
        }
        if (
          localAlive &&
          upstreamAlive &&
          (options.localPort === undefined || options.localPort === 0 || existing.tunnel.localPort === options.localPort)
        ) {
          existing.tunnel = { ...existing.tunnel, healthy: true };
          return { tunnel: existing.tunnel, reused: true };
        }
        await this.closeTunnel(existingId);
      }
    }

    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      const result = await pending;
      return { tunnel: result.tunnel, reused: true };
    }

    const openPromise = this.openFreshTunnel(key, {
      ...options,
      remoteHost,
    });
    this.inflight.set(key, openPromise);
    try {
      return await openPromise;
    } finally {
      if (this.inflight.get(key) === openPromise) {
        this.inflight.delete(key);
      }
    }
  }

  getTunnel(tunnelId: string): LeasedPortTunnel | undefined {
    return this.tunnelsById.get(tunnelId)?.tunnel;
  }

  listTunnels(): readonly LeasedPortTunnel[] {
    return [...this.tunnelsById.values()]
      .map((entry) => entry.tunnel)
      .toSorted((a, b) => a.createdAt - b.createdAt);
  }

  async closeTunnel(tunnelId: string): Promise<boolean> {
    const managed = this.tunnelsById.get(tunnelId);
    if (managed === undefined) return false;
    this.tunnelsById.delete(tunnelId);
    if (this.tunnelIdByKey.get(managed.key) === tunnelId) {
      this.tunnelIdByKey.delete(managed.key);
    }
    for (const socket of managed.sockets) {
      socket.destroy();
    }
    managed.sockets.clear();
    await new Promise<void>((resolveClose) => {
      managed.server.close(() => resolveClose());
    });
    return true;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.tunnelsById.keys()];
    await Promise.allSettled(ids.map((id) => this.closeTunnel(id)));
  }

  private async openFreshTunnel(
    key: string,
    options: Required<Pick<OpenLoopbackTunnelOptions, 'nodeId' | 'remoteHost' | 'remotePort'>> & {
      readonly localPort?: number;
      readonly probeTimeoutMs?: number;
      readonly connectTimeoutMs?: number;
      readonly idleTimeoutMs?: number;
    },
  ): Promise<LoopbackTunnelHandle> {
    const connectTimeoutMs = options.connectTimeoutMs ?? options.probeTimeoutMs ?? 5_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 300_000;

    await probeUpstreamDial(
      this.dialRemote,
      { nodeId: options.nodeId, remoteHost: options.remoteHost, remotePort: options.remotePort },
      connectTimeoutMs,
    );

    const sockets = new Set<Socket>();
    const server = createServer((clientSocket) => {
      sockets.add(clientSocket);
      clientSocket.setTimeout(idleTimeoutMs);
      clientSocket.once('timeout', () => clientSocket.destroy());
      clientSocket.once('close', () => sockets.delete(clientSocket));
      let upstream: Duplex;
      try {
        upstream = this.dialRemote({
          nodeId: options.nodeId,
          remoteHost: options.remoteHost,
          remotePort: options.remotePort,
        });
      } catch {
        clientSocket.destroy();
        return;
      }
      if ('setTimeout' in upstream && typeof upstream.setTimeout === 'function') {
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      }
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      const teardown = (): void => {
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };
      clientSocket.on('error', teardown);
      upstream.on('error', teardown);
      clientSocket.once('close', teardown);
      upstream.once('close', teardown);
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        rejectListen(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolveListen();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options.localPort ?? 0, '127.0.0.1');
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Failed to bind loopback tunnel listener');
    }

    const healthy = await probeTcpReady('127.0.0.1', address.port, options.probeTimeoutMs ?? 1500);
    if (!healthy) {
      server.close();
      throw new Error(`Loopback tunnel readiness probe failed on 127.0.0.1:${address.port}`);
    }

    const tunnelId = `tun_${randomUUID().slice(0, 12)}`;
    const tunnel: LeasedPortTunnel = {
      tunnelId,
      nodeId: options.nodeId,
      remoteHost: options.remoteHost,
      remotePort: options.remotePort,
      localHost: '127.0.0.1',
      localPort: address.port,
      healthy: true,
      createdAt: Date.now(),
    };
    const managed: ManagedTunnel = { key, server, sockets, tunnel };
    this.tunnelsById.set(tunnelId, managed);
    this.tunnelIdByKey.set(key, tunnelId);
    server.once('close', () => {
      if (this.tunnelsById.get(tunnelId) === managed) {
        this.tunnelsById.delete(tunnelId);
        if (this.tunnelIdByKey.get(key) === tunnelId) {
          this.tunnelIdByKey.delete(key);
        }
      }
    });

    return { tunnel, reused: false };
  }
}

/** Performs a non-destructive TCP connect readiness probe against a loopback port. */
export function probeTcpReady(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(ok);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function probeUpstreamDial(
  dialRemote: RemoteTunnelDialer,
  target: { readonly nodeId: string; readonly remoteHost: string; readonly remotePort: number },
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolveProbe, rejectProbe) => {
    let settled = false;
    let stream: Duplex | undefined;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stream !== undefined && !stream.destroyed) stream.destroy();
      if (err !== undefined) rejectProbe(err);
      else resolveProbe();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Upstream tunnel connect timed out after ${timeoutMs}ms for ${target.nodeId}:${target.remotePort}`));
    }, timeoutMs);
    timer.unref?.();
    try {
      stream = dialRemote(target);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if ('connecting' in stream && (stream as Socket).connecting === false) {
      finish();
      return;
    }
    stream.once('connect', () => finish());
    stream.once('ready', () => finish());
    stream.once('error', (err: Error) => finish(err));
  });
}

function defaultTcpDialer(input: {
  readonly remoteHost: string;
  readonly remotePort: number;
}): Duplex {
  return createConnection({ host: input.remoteHost, port: input.remotePort });
}

function tunnelKey(nodeId: string, remoteHost: string, remotePort: number): string {
  return `${nodeId}\0${remoteHost}\0${remotePort}`;
}
