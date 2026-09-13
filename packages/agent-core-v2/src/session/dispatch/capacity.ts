import { Error2, ErrorCodes } from '#/errors';

export interface DispatchCapacityLimits {
  readonly maxDirectChildren: number;
  readonly maxTotalSubagents: number;
}

export interface DispatchReservation {
  (): void;
  bind(agentId: string): void;
  claim(agentId: string): void;
}

export class DispatchCapacity {
  private readonly slots = new Map<symbol, { readonly owner: string; agentId?: string; claimed: boolean; holders: number }>();

  retain(agentId: string): (() => void) | undefined {
    const entry = [...this.slots].find(([, slot]) => slot.agentId === agentId);
    return entry === undefined ? undefined : this.hold(entry[0], entry[1]);
  }

  private hold(key: symbol, slot: { holders: number }): () => void {
    slot.holders++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--slot.holders === 0) this.slots.delete(key);
    };
  }

  reserve(owner: string, limits: DispatchCapacityLimits, agentId?: string): DispatchReservation {
    if (agentId !== undefined && [...this.slots.values()].some((slot) => slot.agentId === agentId)) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_RUNNING, `Agent instance "${agentId}" is already starting or running`, {
        details: { agentId },
      });
    }
    const direct = [...this.slots.values()].filter((slot) => slot.owner === owner).length;
    for (const [layer, current, limit] of [
      ['direct', direct, limits.maxDirectChildren],
      ['tree', this.slots.size, limits.maxTotalSubagents],
    ] as const) {
      if (limit === 0 || current < limit) continue;
      throw new Error2(ErrorCodes.DISPATCH_LIMIT_EXCEEDED,
        `Subagent ${layer} limit reached (${current}/${limit}). No agent was started; wait for an active run to finish before dispatching again.`,
        { details: { layer, current, limit, owner } },
      );
    }
    const key = Symbol();
    const slot = { owner, agentId, claimed: false, holders: 0 };
    this.slots.set(key, slot);
    return Object.assign(this.hold(key, slot), {
      bind: (id: string) => {
        if (slot.agentId !== undefined && slot.agentId !== id) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Dispatch reservation is bound to another agent.');
        slot.agentId = id;
      },
      claim: (id: string) => {
        if (!this.slots.has(key) || slot.agentId !== id || slot.claimed) {
          throw new Error2(ErrorCodes.AGENT_ALREADY_RUNNING, `Agent instance "${id}" has no unclaimed execution reservation`, { details: { agentId: id } });
        }
        slot.claimed = true;
      },
    });
  }
}
