import { createHash, randomUUID } from 'node:crypto';

import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { sliceUtf16 } from '#/_base/text/utf16';
import type { AgentMeta, SessionMeta } from './sessionMetadata';

const PREVIEW_LENGTH = 2048;
const OUTCOME_PREFIX = 'agent-outcomes/';
const OUTCOME_REF_RE = /^agent-outcomes\/[a-f0-9-]+\.json$/;
const MAX_CACHED_OUTCOMES = 64;
const MAX_CACHED_OUTCOME_CHARS = 4 * 1024 * 1024;

type StoredAgentMeta = AgentMeta & { readonly outcomeRef?: string };
interface OutcomeDocument {
  readonly version: 1;
  readonly resultSummary?: string;
  readonly error?: string;
}

interface CachedOutcome {
  readonly resultSummary?: string;
  readonly error?: string;
  readonly chars: number;
}

function isValidOutcomeRef(value: unknown): value is string {
  return typeof value === 'string' && OUTCOME_REF_RE.test(value);
}

function isWithinPreview(agent: AgentMeta): boolean {
  return (agent.resultSummary?.length ?? 0) <= PREVIEW_LENGTH && (agent.error?.length ?? 0) <= PREVIEW_LENGTH;
}

function outcomeDigest(resultSummary: string | undefined, error: string | undefined): string {
  return createHash('sha256')
    .update(resultSummary ?? '')
    .update('\0')
    .update(error ?? '')
    .digest('hex');
}

function isValidOutcomeDocument(outcome: OutcomeDocument | undefined): outcome is OutcomeDocument {
  return (
    outcome?.version === 1 &&
    (outcome.resultSummary === undefined || typeof outcome.resultSummary === 'string') &&
    (outcome.error === undefined || typeof outcome.error === 'string')
  );
}

/** Reads one saved receipt without materializing the session's other outcomes. Missing sidecars retain the saved preview. */
export async function readAgentOutcome(
  store: Pick<IAtomicDocumentStore, 'get'>,
  scope: string,
  agent: AgentMeta,
): Promise<AgentMeta> {
  const { outcomeRef, ...preview } = agent as StoredAgentMeta;
  if (outcomeRef === undefined) return agent;
  if (!isValidOutcomeRef(outcomeRef)) return preview;
  const outcome = await store.get<OutcomeDocument>(scope, outcomeRef);
  if (!isValidOutcomeDocument(outcome)) return preview;
  return { ...preview, resultSummary: outcome.resultSummary, error: outcome.error };
}

export interface ProjectedSessionMeta {
  readonly encoded: SessionMeta;
  readonly resident: SessionMeta;
  readonly sourceAgents: SessionMeta['agents'];
}

export class AgentOutcomeDocuments {
  private readonly projections = new WeakMap<AgentMeta, StoredAgentMeta>();
  private readonly unhydratedRefs = new WeakMap<AgentMeta, string>();
  private readonly receipts = new Map<string, { readonly digest: string; readonly ref: string }>();
  private readonly hydratedCache = new Map<string, CachedOutcome>();
  private hydratedChars = 0;
  private readonly inFlightReads = new Map<string, Promise<OutcomeDocument | undefined>>();

  constructor(
    private readonly store: IAtomicDocumentStore,
    private readonly scope: string,
    private readonly onWriteFailure?: (agentId: string, error: unknown) => void,
  ) {}

  prepareLoaded(meta: SessionMeta): SessionMeta {
    if (meta.agents === undefined) return meta;
    const agents: Record<string, AgentMeta> = {};
    for (const [id, saved] of Object.entries(meta.agents)) {
      const { outcomeRef, ...preview } = saved as StoredAgentMeta;
      if (isValidOutcomeRef(outcomeRef)) {
        const stored: StoredAgentMeta = { ...preview, outcomeRef };
        agents[id] = preview;
        this.projections.set(preview, stored);
        this.unhydratedRefs.set(preview, outcomeRef);
        continue;
      }
      const clean = outcomeRef === undefined ? saved : preview;
      agents[id] = clean;
      if (isWithinPreview(clean)) {
        this.projections.set(clean, clean);
      }
    }
    return { ...meta, agents };
  }

  refOf(agent: AgentMeta | undefined): string | undefined {
    if (agent === undefined) return undefined;
    const tracked = this.unhydratedRefs.get(agent);
    if (tracked !== undefined) return tracked;
    const explicit = (agent as StoredAgentMeta).outcomeRef;
    return isValidOutcomeRef(explicit) ? explicit : undefined;
  }

  preserveAgentRef(previous: AgentMeta | undefined, next: AgentMeta): AgentMeta {
    if (previous === undefined) return next;
    const ref = this.refOf(previous);
    if (
      ref !== undefined &&
      (next as StoredAgentMeta).outcomeRef === undefined &&
      next.resultSummary === previous.resultSummary &&
      next.error === previous.error
    ) {
      this.unhydratedRefs.set(next, ref);
    }
    return next;
  }

  preserveRefs(
    previousAgents: SessionMeta['agents'],
    nextAgents: SessionMeta['agents'],
  ): void {
    if (previousAgents === undefined || nextAgents === undefined || previousAgents === nextAgents) return;
    for (const [id, next] of Object.entries(nextAgents)) {
      const previous = previousAgents[id];
      if (previous !== undefined && previous !== next) {
        this.preserveAgentRef(previous, next);
      }
    }
  }

  sameOutcome(a: AgentMeta, b: AgentMeta): boolean {
    return this.refOf(a) === this.refOf(b) && a.resultSummary === b.resultSummary && a.error === b.error;
  }

  invalidateAgent(agentId: string): void {
    const previous = this.receipts.get(agentId);
    if (previous !== undefined) {
      this.receipts.delete(agentId);
      this.evictRef(previous.ref);
    }
  }

  async readAgent(meta: SessionMeta, agentId: string): Promise<AgentMeta | undefined> {
    const agent = meta.agents?.[agentId];
    if (agent === undefined) return undefined;
    const ref = this.refOf(agent);
    if (ref === undefined) return agent;
    const { outcomeRef: _, ...preview } = agent as StoredAgentMeta;
    const cached = this.hydratedCache.get(ref);
    if (cached !== undefined) {
      this.hydratedCache.delete(ref);
      this.hydratedCache.set(ref, cached);
      return { ...preview, resultSummary: cached.resultSummary, error: cached.error };
    }
    const outcome = await this.fetchOutcome(ref);
    if (outcome === undefined) return preview;
    return { ...preview, resultSummary: outcome.resultSummary, error: outcome.error };
  }

  async hydrateAll(meta: SessionMeta): Promise<SessionMeta> {
    if (meta.agents === undefined) return meta;
    const entries = Object.entries(meta.agents);
    let changed = false;
    const agents: Record<string, AgentMeta> = {};
    for (const [id, current] of entries) {
      const hydrated = await this.readAgent(meta, id);
      const resolved = hydrated ?? current;
      if (resolved !== current) changed = true;
      agents[id] = resolved;
    }
    return changed ? { ...meta, agents } : meta;
  }

  async project(meta: SessionMeta): Promise<ProjectedSessionMeta> {
    if (meta.agents === undefined) {
      return { encoded: meta, resident: meta, sourceAgents: undefined };
    }
    const sourceAgents = meta.agents;
    const encodedAgents: Record<string, StoredAgentMeta> = {};
    const residentAgents: Record<string, AgentMeta> = {};
    let residentChanged = false;
    for (const [id, agent] of Object.entries(sourceAgents)) {
      const cached = this.projections.get(agent);
      if (cached !== undefined) {
        encodedAgents[id] = cached;
        residentAgents[id] = agent;
        continue;
      }
      const existingRef = this.refOf(agent);
      if (existingRef !== undefined && isWithinPreview(agent)) {
        const { outcomeRef: _, ...residentEntry } = agent as StoredAgentMeta;
        const saved: StoredAgentMeta = { ...residentEntry, outcomeRef: existingRef };
        this.projections.set(residentEntry, saved);
        this.unhydratedRefs.set(residentEntry, existingRef);
        encodedAgents[id] = saved;
        residentAgents[id] = residentEntry;
        if (residentEntry !== agent) residentChanged = true;
        continue;
      }
      if (isWithinPreview(agent)) {
        const { outcomeRef: _, ...clean } = agent as StoredAgentMeta;
        const target = (agent as StoredAgentMeta).outcomeRef === undefined ? agent : clean;
        this.invalidateAgent(id);
        this.projections.set(target, target);
        encodedAgents[id] = target;
        residentAgents[id] = target;
        if (target !== agent) residentChanged = true;
        continue;
      }
      const digest = outcomeDigest(agent.resultSummary, agent.error);
      const previous = this.receipts.get(id);
      let ref = previous !== undefined && previous.digest === digest ? previous.ref : undefined;
      if (ref === undefined) {
        const nextRef = `${OUTCOME_PREFIX}${randomUUID()}.json`;
        try {
          await this.store.set(
            this.scope,
            nextRef,
            { version: 1, resultSummary: agent.resultSummary, error: agent.error } satisfies OutcomeDocument,
            { cooperative: true },
          );
        } catch (error) {
          this.onWriteFailure?.(id, error);
          encodedAgents[id] = agent;
          residentAgents[id] = agent;
          continue;
        }
        if (previous !== undefined) this.evictRef(previous.ref);
        ref = nextRef;
        this.receipts.set(id, { digest, ref });
      }
      this.rememberOutcome(ref, agent.resultSummary, agent.error);
      const { outcomeRef: _, ...base } = agent as StoredAgentMeta;
      const residentEntry: AgentMeta = {
        ...base,
        resultSummary: agent.resultSummary === undefined ? undefined : sliceUtf16(agent.resultSummary, 0, PREVIEW_LENGTH),
        error: agent.error === undefined ? undefined : sliceUtf16(agent.error, 0, PREVIEW_LENGTH),
      };
      const saved: StoredAgentMeta = { ...residentEntry, outcomeRef: ref };
      this.projections.set(residentEntry, saved);
      this.unhydratedRefs.set(residentEntry, ref);
      encodedAgents[id] = saved;
      residentAgents[id] = residentEntry;
      residentChanged = true;
    }
    const encoded: SessionMeta = { ...meta, agents: encodedAgents };
    const resident: SessionMeta = residentChanged ? { ...meta, agents: residentAgents } : meta;
    return { encoded, resident, sourceAgents };
  }

  private async fetchOutcome(ref: string): Promise<OutcomeDocument | undefined> {
    let flight = this.inFlightReads.get(ref);
    if (flight === undefined) {
      flight = this.store.get<OutcomeDocument>(this.scope, ref).finally(() => {
        if (this.inFlightReads.get(ref) === flight) this.inFlightReads.delete(ref);
      });
      void flight.catch(() => {});
      this.inFlightReads.set(ref, flight);
    }
    const outcome = await flight;
    if (!isValidOutcomeDocument(outcome)) return undefined;
    this.rememberOutcome(ref, outcome.resultSummary, outcome.error);
    return outcome;
  }

  private rememberOutcome(ref: string, resultSummary: string | undefined, error: string | undefined): void {
    const chars = (resultSummary?.length ?? 0) + (error?.length ?? 0);
    if (chars > MAX_CACHED_OUTCOME_CHARS) return;
    this.evictRef(ref);
    this.hydratedCache.set(ref, { resultSummary, error, chars });
    this.hydratedChars += chars;
    while (this.hydratedCache.size > MAX_CACHED_OUTCOMES || this.hydratedChars > MAX_CACHED_OUTCOME_CHARS) {
      const oldest = this.hydratedCache.keys().next().value;
      if (oldest === undefined) break;
      this.evictRef(oldest);
    }
  }

  private evictRef(ref: string): void {
    const existing = this.hydratedCache.get(ref);
    if (existing === undefined) return;
    this.hydratedCache.delete(ref);
    this.hydratedChars -= existing.chars;
  }
}
