import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { MEMORY_SECTION, memoryEnabled, type MemoryConfig } from '#/app/memory/configSection';
import { THREAD_COMMUNICATION_SECTION, type ThreadCommunicationConfig } from '#/app/threadCommunication/configSection';

import { ICapabilitySnapshotService, type CapabilitySnapshotChange } from './capabilitySnapshot';

const MEMORY_TOOLS = new Set(['MemoryWrite', 'MemorySearch', 'MemoryRead']);
const THREAD_TOOLS = new Set(['ThreadList', 'ThreadRead', 'ThreadSend', 'ThreadWait']);

interface SessionSnapshot {
  readonly workspaceId: string;
  memory: boolean;
  thread: boolean;
}

export class CapabilitySnapshotService implements ICapabilitySnapshotService {
  declare readonly _serviceBrand: undefined;
  private readonly bySession = new Map<string, SessionSnapshot>();
  readonly ready: Promise<void>;

  constructor(@IConfigService private readonly config: IConfigService) {
    this.ready = config.ready.then(() => {
      for (const snapshot of this.bySession.values()) {
        snapshot.memory = this.readMemory(snapshot.workspaceId);
        snapshot.thread = this.readThread();
      }
    });
  }

  memoryAvailable(workspaceId: string, sessionId: string): boolean {
    return this.snapshot(workspaceId, sessionId).memory;
  }

  threadEnabled(workspaceId?: string, sessionId?: string): boolean {
    if (workspaceId === undefined || sessionId === undefined) return this.readThread();
    return this.snapshot(workspaceId, sessionId).thread;
  }

  anySessionThreadEnabled(): boolean {
    for (const snapshot of this.bySession.values()) {
      if (snapshot.thread) return true;
    }
    return false;
  }

  toolAvailable(name: string, workspaceId: string, sessionId: string): boolean {
    if (MEMORY_TOOLS.has(name)) return this.memoryAvailable(workspaceId, sessionId);
    if (THREAD_TOOLS.has(name)) return this.threadEnabled(workspaceId, sessionId);
    return true;
  }

  refresh(workspaceId: string, sessionId: string): CapabilitySnapshotChange {
    const snapshot = this.snapshot(workspaceId, sessionId);
    const memory = this.readMemory(workspaceId);
    const thread = this.readThread();
    const changed = { memory: memory !== snapshot.memory, thread: thread !== snapshot.thread };
    snapshot.memory = memory;
    snapshot.thread = thread;
    return changed;
  }

  private snapshot(workspaceId: string, sessionId: string): SessionSnapshot {
    let snapshot = this.bySession.get(sessionId);
    if (snapshot === undefined) {
      snapshot = { workspaceId, memory: this.readMemory(workspaceId), thread: this.readThread() };
      this.bySession.set(sessionId, snapshot);
    } else if (snapshot.workspaceId !== workspaceId) {
      throw new Error(`Session "${sessionId}" belongs to another workspace.`);
    }
    return snapshot;
  }

  private readThread(): boolean {
    return this.config.get<ThreadCommunicationConfig>(THREAD_COMMUNICATION_SECTION)?.enabled ?? false;
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
