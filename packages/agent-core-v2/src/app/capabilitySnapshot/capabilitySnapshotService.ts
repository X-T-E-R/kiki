import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { MEMORY_SECTION, memoryEnabled, type MemoryConfig } from '#/app/memory/configSection';
import { THREAD_COMMUNICATION_SECTION, type ThreadCommunicationConfig } from '#/app/threadCommunication/configSection';

import { ICapabilitySnapshotService, type CapabilitySnapshotChange } from './capabilitySnapshot';

const MEMORY_TOOLS = new Set(['MemoryWrite', 'MemorySearch', 'MemoryRead']);
const THREAD_TOOLS = new Set(['ThreadList', 'ThreadRead', 'ThreadSend', 'ThreadWait']);

export class CapabilitySnapshotService implements ICapabilitySnapshotService {
  declare readonly _serviceBrand: undefined;
  private readonly memoryByWorkspace = new Map<string, boolean>();
  private thread: boolean;
  readonly ready: Promise<void>;

  constructor(@IConfigService private readonly config: IConfigService) {
    this.thread = config.get<ThreadCommunicationConfig>(THREAD_COMMUNICATION_SECTION)?.enabled ?? false;
    this.ready = config.ready.then(() => {
      this.thread = config.get<ThreadCommunicationConfig>(THREAD_COMMUNICATION_SECTION)?.enabled ?? false;
      for (const workspaceId of this.memoryByWorkspace.keys()) {
        this.memoryByWorkspace.set(workspaceId, this.readMemory(workspaceId));
      }
    });
  }

  memoryAvailable(workspaceId: string): boolean {
    let available = this.memoryByWorkspace.get(workspaceId);
    if (available === undefined) {
      available = this.readMemory(workspaceId);
      this.memoryByWorkspace.set(workspaceId, available);
    }
    return available;
  }

  threadEnabled(): boolean {
    return this.thread;
  }

  toolAvailable(name: string, workspaceId: string): boolean {
    if (MEMORY_TOOLS.has(name)) return this.memoryAvailable(workspaceId);
    if (THREAD_TOOLS.has(name)) return this.thread;
    return true;
  }

  refresh(workspaceId: string): CapabilitySnapshotChange {
    const memory = this.readMemory(workspaceId);
    const thread = this.config.get<ThreadCommunicationConfig>(THREAD_COMMUNICATION_SECTION)?.enabled ?? false;
    const changed = {
      memory: memory !== this.memoryAvailable(workspaceId),
      thread: thread !== this.thread,
    };
    this.memoryByWorkspace.set(workspaceId, memory);
    this.thread = thread;
    return changed;
  }

  private readMemory(workspaceId: string): boolean {
    const settings = this.config.get<MemoryConfig>(MEMORY_SECTION);
    return memoryEnabled(settings, workspaceId) && settings?.approval !== 'off';
  }
}

registerScopedService(
  LifecycleScope.App,
  ICapabilitySnapshotService,
  CapabilitySnapshotService,
  ScopeActivation.OnScopeCreated,
  'capabilitySnapshot',
);
