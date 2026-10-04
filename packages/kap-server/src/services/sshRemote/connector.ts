import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { connectionIdentitySchema, sshRemoteProfileSchema, type ConnectionIdentity, type SshRemoteExecute, type SshRemotePlan, type SshRemoteProfile, type SshRemoteStatus, type SshRemoteTransport } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { AdmissionError, sameIdentity } from '../connections/admission';
import { SystemSshProcess, type SshTunnelProcess } from './process';

const bootstrapSchema = z.object({
  url: z.string().url(), token: z.string().min(32).max(4096).regex(/^[a-zA-Z0-9_-]+$/),
  serverId: z.string().min(1), identity: connectionIdentitySchema, serverVersion: z.string().min(1),
  dangerousBypassAuth: z.literal(false), buildChannel: z.string().optional(),
});
type Bootstrap = z.infer<typeof bootstrapSchema>;
type Purpose = 'gui' | 'bridge';
interface PlanEntry { public: SshRemotePlan; bootstrap?: Bootstrap; pending?: Promise<SshRemotePlan> }
interface Slot {
  record: SshRemoteRecord; lifetime: AbortController;
  holds: Map<AbortSignal, { purpose: Purpose; dispose(): void }>;
  pending?: Promise<SshRemoteResolved>; tunnel?: SshTunnelProcess;
}
export interface SshRemoteRecord { id: string; target: ConnectionIdentity; transport: SshRemoteTransport }
export interface SshRemoteResolved { id: string; endpoint: string; target: ConnectionIdentity }
export interface SshRemoteOwner { endpoint: string; localOwnerToken: string; target: ConnectionIdentity; profile: SshRemoteProfile }
export interface SshRemoteConnectorOptions { process?: SystemSshProcess; serverVersion?: string; fetch?: typeof fetch }
export class SshRemoteConnector {
  private readonly plans = new Map<string, PlanEntry>();
  private readonly slots = new Map<string, Slot>();
  private readonly process: SystemSshProcess;
  private readonly fetch: typeof fetch;
  private readonly lifetime = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: SshRemoteConnectorOptions = {}) {
    this.process = options.process ?? new SystemSshProcess(); this.fetch = options.fetch ?? globalThis.fetch;
    this.timer = setInterval(() => { for (const [id, entry] of this.plans) if (entry.public.expiresAt <= Date.now()) this.plans.delete(id); }, 30000); this.timer.unref();
  }
  private validateBootstrap(value: unknown, profile: SshRemoteProfile): Bootstrap {
    const parsed = bootstrapSchema.safeParse(value);
    if (!parsed.success) throw new AdmissionError(409, 'ssh_bootstrap_protocol_mismatch');
    const data = parsed.data; const url = new URL(data.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || Number(url.port) < 1) throw new AdmissionError(409, 'ssh_bootstrap_endpoint_invalid');
    if (data.buildChannel !== undefined && data.buildChannel !== profile.releaseChannel) throw new AdmissionError(409, 'ssh_release_channel_mismatch');
    if (this.options.serverVersion !== undefined && data.serverVersion !== this.options.serverVersion) throw new AdmissionError(409, 'ssh_server_version_mismatch');
    return data;
  }
  private async query(profile: SshRemoteProfile, ensure: boolean, signal: AbortSignal): Promise<Bootstrap | undefined> {
    const value = await this.process.query(profile, ensure, AbortSignal.any([this.lifetime.signal, signal]));
    if (!ensure && typeof value === 'object' && value !== null && Object.keys(value).length === 1 && (value as { running?: unknown }).running === false) return undefined;
    return this.validateBootstrap(value, profile);
  }
  async plan(raw: SshRemoteProfile, signal: AbortSignal = this.lifetime.signal): Promise<SshRemotePlan> {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    if (this.plans.size >= 100) throw new AdmissionError(429, 'ssh_plan_limit');
    const profile = sshRemoteProfileSchema.parse(raw); const bootstrap = await this.query(profile, false, signal);
    const plan: SshRemotePlan = { id: randomUUID(), profile, state: bootstrap === undefined ? 'ensure_required' : 'attach',
      target: bootstrap?.identity, serverId: bootstrap?.serverId, expiresAt: Date.now() + 300000,
      effects: { startsServer: bootstrap === undefined, serverLifetime: bootstrap === undefined ? 'until_explicit_stop' : 'existing', opensInbound: false, installsSoftware: false } };
    this.plans.set(plan.id, { public: plan, bootstrap }); return this.publicPlan(plan);
  }
  private publicPlan(plan: SshRemotePlan): SshRemotePlan { return structuredClone(plan); }
  private entry(id: string): PlanEntry {
    this.lifetime.signal.throwIfAborted(); const entry = this.plans.get(id);
    if (entry === undefined || entry.public.expiresAt <= Date.now()) { this.plans.delete(id); throw new AdmissionError(410, 'ssh_plan_expired'); }
    return entry;
  }
  async execute(id: string, input: SshRemoteExecute, signal: AbortSignal = this.lifetime.signal): Promise<SshRemotePlan> {
    const entry = this.entry(id);
    if (entry.public.state === 'ensure_required' && !input.ensure) throw new AdmissionError(409, 'ssh_ensure_confirmation_required');
    if (entry.pending !== undefined) return entry.pending;
    const pending = (async () => {
      let bootstrap = await this.query(entry.public.profile, false, signal);
      if (bootstrap === undefined && input.ensure && entry.public.state === 'ensure_required') bootstrap = await this.query(entry.public.profile, true, signal);
      if (bootstrap === undefined) throw new AdmissionError(409, 'ssh_remote_not_running');
      if (entry.public.target !== undefined && !sameIdentity(entry.public.target, bootstrap.identity)) throw new AdmissionError(409, 'identity_changed');
      entry.bootstrap = bootstrap; entry.public.state = 'ready'; entry.public.target = bootstrap.identity; entry.public.serverId = bootstrap.serverId;
      return this.publicPlan(entry.public);
    })();
    entry.pending = pending;
    try { return await pending; } finally { if (entry.pending === pending) entry.pending = undefined; }
  }
  async withOwner<T>(id: string, work: (owner: SshRemoteOwner) => Promise<T>, signal: AbortSignal = this.lifetime.signal): Promise<T> {
    const entry = this.entry(id);
    if (entry.public.state !== 'ready' || entry.bootstrap === undefined) throw new AdmissionError(409, 'ssh_plan_not_ready');
    const bootstrap = entry.bootstrap; entry.bootstrap = undefined;
    const tunnel = await this.open(entry.public.profile, bootstrap, AbortSignal.any([this.lifetime.signal, signal]));
    try { return await work({ endpoint: tunnel.endpoint, localOwnerToken: bootstrap.token, target: bootstrap.identity, profile: structuredClone(entry.public.profile) }); }
    finally { await tunnel.close(); }
  }
  async acquire(record: SshRemoteRecord, signal: AbortSignal, purpose: Purpose): Promise<SshRemoteResolved> {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    const profile = sshRemoteProfileSchema.parse(record.transport.profile);
    let slot = this.slots.get(record.id);
    if (slot !== undefined && (!sameIdentity(slot.record.target, record.target) || JSON.stringify(slot.record.transport.profile) !== JSON.stringify(profile))) { this.stop(record.id); throw new AdmissionError(409, 'identity_changed'); }
    if (slot === undefined) {
      slot = { record: { id: record.id, target: { ...record.target }, transport: { kind: 'ssh', profile } }, lifetime: new AbortController(), holds: new Map() };
      this.slots.set(record.id, slot);
    }
    const current = slot;
    if (!current.holds.has(signal)) {
      const release = () => { current.holds.get(signal)?.dispose(); current.holds.delete(signal); if (current.holds.size === 0) this.stop(record.id); };
      signal.addEventListener('abort', release, { once: true });
      current.holds.set(signal, { purpose, dispose: () => signal.removeEventListener('abort', release) });
      if (signal.aborted) release();
    } else if (current.holds.get(signal)?.purpose !== purpose) throw new AdmissionError(403, 'ssh_lease_purpose_mismatch');
    if (current.tunnel !== undefined) {
      if (current.tunnel.signal.aborted) { this.stop(record.id); throw new AdmissionError(502, 'ssh_tunnel_offline'); }
      return { id: record.id, endpoint: current.tunnel.endpoint, target: { ...record.target } };
    }
    if (current.pending === undefined) current.pending = (async () => {
      const bootstrap = await this.query(profile, false, current.lifetime.signal);
      if (bootstrap === undefined) throw new AdmissionError(409, 'ssh_ensure_confirmation_required');
      if (!sameIdentity(bootstrap.identity, record.target)) throw new AdmissionError(409, 'identity_changed');
      const tunnel = await this.open(profile, bootstrap, current.lifetime.signal);
      if (this.slots.get(record.id) !== current || current.lifetime.signal.aborted) { await tunnel.close(); throw new AdmissionError(499, 'ssh_operation_cancelled'); }
      current.tunnel = tunnel;
      tunnel.signal.addEventListener('abort', () => this.stop(record.id), { once: true });
      return { id: record.id, endpoint: tunnel.endpoint, target: { ...record.target } };
    })().catch((error: unknown) => { if (this.slots.get(record.id) === current) this.stop(record.id); throw error; });
    const result = await current.pending; signal.throwIfAborted(); return result;
  }
  private async open(profile: SshRemoteProfile, bootstrap: Bootstrap, signal: AbortSignal): Promise<SshTunnelProcess> {
    const tunnel = await this.process.tunnel(profile, Number(new URL(bootstrap.url).port), signal);
    try {
      const fetchSignal = AbortSignal.any([signal, tunnel.signal, AbortSignal.timeout(10000)]);
      const headers = { authorization: `Bearer ${bootstrap.token}` };
      const metaResponse = await this.fetch(tunnel.endpoint + '/api/meta', { headers, signal: fetchSignal, redirect: 'error' });
      if (!metaResponse.ok) { await metaResponse.body?.cancel(); throw new AdmissionError(metaResponse.status, 'ssh_meta_rejected'); }
      const meta = await readBoundedJsonBody(metaResponse, 65536) as { code: number; data: { server_home_id: string; server_id: string; server_version: string; dangerous_bypass_auth: boolean } };
      if (meta.code !== 0 || meta.data.server_home_id !== bootstrap.identity.homeId || meta.data.server_id !== bootstrap.serverId) throw new AdmissionError(409, 'identity_changed');
      if (meta.data.dangerous_bypass_auth !== false || meta.data.server_version !== bootstrap.serverVersion) throw new AdmissionError(409, 'ssh_server_version_mismatch');
      const helloResponse = await this.fetch(tunnel.endpoint + '/api/remote-connections/handshake', { headers, signal: fetchSignal, redirect: 'error' });
      if (!helloResponse.ok) { await helloResponse.body?.cancel(); throw new AdmissionError(helloResponse.status, 'ssh_handshake_rejected'); }
      const hello = await readBoundedJsonBody(helloResponse, 8192) as { code: number; data: { identity: unknown; serverId: string } };
      const identity = connectionIdentitySchema.safeParse(hello.data?.identity);
      if (hello.code !== 0 || !identity.success || !sameIdentity(identity.data, bootstrap.identity) || hello.data.serverId !== bootstrap.serverId) throw new AdmissionError(409, 'identity_changed');
      signal.throwIfAborted(); tunnel.signal.throwIfAborted(); return tunnel;
    } catch (error) { await tunnel.close(); throw error; }
  }
  status(id: string): SshRemoteStatus {
    const slot = this.slots.get(id); const purposes = [...slot?.holds.values() ?? []];
    return { connectionId: id, state: slot === undefined ? 'offline' : slot.tunnel === undefined ? 'connecting' : 'ready', guiLeases: purposes.filter((p) => p.purpose === 'gui').length, bridgeLeases: purposes.filter((p) => p.purpose === 'bridge').length };
  }
  stop(id: string, purpose?: Purpose): void {
    const slot = this.slots.get(id); if (slot === undefined) return;
    for (const [signal, hold] of slot.holds) if (purpose === undefined || hold.purpose === purpose) { hold.dispose(); slot.holds.delete(signal); }
    if (slot.holds.size > 0) return;
    this.slots.delete(id); slot.lifetime.abort(); void slot.tunnel?.close();
  }
  async close(): Promise<void> {
    clearInterval(this.timer); this.lifetime.abort(); this.plans.clear();
    const slots = [...this.slots.values()]; for (const id of this.slots.keys()) this.stop(id);
    await Promise.allSettled(slots.map(async (slot) => { await slot.pending; await slot.tunnel?.close(); }));
    await this.process.close();
  }
}
