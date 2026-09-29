import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface CapabilitySnapshotChange {
  readonly memory: boolean;
  readonly thread: boolean;
}

export interface ICapabilitySnapshotService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  memoryAvailable(workspaceId: string, sessionId: string): boolean;
  threadEnabled(workspaceId?: string, sessionId?: string): boolean;
  anySessionThreadEnabled(): boolean;
  toolAvailable(name: string, workspaceId: string, sessionId: string): boolean;
  refresh(workspaceId: string, sessionId: string): CapabilitySnapshotChange;
}

export const ICapabilitySnapshotService: ServiceIdentifier<ICapabilitySnapshotService> =
  createDecorator<ICapabilitySnapshotService>('capabilitySnapshotService');
