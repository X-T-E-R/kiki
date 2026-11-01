/**
 * In-process dispatcher — resolves a wire triple `(service, method, args)`
 * against a live engine scope and mirrors kap-server's dispatcher semantics
 * (reflection calls and property reads, with passive lifecycle watches for
 * nonresident agents' ordinary events). Scope routing resolves workspace
 * instances through `IWorkspaceInstanceManager` and live sessions through the
 * App `SessionManager`, matching the server's `resolveScope`. Every argument,
 * result, and event payload passes
 * through `wireClone` (a JSON round-trip), so consumers observe
 * byte-identical data no matter whether the call crossed a socket or stayed
 * in-process — and non-serializable leaks fail early.
 *
 * Shared by the memory transport and the HTTP/IPC hosts, so scope routing and
 * ordinary event subscriptions behave identically across transports.
 */

import { IInstantiationService, type ServiceIdentifier } from '@kiki/agent-core-v2/_base/di/instantiation';
import { IWorkspaceInstanceManager } from '@kiki/agent-core-v2/workspace/workspaceInstance/workspaceInstanceManager';
import { ISessionManager } from '@kiki/agent-core-v2/app/sessionManager/sessionManager';
import { getLiveSessionById } from '@kiki/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '@kiki/agent-core-v2/session/agentLifecycle/mainAgent';
import { readPersistedAgentProfileSnapshot } from '@kiki/agent-core-v2/session/agentProfileSnapshot';
import { readPersistedExecutionControl } from '@kiki/agent-core-v2/session/executionControl/readExecutionControl';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';
import { IEventBus } from '@kiki/agent-core-v2/app/event/eventBus';
import { ISessionMetadata, type SessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionContext, makeSessionContext } from '@kiki/agent-core-v2/session/sessionContext/sessionContext';
import { ISessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { join } from 'node:path';
import { IAppendLogStore } from '@kiki/agent-core-v2/persistence/interface/appendLogStore';
import { IHostFileSystem } from '@kiki/agent-core-v2/os/interface/hostFileSystem';
import { readPersistedPlan } from '@kiki/agent-core-v2/features/plan/planRead';
import { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import { PersistedModelSwitchReader, ModelSwitchQueuePreparingError } from '@kiki/agent-core-v2/agent/prompt/modelSwitchQueueRead';
import { readUnstartedSessionMcpCapabilities } from '@kiki/agent-core-v2/agent/mcp/mcpService';
import type {
  FileMeta,
  GetResult,
  SaveOptions,
} from '@kiki/agent-core-v2/app/file/fileService';
import { FileErrors } from '@kiki/agent-core-v2/app/file/fileService';
import { Error2 } from '@kiki/agent-core-v2/errors';

import { Readable } from 'node:stream';

import type { CallOptions, EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import { RPCError, toRPCError } from '../../core/errors.js';
import { IEventService, pluginServiceTokens, serviceTokens } from './serviceRegistry.js';

/** Structural minimum of an engine `Scope` / `IScopeHandle`. */
export interface ScopeLike {
  readonly accessor: {
    get<T>(id: ServiceIdentifier<T>): T;
  };
}

/** JSON round-trip so in-process data matches wire data exactly. */
export function wireClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface MemoryDispatcher {
  call(scope: ScopeRef, service: string, method: string, args: unknown[], options?: CallOptions): Promise<unknown>;
  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown>;
  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
    onReady?: () => void,
  ): IDisposable;
}

const REQUEST_INVALID = 40001;
const NOT_FOUND = 40404;

/**
 * Engine file errors cross the facade as public `RPCError`s, never as the
 * engine's raw `Error2`. The dispatcher is shared by both transports, so
 * memory and ipc then surface the identical `NOT_FOUND` code for a stale or
 * expired upload id.
 */
function rethrowFileErrorAsRpc(error: unknown): never {
  if (error instanceof Error2 && error.code === FileErrors.codes.FILE_NOT_FOUND) {
    throw new RPCError(NOT_FOUND, error.message, error.details);
  }
  throw error;
}

type ScopeKind = 'core' | 'workspace' | 'session' | 'agent';

interface ResolvedScope {
  readonly kind: ScopeKind;
  readonly like: ScopeLike;
}

/** Structural view of the engine's `IFileService` used by the wire adaptation. */
type FileServiceWireTarget = {
  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;
  get(fileId: string): Promise<GetResult>;
};

export function createMemoryDispatcher(root: ScopeLike): MemoryDispatcher {
  let modelSwitchReader: PersistedModelSwitchReader | undefined;
  /** Mirrors kap-server's `resolveScope`, incl. main-agent materialization. */
  async function resolveScope(scope: ScopeRef): Promise<ResolvedScope> {
    if (scope.workspaceId !== undefined) {
      const workspace = await root.accessor
        .get(IWorkspaceInstanceManager)
        .getOrCreate({ workspaceId: scope.workspaceId });
      void workspace.program;
      return { kind: 'workspace', like: root };
    }
    if (scope.sessionId === undefined) return { kind: 'core', like: root };
    const session = root.accessor.get(ISessionManager).get(scope.sessionId) ?? getLiveSessionById(root.accessor, scope.sessionId);
    if (session === undefined) {
      throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
    }
    if (scope.agentId === undefined) return { kind: 'session', like: session };
    if (scope.agentId === 'main') {
      return { kind: 'agent', like: await ensureMainAgent(session) };
    }
    const agent = session.accessor.get(IAgentLifecycleService).get(scope.agentId);
    if (agent === undefined) {
      throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
    }
    return { kind: 'agent', like: agent };
  }

  async function restoreKnownAgentForProfileChange(
    scope: ScopeRef,
    options?: CallOptions,
  ): Promise<void> {
    if (
      scope.workspaceId !== undefined ||
      scope.sessionId === undefined ||
      scope.agentId === undefined ||
      scope.agentId === 'main'
    ) return;
    const session = (await resolveScope({ sessionId: scope.sessionId })).like;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    if (lifecycle.get(scope.agentId) !== undefined) return;
    const metadata = await session.accessor.get(ISessionMetadata).read();
    const agentMetadata = metadata.agents?.[scope.agentId];
    if (agentMetadata === undefined) {
      throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
    }
    options?.signal?.throwIfAborted();
    const context = session.accessor.get(ISessionContext);
    const snapshot = await readPersistedAgentProfileSnapshot(
      root,
      context.workspaceId,
      context.sessionId,
      scope.agentId,
      agentMetadata,
      options?.signal,
    );
    options?.signal?.throwIfAborted();
    if (snapshot === undefined) {
      throw new RPCError(
        REQUEST_INVALID,
        `Persisted binding metadata for agent "${scope.agentId}" is unavailable`,
        { agentId: scope.agentId },
      );
    }
    await lifecycle.create({
      agentId: scope.agentId,
      restoreBinding: {
        profileName: snapshot.profileName,
        routeId: snapshot.routeId,
        modelAlias: snapshot.modelAlias,
        thinkingEffort: snapshot.thinkingLevel,
        thinkingEffortExplicit: snapshot.thinkingEffortExplicit,
        executorId: snapshot.executorId,
        executorProtocol: snapshot.executorProtocol,
      },
    });
  }

  function resolveService(resolved: ResolvedScope, service: string): Record<string, unknown> {
    const token = serviceTokens[service];
    if (token !== undefined) {
      return resolved.like.accessor.get(token) as Record<string, unknown>;
    }
    const pluginToken = pluginServiceTokens[service];
    if (pluginToken !== undefined) return resolveInstalledPlugin(resolved, service, pluginToken);
    throw new RPCError(REQUEST_INVALID, `unknown service: ${service}`);
  }

  function resolveInstalledPlugin(
    resolved: ResolvedScope,
    service: string,
    token: ServiceIdentifier<unknown>,
  ): Record<string, unknown> {
    let instance: unknown;
    try {
      instance = resolved.like.accessor.get(token);
    } catch (error) {
      if (isUninstalledPlugin(error, token)) {
        throw new RPCError(REQUEST_INVALID, `unknown service: ${service}`);
      }
      throw error;
    }
    if (instance === null || instance === undefined || typeof instance !== 'object') {
      throw new RPCError(REQUEST_INVALID, `unknown service: ${service}`);
    }
    return instance as Record<string, unknown>;
  }

  function isUninstalledPlugin(error: unknown, token: ServiceIdentifier<unknown>): boolean {
    return error instanceof Error
      && error.message.includes('unknown service')
      && error.message.includes(String(token));
  }

  /** Mirrors kap-server's WS `eventMap` per scope kind. */
  function subscribeStream(
    resolved: ResolvedScope,
    name: string,
    handler: (data: unknown) => void,
  ): IDisposable {
    if (resolved.kind === 'core' && name === 'events') {
      const bus = resolved.like.accessor.get(IEventService);
      return bus.subscribe((event) => {
        handler(wireClone(event));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions') {
      const interaction = resolved.like.accessor.get(ISessionInteractionService);
      return interaction.onDidChangePending(() => {
        handler(wireClone(interaction.listPending()));
      });
    }
    if (resolved.kind === 'session' && name === 'interactions:resolved') {
      const interaction = resolved.like.accessor.get(ISessionInteractionService);
      return interaction.onDidResolve((resolution) => {
        handler(wireClone(resolution));
      });
    }
    if (resolved.kind === 'agent' && name === 'events') {
      const bus = resolved.like.accessor.get(IEventBus);
      return bus.subscribe((event) => {
        handler(wireClone(event));
      });
    }
    throw new RPCError(REQUEST_INVALID, `unknown event stream: ${name} (${resolved.kind})`);
  }

  function subscribeSource(
    resolved: ResolvedScope,
    source: EventSourceRef,
    handler: (data: unknown) => void,
  ): IDisposable {
    if (source.kind === 'stream') {
      return subscribeStream(resolved, source.name, handler);
    }
    if (!/^on[A-Z]/.test(source.event)) {
      throw new RPCError(REQUEST_INVALID, `not an event property: ${source.event}`);
    }
    const instance = resolveService(resolved, source.service);
    const emitter = instance[source.event];
    if (typeof emitter !== 'function') {
      throw new RPCError(REQUEST_INVALID, `event not found: ${source.service}.${source.event}`);
    }
    return (emitter as (listener: (data: unknown) => void) => IDisposable).call(
      instance,
      (data) => {
        handler(wireClone(data));
      },
    );
  }

  function listenAgentEvents(
    sessionId: string,
    agentId: string,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
    onReady?: () => void,
  ): IDisposable {
    let disposed = false;
    let session: ScopeLike | undefined;
    let agent: ScopeLike | undefined;
    let source: IDisposable | undefined;
    let agentDisposal: IDisposable | undefined;
    let sessionWatches: IDisposable[] = [];
    const watches: IDisposable[] = [];
    const detachAgent = () => {
      agent = undefined;
      source?.dispose(); source = undefined;
      agentDisposal?.dispose(); agentDisposal = undefined;
    };
    const detachSession = () => {
      session = undefined;
      detachAgent();
      for (const watch of sessionWatches) watch.dispose();
      sessionWatches = [];
    };
    const subscription = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        detachSession();
        for (const watch of watches) watch.dispose();
        watches.length = 0;
      },
    };
    const fail = (error: unknown) => {
      if (disposed) return;
      subscription.dispose();
      const normalized = toRPCError(error);
      onError?.(normalized instanceof Error ? normalized : new Error(String(normalized)));
    };
    const attachAgent = (handle: ScopeLike | undefined) => {
      if (disposed || handle === agent) return;
      detachAgent();
      if (handle === undefined) return;
      agent = handle;
      agentDisposal = handle.accessor.get(IInstantiationService).onWillDispose(detachAgent);
      source = subscribeStream({ kind: 'agent', like: handle }, 'events', data => {
        if (!disposed && agent === handle) handler(data);
      });
    };
    const attachSession = (handle: ScopeLike | undefined) => {
      if (disposed || handle === session) return;
      detachSession();
      if (handle === undefined) return;
      let instantiation: IInstantiationService;
      try {
        instantiation = handle.accessor.get(IInstantiationService);
      } catch (error) {
        if (error instanceof Error && error.message === 'InstantiationService has been disposed') return;
        throw error;
      }
      session = handle;
      sessionWatches.push(instantiation.onWillDispose(detachSession));
      const lifecycle = handle.accessor.get(IAgentLifecycleService);
      sessionWatches.push(lifecycle.onDidCreate(created => {
        if (session !== handle || created.id !== agentId) return;
        try { attachAgent(created); } catch (error) { fail(error); }
      }));
      sessionWatches.push(lifecycle.onDidDispose(id => {
        if (session !== handle || id !== agentId) return;
        try { attachAgent(lifecycle.get(agentId)); } catch (error) { fail(error); }
      }));
      attachAgent(lifecycle.get(agentId));
    };
    void Promise.resolve().then(async () => {
      if (disposed) return;
      const manager = root.accessor.get(ISessionManager);
      const created = manager.onDidCreateSession?.(event => {
        if (event.sessionId !== sessionId) return;
        try { attachSession(event.handle); } catch (error) { fail(error); }
      });
      if (created === undefined) throw new RPCError(REQUEST_INVALID, 'session lifecycle event watch unavailable');
      watches.push(created);
      const closed = manager.onDidCloseSession?.(event => {
        if (event.sessionId === sessionId) detachSession();
      });
      if (closed !== undefined) watches.push(closed);
      const archived = manager.onDidArchiveSession?.(event => {
        if (event.sessionId === sessionId) detachSession();
      });
      if (archived !== undefined) watches.push(archived);
      const deleted = manager.onDidDeleteSession?.(event => {
        if (event.sessionId === sessionId) fail(new RPCError(NOT_FOUND, `session not found: ${sessionId}`));
      });
      if (deleted !== undefined) watches.push(deleted);
      attachSession(manager.get(sessionId));
      for (;;) {
        if (disposed || agent !== undefined || (session !== undefined && agentId === 'main')) break;
        const observedSession = session;
        let metadata: SessionMeta | undefined;
        try {
          if (observedSession !== undefined) {
            metadata = await observedSession.accessor.get(ISessionMetadata).read();
          } else {
            const summary = await root.accessor.get(ISessionIndex).get(sessionId);
            if (disposed) return;
            if (session !== observedSession) continue;
            if (summary === undefined) throw new RPCError(NOT_FOUND, `session not found: ${sessionId}`);
            metadata = await root.accessor.get(IAtomicDocumentStore).get<SessionMeta>(`sessions/${summary.workspaceId}/${sessionId}`, 'state.json');
          }
        } catch (error) {
          if (disposed) return;
          if (session !== observedSession || agent !== undefined) continue;
          throw error;
        }
        if (disposed) return;
        if (session !== observedSession || agent !== undefined) continue;
        if (metadata?.id !== sessionId) throw new RPCError(NOT_FOUND, `session not found: ${sessionId}`);
        if (!/^[a-zA-Z0-9_-]+$/.test(agentId) ||
          (agentId !== 'main' && !Object.hasOwn(metadata.agents ?? {}, agentId))) {
          throw new RPCError(NOT_FOUND, `agent not found: ${agentId}`);
        }
        break;
      }
      if (!disposed) onReady?.();
    }).catch(fail);
    return subscription;
  }

  return {
    async call(scope, service, method, args, options) {
      options?.signal?.throwIfAborted();
      if (service === 'sessionExecutionControl' && scope.sessionId !== undefined && scope.agentId === undefined && scope.workspaceId === undefined) {
        const live = getLiveSessionById(root.accessor, scope.sessionId);
        if (method === 'read' && live === undefined) {
          const summary = await root.accessor.get(ISessionIndex).get(scope.sessionId);
          if (summary === undefined) throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
          return wireClone(await readPersistedExecutionControl(root.accessor.get(IAtomicDocumentStore), `sessions/${summary.workspaceId}/${scope.sessionId}`));
        }
        const manager = root.accessor.get(ISessionManager);
        const lease = await manager.acquire?.(scope.sessionId, 'execution-control', undefined, options?.signal);
        if (manager.acquire === undefined && live === undefined) await manager.resume(scope.sessionId);
        try {
          const resolved = await resolveScope(scope);
          const instance = resolveService(resolved, service);
          const member = instance[method];
          if (typeof member !== 'function') throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
          return wireClone(await (member as (...values: unknown[]) => unknown).apply(instance, args.map(wireClone)));
        } catch (error) {
          throw toRPCError(error);
        } finally {
          await lease?.dispose();
        }
      }
      const bindingAction = service === 'agentProfileService' && ['setModel', 'setEffort', 'setThinking'].includes(method)
        || service === 'agentPromptService' && ['switchModel', 'updateModelSwitch', 'cancelModelSwitch', 'recoverModelSwitch'].includes(method);
      if (bindingAction && scope.sessionId !== undefined && scope.agentId !== undefined && scope.workspaceId === undefined) {
        const manager = root.accessor.get(ISessionManager);
        const lease = await manager.acquire?.(scope.sessionId, 'model-binding-action');
        if (manager.acquire !== undefined && lease === undefined) throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
        try {
          options?.signal?.throwIfAborted();
          await restoreKnownAgentForProfileChange(scope, options);
          const resolved = await resolveScope(scope);
          options?.signal?.throwIfAborted();
          const instance = resolveService(resolved, service);
          const member = instance[method];
          if (typeof member !== 'function') throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
          return wireClone(await (member as (...values: unknown[]) => unknown).apply(instance, args.map(wireClone)));
        } catch (error) {
          throw toRPCError(error);
        } finally {
          await lease?.dispose();
        }
      }
      if (service === 'agentMcpService' && method === 'listMcpSessionCapabilities' &&
        scope.sessionId !== undefined && scope.agentId === 'main' && scope.workspaceId === undefined) {
        const live = getLiveSessionById(root.accessor, scope.sessionId);
        if (live !== undefined && live.accessor.get(IAgentLifecycleService).get('main') === undefined) {
          const result = await readUnstartedSessionMcpCapabilities(live);
          options?.signal?.throwIfAborted();
          return wireClone(result);
        }
      }
      if (service === 'agentPromptService' && method === 'listModelSwitches' &&
        scope.sessionId !== undefined && scope.agentId !== undefined && scope.workspaceId === undefined) {
        const live = getLiveSessionById(root.accessor, scope.sessionId);
        const resident = live?.accessor.get(IAgentLifecycleService).get(scope.agentId);
        if (resident === undefined) {
          const summary = await root.accessor.get(ISessionIndex).get(scope.sessionId);
          if (summary === undefined) throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
          const sessionScope = `sessions/${summary.workspaceId}/${scope.sessionId}`;
          const metadata = await root.accessor.get(IAtomicDocumentStore).get<SessionMeta>(sessionScope, 'state.json');
          if (!/^[a-zA-Z0-9_-]+$/.test(scope.agentId) ||
            (scope.agentId !== 'main' && !Object.hasOwn(metadata?.agents ?? {}, scope.agentId))) {
            throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
          }
          modelSwitchReader ??= new PersistedModelSwitchReader({
            docs: root.accessor.get(IAtomicDocumentStore), storage: root.accessor.get(IFileSystemStorageService),
            files: root.accessor.get(IHostFileSystem),
          });
          try {
            return wireClone(await modelSwitchReader.readReady(`${sessionScope}/agents/${scope.agentId}`, options?.signal));
          } catch (error) {
            if (error instanceof ModelSwitchQueuePreparingError) {
              throw new RPCError(REQUEST_INVALID, error.message, { reason: 'model_switch_queue_preparing' });
            }
            throw toRPCError(error);
          }
        }
      }
      if (
        service === 'sessionMetadata' &&
        (method === 'read' || method === 'getAgentExecutor') &&
        scope.sessionId !== undefined &&
        scope.workspaceId === undefined &&
        scope.agentId === undefined &&
        getLiveSessionById(root.accessor, scope.sessionId) === undefined
      ) {
        const summary = await root.accessor.get(ISessionIndex).get(scope.sessionId);
        const metadata = summary === undefined ? undefined : await root.accessor.get(IAtomicDocumentStore).get<SessionMeta>(`sessions/${summary.workspaceId}/${scope.sessionId}`, 'state.json');
        options?.signal?.throwIfAborted();
        if (metadata === undefined) throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
        if (method === 'read') return wireClone(metadata);
        const agentId = args[0];
        if (typeof agentId !== 'string') return undefined;
        return wireClone(metadata.agents?.[agentId]?.executor);
      }
      if (service === 'agentPlanService' && method === 'status' && scope.sessionId !== undefined && scope.agentId !== undefined && scope.workspaceId === undefined) {
        const live = getLiveSessionById(root.accessor, scope.sessionId);
        if (live === undefined) {
          const summary = await root.accessor.get(ISessionIndex).get(scope.sessionId);
          if (summary === undefined) throw new RPCError(NOT_FOUND, `session not found: ${scope.sessionId}`);
          const sessionScope = `sessions/${summary.workspaceId}/${scope.sessionId}`;
          const metadata = await root.accessor.get(IAtomicDocumentStore).get<SessionMeta>(sessionScope, 'state.json');
          if (!/^[a-zA-Z0-9_-]+$/.test(scope.agentId) ||
              (scope.agentId !== 'main' && !Object.hasOwn(metadata?.agents ?? {}, scope.agentId))) {
            throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
          }
          const context = makeSessionContext({
            sessionId: scope.sessionId, workspaceId: summary.workspaceId, sessionScope,
            sessionDir: join(root.accessor.get(IBootstrapService).homeDir, sessionScope), cwd: summary.cwd ?? '',
          });
          try {
            const plan = await readPersistedPlan(context, scope.agentId,
              root.accessor.get(IAppendLogStore), root.accessor.get(IHostFileSystem), options?.signal);
            options?.signal?.throwIfAborted();
            return wireClone(plan);
          } catch (error) {
            throw toRPCError(error);
          }
        }
        const session = (await resolveScope({ sessionId: scope.sessionId })).like;
        if (session.accessor.get(IAgentLifecycleService).get(scope.agentId) === undefined && scope.agentId !== 'main') {
          const metadata = await session.accessor.get(ISessionMetadata).read();
          if (!Object.hasOwn(metadata.agents ?? {}, scope.agentId)) throw new RPCError(NOT_FOUND, `agent not found: ${scope.agentId}`);
          options?.signal?.throwIfAborted();
          try {
            const plan = await readPersistedPlan(
              session.accessor.get(ISessionContext), scope.agentId,
              root.accessor.get(IAppendLogStore), root.accessor.get(IHostFileSystem), options?.signal,
            );
            options?.signal?.throwIfAborted();
            return wireClone(plan);
          } catch (error) {
            throw toRPCError(error);
          }
        }
      }
      const resolved = await resolveScope(scope);
      options?.signal?.throwIfAborted();
      const instance = resolveService(resolved, service);
      // `fileService` adapts bytes ⇄ streams: the JSON wire cannot carry
      // `save`'s Readable source or `get`'s result stream, so both cross as
      // base64 strings (the same kind of wire adaptation as
      // `modelResolver.generate` in `stream`).
      if (service === 'fileService' && method === 'save') {
        const [data, filename, options] = args as [string, string, SaveOptions | undefined];
        const files = instance as FileServiceWireTarget;
        try {
          const meta = await files.save(
            Readable.from(Buffer.from(data, 'base64')),
            filename,
            options,
          );
          return wireClone(meta);
        } catch (error) {
          rethrowFileErrorAsRpc(error);
        }
      }
      if (service === 'fileService' && method === 'get') {
        const [fileId] = args as [string];
        const files = instance as FileServiceWireTarget;
        try {
          const { meta, stream } = await files.get(fileId);
          const chunks: Buffer[] = [];
          for await (const chunk of stream()) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
          return { meta: wireClone(meta), data: Buffer.concat(chunks).toString('base64') };
        } catch (error) {
          rethrowFileErrorAsRpc(error);
        }
      }
      const member = instance[method];
      if (member === undefined) {
        throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
      }
      if (typeof member !== 'function') {
        return wireClone(member);
      }
      const clonedArgs = args.map(wireClone);
      if (service === 'mcpManagementService' && method === 'completeServerAuth') {
        clonedArgs[1] = { signal: options?.signal };
      }
      if (service === 'agentPromptService' && method === 'submitAndWait') {
        clonedArgs[1] = options?.signal;
      }
      if (service === 'agentPanelService' && method === 'read') {
        clonedArgs[1] = options?.signal;
      }
      if (service === 'pluginService' && method === 'previewPlugin') {
        clonedArgs[1] = options?.signal;
      }
      try {
        const result = await (member as (...a: unknown[]) => unknown).apply(instance, clonedArgs);
        return wireClone(result);
      } catch (error) {
        throw toRPCError(error);
      }
    },

    stream(scope, service, method, args): AsyncIterable<unknown> {
      // Special case: modelResolver.generate routes to
      // getRequester(modelId).request(input, signal, params) because the
      // catalog has no `generate` method — the facade synthesises the call.
      if (service === 'modelResolver' && method === 'generate') {
        return {
          [Symbol.asyncIterator]() {
            let source: AsyncIterator<unknown> | undefined;
            let started: Promise<void> | undefined;
            const controller = new AbortController();

            const ensureStarted = (): Promise<void> => {
              started ??= (async () => {
                const resolved = await resolveScope(scope);
                const catalog = resolveService(resolved, 'modelResolver');
                const [modelId, input, params] = args;
                const requester = (catalog as { getRequester(id: string): { request(...a: unknown[]): AsyncIterable<unknown> } })
                  .getRequester(modelId as string);
                const iterable = requester.request(
                  wireClone(input),
                  controller.signal,
                  wireClone(params),
                );
                source = iterable[Symbol.asyncIterator]();
              })();
              return started;
            };

            return {
              async next() {
                await ensureStarted();
                const result = await source!.next();
                if (result.done) return { done: true, value: undefined };
                return { done: false, value: wireClone(result.value) };
              },
              async return(value?: unknown) {
                controller.abort();
                await source?.return?.(value);
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      }

      // The underlying service method returns an AsyncIterable; we wire-clone
      // each yielded chunk so in-process consumers observe the same data as
      // networked ones.
      return {
        [Symbol.asyncIterator]() {
          let source: AsyncIterator<unknown> | undefined;
          let started: Promise<void> | undefined;

          const ensureStarted = (): Promise<void> => {
            started ??= (async () => {
              const resolved = await resolveScope(scope);
              const instance = resolveService(resolved, service);
              const member = instance[method];
              if (member === undefined) {
                throw new RPCError(REQUEST_INVALID, `method not found: ${service}.${method}`);
              }
              if (typeof member !== 'function') {
                throw new RPCError(REQUEST_INVALID, `not a streaming method: ${service}.${method}`);
              }
              const clonedArgs = args.map(wireClone);
              const iterable = (member as (...a: unknown[]) => unknown).apply(
                instance,
                clonedArgs,
              ) as AsyncIterable<unknown>;
              source = iterable[Symbol.asyncIterator]();
            })();
            return started;
          };

          return {
            async next() {
              await ensureStarted();
              const result = await source!.next();
              if (result.done) return { done: true, value: undefined };
              return { done: false, value: wireClone(result.value) };
            },
            async return(value?: unknown) {
              await source?.return?.(value);
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },

    listen(scope, source, handler, onError, onReady) {
      if (scope.workspaceId === undefined && scope.sessionId !== undefined && scope.agentId !== undefined &&
        source.kind === 'stream' && source.name === 'events') {
        return listenAgentEvents(scope.sessionId, scope.agentId, handler, onError, onReady);
      }
      if (scope.sessionId !== undefined && scope.agentId === undefined && scope.workspaceId === undefined &&
        source.kind === 'emitter' && source.service === 'sessionExecutionControl') {
        const manager = root.accessor.get(ISessionManager);
        let inner: IDisposable | undefined;
        let disposed = false;
        const attach = (session: ScopeLike) => {
          if (disposed) return;
          inner?.dispose();
          inner = subscribeSource({ kind: 'session', like: session }, source, handler);
        };
        const created = manager.onDidCreateSession?.(event => {
          if (event.sessionId === scope.sessionId) attach(event.handle);
        });
        const closed = manager.onDidCloseSession?.(event => {
          if (event.sessionId !== scope.sessionId) return;
          inner?.dispose(); inner = undefined;
        });
        try {
          const live = getLiveSessionById(root.accessor, scope.sessionId);
          if (live !== undefined) attach(live);
          queueMicrotask(() => { if (!disposed) onReady?.(); });
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
        return { dispose: () => { disposed = true; created?.dispose(); closed?.dispose(); inner?.dispose(); } };
      }
      if (scope.sessionId !== undefined && scope.agentId === 'main' && scope.workspaceId === undefined) {
        const session = getLiveSessionById(root.accessor, scope.sessionId);
        const lifecycle = session?.accessor.get(IAgentLifecycleService);
        if (lifecycle !== undefined && lifecycle.get('main') === undefined) {
          let inner: IDisposable | undefined;
          let disposed = false;
          const pending = lifecycle.onDidCreate((agent) => {
            if (disposed || agent.id !== 'main') return;
            pending.dispose();
            try {
              inner = subscribeSource({ kind: 'agent', like: agent }, source, handler);
            } catch (error) {
              onError?.(error instanceof Error ? error : new Error(String(error)));
            }
          });
          queueMicrotask(() => { if (!disposed) onReady?.(); });
          return { dispose: () => { disposed = true; pending.dispose(); inner?.dispose(); } };
        }
      }
      let inner: IDisposable | undefined;
      let disposed = false;
      void resolveScope(scope).then(
        (resolved) => {
          if (disposed) return;
          try {
            inner = subscribeSource(resolved, source, handler);
          } catch (error) {
            onError?.(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (disposed) inner.dispose();
          else onReady?.();
        },
        (error: unknown) => {
          if (!disposed) onError?.(error instanceof Error ? error : new Error(String(error)));
        },
      );
      return {
        dispose: () => {
          disposed = true;
          inner?.dispose();
        },
      };
    },
  };
}
