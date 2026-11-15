import type { WireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { readPersistedAgentRuntimeFacts } from '#/session/agentRuntimeFacts';
import type { IFileSystemStorageService, StorageFileStat } from '#/persistence/interface/storage';
import { readWireContextProjection } from '#/persistence/wireContextRead';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

type PersistedStatus = Omit<WireContextProjection, 'transcript'>;

export class PersistedStatusReader {
  private readonly cache = new Map<string, { readonly revision: string; readonly status: PersistedStatus }>();

  constructor(
    private readonly workers: ICpuWorkerService,
    private readonly logs: IAppendLogStore,
    private readonly storage: IFileSystemStorageService,
    private readonly docs: IAtomicDocumentStore,
  ) {}

  async read(workspaceId: string, sessionId: string, metadata?: AgentMeta): Promise<PersistedStatus> {
    const scope = `sessions/${workspaceId}/${sessionId}/agents/main`;
    const before = await this.storage.stat?.(scope, AGENT_WIRE_RECORD_KEY);
    const revision = before === undefined ? undefined : fingerprint(before);
    const cached = this.cache.get(scope);
    if (revision !== undefined && cached?.revision === revision) {
      this.cache.delete(scope);
      this.cache.set(scope, cached);
      return cached.status;
    }
    const facts = await readPersistedAgentRuntimeFacts(
      { storage: this.storage, appendLog: this.logs, docs: this.docs }, workspaceId, sessionId, 'main', metadata, undefined, { includeStatus: true },
    );
    let status: PersistedStatus;
    if (facts.complete && facts.status !== undefined) {
      status = facts.status;
    } else {
      const { transcript: _transcript, ...projection } = await readWireContextProjection(
        this.workers.request.bind(this.workers), this.logs, this.storage, scope, AGENT_WIRE_RECORD_KEY,
      );
      status = projection;
    }
    const after = await this.storage.stat?.(scope, AGENT_WIRE_RECORD_KEY);
    this.cache.delete(scope);
    if (revision !== undefined && after !== undefined && fingerprint(after) === revision) {
      this.cache.set(scope, { revision, status });
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    }
    return status;
  }
}

function fingerprint(stat: StorageFileStat): string {
  return `${stat.size}:${stat.identity ?? ''}:${stat.revision}`;
}
