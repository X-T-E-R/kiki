import type { BridgeToolsCallResult, RemoteExportedTool, SpacePlatform } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export const REMOTE_SPACE_TOOL_ROUTER: unique symbol = Symbol('remoteSpaceToolRouter');

export interface RemoteBorrowedSpaceCatalog {
  readonly bridgeId: string;
  readonly connectionId: string;
  readonly spaceLabel: string;
  readonly platform?: SpacePlatform;
  readonly tools: readonly RemoteExportedTool[];
}

export interface ListRemoteSpaceToolsInput {
  readonly caller: { readonly workspaceId: string; readonly sessionId: string };
  readonly signal?: AbortSignal;
}

export interface CallRemoteSpaceToolInput {
  readonly bridgeId: string;
  readonly connectionId: string;
  readonly caller: { readonly workspaceId: string; readonly sessionId: string };
  readonly remoteName: string;
  readonly arguments: Record<string, unknown>;
  readonly callId: string;
  readonly signal?: AbortSignal;
}

export interface RemoteSpaceToolConnector {
  listBorrowedTools(input: ListRemoteSpaceToolsInput): Promise<readonly RemoteBorrowedSpaceCatalog[]>;
  callBorrowedTool(input: CallRemoteSpaceToolInput): Promise<BridgeToolsCallResult>;
}

export interface RemoteSpaceToolCapability {
  [REMOTE_SPACE_TOOL_ROUTER](connector: RemoteSpaceToolConnector | undefined): void;
  notifyChanged(): void;
}

export interface IRemoteSpaceToolBridgeService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  hasConnector(): boolean;
  listBorrowedTools(input: ListRemoteSpaceToolsInput): Promise<readonly RemoteBorrowedSpaceCatalog[]>;
  callBorrowedTool(input: CallRemoteSpaceToolInput): Promise<BridgeToolsCallResult>;
}

export const IRemoteSpaceToolBridgeService = createDecorator<IRemoteSpaceToolBridgeService>('remoteSpaceToolBridgeService');

export function remoteSpaceToolCapability(service: IRemoteSpaceToolBridgeService): RemoteSpaceToolCapability {
  if (!(REMOTE_SPACE_TOOL_ROUTER in service)) throw new Error('Remote space tool capability unavailable.');
  return service as IRemoteSpaceToolBridgeService & RemoteSpaceToolCapability;
}
