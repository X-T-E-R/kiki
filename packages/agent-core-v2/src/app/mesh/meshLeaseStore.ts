import {
  meshSessionLeaseSchema,
  type LeasedPeerNode,
  type LeasedPortTunnel,
  type LeasedSeat,
  type LeasedWorkspaceCopy,
  type MeshContextProjection,
  type MeshSessionLease,
} from '@kiki/protocol';

import type { IFileSystemStorageService } from '#/persistence/interface/storage';

const LEASE_SCOPE = 'mesh';
const LEASE_KEY = 'session-leases.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MESH_CONTEXT_MAX_BYTES = 2048;
export const DEFAULT_COALESCE_WINDOW_MS = 1500;

interface StoredLeaseBook {
  readonly version: 1;
  readonly sessions: Record<string, MeshSessionLease>;
}

/** Persists session-scoped active mesh leases so only resources created by or pinned to a session enter its prompt context. */
export class MeshLeaseStore {
  private loaded = false;
  private readonly sessions = new Map<string, MeshSessionLease>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage?: IFileSystemStorageService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (this.storage === undefined) return;
    const bytes = await this.storage.read(LEASE_SCOPE, LEASE_KEY, { recoverMissing: false });
    if (bytes === undefined) return;
    try {
      const parsed = JSON.parse(decoder.decode(bytes)) as Partial<StoredLeaseBook>;
      if (parsed.version === 1 && parsed.sessions !== undefined && typeof parsed.sessions === 'object') {
        for (const [sessionId, raw] of Object.entries(parsed.sessions)) {
          const valid = meshSessionLeaseSchema.safeParse(raw);
          if (valid.success) this.sessions.set(sessionId, valid.data);
        }
      }
    } catch {
    }
  }

  async getLease(sessionId: string): Promise<MeshSessionLease> {
    await this.load();
    return this.sessions.get(sessionId) ?? emptyLease(sessionId, this.now());
  }

  async listLeasedSessionIds(): Promise<readonly string[]> {
    await this.load();
    return [...this.sessions.keys()].toSorted();
  }

  async pinNode(sessionId: string, node: Omit<LeasedPeerNode, 'pinnedAt'>): Promise<MeshSessionLease> {
    return this.mutate(sessionId, (lease, ts) => {
      const entry: LeasedPeerNode = { ...node, pinnedAt: ts };
      const nodes = [...lease.nodes.filter((item) => item.nodeId !== node.nodeId), entry];
      return { ...lease, nodes };
    });
  }

  async pinSeat(
    sessionId: string,
    seat: Omit<LeasedSeat, 'pinnedAt' | 'updatedAt'>,
  ): Promise<MeshSessionLease> {
    return this.mutate(sessionId, (lease, ts) => {
      const existing = lease.seats.find((item) => item.seatId === seat.seatId);
      const entry: LeasedSeat = {
        ...seat,
        pinnedAt: existing?.pinnedAt ?? ts,
        updatedAt: ts,
      };
      const seats = [...lease.seats.filter((item) => item.seatId !== seat.seatId), entry];
      return { ...lease, seats };
    });
  }

  async pinWorkspaceCopy(sessionId: string, copy: LeasedWorkspaceCopy): Promise<MeshSessionLease> {
    return this.mutate(sessionId, (lease) => {
      const workspaceCopies = [
        ...lease.workspaceCopies.filter((item) => item.copyId !== copy.copyId),
        copy,
      ];
      return { ...lease, workspaceCopies };
    });
  }

  async pinPortTunnel(sessionId: string, tunnel: LeasedPortTunnel): Promise<MeshSessionLease> {
    return this.mutate(sessionId, (lease) => {
      const portTunnels = [
        ...lease.portTunnels.filter((item) => item.tunnelId !== tunnel.tunnelId),
        tunnel,
      ];
      return { ...lease, portTunnels };
    });
  }

  async unpin(
    sessionId: string,
    kind: 'node' | 'seat' | 'workspace_copy' | 'port_tunnel',
    id: string,
  ): Promise<MeshSessionLease> {
    return this.mutate(sessionId, (lease) => {
      switch (kind) {
        case 'node':
          return { ...lease, nodes: lease.nodes.filter((item) => item.nodeId !== id) };
        case 'seat':
          return { ...lease, seats: lease.seats.filter((item) => item.seatId !== id) };
        case 'workspace_copy':
          return { ...lease, workspaceCopies: lease.workspaceCopies.filter((item) => item.copyId !== id) };
        case 'port_tunnel':
          return { ...lease, portTunnels: lease.portTunnels.filter((item) => item.tunnelId !== id) };
      }
    });
  }

  async projectContext(sessionId: string): Promise<MeshContextProjection> {
    const lease = await this.getLease(sessionId);
    const contextBlock = renderMeshContext(lease);
    return {
      sessionId,
      revision: lease.revision,
      contextBlock,
      byteLength: contextBlock === null ? 0 : Buffer.byteLength(contextBlock, 'utf8'),
      lease,
    };
  }

  private mutate(
    sessionId: string,
    updater: (lease: MeshSessionLease, ts: number) => MeshSessionLease,
  ): Promise<MeshSessionLease> {
    const run = this.writeChain.then(async () => {
      await this.load();
      const ts = this.now();
      const current = this.sessions.get(sessionId) ?? emptyLease(sessionId, ts);
      const updated = updater(current, ts);
      const next: MeshSessionLease = {
        ...updated,
        sessionId,
        revision: current.revision + 1,
        updatedAt: ts,
      };
      if (isLeaseEmpty(next)) {
        this.sessions.delete(sessionId);
      } else {
        this.sessions.set(sessionId, next);
      }
      await this.persist();
      return next;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    if (this.storage === undefined) return;
    const payload: StoredLeaseBook = {
      version: 1,
      sessions: Object.fromEntries([...this.sessions.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
    };
    await this.storage.write(
      LEASE_SCOPE,
      LEASE_KEY,
      encoder.encode(`${JSON.stringify(payload, null, 2)}\n`),
      { atomic: true },
    );
  }
}

/**
 * Renders a compact overwrite-in-place `<mesh-context>` summary guaranteed to stay within 2048 UTF-8 bytes.
 * Returns `null` when the session has no active leased mesh resources.
 */
export function renderMeshContext(
  lease: MeshSessionLease,
  maxBytes: number = MESH_CONTEXT_MAX_BYTES,
): string | null {
  if (isLeaseEmpty(lease)) return null;
  const header = `<mesh-context session="${escapeAttr(lease.sessionId)}" rev="${lease.revision}">`;
  const footer = '</mesh-context>';

  const candidateLines: string[] = [];
  for (const node of [...lease.nodes].toSorted((a, b) => a.nodeId.localeCompare(b.nodeId))) {
    candidateLines.push(
      `node ${compact(node.nodeId, 32)} "${compact(node.label, 32)}" ${node.state} tier=${node.trustTier}${node.platform === undefined ? '' : ` os=${node.platform}`}`,
    );
  }
  for (const seat of [...lease.seats].toSorted((a, b) => seatPriority(a.state) - seatPriority(b.state) || a.seatId.localeCompare(b.seatId))) {
    candidateLines.push(
      `seat ${compact(seat.seatId, 32)}@${compact(seat.nodeId, 24)} ${seat.state} "${compact(seat.label, 28)}"${seat.summary === undefined ? '' : ` (${compact(seat.summary, 48)})`}`,
    );
  }
  for (const copy of [...lease.workspaceCopies].toSorted((a, b) => a.copyId.localeCompare(b.copyId))) {
    candidateLines.push(
      `copy ${compact(copy.copyId, 32)}@${compact(copy.nodeId, 24)} ${copy.strategy}${copy.dirty ? ' dirty' : ''}`,
    );
  }
  for (const tunnel of [...lease.portTunnels].toSorted((a, b) => a.tunnelId.localeCompare(b.tunnelId))) {
    candidateLines.push(
      `tunnel ${tunnel.localHost}:${tunnel.localPort}->${compact(tunnel.nodeId, 24)}:${tunnel.remotePort} ${tunnel.healthy ? 'ok' : 'down'}`,
    );
  }

  const kept: string[] = [];
  for (let index = 0; index < candidateLines.length; index += 1) {
    const line = candidateLines[index]!;
    const remaining = candidateLines.length - index - 1;
    const trialLines = [...kept, line];
    const withOverflow =
      remaining > 0 ? [...trialLines, `... (+${remaining} more)`] : trialLines;
    const block = `${header}\n${withOverflow.join('\n')}\n${footer}`;
    if (Buffer.byteLength(block, 'utf8') <= maxBytes) {
      kept.push(line);
    } else {
      const omitted = candidateLines.length - kept.length;
      const overflowLine = `... (+${omitted} more)`;
      const truncated = kept.length > 0
        ? `${header}\n${kept.join('\n')}\n${overflowLine}\n${footer}`
        : `${header}\n${overflowLine}\n${footer}`;
      if (Buffer.byteLength(truncated, 'utf8') <= maxBytes) return truncated;
      return `${header}\n${footer}`.slice(0, maxBytes);
    }
  }
  return `${header}\n${kept.join('\n')}\n${footer}`;
}

export interface MeshStateTransition {
  readonly sessionId: string;
  readonly resourceKind: 'node' | 'seat' | 'workspace_copy' | 'port_tunnel';
  readonly resourceId: string;
  readonly previousState: string;
  readonly nextState: string;
  readonly at: number;
  readonly detail?: string;
}

/** Burst-coalesces rapid remote state transitions over a 1.5s window per resource into one compact batch. */
export class MeshStateCoalescer {
  private readonly pending = new Map<string, MeshStateTransition>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onFlush: (transitions: readonly MeshStateTransition[]) => void,
    private readonly windowMs: number = DEFAULT_COALESCE_WINDOW_MS,
  ) {}

  push(transition: MeshStateTransition): void {
    const key = `${transition.sessionId}\0${transition.resourceKind}\0${transition.resourceId}`;
    const existing = this.pending.get(key);
    if (existing === undefined) {
      this.pending.set(key, transition);
    } else {
      this.pending.set(key, {
        ...transition,
        previousState: existing.previousState,
      });
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.flush();
      }, this.windowMs);
      this.timer.unref?.();
    }
  }

  flush(): readonly MeshStateTransition[] {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = [...this.pending.values()].filter(
      (entry) => entry.previousState !== entry.nextState,
    );
    this.pending.clear();
    if (batch.length > 0) this.onFlush(batch);
    return batch;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
  }
}

function emptyLease(sessionId: string, updatedAt: number): MeshSessionLease {
  return {
    sessionId,
    revision: 0,
    updatedAt,
    nodes: [],
    seats: [],
    workspaceCopies: [],
    portTunnels: [],
  };
}

function isLeaseEmpty(lease: MeshSessionLease): boolean {
  return (
    lease.nodes.length === 0 &&
    lease.seats.length === 0 &&
    lease.workspaceCopies.length === 0 &&
    lease.portTunnels.length === 0
  );
}

function seatPriority(state: LeasedSeat['state']): number {
  switch (state) {
    case 'blocked':
      return 0;
    case 'failed':
      return 1;
    case 'running':
      return 2;
    case 'offline':
      return 3;
    case 'completed':
      return 4;
    case 'idle':
      return 5;
  }
}

function compact(value: string, maxChars: number): string {
  const singleLine = value.replaceAll(/[\r\n\t]+/g, ' ').trim();
  return singleLine.length <= maxChars ? singleLine : `${singleLine.slice(0, maxChars - 1)}…`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('"', '').replaceAll(/[\r\n]/g, '');
}
