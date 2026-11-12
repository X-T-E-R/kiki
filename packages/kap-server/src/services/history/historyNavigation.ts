import type { HistoryDirectoryRequest } from '@kiki/agent-core-v2/agent/tools/history/historyListTool';
import type { HistoryPreparation } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import type { ContentSource, TranscriptTurn } from '@kiki/transcript';
import type { TranscriptService } from '../transcript/transcriptService';
import type { HistoryLocatorEngine, HistoryLocatorStore, HistoryNavRow, HistoryNavSearch } from './historyLocatorStore';
import type { ResidentCheckpoint, ResidentFailureReceipt } from './historyCanonicalReader';
import { decodeHistoryRef, encodeHistoryRef } from './historySource';
import { HistoryNavigationWorker } from './worker/host';
import type { NavigationMethod, NavigationReport } from './worker/protocol';

const EMPTY_REPORT: NavigationReport = {
  cacheBytes: 0, cacheEntries: 0, oversizedCacheBytes: 0, oversizedCacheEntries: 0, cacheBudgetBytes: 0,
  replayBytes: 0, replayRecords: 0, replays: 0, cacheHits: 0, projectionBytes: 0, projectionRecords: 0,
  proofPages: 0, proofSkipped: 0, proofMaxPageBytes: 0, proofMaxExtraBytes: 0, proofRejectedOrdinal: undefined,
  proofReconciliations: 0, proofMaxRecordWorkspaceEstimate: 0, proofMaxTraversalBytes: 0,
  preparationsActive: 0, preparationsCompleted: 0, preparationsFailed: 0, preparationsCancelled: 0,
};

type Result<K extends keyof HistoryLocatorStore> = HistoryLocatorStore[K] extends (...args: never[]) => Promise<infer T> ? T : never;

export class HistoryNavigation implements HistoryLocatorStore {
  private readonly worker: HistoryNavigationWorker;
  private generation = 0;
  private readonly residentFailures = new WeakMap<TranscriptTurn, ResidentFailureReceipt>();
  readonly supportsSortedSearch = true;

  constructor(database: string, transcript: TranscriptService) {
    this.worker = new HistoryNavigationWorker(database, transcript);
  }

  private invoke<K extends NavigationMethod & keyof HistoryLocatorStore>(method: K, args: readonly unknown[],
    signal?: AbortSignal, session?: string, agent?: string): Promise<Result<K>> {
    return this.worker.request(method, args, signal, session === undefined || agent === undefined ? undefined : { session, agent });
  }

  scan(session: string, agent: string, signal?: AbortSignal, search?: HistoryNavSearch, through?: number,
    limits?: Parameters<HistoryLocatorStore['scan']>[5]) {
    return this.invoke('scan', [session, agent, search, through, limits], signal, session, agent);
  }

  list({ signal, ...request }: HistoryDirectoryRequest) {
    return this.invoke('list', [request], signal, request.sessionId, request.agentId);
  }

  lookupDirectory(workspace: string, session: string, agent: string, turn: number, step?: string,
    preparation?: HistoryPreparation, signal?: AbortSignal) {
    return this.invoke('lookupDirectory', [workspace, session, agent, turn, step, preparation], signal, session, agent);
  }

  async directoryRef(workspace: string, session: string, agent: string, turn: number, step?: string) {
    const result = await this.lookupDirectory(workspace, session, agent, turn, step);
    return result.status === 'ok' ? result.ref : undefined;
  }

  async readBlocks(ref: string, maxChars: number, cursor?: Parameters<HistoryLocatorStore['readBlocks']>[2], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { session, agent } = decodeHistoryRef(ref);
    return this.invoke('readBlocks', [ref, maxChars, cursor], signal, session, agent);
  }

  async read(ref: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { session, agent } = decodeHistoryRef(ref);
    return this.invoke('read', [ref], signal, session, agent);
  }

  row(...args: Parameters<HistoryLocatorStore['row']>) { return this.invoke('row', args); }
  ref(row: HistoryNavRow, focus?: number): string { return encodeHistoryRef({ ...row.anchor, selector: row.selector, focus }); }

  lookupToolCall(session: string, agent: string, toolCallId: string, signal?: AbortSignal) {
    return this.invoke('lookupToolCall', [session, agent, toolCallId], signal, session, agent);
  }

  readCanonicalEntity(session: string, agent: string, source: ContentSource, signal?: AbortSignal) {
    return this.invoke('readCanonicalEntity', [session, agent, source, signal !== undefined], signal, session, agent);
  }

  readDurableTurn(session: string, agent: string, turnId: string, signal: AbortSignal) {
    return this.invoke('readDurableTurn', [session, agent, turnId], signal, session, agent);
  }

  async prepareResidentProof(session: string, agent: string, signal: AbortSignal): ReturnType<HistoryLocatorStore['prepareResidentProof']> {
    const generation = this.generation;
    const checkpoint = await this.worker.request<ResidentCheckpoint | undefined>(
      'prepareResidentProof', [session, agent], signal, { session, agent });
    if (checkpoint === undefined) return undefined;
    return {
      prove: async (resident, owned) => {
        if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
        const cached = this.residentFailures.get(resident);
        if (cached !== undefined && await this.worker.request<boolean>('checkResidentFailure', [checkpoint, resident.turnId, cached], owned)) {
          return { status: cached.status };
        }
        const { result, failure } = await this.worker.request<Awaited<ReturnType<HistoryLocatorEngine['proveResidentCheckpoint']>>>(
          'proveResident', [checkpoint, agent, resident], owned);
        if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
        if (failure === undefined) this.residentFailures.delete(resident);
        else this.residentFailures.set(resident, failure);
        return result.status === 'found' ? { ...result, snapshot: { ...result.snapshot, items: [resident] } } : result;
      },
    };
  }

  readCanonicalTurnHeader(session: string, agent: string, turnId: string, signal?: AbortSignal) {
    return this.invoke('readCanonicalTurnHeader', [session, agent, turnId], signal, session, agent);
  }

  readCanonicalTurnHeaders(session: string, agent: string, turnIds: readonly string[], signal?: AbortSignal) {
    return this.invoke('readCanonicalTurnHeaders', [session, agent, turnIds], signal, session, agent);
  }

  indexedTurnByte(session: string, agent: string, turnId: string) {
    return this.invoke('indexedTurnByte', [session, agent, turnId], undefined, session, agent);
  }

  get retainedBodyChars(): number { return this.worker.retainedBodyChars; }
  canonicalReadReport(): NavigationReport { return this.worker.report ?? EMPTY_REPORT; }
  invalidateCanonical(): void { this.generation += 1; this.worker.invalidate(); }
  close(): Promise<void> { return this.worker.close(); }
}
