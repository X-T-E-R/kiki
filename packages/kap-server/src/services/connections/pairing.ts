import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { PeerTlsIdentity } from './tlsIdentity';
import { isLegacyTlsError, peerFetch } from './peerTls';
import { hostname, networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bridgeGrantSchema, connectionIdentitySchema, extractRelayTargetFingerprint, isDirectConnectionHost, meshCapabilitySchema, normalizePairingCode, normalizeRelayEndpoint, parsePairingUri, peerTrustTierSchema, type BridgeGrant, type BridgeOperation, type ConnectionIdentity, type ConnectionPairRequest, type RemoteConnection, type SpacePlatform } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { AdmissionError } from './admission';
import { PairingBridgeRetirementError, validateEndpoint, type RemoteConnectionManager } from './manager';
import { parseCcpEndpoint, type CcpPairingPrepared } from '../ccpTunnel/connector';

const claimedSchema = z.object({
  target: connectionIdentitySchema, targetLabel: z.string().max(128), grantId: z.string().uuid(), revision: z.number().int().positive(),
  peerToken: z.string().min(32).max(128), revokedBridgeIds: z.array(z.string().uuid()).max(1000).optional(), bridge: z.array(z.object({ grant: bridgeGrantSchema, credential: z.string().min(32).max(128) }).strict()).optional(),
  relayEndpoints: z.array(z.string().min(1).max(2048)).max(16).optional(),
  trustTier: peerTrustTierSchema.optional(),
  meshCapabilities: z.array(meshCapabilitySchema).optional(),
  x25519Recipient: z.string().regex(/^age1[a-z0-9]+$/).optional(),
}).strict();
export interface PairingHooks {
  workspaces(): Promise<readonly string[]>;
  issueBridges(input: { grantId: string; source: ConnectionIdentity; sourceLabel: string; sourceWorkspaces: readonly string[]; approvedOperations?: readonly BridgeOperation[]; requestedOperations?: readonly BridgeOperation[] }): Promise<{ grant: BridgeGrant; credential: string }[]>;
  installBridge(connectionId: string, grant: BridgeGrant, credential: string, connectionGrantId?: string, borrowTools?: boolean): Promise<void>;
  revokeBridge(id: string, source: ConnectionIdentity): Promise<void>;
  revokedBridges?(source: ConnectionIdentity): string[];
  retireBridges?(connectionId: string, ids: readonly string[]): Promise<void>;
  enableThreads(): Promise<void>;
  endpoints(): Promise<readonly string[]>;
  loopbackEndpoint?(): string | undefined;
  x25519Recipient?(): string | undefined;
  relayPairingEndpoints?(expiresAtMs: number): Promise<readonly string[]>;
  relayGrantEndpoints?(grantId: string): readonly string[];
}
export class PairingRateLimit {
  private readonly hits = new Map<string, number[]>();
  private lastPruneAt = 0;
  allow(ip: string, now = Date.now()): boolean {
    if (this.hits.size > 1024 || now - this.lastPruneAt >= 60_000) {
      this.lastPruneAt = now;
      for (const [key, stamps] of this.hits) {
        const fresh = stamps.filter((at) => now - at < 60_000);
        if (fresh.length === 0) this.hits.delete(key);
        else this.hits.set(key, fresh);
      }
      while (this.hits.size >= 4096) {
        const oldest = this.hits.keys().next().value;
        if (oldest === undefined) break;
        this.hits.delete(oldest);
      }
    }
    const recent = (this.hits.get(ip) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 5) { this.hits.set(ip, recent); return false; }
    recent.push(now); this.hits.set(ip, recent); return true;
  }
}
export function machineLabel(): string {
  const name = hostname().replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 128);
  return name === '' ? 'Kiki' : name;
}
export function currentSpacePlatform(): SpacePlatform {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}
const VIRTUAL_INTERFACE_PATTERN = /(?:^|[\s_-])(?:vethernet|wsl|hyper-v\S*|docker\d*|br-[0-9a-f]+|veth\S*|virbr\d*|cni\d*|flannel\S*|kube-\S*|podman\d*|vmnet\d*|vmware\S*|vboxnet\d*|virtualbox\S*|bridge\d*|awdl\d*|llw\d*|anpi\d*|ap\d+|clash\S*|mihomo\S*|meta|sing-?box\S*|wintun\S*|loopback\S*|npcap\S*)(?:$|[\s_(-])/i;
const TUNNEL_INTERFACE_PATTERN = /^(?:utun|tun|tap|wg|tailscale)\d*$/i;
function parseIpv4(host: string): readonly [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}
function isTailscaleHost(host: string): boolean {
  const bare = (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase();
  if (bare.endsWith('.ts.net') || bare.endsWith('.tailscale.net')) return true;
  const parts = parseIpv4(bare);
  return parts !== undefined && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
function isUnusableDirectHost(host: string): boolean {
  const bare = (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase();
  if (bare === '' || bare === 'localhost' || bare === '::1' || bare === '::' || bare.startsWith('fe80:')) return true;
  const parts = parseIpv4(bare);
  if (parts === undefined) return false;
  const [a, b] = parts;
  return a === 0 || a === 127 || (a === 169 && b === 254) || (a === 198 && (b === 18 || b === 19));
}
function directHostRank(host: string, interfaceName = ''): number {
  if (isTailscaleHost(host)) return 1;
  const parts = parseIpv4(host);
  const tunnel = TUNNEL_INTERFACE_PATTERN.test(interfaceName.trim());
  if (parts !== undefined) {
    const [a, b] = parts;
    if (!tunnel && ((a === 192 && b === 168) || a === 10)) return 0;
    if (!tunnel && a === 172 && b >= 16 && b <= 31) return 2;
    return 4;
  }
  return 4;
}
function endpointRank(rawUrl: string): number {
  try {
    const parsed = new URL(rawUrl);
    if (isTailscaleHost(parsed.hostname)) return 1;
    const parts = parseIpv4(parsed.hostname);
    if (parts !== undefined) {
      const [a, b] = parts;
      if ((a === 192 && b === 168) || a === 10) return 0;
      if (a === 172 && b >= 16 && b <= 31) return 2;
      return 4;
    }
    return parsed.protocol === 'https:' ? 3 : 4;
  } catch {
    return 5;
  }
}
function isUsableEndpointUrl(rawUrl: string): boolean {
  try {
    return !isUnusableDirectHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}
function rankedDirectAddresses(interfaces = networkInterfaces()): readonly { address: string; rank: number }[] {
  const candidates = new Map<string, { rank: number; order: number }>();
  let order = 0;
  for (const [name, entries] of Object.entries(interfaces)) {
    const isVirtual = VIRTUAL_INTERFACE_PATTERN.test(name);
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal || (family !== 'IPv4' && family !== 4) || !isDirectConnectionHost(entry.address) || isUnusableDirectHost(entry.address)) continue;
      if (isVirtual && !isTailscaleHost(entry.address)) continue;
      const rank = directHostRank(entry.address, name);
      const existing = candidates.get(entry.address);
      if (existing === undefined || rank < existing.rank) {
        candidates.set(entry.address, { rank, order: existing?.order ?? order++ });
      }
    }
  }
  return [...candidates.entries()]
    .sort((left, right) => left[1].rank - right[1].rank || left[1].order - right[1].order)
    .map(([address, meta]) => ({ address, rank: meta.rank }));
}
export function directAddresses(interfaces = networkInterfaces()): string[] {
  return rankedDirectAddresses(interfaces).map(({ address }) => address);
}
export function directEndpoints(bound: { host: string; port: number } | number, extras: readonly string[] = [], interfaces = networkInterfaces()): string[] {
  const ranked = rankedDirectAddresses(interfaces);
  const interfaceRanks = new Map(ranked.map(({ address, rank }) => [address, rank]));
  const rankForUrl = (url: string): number => {
    try {
      const host = new URL(url).hostname.replaceAll(/^\[|\]$/g, '');
      const known = interfaceRanks.get(host);
      if (known !== undefined) return known;
    } catch {}
    return endpointRank(url);
  };
  const urls = new Map<string, { rank: number; order: number }>();
  let order = 0;
  const add = (url: string, rank = rankForUrl(url)): void => {
    if (url === '' || !isUsableEndpointUrl(url)) return;
    const existing = urls.get(url);
    if (existing === undefined || rank < existing.rank) {
      urls.set(url, { rank, order: existing?.order ?? order++ });
    }
  };
  const target = typeof bound === 'number' ? { host: '0.0.0.0', port: bound } : bound;
  const host = target.host.replace(/^::ffff:/i, '');
  if (target.port > 0) {
    if (host === '0.0.0.0' || host === '::' || host === '') {
      for (const [index, { address, rank }] of ranked.entries()) {
        add(`http://${address}:${target.port}`, rank);
        order = Math.max(order, index + 1);
      }
    } else if (!isUnusableDirectHost(host) && isDirectConnectionHost(host)) {
      add(`http://${host.includes(':') ? `[${host}]` : host}:${target.port}`, interfaceRanks.get(host) ?? endpointRank(`http://${host.includes(':') ? `[${host}]` : host}:${target.port}`));
    }
  }
  for (const extra of extras) add(extra, rankForUrl(extra));
  return [...urls.entries()]
    .sort((left, right) => left[1].rank - right[1].rank || left[1].order - right[1].order)
    .map(([url]) => url);
}
export class PeerListeners {
  private readonly servers = new Map<string, { url: string; rank: number; order: number; close: () => Promise<void> }>();
  private loopbackServer?: { url: string; close: () => Promise<void> };
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
      if (!this.closed && this.loopbackServer === undefined) {
        const bound = await this.listen('127.0.0.1', 0, true).catch(() => undefined);
        if (bound !== undefined) {
          if (this.closed) { await bound.close().catch(() => undefined); }
          else { this.loopbackServer = { url: bound.url.replace(/^http:/, 'https:'), close: bound.close }; }
        }
      }
      const ranked = rankedDirectAddresses();
      const hosts = new Set(ranked.map(({ address }) => address));
      for (const [host, listener] of this.servers) if (!hosts.has(host)) { this.servers.delete(host); await listener.close(); }
      for (const [order, { address: host, rank }] of ranked.entries()) {
        if (this.closed) continue;
        const existing = this.servers.get(host);
        if (existing !== undefined) { existing.rank = rank; existing.order = order; continue; }
        const bound = await this.listen(host, this.port).catch(() => this.listen(host, 0).catch(() => undefined));
        if (bound === undefined) continue;
        if (this.closed) { await bound.close().catch(() => undefined); continue; }
        this.servers.set(host, { ...bound, rank, order });
      }
    });
    this.flight = run.catch(() => undefined);
    return run.then(() => this.urls());
  }
  urls(): string[] { return [...this.servers.values()].sort((left, right) => left.rank - right.rank || left.order - right.order).map((entry) => entry.url); }
  loopbackUrl(): string | undefined { return this.loopbackServer?.url; }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.refreshTimer);
    await this.flight;
    const active = [...this.servers.values()];
    this.servers.clear();
    const loopback = this.loopbackServer;
    this.loopbackServer = undefined;
    if (loopback !== undefined) active.push({ ...loopback, rank: 0, order: 0 });
    await Promise.allSettled(active.map((entry) => entry.close()));
  }
  private async listen(host: string, port: number, tlsOnly = false): Promise<{ url: string; close: () => Promise<void> }> {
    const headerTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
    const clearHeaders = (socket: Socket): void => { clearTimeout(headerTimers.get(socket)); headerTimers.delete(socket); };
    const http = createServer((req, res) => { clearHeaders(req.socket); this.peerRequests.add(req); this.app.server.emit('request', req, res); });
    http.requestTimeout = 0;
    http.on('upgrade', (req, socket, head) => { clearHeaders(req.socket); this.peerRequests.add(req); this.app.server.emit('upgrade', req, socket, head); });
    const guardHeaders = (socket: Socket): void => {
      const drop = (): void => { socket.destroy(); };
      const timer = setTimeout(drop, 15000);
      timer.unref();
      headerTimers.set(socket, timer);
      socket.once('close', () => clearHeaders(socket));
    };
    const tls = createTlsServer({ ...this.identity, handshakeTimeout: 15000 }, (socket) => { guardHeaders(socket); http.emit('connection', socket); });
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
        } else if (tlsOnly) {
          socket.destroy();
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
export async function pairOutbound(manager: RemoteConnectionManager, input: ConnectionPairRequest, hooks: PairingHooks | undefined): Promise<RemoteConnection> {
  const ccpSpec = parseCcpEndpoint(input.endpoint);
  let ccpPrepared: CcpPairingPrepared | undefined;
  let ccpAdopted = false;
  try {
    let rawEndpoint = input.endpoint;
    let rawCode = input.code;
    let explicitFingerprint = input.fingerprint;
    if (ccpSpec !== undefined) {
      if (manager.ccpTunnel === undefined) throw new AdmissionError(503, 'ccp_tunnel_transport_unavailable');
      ccpPrepared = await manager.ccpTunnel.preparePairing({
        runtimeId: ccpSpec.runtimeId,
        remoteTlsPort: ccpSpec.remoteTlsPort,
        code: input.code,
        trusted: input.trusted,
        fingerprint: input.fingerprint,
      });
      rawEndpoint = ccpPrepared.tunnel.endpoint;
      rawCode = ccpPrepared.code;
      explicitFingerprint = ccpPrepared.fingerprint;
    }
    const parsedUri = ccpSpec !== undefined ? undefined : parsePairingUri(rawEndpoint);
    const primaryTarget = parsedUri?.endpoint ?? rawEndpoint;
    const rawAsRelay = ccpSpec === undefined ? normalizeRelayEndpoint(primaryTarget) : undefined;
    const relayCandidates: string[] = [];
    const pushRelay = (candidate: string | undefined) => {
      if (candidate === undefined) return;
      const normalized = normalizeRelayEndpoint(candidate);
      if (normalized !== undefined && !relayCandidates.includes(normalized)) {
        relayCandidates.push(normalized);
      }
    };
    pushRelay(rawAsRelay);
    for (const item of parsedUri?.relayEndpoints ?? []) pushRelay(item);
    for (const item of input.relayEndpoints ?? []) pushRelay(item);

    const directNormalized: string[] = [];
    const pushDirect = (candidate: string | undefined) => {
      if (candidate === undefined || normalizeRelayEndpoint(candidate) !== undefined) return;
      const normalized = normalizeEndpoint(candidate);
      if (!directNormalized.includes(normalized)) directNormalized.push(normalized);
    };
    if (rawAsRelay === undefined) {
      pushDirect(primaryTarget);
    }
    for (const item of parsedUri?.endpoints ?? []) pushDirect(item);
    for (const item of input.endpoints ?? []) pushDirect(item);

    const toSecureOrigin = (rawUrl: string): string => {
      const u = new URL(rawUrl);
      const port = u.port || (u.protocol === 'http:' ? '80' : '443');
      u.protocol = 'https:';
      u.port = port;
      return u.origin;
    };

    const relayDerivedFp = rawAsRelay !== undefined
      ? extractRelayTargetFingerprint(rawAsRelay)
      : relayCandidates.length > 0
        ? extractRelayTargetFingerprint(relayCandidates[0]!)
        : undefined;
    explicitFingerprint = parsedUri?.fingerprint ?? explicitFingerprint ?? relayDerivedFp;
    if (
      explicitFingerprint !== undefined &&
      relayDerivedFp !== undefined &&
      explicitFingerprint !== relayDerivedFp
    ) {
      throw new AdmissionError(409, 'identity_changed');
    }

    let endpoint: string;
    let secureOrigin: string;
    if (directNormalized.length > 0) {
      endpoint = directNormalized[0]!;
      secureOrigin = toSecureOrigin(endpoint);
    } else if (relayCandidates.length > 0) {
      const rParsed = new URL(relayCandidates[0]!);
      const synthetic = `https://${rParsed.host}`;
      endpoint = synthetic;
      secureOrigin = synthetic;
    } else {
      throw new AdmissionError(400, 'invalid_connection_endpoint');
    }

    const previous = manager.list().find((entry) =>
      ccpSpec !== undefined
        ? entry.transport?.kind === 'ccp_tunnel' && entry.transport.runtimeId === ccpSpec.runtimeId && entry.pinnedFingerprint !== undefined
        : entry.transport === undefined && entry.endpoint === secureOrigin && entry.pinnedFingerprint !== undefined,
    );
    const fingerprint = explicitFingerprint ?? previous?.pinnedFingerprint;
    if (relayCandidates.length > 0 && fingerprint === undefined) {
      throw new AdmissionError(409, 'connection_requires_tls');
    }
    const secureDirectCandidates = directNormalized.map(toSecureOrigin);
    let pinnedFingerprint: string | undefined;
    const code = normalizePairingCode(parsedUri?.code ?? rawCode ?? '');
    if (code === undefined) throw new AdmissionError(401, 'invalid_pairing_code');
    const includeGui = input.includeGui !== false;
    const requestBridge = includeGui ? (input.requestBridge ?? true) : true;
    const backgroundSummary = includeGui ? (input.backgroundSummary ?? true) : false;
    const sourceWorkspaces = hooks === undefined || !requestBridge ? [] : await hooks.workspaces();
    const localRecipient = hooks?.x25519Recipient?.();
    const useHappyEyeballs = relayCandidates.length > 0 || secureDirectCandidates.length > 1;
    const pairingCandidates = useHappyEyeballs
      ? { directEndpoints: secureDirectCandidates, relayEndpoints: relayCandidates }
      : undefined;
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kiki-pairing-rotation': '1', 'x-kiki-mesh-metadata': '1', 'x-kiki-bridge-ceiling': '1' },
      body: JSON.stringify({
        code,
        source: manager.identity,
        sourceLabel: machineLabel(),
        requestBridge,
        bridgeOperations: input.bridgeOperations,
        sourceWorkspaces,
        ...(localRecipient === undefined ? {} : { x25519Recipient: localRecipient }),
      }),
      signal: AbortSignal.timeout(15000),
    };
    const original = endpoint;
    const direct = directNormalized.length > 0 && isDirectConnectionHost(new URL(endpoint).hostname);
    let response: Response;
    if (fingerprint !== undefined || original.startsWith('https:') || (direct && original.startsWith('http:'))) {
      endpoint = secureOrigin;
      try {
        response = await peerFetch(
          endpoint + '/api/remote-connections/pair/claim',
          pairingCandidates === undefined ? init : { ...init, candidates: pairingCandidates },
          fingerprint,
          (actual) => { pinnedFingerprint = actual; },
        );
      } catch (error) {
        if (fingerprint !== undefined || relayCandidates.length > 0 || !original.startsWith('http:') || !isLegacyTlsError(error)) throw error;
        endpoint = original;
        response = await peerFetch(endpoint + '/api/remote-connections/pair/claim', init);
      }
    } else response = await peerFetch(endpoint + '/api/remote-connections/pair/claim', init);
    const envelope = await readBoundedJsonBody(response, 65536).catch(() => undefined) as { code?: number; msg?: string; data?: unknown } | undefined;
    if (!response.ok || envelope?.code !== 0) throw new AdmissionError(response.ok ? 409 : response.status, typeof envelope?.msg === 'string' ? envelope.msg : 'invalid_pairing_code');
    const claimed = claimedSchema.parse(envelope.data);
    const durableRelays = (claimed.relayEndpoints ?? [])
      .map((item) => normalizeRelayEndpoint(item))
      .filter((item): item is string => item !== undefined);
    const persistedRelayEndpoints = durableRelays.length > 0 ? durableRelays : relayCandidates;
    const persistedDirectEndpoints =
      ccpPrepared !== undefined
        ? undefined
        : secureDirectCandidates.length > 1 || (directNormalized.length === 0 && persistedRelayEndpoints.length > 0)
          ? secureDirectCandidates
          : undefined;
    const bridges = claimed.bridge ?? [];
    if (!includeGui && bridges.length === 0) {
      const credential = { ownerToken: claimed.peerToken, grant: claimed.peerToken, grantId: claimed.grantId, revision: claimed.revision };
      await manager.cancelClaim(endpoint, claimed.target, credential, pinnedFingerprint, pairingCandidates).catch(() => undefined);
      throw new AdmissionError(409, 'bridge_operation_denied');
    }
    const id = randomUUID();
    const purposes: RemoteConnection['purposes'] = includeGui ? (bridges.length > 0 ? ['gui', 'bridge'] : ['gui']) : ['bridge'];
    const ccpTransport = ccpPrepared === undefined
      ? undefined
      : { kind: 'ccp_tunnel' as const, runtimeId: ccpPrepared.runtimeId, remoteTlsPort: ccpPrepared.remoteTlsPort };
    const storedEndpoint = ccpTransport === undefined ? endpoint : `ccp://${encodeURIComponent(ccpTransport.runtimeId)}`;
    const record: RemoteConnection = {
      id,
      label: input.label?.trim() || claimed.targetLabel,
      endpoint: storedEndpoint,
      ...(persistedDirectEndpoints === undefined ? {} : { endpoints: persistedDirectEndpoints }),
      ...(ccpTransport === undefined && persistedRelayEndpoints.length > 0 ? { relayEndpoints: persistedRelayEndpoints } : {}),
      ...(ccpTransport === undefined ? {} : { transport: ccpTransport }),
      pinnedFingerprint,
      fingerprintToVerify: fingerprint === undefined ? pinnedFingerprint : undefined,
      target: claimed.target,
      credentialRef: id,
      enabled: true,
      purposes,
      backgroundSummary,
      state: 'online',
      lastConnectedAt: Date.now(),
      activeLeases: 0,
      ...(claimed.trustTier === undefined ? {} : { trustTier: claimed.trustTier }),
      ...(input.trusted === true ? { localTrusted: true } : {}),
      ...(claimed.meshCapabilities === undefined ? {} : { meshCapabilities: claimed.meshCapabilities }),
      ...(claimed.x25519Recipient === undefined ? {} : { x25519Recipient: claimed.x25519Recipient }),
    };
    let saved: RemoteConnection | undefined;
    try {
      saved = await manager.storePeer(
        record,
        { ownerToken: claimed.peerToken, grant: claimed.peerToken, grantId: claimed.grantId, revision: claimed.revision },
        input.label,
        ccpPrepared?.tunnel,
      );
      if (ccpPrepared !== undefined) ccpAdopted = true;
      await hooks?.retireBridges?.(saved.id, claimed.revokedBridgeIds ?? []);
      if (hooks !== undefined && bridges.length > 0) {
        await hooks.enableThreads().catch(() => undefined);
        for (const bundle of bridges) await hooks.installBridge(saved.id, bundle.grant, bundle.credential, claimed.grantId, input.borrowTools);
      }
      return saved;
    } catch (error) {
      if (saved === undefined && !(error instanceof PairingBridgeRetirementError)) {
        const credential = { ownerToken: claimed.peerToken, grant: claimed.peerToken, grantId: claimed.grantId, revision: claimed.revision };
        await manager.cancelClaim(endpoint, claimed.target, credential, pinnedFingerprint, pairingCandidates);
      }
      throw error;
    }
  } finally {
    if (ccpPrepared !== undefined && !ccpAdopted) {
      await ccpPrepared.tunnel.close().catch(() => {});
    }
  }
}
