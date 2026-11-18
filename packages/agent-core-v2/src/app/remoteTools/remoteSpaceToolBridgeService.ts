import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { BridgeToolsCallResult } from '@kiki/protocol';

import {
  IRemoteSpaceToolBridgeService,
  REMOTE_SPACE_TOOL_ROUTER,
  type CallRemoteSpaceToolInput,
  type ListRemoteSpaceToolsInput,
  type RemoteBorrowedSpaceCatalog,
  type RemoteSpaceToolCapability,
  type RemoteSpaceToolConnector,
} from './remoteSpaceToolBridge';

const DEFAULT_CACHE_TTL_MS = 15_000;

interface CachedWorkspaceCatalogs {
  readonly catalogs: readonly RemoteBorrowedSpaceCatalog[];
  expiresAt: number;
}

interface InFlightCatalogRequest {
  readonly token: symbol;
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<readonly RemoteBorrowedSpaceCatalog[]>;
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class RemoteSpaceToolBridgeService
  extends Disposable
  implements IRemoteSpaceToolBridgeService, RemoteSpaceToolCapability
{
  declare readonly _serviceBrand: undefined;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private connector: RemoteSpaceToolConnector | undefined;
  private cacheGeneration = 0;
  private readonly cache = new Map<string, CachedWorkspaceCatalogs>();
  private readonly inFlight = new Map<string, InFlightCatalogRequest>();

  private abortInFlight(): void {
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
    this.inFlight.clear();
  }

  [REMOTE_SPACE_TOOL_ROUTER](connector: RemoteSpaceToolConnector | undefined): void {
    this.connector = connector;
    this.cacheGeneration += 1;
    this.cache.clear();
    this.abortInFlight();
    this.onDidChangeEmitter.fire();
  }

  notifyChanged(): void {
    this.cacheGeneration += 1;
    for (const entry of this.cache.values()) {
      entry.expiresAt = 0;
    }
    this.abortInFlight();
    this.onDidChangeEmitter.fire();
  }

  hasConnector(): boolean {
    return this.connector !== undefined;
  }

  async listBorrowedTools(input: ListRemoteSpaceToolsInput): Promise<readonly RemoteBorrowedSpaceCatalog[]> {
    input.signal?.throwIfAborted();
    const connector = this.connector;
    if (connector === undefined) return [];
    const workspaceId = input.caller.workspaceId;
    const cached = this.cache.get(workspaceId);
    if (cached !== undefined && Date.now() < cached.expiresAt) {
      return cached.catalogs;
    }
    const existing = this.inFlight.get(workspaceId);
    if (existing !== undefined && existing.generation === this.cacheGeneration) {
      return awaitWithSignal(existing.promise, input.signal);
    }
    const generation = this.cacheGeneration;
    const token = Symbol('inFlight');
    const controller = new AbortController();
    const promise = (async (): Promise<readonly RemoteBorrowedSpaceCatalog[]> => {
      try {
        const catalogs = await connector.listBorrowedTools({
          caller: input.caller,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && generation === this.cacheGeneration && this.connector === connector) {
          this.cache.set(workspaceId, {
            catalogs,
            expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
          });
        }
        return catalogs;
      } catch {
        return this.cache.get(workspaceId)?.catalogs ?? [];
      } finally {
        const current = this.inFlight.get(workspaceId);
        if (current?.token === token) {
          this.inFlight.delete(workspaceId);
        }
      }
    })();
    this.inFlight.set(workspaceId, { token, generation, controller, promise });
    return awaitWithSignal(promise, input.signal);
  }

  async callBorrowedTool(input: CallRemoteSpaceToolInput): Promise<BridgeToolsCallResult> {
    const connector = this.connector;
    if (connector === undefined) {
      throw new Error('Remote space tool connector is unavailable.');
    }
    return connector.callBorrowedTool(input);
  }

  override dispose(): void {
    this.connector = undefined;
    this.cacheGeneration += 1;
    this.cache.clear();
    this.abortInFlight();
    super.dispose();
  }
}

registerScopedService(
  LifecycleScope.App,
  IRemoteSpaceToolBridgeService,
  RemoteSpaceToolBridgeService,
  ScopeActivation.OnDemand,
  'remoteTools',
);
