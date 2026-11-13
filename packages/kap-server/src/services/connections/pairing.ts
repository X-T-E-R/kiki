import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { PeerTlsIdentity } from './tlsIdentity';
import { isLegacyTlsError, peerFetch } from './peerTls';
import { hostname, networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bridgeGrantSchema, connectionIdentitySchema, isDirectConnectionHost, normalizePairingCode, parsePairingUri, type BridgeGrant, type BridgeOperation, type ConnectionIdentity, type ConnectionPairInput, type RemoteConnection } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { AdmissionError } from './admission';
import { PairingBridgeRetirementError, validateEndpoint, type RemoteConnectionManager } from './manager';

const claimedSchema = z.object({
  target: connectionIdentitySchema, targetLabel: z.string().max(128), grantId: z.string().uuid(), revision: z.number().int().positive(),
  peerToken: z.string().min(32).max(128), revokedBridgeIds: z.array(z.string().uuid()).max(1000).optional(), bridge: z.array(z.object({ grant: bridgeGrantSchema, credential: z.string().min(32).max(128) }).strict()).optional(),
}).strict();
export interface PairingHooks {
  workspaces(): Promise<readonly string[]>;
  issueBridges(input: { grantId: string; source: ConnectionIdentity; sourceLabel: string; sourceWorkspaces: readonly string[]; approvedOperations?: readonly BridgeOperation[]; requestedOperations?: readonly BridgeOperation[] }): Promise<{ grant: BridgeGrant; credential: string }[]>;
  installBridge(connectionId: string, grant: BridgeGrant, credential: string, connectionGrantId?: string): Promise<void>;
  revokeBridge(id: string, source: ConnectionIdentity): Promise<void>;
  revokedBridges?(source: ConnectionIdentity): string[];
  retireBridges?(connectionId: string, ids: readonly string[]): Promise<void>;
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
  private refreshTimer?: ReturnType<typeof setInterval>;
  constructor(private readonly app: FastifyInstance, private readonly port: number, private readonly peerRequests: WeakSet<IncomingMessage>, private readonly enabled: boolean, private readonly identity: PeerTlsIdentity) {}
  ensure(): Promise<readonly string[]> {
    if (!this.enabled || this.closed) return Promise.resolve([]);
    if (this.refreshTimer === undefined) {
      this.refreshTimer = setInterval(() => { void this.ensure().catch(() => {}); }, 5000);
      this.refreshTimer.unref();
    }
    const run = this.flight.then(async () => {
      const hosts = directAddresses();
      for (const [host, listener] of this.servers) if (!hosts.includes(host)) { this.servers.delete(host); await listener.close(); }
      for (const host of hosts) {
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
    clearInterval(this.refreshTimer);
    await this.flight;
    const active = [...this.servers.values()];
    this.servers.clear();
    await Promise.allSettled(active.map((entry) => entry.close()));
  }
  private async listen(host: string, port: number): Promise<{ url: string; close: () => Promise<void> }> {
    const http = createServer((req, res) => { this.peerRequests.add(req); this.app.server.emit('request', req, res); });
    http.requestTimeout = 0;
    http.on('upgrade', (req, socket, head) => { this.peerRequests.add(req); this.app.server.emit('upgrade', req, socket, head); });
    const guardHeaders = (socket: Socket): void => {
      const drop = (): void => { socket.destroy(); };
      const timer = setTimeout(drop, 15000);
      timer.unref();
      const clear = (): void => { clearTimeout(timer); };
      socket.once('close', clear);
      http.prependOnceListener('request', (req) => { if (req.socket === socket) clear(); });
      http.prependOnceListener('upgrade', (req) => { if (req.socket === socket) clear(); });
    };
    const tls = createTlsServer(this.identity, (socket) => { guardHeaders(socket); http.emit('connection', socket); });
    const sockets = new Set<Socket>();
    const server = createNetServer({ pauseOnConnect: true }, (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.setTimeout(15000, sniffTimeout);
      function sniffTimeout(): void { socket.destroy(); }
      socket.once('readable', () => {
        const chunk = socket.read(1) as Buffer | null;
        if (chunk === null) { socket.destroy(); return; }
        socket.setTimeout(0); socket.off('timeout', sniffTimeout);
        socket.unshift(chunk);
        if (chunk[0] === 0x16) {
          tls.emit('connection', socket);
        } else {
          guardHeaders(socket);
          http.emit('connection', socket);
        }
      });
    });
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
  let endpoint = normalizeEndpoint(parsedUri?.endpoint ?? input.endpoint);
  const secure = new URL(endpoint);
  const port = secure.port || (secure.protocol === 'http:' ? '80' : '443');
  secure.protocol = 'https:'; secure.port = port;
  const explicitFingerprint = parsedUri?.fingerprint ?? input.fingerprint;
  const previous = manager.list().find((entry) => entry.purposes.includes('gui') && entry.endpoint === secure.origin && entry.pinnedFingerprint !== undefined);
  const fingerprint = explicitFingerprint ?? previous?.pinnedFingerprint;
  let pinnedFingerprint: string | undefined;
  const code = normalizePairingCode(parsedUri?.code ?? input.code);
  if (code === undefined) throw new AdmissionError(401, 'invalid_pairing_code');
  const requestBridge = input.requestBridge ?? true;
  const sourceWorkspaces = hooks === undefined || !requestBridge ? [] : await hooks.workspaces();
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'x-kiki-pairing-rotation': '1' }, body: JSON.stringify({ code, source: manager.identity, sourceLabel: machineLabel(), requestBridge, sourceWorkspaces }), signal: AbortSignal.timeout(15000) };
  const original = endpoint;
  const direct = isDirectConnectionHost(new URL(endpoint).hostname);
  let response: Response;
  if (fingerprint !== undefined || (direct && original.startsWith('http:'))) {
    endpoint = secure.origin;
    try { response = await peerFetch(endpoint + '/api/remote-connections/pair/claim', init, fingerprint, (actual) => { pinnedFingerprint = actual; }); }
    catch (error) {
      if (fingerprint !== undefined || !original.startsWith('http:') || !isLegacyTlsError(error)) throw error;
      endpoint = original;
      response = await peerFetch(endpoint + '/api/remote-connections/pair/claim', init);
    }
  } else response = await peerFetch(endpoint + '/api/remote-connections/pair/claim', init);
  const envelope = await readBoundedJsonBody(response, 65536).catch(() => undefined) as { code?: number; msg?: string; data?: unknown } | undefined;
  if (!response.ok || envelope?.code !== 0) throw new AdmissionError(response.ok ? 409 : response.status, typeof envelope?.msg === 'string' ? envelope.msg : 'invalid_pairing_code');
  const claimed = claimedSchema.parse(envelope.data);
  const bridges = claimed.bridge ?? [];
  const id = randomUUID();
  const record: RemoteConnection = { id, label: input.label?.trim() || claimed.targetLabel, endpoint, pinnedFingerprint, fingerprintToVerify: fingerprint === undefined ? pinnedFingerprint : undefined, target: claimed.target, credentialRef: id, enabled: true, purposes: bridges.length > 0 ? ['gui', 'bridge'] : ['gui'], backgroundSummary: input.backgroundSummary, state: 'online', lastConnectedAt: Date.now(), activeLeases: 0 };
  let saved: RemoteConnection | undefined;
  try {
    saved = await manager.storePeer(record, { ownerToken: claimed.peerToken, grant: claimed.peerToken, grantId: claimed.grantId, revision: claimed.revision }, input.label);
    await hooks?.retireBridges?.(saved.id, claimed.revokedBridgeIds ?? []);
    if (hooks !== undefined && bridges.length > 0) {
      await hooks.enableThreads().catch(() => undefined);
      for (const bundle of bridges) await hooks.installBridge(saved.id, bundle.grant, bundle.credential, claimed.grantId);
    }
    return saved;
  } catch (error) {
    if (saved === undefined && !(error instanceof PairingBridgeRetirementError)) {
      const credential = { ownerToken: claimed.peerToken, grant: claimed.peerToken, grantId: claimed.grantId, revision: claimed.revision };
      await manager.cancelClaim(endpoint, claimed.target, credential, pinnedFingerprint);
    }
    throw error;
  }
}
