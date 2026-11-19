import type { AgentId } from '../model/ids';
import {
  AgentTranscript,
  type Disposable,
  type TranscriptResidentLimits,
} from './agentTranscript';

export interface AgentDescriptor {
  readonly agentId: AgentId;
  /** Engine metadata, mirrored for display (e.g. 'main' | 'sub' | independent). */
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: AgentId;
  readonly delegator?:
    | { readonly kind: 'agent'; readonly agentId: AgentId }
    | { readonly kind: 'external'; readonly delegationId: string };
  readonly label?: string;
  readonly isBranch?: boolean;
  readonly branchSeed?: 'fresh' | 'compact' | 'verbatim';
  readonly branchInitiator?: 'user' | 'agent';
  readonly toolsLocked?: boolean;
  readonly branchSealed?: boolean;
  readonly branchBaseTurnId?: number;
  readonly branchBaseMessageId?: string;
  /** Immutable entity birth as a UTC ISO timestamp; absent for legacy identities, never a run/attach time. */
  readonly createdAt?: string;
  readonly disposedAt?: string;
}

export type RosterListener = (agents: readonly AgentDescriptor[]) => void;

function sameDelegator(
  left: AgentDescriptor['delegator'],
  right: AgentDescriptor['delegator'],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  return left.kind === 'agent'
    ? left.agentId === (right as { readonly kind: 'agent'; readonly agentId: AgentId }).agentId
    : left.delegationId === (right as { readonly kind: 'external'; readonly delegationId: string }).delegationId;
}

function sameDescriptor(left: AgentDescriptor | undefined, right: AgentDescriptor): boolean {
  if (left === right) return true;
  if (left === undefined) return false;
  return (
    left.agentId === right.agentId &&
    left.type === right.type &&
    left.parentAgentId === right.parentAgentId &&
    sameDelegator(left.delegator, right.delegator) &&
    left.label === right.label &&
    left.isBranch === right.isBranch &&
    left.branchSeed === right.branchSeed &&
    left.branchInitiator === right.branchInitiator &&
    left.toolsLocked === right.toolsLocked &&
    left.branchSealed === right.branchSealed &&
    left.branchBaseTurnId === right.branchBaseTurnId &&
    left.branchBaseMessageId === right.branchBaseMessageId &&
    left.createdAt === right.createdAt &&
    left.disposedAt === right.disposedAt
  );
}

export class TranscriptStore {
  readonly #agents = new Map<AgentId, AgentTranscript>();
  readonly #descriptors = new Map<AgentId, AgentDescriptor>();
  readonly #rosterListeners = new Set<RosterListener>();

  constructor(
    readonly sessionId: string,
    readonly residentLimits?: TranscriptResidentLimits,
  ) { }

  /** Lazily create (or fetch) the transcript for an agent. */
  ensureAgent(agentId: AgentId, descriptor?: AgentDescriptor): AgentTranscript {
    let transcript = this.#agents.get(agentId);
    if (!transcript) {
      transcript = new AgentTranscript(agentId, this.residentLimits);
      this.#agents.set(agentId, transcript);
    }
    if (descriptor && !sameDescriptor(this.#descriptors.get(agentId), descriptor)) {
      this.#descriptors.set(agentId, descriptor);
      this.#emitRoster();
    }
    return transcript;
  }

  getAgent(agentId: AgentId): AgentTranscript | undefined {
    return this.#agents.get(agentId);
  }

  /** Drop an agent entirely (disposed sub-agent cleaned up). */
  removeAgent(agentId: AgentId): boolean {
    const removed = this.#agents.delete(agentId);
    if (this.#descriptors.delete(agentId) || removed) this.#emitRoster();
    return removed;
  }

  /**
   * Drop an agent's transcript content while keeping it on the roster, for an
   * agent whose history stays available in persistent storage and can be
   * rebuilt on the next read.
   */
  evictAgentTranscript(agentId: AgentId): boolean {
    return this.#agents.delete(agentId);
  }

  /** Merge or replace an agent's roster descriptor. */
  describeAgent(descriptor: AgentDescriptor): void {
    if (!sameDescriptor(this.#descriptors.get(descriptor.agentId), descriptor)) {
      this.#descriptors.set(descriptor.agentId, descriptor);
      this.#emitRoster();
    }
  }

  /** Merge or replace multiple agent roster descriptors in one batch. */
  describeAgents(descriptors: Iterable<AgentDescriptor>): void {
    let changed = false;
    for (const descriptor of descriptors) {
      if (!sameDescriptor(this.#descriptors.get(descriptor.agentId), descriptor)) {
        this.#descriptors.set(descriptor.agentId, descriptor);
        changed = true;
      }
    }
    if (changed) this.#emitRoster();
  }

  markDisposed(agentId: AgentId, disposedAt: string): void {
    const descriptor = this.#descriptors.get(agentId);
    if (descriptor === undefined || descriptor.disposedAt !== undefined) return;
    this.describeAgent({ ...descriptor, disposedAt });
  }

  agents(): readonly AgentDescriptor[] {
    return [...this.#descriptors.values()];
  }

  onRosterChange(listener: RosterListener): Disposable {
    this.#rosterListeners.add(listener);
    return { dispose: () => void this.#rosterListeners.delete(listener) };
  }

  #emitRoster(): void {
    const agents = this.agents();
    for (const listener of this.#rosterListeners) listener(agents);
  }
}
