import { AsyncLocalStorage } from 'node:async_hooks';

import type { DshLiveAgentFacade } from './index';

export interface DshAgentInit {
  readonly id: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly scopeKey: object;
  readonly provider?: string;
  readonly model?: string;
  readonly requestHeader?: () => {
    readonly provider?: string;
    readonly model?: string;
    readonly config?: Readonly<Record<string, unknown>>;
  } | undefined;
  readonly visibleTools?: () => readonly { readonly name: string; readonly timeoutMs?: number | null }[];
}

interface AgentState {
  revoked: boolean;
}

export class DshAgentIdentityRegistry {
  private readonly als = new AsyncLocalStorage<DshLiveAgentFacade>();
  private readonly generations = new Map<string, WeakRef<DshLiveAgentFacade>>();
  private readonly states = new WeakMap<DshLiveAgentFacade, AgentState>();

  acquire(init: DshAgentInit): DshLiveAgentFacade {
    const key = `${init.sessionId}\0${init.id}\0${init.generation}`;
    const existing = this.generations.get(key)?.deref();
    if (existing !== undefined && !existing.revoked) return existing;
    const state: AgentState = { revoked: false };
    const options = Object.freeze({ provider: init.provider, model: init.model });
    const session = Object.freeze({
      id: init.sessionId,
      requestHeader: () => init.requestHeader?.() ?? (init.provider === undefined && init.model === undefined
        ? undefined
        : { provider: init.provider, model: init.model }),
    });
    const facade: DshLiveAgentFacade & {
      readonly options: Readonly<{ provider?: string; model?: string }>;
    } = {
      id: init.id,
      sessionId: init.sessionId,
      generation: init.generation,
      scopeKey: init.scopeKey,
      options,
      session,
      get revoked() { return state.revoked; },
      get visibleTools() { return init.visibleTools?.() ?? []; },
    };
    this.states.set(facade, state);
    this.generations.set(key, new WeakRef(facade));
    return facade;
  }

  revoke(agent: DshLiveAgentFacade): void {
    const state = this.states.get(agent);
    if (state === undefined) throw new Error('unknown DSH Agent facade');
    state.revoked = true;
  }

  async withInitiator<T>(agent: DshLiveAgentFacade, operation: () => Promise<T> | T): Promise<T> {
    if (agent.revoked) throw new Error(`DSH Agent "${agent.id}" generation ${agent.generation} is revoked`);
    return this.als.run(agent, operation);
  }

  dispose(): void {
    for (const ref of this.generations.values()) {
      const agent = ref.deref();
      if (agent !== undefined) this.revoke(agent);
    }
    this.generations.clear();
    this.als.disable();
  }

  currentInitiator(): DshLiveAgentFacade | undefined {
    return this.als.getStore();
  }

  requireInitiator(): DshLiveAgentFacade {
    const agent = this.currentInitiator();
    if (agent === undefined) throw new Error('this DSH operation requires an active Agent initiator');
    if (agent.revoked) throw new Error(`DSH Agent "${agent.id}" generation ${agent.generation} is revoked`);
    return agent;
  }
}
