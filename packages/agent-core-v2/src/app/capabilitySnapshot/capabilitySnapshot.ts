import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface CapabilitySnapshotChange {
  readonly memory: boolean;
  readonly thread: boolean;
}

export interface ICapabilitySnapshotService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  memoryAvailable(workspaceId: string): boolean;
  threadEnabled(): boolean;
  toolAvailable(name: string, workspaceId: string): boolean;
  refresh(workspaceId: string): CapabilitySnapshotChange;
}

export const ICapabilitySnapshotService: ServiceIdentifier<ICapabilitySnapshotService> =
  createDecorator<ICapabilitySnapshotService>('capabilitySnapshotService');
