import { randomUUID } from 'node:crypto';

import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { AgentMeta, SessionMeta } from './sessionMetadata';

const PREVIEW_LENGTH = 2048;
const OUTCOME_PREFIX = 'agent-outcomes/';

type StoredAgentMeta = AgentMeta & { readonly outcomeRef?: string };
interface OutcomeDocument {
  readonly version: 1;
  readonly resultSummary?: string;
  readonly error?: string;
}

/** Reads one saved receipt without materializing the session's other outcomes. Missing sidecars retain the saved preview. */
export async function readAgentOutcome(
  store: Pick<IAtomicDocumentStore, 'get'>,
  scope: string,
  agent: AgentMeta,
): Promise<AgentMeta> {
  const { outcomeRef, ...preview } = agent as StoredAgentMeta;
  if (outcomeRef === undefined) return agent;
  if (!/^agent-outcomes\/[a-f0-9-]+\.json$/.test(outcomeRef)) return preview;
  const outcome = await store.get<OutcomeDocument>(scope, outcomeRef);
  if (outcome?.version !== 1 ||
    (outcome.resultSummary !== undefined && typeof outcome.resultSummary !== 'string') ||
    (outcome.error !== undefined && typeof outcome.error !== 'string')) return preview;
  return { ...preview, resultSummary: outcome.resultSummary, error: outcome.error };
}

export class AgentOutcomeDocuments {
  private readonly projections = new WeakMap<AgentMeta, StoredAgentMeta>();
  private readonly receipts = new Map<string, { readonly resultSummary?: string; readonly error?: string; readonly ref: string }>();

  constructor(
    private readonly store: IAtomicDocumentStore,
    private readonly scope: string,
    private readonly onWriteFailure?: (agentId: string, error: unknown) => void,
  ) {}

  async hydrate(meta: SessionMeta): Promise<SessionMeta> {
    if (meta.agents === undefined) return meta;
    const agents: Record<string, AgentMeta> = {};
    for (const [id, saved] of Object.entries(meta.agents)) {
      const agent = await readAgentOutcome(this.store, this.scope, saved);
      agents[id] = agent;
      const ref = (saved as StoredAgentMeta).outcomeRef;
      if (ref !== undefined || ((agent.resultSummary?.length ?? 0) <= PREVIEW_LENGTH && (agent.error?.length ?? 0) <= PREVIEW_LENGTH)) {
        this.projections.set(agent, saved);
      }
      if (ref !== undefined) this.receipts.set(id, { resultSummary: agent.resultSummary, error: agent.error, ref });
    }
    return { ...meta, agents };
  }

  async project(meta: SessionMeta): Promise<SessionMeta> {
    if (meta.agents === undefined) return meta;
    const agents: Record<string, StoredAgentMeta> = {};
    for (const [id, agent] of Object.entries(meta.agents)) {
      const cached = this.projections.get(agent);
      if (cached !== undefined) {
        agents[id] = cached;
        continue;
      }
      if ((agent.resultSummary?.length ?? 0) <= PREVIEW_LENGTH && (agent.error?.length ?? 0) <= PREVIEW_LENGTH) {
        agents[id] = agent;
        this.projections.set(agent, agent);
        continue;
      }
      const previous = this.receipts.get(id);
      let ref = previous !== undefined && previous.resultSummary === agent.resultSummary && previous.error === agent.error ? previous.ref : undefined;
      if (ref === undefined) {
        ref = `${OUTCOME_PREFIX}${randomUUID()}.json`;
        try {
          await this.store.set(this.scope, ref, { version: 1, resultSummary: agent.resultSummary, error: agent.error } satisfies OutcomeDocument);
        } catch (error) {
          this.onWriteFailure?.(id, error);
          agents[id] = agent;
          continue;
        }
        this.receipts.set(id, { resultSummary: agent.resultSummary, error: agent.error, ref });
      }
      const saved: StoredAgentMeta = { ...agent, resultSummary: agent.resultSummary?.slice(0, PREVIEW_LENGTH),
        error: agent.error?.slice(0, PREVIEW_LENGTH), outcomeRef: ref };
      agents[id] = saved;
      this.projections.set(agent, saved);
    }
    return { ...meta, agents };
  }
}
