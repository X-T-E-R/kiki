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
const MAX_CACHE_ENTRIES = 256;

interface CachedWorkspaceCatalogs {
  readonly catalogs: readonly RemoteBorrowedSpaceCatalog[];
  expiresAt: number;
}

interface InFlightCatalogState {
  waiters: number;
  settled: boolean;
}

interface InFlightCatalogRequest {
  readonly token: symbol;
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<readonly RemoteBorrowedSpaceCatalog[]>;
  readonly state: InFlightCatalogState;
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

  private attachWaiter(
    key: string,
    entry: InFlightCatalogRequest,
    signal?: AbortSignal,
  ): Promise<readonly RemoteBorrowedSpaceCatalog[]> {
    entry.state.waiters += 1;
    if (signal === undefined) {
      return entry.promise.finally(() => {
        entry.state.waiters = Math.max(0, entry.state.waiters - 1);
      });
    }
    if (signal.aborted) {
      entry.state.waiters = Math.max(0, entry.state.waiters - 1);
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    return new Promise<readonly RemoteBorrowedSpaceCatalog[]>((resolve, reject) => {
      let released = false;
      const release = (): number => {
        if (!released) {
          released = true;
          entry.state.waiters = Math.max(0, entry.state.waiters - 1);
        }
        return entry.state.waiters;
      };
      const onAbort = (): void => {
        const remaining = release();
        if (remaining === 0 && !entry.state.settled) {
          const current = this.inFlight.get(key);
          if (current?.token === entry.token) {
            this.inFlight.delete(key);
          }
          entry.controller.abort(signal.reason);
        }
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void entry.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          release();
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          release();
          reject(error);
        },
      );
    });
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

  private setCached(key: string, entry: CachedWorkspaceCatalogs): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const now = Date.now();
    for (const [candidateKey, candidate] of this.cache) {
      if (candidateKey !== key && now >= candidate.expiresAt) {
        this.cache.delete(candidateKey);
      }
    }
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  async listBorrowedTools(input: ListRemoteSpaceToolsInput): Promise<readonly RemoteBorrowedSpaceCatalog[]> {
    input.signal?.throwIfAborted();
    const connector = this.connector;
    if (connector === undefined) return [];
    const key = `${input.caller.workspaceId}\0${input.caller.sessionId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.now() < cached.expiresAt) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.catalogs;
    }
    const existing = this.inFlight.get(key);
    if (
      existing !== undefined
      && existing.generation === this.cacheGeneration
      && !existing.controller.signal.aborted
      && !existing.state.settled
    ) {
      return this.attachWaiter(key, existing, input.signal);
    }
    const generation = this.cacheGeneration;
    const token = Symbol('inFlight');
    const controller = new AbortController();
    const state: InFlightCatalogState = { waiters: 0, settled: false };
    const promise = (async (): Promise<readonly RemoteBorrowedSpaceCatalog[]> => {
      try {
        const catalogs = await connector.listBorrowedTools({
          caller: input.caller,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && generation === this.cacheGeneration && this.connector === connector) {
          this.setCached(key, {
            catalogs,
            expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
          });
        }
        return catalogs;
      } catch {
        return this.cache.get(key)?.catalogs ?? [];
      } finally {
        state.settled = true;
        const current = this.inFlight.get(key);
        if (current?.token === token) {
          this.inFlight.delete(key);
        }
      }
    })();
    const entry: InFlightCatalogRequest = { token, generation, controller, promise, state };
    this.inFlight.set(key, entry);
    return this.attachWaiter(key, entry, input.signal);
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
