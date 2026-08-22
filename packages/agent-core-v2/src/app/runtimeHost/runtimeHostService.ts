import { randomUUID } from 'node:crypto';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';

import { createRuntimeClient, type ClientCallbacks } from './client';
import { HomeRuntimeError, isFatalRuntimeError } from './errors';
import {
  RUNTIME_ELECTION_TIMEOUT_MS,
  RUNTIME_MAX_REQUEST_ID_LENGTH,
  RUNTIME_PROTOCOL_VERSION,
  callTimeoutMs,
  type RuntimeCallOptions,
  type RuntimeHostStatus,
  type RuntimeLimits,
  type RuntimeMethodContext,
  type RuntimeRole,
} from './messages';
import {
  bootstrapHomeIdentity,
  endpointPathFor,
  isAddrInUse,
  type CommittedOwnerRecord,
  readPersistedOwner,
  removeOwnedEndpoint,
  tryRemoveStaleEndpoint,
  writePersistedOwner,
} from './paths';
import {
  createFenceTable,
  createRuntimeServer,
  type FenceTable,
  type FenceToken,
  type OwnershipCommitContext,
  type RuntimeServer,
  type ServerCallbacks,
} from './server';
import { IHomeRuntimeService, type RuntimeMethodHandler, type RuntimeRoleStatus } from './runtimeHost';

const REELECT_DELAY_MS = 50;
const DEFAULT_LIMITS: RuntimeLimits = Object.freeze({});

interface DirectInvocation {
  readonly fenceToken: FenceToken;
  readonly controller: AbortController;
}

export class HomeRuntimeHostService implements IHomeRuntimeService {
  declare readonly _serviceBrand: undefined;

  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly limits = DEFAULT_LIMITS;
  private readonly fence: FenceTable;
  private readonly methods = new Map<string, RuntimeMethodHandler>();
  private readonly directInvocations = new Set<DirectInvocation>();
  private readonly roleStatusEmitter = new Emitter<RuntimeRoleStatus>('runtimeRoleStatus');
  readonly onDidChangeRoleStatus: Event<RuntimeRoleStatus> = this.roleStatusEmitter.event;
  private role: RuntimeRole = 'idle';
  private readyState = false;
  private epoch = 0;
  private epochForBind = 0;
  private lastRoleStatus: RuntimeRoleStatus = { role: 'idle', ready: false, epoch: 0 };
  private hostId = '';
  private token = '';
  private canonicalHomeDir = '';
  private endpointPath = '';
  private server: RuntimeServer | undefined;
  private client: ReturnType<typeof createRuntimeClient> | undefined;
  private closing = false;
  private closeFlight: Promise<void> | undefined;
  private loopPromise: Promise<void> | undefined;
  private roleLostWaiters: Array<() => void> = [];
  private readyWaiter: Promise<void> | undefined;
  private bootstrapError: unknown;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    this.platform = bootstrap.platform;
    this.homeDir = bootstrap.homeDir;
    this.fence = createFenceTable(this.limits);
  }

  ready(): Promise<void> {
    if (this.closing) {
      return Promise.reject(new HomeRuntimeError('runtime.connection_failed', 'runtime service is closed'));
    }
    if (this.readyState) return Promise.resolve();
    this.readyWaiter ??= this.waitForReady().finally(() => {
      this.readyWaiter = undefined;
    });
    return this.readyWaiter;
  }

  status(): RuntimeHostStatus {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      role: this.role,
      ready: this.readyState,
      epoch: this.epoch,
      hostId: this.hostId,
    };
  }

  registerMethod(name: string, handler: RuntimeMethodHandler): IDisposable {
    if (name.length === 0) {
      throw new HomeRuntimeError('runtime.invalid_request', 'runtime method name must not be empty');
    }
    this.methods.set(name, handler);
    if (this.role === 'owner') this.server?.broadcastReady();
    return toDisposable(() => {
      if (this.methods.get(name) !== handler) return;
      this.methods.delete(name);
      if (this.role === 'owner') this.server?.broadcastReady();
    });
  }

  call(name: string, payload: unknown, options: RuntimeCallOptions = {}): Promise<unknown> {
    if (!this.readyState) {
      return Promise.reject(new HomeRuntimeError('runtime.connection_failed', 'runtime service is not ready'));
    }
    if (this.role === 'owner') return this.directCall(name, payload, options);
    if (this.role === 'client' && this.client !== undefined) return this.client.call(name, payload, options);
    return Promise.reject(new HomeRuntimeError('runtime.connection_failed', 'runtime service is not connected'));
  }

  close(): Promise<void> {
    this.closeFlight ??= this.doClose();
    return this.closeFlight;
  }

  protected persistOwnership(
    record: CommittedOwnerRecord,
    context: OwnershipCommitContext,
  ): Promise<void> {
    return writePersistedOwner(this.canonicalHomeDir, record, {
      signal: context.signal,
      commitToken: context.commitToken,
    });
  }

  private async waitForReady(): Promise<void> {
    if (this.bootstrapError !== undefined) throw ensureError(this.bootstrapError);
    void this.startElectionLoop();
    await waitUntil(
      () => this.readyState || this.closing || this.bootstrapError !== undefined,
      RUNTIME_ELECTION_TIMEOUT_MS,
    );
    if (this.readyState) return;
    if (this.bootstrapError !== undefined) throw ensureError(this.bootstrapError);
    if (this.closing) throw new HomeRuntimeError('runtime.connection_failed', 'runtime service closed during election');
    throw new HomeRuntimeError('runtime.timeout', 'runtime election timed out');
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    this.readyState = false;
    this.role = 'idle';
    this.publishRoleStatus();
    this.signalRoleLost();
    this.abortDirectCalls(new HomeRuntimeError('runtime.detached', 'runtime service closed'));
    await this.teardown();
    this.fence.reset();
    await this.loopPromise?.catch(() => {});
    await this.teardown();
    this.roleStatusEmitter.dispose();
  }

  private async teardown(): Promise<void> {
    if (this.server !== undefined) {
      const server = this.server;
      this.server = undefined;
      await server.detach();
      await removeOwnedEndpoint(this.platform, this.canonicalHomeDir, this.endpointPath).catch(() => undefined);
    }
    if (this.client !== undefined) {
      this.client.disconnect('runtime service closed');
      this.client = undefined;
    }
    this.readyState = false;
    this.role = 'idle';
    this.publishRoleStatus();
  }

  private startElectionLoop(): Promise<void> {
    if (this.loopPromise !== undefined) return this.loopPromise;
    this.loopPromise = (async () => {
      while (!this.closing) {
        if (this.readyState) {
          await this.waitForRoleLost();
          continue;
        }
        try {
          await this.ensureIdentity();
          if (await this.tryAcquire()) continue;
          await delay(REELECT_DELAY_MS);
        } catch (error) {
          if (this.closing) return;
          if (isFatalRuntimeError(error)) {
            this.bootstrapError = error;
            this.signalRoleLost();
            return;
          }
          await delay(REELECT_DELAY_MS);
        }
      }
    })();
    return this.loopPromise;
  }

  private async ensureIdentity(): Promise<void> {
    if (this.canonicalHomeDir !== '') return;
    const identity = await bootstrapHomeIdentity(this.platform, this.homeDir);
    this.canonicalHomeDir = identity.canonicalHomeDir;
    this.token = identity.token;
    this.hostId = identity.hostId;
    this.endpointPath = endpointPathFor(this.platform, this.canonicalHomeDir);
    this.epoch = (await readPersistedOwner(this.canonicalHomeDir)).epoch ?? 0;
    this.publishRoleStatus();
  }

  private async tryAcquire(): Promise<boolean> {
    const record = await readPersistedOwner(this.canonicalHomeDir);
    const base = record.epoch ?? 0;
    if (await this.tryBindOwner(base)) return true;
    return this.tryConnectClient();
  }

  private async tryBindOwner(base: number): Promise<boolean> {
    if (this.platform !== 'win32') {
      const stale = await tryRemoveStaleEndpoint(this.platform, this.canonicalHomeDir, this.endpointPath);
      if (stale === 'live') return false;
    }
    const server = createRuntimeServer(
      this.endpointPath,
      this.serverCallbacks(),
      this.limits,
      this.fence,
    );
    this.server = server;
    this.epochForBind = base + 1;
    try {
      await server.listen();
    } catch (error) {
      if (this.server === server) this.server = undefined;
      await server.detach();
      if (this.closing || isAddrInUse(error)) return false;
      throw error;
    }
    if (this.closing || this.server !== server) {
      await server.detach();
      return false;
    }
    this.epoch = this.epochForBind;
    this.role = 'owner';
    this.readyState = true;
    this.publishRoleStatus();
    return true;
  }

  private async tryConnectClient(): Promise<boolean> {
    this.client ??= createRuntimeClient(this.clientCallbacks(), this.limits);
    try {
      await this.client.connect(this.endpointPath);
      return true;
    } catch (error) {
      this.role = 'idle';
      this.readyState = false;
      this.publishRoleStatus();
      if (isRetryableConnectError(error)) return false;
      throw error;
    }
  }

  private serverCallbacks(): ServerCallbacks {
    return {
      canonicalHomeDir: this.canonicalHomeDir,
      localHostId: this.hostId,
      token: this.token,
      getCurrentEpoch: () => Math.max(this.epoch, this.epochForBind),
      resolveHandler: (method) => this.methods.get(method),
      listLocalMethods: () => [...this.methods.keys()],
      persistOwnershipAfterBind: async (_server, context) => {
        await this.persistOwnership({
          ownerHostId: this.hostId,
          epoch: this.epochForBind,
          commitToken: context.commitToken,
        }, context);
        if (context.signal.aborted) {
          throw context.signal.reason instanceof Error
            ? context.signal.reason
            : new HomeRuntimeError('runtime.detached', 'runtime owner commit was cancelled');
        }
        this.epoch = this.epochForBind;
        this.publishRoleStatus();
      },
      onOwnerLost: (error) => {
        void this.onServerLost(error);
      },
    };
  }

  private async onServerLost(error: Error): Promise<void> {
    if (this.role !== 'owner') return;
    this.role = 'idle';
    this.readyState = false;
    this.publishRoleStatus();
    this.abortDirectCalls(new HomeRuntimeError('runtime.owner_gone', 'runtime owner role was lost', { cause: error }));
    if (this.server !== undefined) {
      const server = this.server;
      this.server = undefined;
      await server.detach();
      await removeOwnedEndpoint(this.platform, this.canonicalHomeDir, this.endpointPath).catch(() => undefined);
    }
    this.fence.reset();
    if (isFatalRuntimeError(error)) this.bootstrapError = error;
    this.signalRoleLost();
  }

  private clientCallbacks(): ClientCallbacks {
    return {
      hostId: this.hostId,
      canonicalHomeDir: this.canonicalHomeDir,
      tokens: [this.token],
      onConnected: (peer) => {
        this.epoch = peer.epoch;
        this.role = 'client';
        this.readyState = true;
        this.publishRoleStatus();
      },
      onDisconnected: () => {
        const wasClient = this.role === 'client';
        this.role = 'idle';
        this.readyState = false;
        this.publishRoleStatus();
        if (wasClient) this.signalRoleLost();
      },
    };
  }

  private publishRoleStatus(): void {
    const next = { role: this.role, ready: this.readyState, epoch: this.epoch };
    if (
      next.role === this.lastRoleStatus.role &&
      next.ready === this.lastRoleStatus.ready &&
      next.epoch === this.lastRoleStatus.epoch
    ) return;
    this.lastRoleStatus = next;
    this.roleStatusEmitter.fire(next);
  }

  private signalRoleLost(): void {
    const waiters = this.roleLostWaiters;
    this.roleLostWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private waitForRoleLost(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.roleLostWaiters.push(resolve);
    });
  }

  private directCall(name: string, payload: unknown, options: RuntimeCallOptions): Promise<unknown> {
    const handler = this.methods.get(name);
    if (handler === undefined) {
      return Promise.reject(new HomeRuntimeError('runtime.not_registered', `runtime method not registered: ${name}`));
    }
    const requestId = options.requestId ?? randomUUID();
    if (requestId.length === 0 || requestId.length > RUNTIME_MAX_REQUEST_ID_LENGTH) {
      return Promise.reject(new HomeRuntimeError('runtime.invalid_request', 'requestId must be a non-empty string of at most 128 characters'));
    }
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    const claim = this.fence.claim(this.hostId, name, requestId);
    if (claim.kind === 'duplicate' || claim.kind === 'conflict') {
      return Promise.reject(new HomeRuntimeError('runtime.duplicate_request', `request id is already guarded: ${requestId}`));
    }
    if (claim.kind === 'full') {
      return Promise.reject(new HomeRuntimeError('runtime.outstanding_overflow', 'runtime in-flight limit reached'));
    }
    const controller = new AbortController();
    const invocation = { fenceToken: claim.token, controller };
    this.directInvocations.add(invocation);
    const timeoutMs = callTimeoutMs(options.timeoutMs, this.limits.callTimeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      let callerSettled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abortFromCaller = (): void => controller.abort(abortReason(options.signal!));
      const cleanupCaller = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abortFromCaller);
        controller.signal.removeEventListener('abort', onAbort);
      };
      const settleCaller = (error?: unknown, value?: unknown): void => {
        if (callerSettled) return;
        callerSettled = true;
        cleanupCaller();
        if (error === undefined) resolve(value);
        else reject(ensureError(error));
      };
      const settleHandler = (): void => {
        this.fence.release(invocation.fenceToken);
        this.directInvocations.delete(invocation);
      };
      const onAbort = (): void => settleCaller(abortReason(controller.signal));
      options.signal?.addEventListener('abort', abortFromCaller, { once: true });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort(new HomeRuntimeError('runtime.timeout', `runtime call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const ctx: RuntimeMethodContext = {
        requestId,
        epoch: this.epoch,
        callerHostId: this.hostId,
        signal: controller.signal,
      };
      let result: unknown;
      try {
        result = handler(payload, ctx);
      } catch (error) {
        settleHandler();
        settleCaller(error);
        return;
      }
      void Promise.resolve(result).then(
        (value) => {
          settleHandler();
          if (!controller.signal.aborted) settleCaller(undefined, value);
        },
        (error: unknown) => {
          settleHandler();
          if (!controller.signal.aborted) settleCaller(error);
        },
      );
    });
  }

  private abortDirectCalls(error: HomeRuntimeError): void {
    for (const invocation of this.directInvocations) {
      if (!invocation.controller.signal.aborted) invocation.controller.abort(error);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate() || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && !(signal.reason instanceof DOMException)) return signal.reason;
  return new HomeRuntimeError('runtime.aborted', 'runtime call aborted');
}

function ensureError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableConnectError(error: unknown): boolean {
  return error instanceof HomeRuntimeError && (
    error.code === 'runtime.connection_failed' ||
    error.code === 'runtime.owner_gone' ||
    error.code === 'runtime.detached' ||
    error.code === 'runtime.timeout'
  );
}

registerScopedService(
  LifecycleScope.App,
  IHomeRuntimeService,
  HomeRuntimeHostService,
  ScopeActivation.OnScopeCreated,
  'runtimeHost',
);
