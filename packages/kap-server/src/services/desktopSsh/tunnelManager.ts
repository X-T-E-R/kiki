import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import {
  desktopSshResolvedConnectionSchema,
  type DesktopSshProfile,
  type DesktopSshResolvedConnection,
} from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { SystemSshProcess, sshArguments, type SshTunnelProcess } from '../sshRemote/process';
import type { SshRemoteProfile } from '@kiki/protocol';

export const DESKTOP_SSH_PROBE_TIMEOUT_MS = 12_000;
const MAX_META_BYTES = 64 * 1024;

const remoteMetaSchema = z.object({
  code: z.literal(0),
  data: z.object({
    server_home_id: z.string().min(1),
    server_id: z.string().min(1),
    server_version: z.string().min(1),
    dangerous_bypass_auth: z.literal(false),
    build_id: z.string().min(1).optional(),
    build_channel: z.string().min(1).optional(),
  }),
});

export class DesktopSshTunnelError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'DesktopSshTunnelError';
  }
}

export type DesktopSshTunnelKind = 'active' | 'prepared';

interface DesktopSshTunnelLease {
  readonly profileId: string;
  readonly tunnelId: string;
  kind: DesktopSshTunnelKind;
  readonly profile: DesktopSshProfile;
  readonly connection: DesktopSshResolvedConnection;
  readonly tunnel: SshTunnelProcess;
  accepted: boolean;
  homeId: string;
}

export interface DesktopSshTunnelManagerOptions {
  readonly process?: SystemSshProcess;
  readonly fetch?: typeof fetch;
  readonly probeTimeoutMs?: number;
  readonly now?: () => number;
}

export async function probeRemoteMeta(
  endpoint: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<z.infer<typeof remoteMetaSchema>['data'] | undefined> {
  const signal = parent === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/meta', endpoint), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') return undefined;
    const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
    if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET' || cause?.code === 'ETIMEDOUT') return undefined;
    throw new DesktopSshTunnelError('probe_failed', 'Cannot reach the SSH tunnel endpoint');
  }
  if (response.status === 401 || response.status === 403) {
    void response.body?.cancel().catch(() => undefined);
    throw new DesktopSshTunnelError('auth_rejected', 'Remote Kiki server rejected the bearer token or Host header');
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new DesktopSshTunnelError('probe_http_error', `Remote Kiki metadata request failed (HTTP ${response.status})`);
  }
  let json: unknown;
  try {
    json = await readBoundedJsonBody(response, MAX_META_BYTES, signal);
  } catch (error) {
    if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') return undefined;
    throw new DesktopSshTunnelError('probe_invalid', 'Remote Kiki server returned invalid or oversized metadata');
  }
  const parsed = remoteMetaSchema.safeParse(json);
  if (!parsed.success) throw new DesktopSshTunnelError('probe_invalid', 'Remote Kiki metadata is missing or invalid');
  return parsed.data.data;
}

export async function verifyRemoteServerIdentity(
  endpoint: string,
  token: string,
  expectedHome: string,
  channel: 'stable' | 'beta',
  fetchImpl: typeof fetch,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<z.infer<typeof remoteMetaSchema>['data']> {
  const verified = await probeRemoteMeta(endpoint, token, fetchImpl, timeoutMs, parent);
  if (verified === undefined) throw new DesktopSshTunnelError('probe_incomplete', 'SSH tunnel did not yield remote metadata in time');
  if (verified.server_home_id !== expectedHome) {
    throw new DesktopSshTunnelError('home_mismatch', 'SSH server home identity does not match the trusted profile; connection blocked');
  }
  if (verified.build_channel !== undefined && verified.build_channel !== channel) {
    const hint = verified.build_channel === 'stable' || verified.build_channel === 'beta'
      ? `Remote Kiki release channel is ${verified.build_channel}; select ${verified.build_channel} in this SSH profile and retry`
      : 'Remote Kiki metadata has an unsupported release channel';
    throw new DesktopSshTunnelError('channel_mismatch', hint);
  }
  return verified;
}

export class DesktopSshTunnelManager {
  private readonly leases = new Map<string, DesktopSshTunnelLease>();
  private readonly activeByProfile = new Map<string, string>();
  private readonly preparedByProfile = new Map<string, string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private nextId = 0;
  private stopping = false;
  private readonly process: SystemSshProcess;
  private readonly fetchImpl: typeof fetch;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: DesktopSshTunnelManagerOptions = {}) {
    this.process = options.process ?? new SystemSshProcess();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DESKTOP_SSH_PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  private ensureAccepting(): void {
    if (this.stopping) throw new DesktopSshTunnelError('shutting_down', 'The server is stopping; SSH connections are closed');
  }

  private key(profileId: string, tunnelId: string): string {
    return `${profileId}:${tunnelId}`;
  }

  async connect(profile: DesktopSshProfile, token: string, homeId: string, staged: boolean): Promise<DesktopSshResolvedConnection> {
    this.ensureAccepting();
    const work = this.connectInner(profile, token, homeId, staged);
    this.inFlight.add(work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  private async connectInner(profile: DesktopSshProfile, token: string, homeId: string, staged: boolean): Promise<DesktopSshResolvedConnection> {
    if (profile.remotePort === undefined) {
      throw new DesktopSshTunnelError('remote_port_missing', 'Set the running Kiki server port in this SSH profile');
    }
    if (profile.serverHomeId === undefined) {
      throw new DesktopSshTunnelError('server_home_missing', 'Set the expected home ID from the trusted remote Kiki terminal');
    }
    const remotePort = profile.remotePort;
    const expectedHome = profile.serverHomeId;
    const processProfile = toProcessProfile(profile);
    const tunnel = await this.process.forward(sshArguments(processProfile), remotePort, this.lifetime.signal);
    const probeDeadline = this.now() + this.probeTimeoutMs;
    try {
      for (;;) {
        this.ensureAccepting();
        if (tunnel.signal.aborted) {
          throw new DesktopSshTunnelError('tunnel_offline', 'SSH tunnel exited before the server identity was verified');
        }
        const budget = Math.min(2_000, Math.max(250, probeDeadline - this.now()));
        const signal = AbortSignal.any([this.lifetime.signal, tunnel.signal, AbortSignal.timeout(budget)]);
        let verified: z.infer<typeof remoteMetaSchema>['data'] | undefined;
        try {
          verified = await verifyRemoteServerIdentity(tunnel.endpoint, token, expectedHome, profile.releaseChannel, this.fetchImpl, budget, signal);
        } catch (error) {
          if (error instanceof DesktopSshTunnelError && error.reason === 'probe_incomplete') verified = undefined;
          else throw error;
        }
        if (verified !== undefined) {
          if (tunnel.signal.aborted) {
            throw new DesktopSshTunnelError('tunnel_offline', 'SSH tunnel closed before the server identity was verified');
          }
          this.ensureAccepting();
          this.nextId += 1;
          const tunnelId = String(this.nextId);
          const connection = desktopSshResolvedConnectionSchema.parse({
            config: { url: tunnel.endpoint, token },
            tunnelId,
            serverHomeId: verified.server_home_id,
            serverInstanceId: verified.server_id,
            serverVersion: verified.server_version,
            buildId: verified.build_id,
            buildChannel: verified.build_channel,
          });
          const lease: DesktopSshTunnelLease = {
            profileId: profile.id,
            tunnelId,
            kind: staged ? 'prepared' : 'active',
            profile: structuredClone(profile),
            connection,
            tunnel,
            accepted: !staged,
            homeId,
          };
          this.publish(lease);
          return connection;
        }
        if (this.now() >= probeDeadline) {
          throw new DesktopSshTunnelError('probe_timeout', 'SSH tunnel timed out; verify the running Kiki port and SSH forwarding permission');
        }
        await delay(100, undefined, { signal }).catch(() => undefined);
      }
    } catch (error) {
      await tunnel.close().catch(() => undefined);
      throw error;
    }
  }

  private publish(lease: DesktopSshTunnelLease): void {
    this.ensureAccepting();
    const index = lease.kind === 'prepared' ? this.preparedByProfile : this.activeByProfile;
    const previousId = index.get(lease.profileId);
    if (previousId !== undefined) {
      const previous = this.leases.get(this.key(lease.profileId, previousId));
      index.delete(lease.profileId);
      this.leases.delete(this.key(lease.profileId, previousId));
      if (previous !== undefined) void previous.tunnel.close().catch(() => undefined);
    }
    index.set(lease.profileId, lease.tunnelId);
    this.leases.set(this.key(lease.profileId, lease.tunnelId), lease);
    lease.tunnel.signal.addEventListener('abort', () => {
      const current = this.leases.get(this.key(lease.profileId, lease.tunnelId));
      if (current === lease) this.remove(lease.profileId, lease.tunnelId);
    }, { once: true });
  }

  private lookup(profileId: string, tunnelId: string): DesktopSshTunnelLease | undefined {
    const lease = this.leases.get(this.key(profileId, tunnelId));
    if (lease === undefined) return undefined;
    if (lease.tunnel.signal.aborted) {
      this.remove(profileId, tunnelId);
      return undefined;
    }
    return lease;
  }

  resume(profileId: string, tunnelId: string, homeId: string): { profile: DesktopSshProfile; connection: DesktopSshResolvedConnection } {
    this.ensureAccepting();
    const lease = this.lookup(profileId, tunnelId);
    if (lease === undefined || lease.homeId !== homeId) {
      throw new DesktopSshTunnelError('lease_expired', 'SSH connection reference expired');
    }
    return { profile: structuredClone(lease.profile), connection: lease.connection };
  }

  commit(profileId: string, tunnelId: string, homeId: string): void {
    this.resume(profileId, tunnelId, homeId);
    const lease = this.leases.get(this.key(profileId, tunnelId));
    if (lease === undefined) throw new DesktopSshTunnelError('lease_expired', 'SSH connection reference expired');
    lease.accepted = true;
    if (lease.kind === 'prepared') {
      if (this.preparedByProfile.get(profileId) === tunnelId) this.preparedByProfile.delete(profileId);
      const previousActiveId = this.activeByProfile.get(profileId);
      if (previousActiveId !== undefined && previousActiveId !== tunnelId) {
        const previousKey = this.key(profileId, previousActiveId);
        const previous = this.leases.get(previousKey);
        this.leases.delete(previousKey);
        if (previous !== undefined) void previous.tunnel.close().catch(() => undefined);
      }
      this.activeByProfile.set(profileId, tunnelId);
      lease.kind = 'active';
    }
  }

  isRunning(profileId: string, tunnelId: string): boolean {
    return this.lookup(profileId, tunnelId) !== undefined;
  }

  disconnect(profileId: string, tunnelId: string): boolean {
    const lease = this.leases.get(this.key(profileId, tunnelId));
    if (lease === undefined) return false;
    this.remove(profileId, tunnelId);
    void lease.tunnel.close().catch(() => undefined);
    return true;
  }

  private remove(profileId: string, tunnelId: string): void {
    const key = this.key(profileId, tunnelId);
    const lease = this.leases.get(key);
    this.leases.delete(key);
    if (lease !== undefined) {
      for (const index of [this.activeByProfile, this.preparedByProfile]) {
        if (index.get(profileId) === tunnelId) index.delete(profileId);
      }
    }
  }

  private shutdownWork: Promise<void> | undefined;

  shutdown(): Promise<void> {
    this.shutdownWork ??= this.shutdownInner();
    return this.shutdownWork;
  }

  private async shutdownInner(): Promise<void> {
    this.stopping = true;
    this.lifetime.abort();
    const closing = [...this.leases.values()].map((lease) => lease.tunnel.close().catch(() => undefined));
    this.leases.clear();
    this.activeByProfile.clear();
    this.preparedByProfile.clear();
    await Promise.all(closing);
    await Promise.allSettled([...this.inFlight]);
    await this.process.close();
  }
}

function toProcessProfile(profile: DesktopSshProfile): SshRemoteProfile {
  return {
    id: profile.id,
    label: profile.label,
    target: profile.target,
    identityFile: profile.identityFile,
    releaseChannel: profile.releaseChannel,
    remoteHome: '.',
    remoteExecutable: 'kiki',
    remoteShell: 'posix',
  };
}
