import type { WireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
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
  ) {}

  async read(scope: string): Promise<PersistedStatus> {
    const before = await this.storage.stat?.(scope, AGENT_WIRE_RECORD_KEY);
    const revision = before === undefined ? undefined : fingerprint(before);
    const cached = this.cache.get(scope);
    if (revision !== undefined && cached?.revision === revision) {
      this.cache.delete(scope);
      this.cache.set(scope, cached);
      return cached.status;
    }
    const { transcript: _transcript, ...status } = await readWireContextProjection(
      this.workers.request.bind(this.workers), this.logs, this.storage, scope, AGENT_WIRE_RECORD_KEY,
    );
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
