import { randomUUID } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { z } from 'zod';
import { bridgeGrantSchema, connectionIdentitySchema, isDirectConnectionHost, normalizePairingCode, type BridgeGrant, type ConnectionIdentity, type ConnectionPairInput, type RemoteConnection } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { AdmissionError } from './admission';
import { validateEndpoint, type RemoteConnectionManager } from './manager';

const claimedSchema = z.object({
  target: connectionIdentitySchema, targetLabel: z.string().max(128), grantId: z.string().uuid(), revision: z.number().int().positive(),
  peerToken: z.string().min(32).max(128), bridge: z.array(z.object({ grant: bridgeGrantSchema, credential: z.string().min(32).max(128) }).strict()).optional(),
}).strict();
export interface PairingHooks {
  workspaces(): Promise<readonly string[]>;
  issueBridges(input: { source: ConnectionIdentity; sourceLabel: string; sourceWorkspaces: readonly string[] }): Promise<{ grant: BridgeGrant; credential: string }[]>;
  installBridge(connectionId: string, grant: BridgeGrant, credential: string): Promise<void>;
  revokeBridge(id: string, source: ConnectionIdentity): Promise<void>;
  enableThreads(): Promise<void>;
  webUrl(): string | undefined;
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
export function directEndpoints(port: number, extras: readonly string[] = []): string[] {
  const urls = new Set<string>();
  if (port > 0) {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        const family = entry.family as string | number;
        if (entry.internal || (family !== 'IPv4' && family !== 4) || !isDirectConnectionHost(entry.address)) continue;
        urls.add(`http://${entry.address}:${port}`);
      }
    }
  }
  for (const extra of extras) if (extra !== '') urls.add(extra);
  return [...urls];
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
  const endpoint = normalizeEndpoint(input.endpoint);
  const code = normalizePairingCode(input.code);
  if (code === undefined) throw new AdmissionError(401, 'invalid_pairing_code');
  if (hooks !== undefined) await hooks.enableThreads().catch(() => undefined);
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
    if (hooks !== undefined) for (const bundle of bridges) await hooks.installBridge(saved.id, bundle.grant, bundle.credential);
    return saved;
  } catch (error) {
    await fetch(endpoint + '/api/remote-connections/pair/cancel', { method: 'POST', headers: { authorization: `Bearer ${claimed.peerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ grantId: claimed.grantId, bridgeGrantIds: bridges.map((bundle) => bundle.grant.id) }), redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => undefined);
    if (stored) await manager.remove(id).catch(() => undefined);
    throw error;
  }
}
