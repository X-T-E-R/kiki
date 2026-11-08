import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bridgeGrantSchema, connectionIdentitySchema, isDirectConnectionHost, normalizePairingCode, parsePairingUri, type BridgeGrant, type ConnectionIdentity, type ConnectionPairInput, type RemoteConnection } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { AdmissionError } from './admission';
import { validateEndpoint, type RemoteConnectionManager } from './manager';

const claimedSchema = z.object({
  target: connectionIdentitySchema, targetLabel: z.string().max(128), grantId: z.string().uuid(), revision: z.number().int().positive(),
  peerToken: z.string().min(32).max(128), bridge: z.array(z.object({ grant: bridgeGrantSchema, credential: z.string().min(32).max(128) }).strict()).optional(),
}).strict();
export interface PairingHooks {
  workspaces(): Promise<readonly string[]>;
  issueBridges(input: { grantId: string; source: ConnectionIdentity; sourceLabel: string; sourceWorkspaces: readonly string[] }): Promise<{ grant: BridgeGrant; credential: string }[]>;
  installBridge(connectionId: string, grant: BridgeGrant, credential: string): Promise<void>;
  revokeBridge(id: string, source: ConnectionIdentity): Promise<void>;
  enableThreads(): Promise<void>;
  endpoints(): Promise<readonly string[]>;
}
export class PairingRateLimit {
  private readonly hits = new Map<string, number[]>();
  allow(ip: string, now = Date.now()): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 5) { this.hits.set(ip, recent); return false; }
    recent.push(now); this.hits.set(ip, recent); return true;
  }
}
export function machineLabel(): string {
  const name = hostname().replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 128);
  return name === '' ? 'Kiki' : name;
}
export function directAddresses(interfaces = networkInterfaces()): string[] {
  const hosts = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== 'IPv4' && family !== 4) || !isDirectConnectionHost(entry.address)) continue;
      hosts.add(entry.address);
    }
  }
  return [...hosts];
}
export function directEndpoints(bound: { host: string; port: number } | number, extras: readonly string[] = [], interfaces = networkInterfaces()): string[] {
  const urls = new Set<string>();
  const target = typeof bound === 'number' ? { host: '0.0.0.0', port: bound } : bound;
  const host = target.host.replace(/^::ffff:/i, '');
  if (target.port > 0) {
    if (host === '0.0.0.0' || host === '::' || host === '') {
      for (const address of directAddresses(interfaces)) urls.add(`http://${address}:${target.port}`);
    } else if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase()) && isDirectConnectionHost(host)) {
      urls.add(`http://${host.includes(':') ? `[${host}]` : host}:${target.port}`);
    }
  }
  for (const extra of extras) if (extra !== '') urls.add(extra);
  return [...urls];
}
export class PeerListeners {
  private readonly servers = new Map<string, { url: string; close: () => Promise<void> }>();
  private flight: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly app: FastifyInstance, private readonly port: number, private readonly peerRequests: WeakSet<IncomingMessage>, private readonly enabled: boolean) {}
  ensure(): Promise<readonly string[]> {
    if (!this.enabled || this.closed) return Promise.resolve([]);
    const run = this.flight.then(async () => {
      for (const host of directAddresses()) {
        if (this.closed || this.servers.has(host)) continue;
        const bound = await this.listen(host, this.port).catch(() => this.listen(host, 0).catch(() => undefined));
        if (bound === undefined) continue;
        if (this.closed) { await bound.close().catch(() => undefined); continue; }
        this.servers.set(host, bound);
      }
    });
    this.flight = run.catch(() => undefined);
    return run.then(() => this.urls());
  }
  urls(): string[] { return [...this.servers.values()].map((entry) => entry.url); }
  async close(): Promise<void> {
    this.closed = true;
    await this.flight;
    const active = [...this.servers.values()];
    this.servers.clear();
    await Promise.allSettled(active.map((entry) => entry.close()));
  }
  private async listen(host: string, port: number): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => { this.peerRequests.add(req); this.app.server.emit('request', req, res); });
    server.requestTimeout = 0;
    server.on('upgrade', (req, socket, head) => { this.peerRequests.add(req); this.app.server.emit('upgrade', req, socket, head); });
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    const bound = server.address();
    if (bound === null || typeof bound === 'string') { server.close(); throw new Error('Peer listener has no address'); }
    return {
      url: `http://${host.includes(':') ? `[${host}]` : host}:${bound.port}`,
      close: async () => {
        const closed = new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
        await closed;
      },
    };
  }
}
export function normalizeEndpoint(raw: string): string {
  const text = raw.trim();
  if (text === '') throw new AdmissionError(400, 'invalid_connection_endpoint');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return validateEndpoint(text);
  const host = text.split('/')[0] ?? text;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0] ?? host;
  return validateEndpoint(`${isDirectConnectionHost(name) ? 'http' : 'https'}://${text}`);
}
export async function pairOutbound(manager: RemoteConnectionManager, input: ConnectionPairInput, hooks: PairingHooks | undefined): Promise<RemoteConnection> {
  const parsedUri = parsePairingUri(input.endpoint);
  const endpoint = normalizeEndpoint(parsedUri?.endpoint ?? input.endpoint);
  const code = normalizePairingCode(parsedUri?.code ?? input.code);
  if (code === undefined) throw new AdmissionError(401, 'invalid_pairing_code');
  const sourceWorkspaces = hooks === undefined ? [] : await hooks.workspaces();
  const response = await fetch(endpoint + '/api/remote-connections/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, source: manager.identity, sourceLabel: machineLabel(), requestBridge: true, sourceWorkspaces }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const envelope = await readBoundedJsonBody(response, 65536).catch(() => undefined) as { code?: number; msg?: string; data?: unknown } | undefined;
  if (!response.ok || envelope?.code !== 0) throw new AdmissionError(response.ok ? 409 : response.status, typeof envelope?.msg === 'string' ? envelope.msg : 'invalid_pairing_code');
  const claimed = claimedSchema.parse(envelope.data);
  const bridges = claimed.bridge ?? [];
  const id = randomUUID();
  const record: RemoteConnection = { id, label: input.label?.trim() || claimed.targetLabel, endpoint, target: claimed.target, credentialRef: id, enabled: true, purposes: bridges.length > 0 ? ['gui', 'bridge'] : ['gui'], backgroundSummary: input.backgroundSummary, state: 'online', lastConnectedAt: Date.now(), activeLeases: 0 };
  let stored = false;
  try {
    const saved = await manager.storePeer(record, { ownerToken: claimed.peerToken, grant: claimed.peerToken, grantId: claimed.grantId, revision: claimed.revision });
    stored = true;
    if (hooks !== undefined && bridges.length > 0) {
      await hooks.enableThreads().catch(() => undefined);
      for (const bundle of bridges) await hooks.installBridge(saved.id, bundle.grant, bundle.credential);
    }
    return saved;
  } catch (error) {
    await fetch(endpoint + '/api/remote-connections/pair/cancel', { method: 'POST', headers: { authorization: `Bearer ${claimed.peerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ grantId: claimed.grantId, bridgeGrantIds: bridges.map((bundle) => bundle.grant.id) }), redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => undefined);
    if (stored) await manager.remove(id).catch(() => undefined);
    throw error;
  }
}
