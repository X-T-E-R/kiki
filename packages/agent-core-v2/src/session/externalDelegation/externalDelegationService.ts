/**
 * `externalDelegation` domain — `ISessionExternalDelegationService` implementation.
 *
 * Persists one versioned delegation root through the atomic-document store,
 * materializes externally-owned agents through `agentLifecycle`, drives turns
 * through `subagent`, and reads their context through `contextMemory`. Profile,
 * workspace, process, flag, and main-agent services supply composition-owned
 * defaults. Bound at Session scope.
 */

import { ulid } from 'ulid';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes, isError2, toKimiErrorPayload } from '#/errors';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { listAvailableSubagentTargets } from '#/app/agentProfileCatalog/subagentDispatch';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ILogService } from '#/_base/log/log';
import { IModelService } from '#/kosong/model/model';
import { inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import {
  ISessionDispatchService,
  type DispatchChild,
  type DispatchRun,
} from '#/session/dispatch/dispatch';
import {
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
} from '#/session/agentCollaboration/messageMailbox';
import { buildProfileCatalogEntries } from '#/session/dispatch/profileCatalogProjection';
import {
  KeyReservationRegistry,
  type ReservationResult,
} from '#/session/dispatch/reservation';

import { EXTERNAL_DELEGATION_FLAG_ID } from './flag';
import {
  classifyExternalFailureCode,
  externalFailureDescription,
  type DispatchUsageView,
  type DispatchWaitRequest,
  type DispatchWaitView,
  type ExternalAuthority,
  type ExternalChildView,
  type ExternalContinueRequest,
  type ExternalDispatchLookup,
  type ExternalDispatchRequest,
  type ExternalDispatchStatus,
  type ExternalDispatchView,
  type ExternalEventPage,
  type ExternalEventView,
  type ExternalFailureCategory,
  type ExternalPageLookup,
  type ExternalResultPage,
  type ExternalRootView,
  type ExternalSendRequest,
  type ExternalTranscriptPage,
  ISessionExternalDelegationService,
} from './externalDelegation';

interface StoredChild {
  taskName: string;
  agentId: string;
  profileName: string;
  createdAt: number;
  latestDispatchId?: string;
}

interface StoredDispatch extends Omit<ExternalDispatchView, 'status' | 'startedAt' | 'endedAt' | 'usage'> {
  agentId: string;
  status: ExternalDispatchStatus;
  startedAt?: number;
  endedAt?: number;
  transcriptStart: number;
  result?: string;
  error?: string;
  errorCode?: ExternalFailureCategory;
  usage?: TokenUsage;
}

interface StoredDispatchKey {
  fingerprint: string;
  dispatchId: string;
}

interface ExternalDelegationDocument {
  version: 1;
  delegationId: string;
  principalFingerprint: string;
  authorityFingerprint: string;
  configFingerprint: string;
  lifecycle: 'active' | 'closed';
  createdAt: number;
  lastClosedAt?: number;
  lastCloseReason?: 'exit' | 'archive';
  children: Record<string, StoredChild>;
  dispatches: Record<string, StoredDispatch>;
  dispatchKeys?: Record<string, StoredDispatchKey>;
  events: ExternalEventView[];
  nextEventSeq: number;
}

const STORE_KEY = 'root';
const TASK_NAME = /^(?!root$)[a-z0-9_]+$/;
const ACTIVE = new Set<ExternalDispatchStatus>(['queued', 'running']);
const EXTERNAL_FAILURE_MESSAGE_MAX_BYTES = 512;

export class SessionExternalDelegationService
  extends Disposable
  implements ISessionExternalDelegationService
{
  declare readonly _serviceBrand: undefined;
  private readonly scope: string;
  private readonly sessionId: string;
  private readonly controllers = new Map<string, AbortController>();
  private readonly changed = new Emitter<void>();
  private readonly dispatchKeys = new KeyReservationRegistry<string>();
  private document: ExternalDelegationDocument | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ISessionContext session: ISessionContext,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionDispatchService private readonly dispatchDomain: ISessionDispatchService,
    @IAgentCollaborationMessagingService private readonly messaging: IAgentCollaborationMessagingService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ILogService private readonly log: ILogService,
    @ISessionManager lifecycle: ISessionManager,
    @IModelService private readonly models: IModelService,
  ) {
    super();
    this.scope = session.scope('external-delegation');
    this.sessionId = session.sessionId;
    this._register(this.changed);
    this._register(this.store.acquire(this.scope, STORE_KEY));
    this.ready = this.load();
    if (lifecycle.onWillCloseSession !== undefined) {
      this._register(
        lifecycle.onWillCloseSession((event) => {
          if (event.sessionId !== this.sessionId) return;
          event.waitUntil(this.closeForSession(event.reason));
        }),
      );
    }
    this._register({
      dispose: () => {
        for (const controller of this.controllers.values()) controller.abort(new Error('Session closed'));
        this.controllers.clear();
        void this.interruptActive('Session closed');
      },
    });
  }

  private async closeForSession(reason: 'exit' | 'archive'): Promise<void> {
    for (const controller of this.controllers.values()) {
      controller.abort(new Error('Session closed'));
    }
    this.controllers.clear();
    await this.interruptActive('Session closed');
    if (this.document !== undefined) {
      this.document.lastClosedAt = Date.now();
      this.document.lastCloseReason = reason;
      await this.persist();
    }
  }

  async list(authority: ExternalAuthority): Promise<ExternalRootView> {
    const doc = await this.authorize(authority);
    await this.profiles.ready;
    const main = this.requireMain();
    const own = main.accessor.get(IAgentProfileService).data();
    const snapshot = this.profiles.snapshot?.();
    const available = listAvailableSubagentTargets(
      this.profiles,
      own,
      {
        profiles: this.profiles.list(),
        routes: this.profiles.listRoutes?.() ?? [],
        snapshot,
      },
      this.models,
    );
    const entries = buildProfileCatalogEntries(
      available.profiles,
      [],
      () => true,
      undefined,
      (alias) => this.modelAliasAvailable(alias),
    );
    return {
      version: 1,
      delegationId: doc.delegationId,
      lifecycle: doc.lifecycle,
      dispatchables: [
        { kind: 'main' },
        ...entries.map((entry) => ({
          kind: 'named' as const,
          ...entry,
        })),
      ],
      children: Object.values(doc.children)
        .map((child) => childView(child, doc))
        .toSorted((a, b) => a.taskName.localeCompare(b.taskName)),
      continuations: Object.values(doc.dispatches)
        .filter((dispatch) => !ACTIVE.has(dispatch.status))
        .map(dispatchView),
    };
  }

  async dispatch(request: ExternalDispatchRequest): Promise<ExternalDispatchView> {
    return this.exclusive(async () => {
      const message = requireNonblank(request.message, 'message');
      const doc = await this.authorize(request.authority);
      if (
        request.target === 'main' &&
        (request.taskName !== undefined ||
          request.profileName !== undefined ||
          request.modelAlias !== undefined ||
          request.thinkingEffort !== undefined)
      ) {
        throw invalid('Named-child fields are not admitted for target main.');
      }
      const key = optionalNonblank(request.dispatchKey, 'dispatch_key');
      const reservation = this.reserveDispatchKey(
        doc,
        key,
        dispatchFingerprint(request, message),
      );
      if (reservation.kind === 'replay') {
        return dispatchView(this.lookup(doc, reservation.result));
      }
      if (reservation.kind === 'conflict') throw invalid('dispatch_key is already in use.');
      try {
        return request.target === 'main'
          ? await this.startExistingDispatch(
              doc,
              targetView(this.requireMain(), undefined, undefined),
              message,
              undefined,
              key,
              reservation,
            )
          : await this.startNamedDispatch(doc, request, message, key, reservation);
      } catch (error) {
        reservation.release();
        throw error;
      }
    });
  }

  async continue(request: ExternalContinueRequest): Promise<ExternalDispatchView> {
    return this.exclusive(async () => {
      const message = requireNonblank(request.message, 'message');
      const doc = await this.authorize(request.authority);
      const previous = this.lookup(doc, request.dispatchId);
      const key = optionalNonblank(request.dispatchKey, 'dispatch_key');
      const reservation = this.reserveDispatchKey(
        doc,
        key,
        continueFingerprint(request, message),
      );
      if (reservation.kind === 'replay') {
        return dispatchView(this.lookup(doc, reservation.result));
      }
      if (reservation.kind === 'conflict') throw invalid('dispatch_key is already in use.');
      if (ACTIVE.has(previous.status)) {
        reservation.release();
        throw invalid('Cannot continue an active dispatch.');
      }
      try {
        const target =
          previous.target === 'main'
            ? targetView(this.requireMain(), undefined, undefined)
            : await this.existingNamedTarget(doc, previous.taskName!);
        return await this.startExistingDispatch(
          doc,
          target,
          message,
          previous.dispatchId,
          key,
          reservation,
        );
      } catch (error) {
        reservation.release();
        throw error;
      }
    });
  }

  async send(request: ExternalSendRequest): Promise<AgentMessageAcceptance> {
    requireNonblank(request.message, 'message');
    const taskName = requireNonblank(request.taskName, 'task_name');
    const idempotencyKey = requireNonblank(request.idempotencyKey, 'idempotency_key');
    const doc = await this.authorize(request.authority);
    const target = await this.existingNamedTarget(doc, taskName);
    return this.messaging.send({
      sourceAgentId: `external:${doc.delegationId}`,
      sourceTaskName: 'external',
      targetAgentId: target.agentId,
      targetTaskName: taskName,
      content: request.message,
      idempotencyKey,
    });
  }

  async status(request: ExternalDispatchLookup): Promise<ExternalDispatchView> {
    const doc = await this.authorize(request.authority);
    return dispatchView(this.lookup(doc, request.dispatchId));
  }

  async wait(request: DispatchWaitRequest): Promise<DispatchWaitView> {
    const doc = await this.authorize(request.authority);
    if (request.dispatchId !== undefined) this.lookup(doc, request.dispatchId);
    const waited = await this.dispatchDomain.wait(
      {
        onDidChange: this.changed.event,
        read: () => Object.values(doc.dispatches),
        key: (dispatch) => dispatch.dispatchId,
        terminal: (dispatch) => !ACTIVE.has(dispatch.status),
      },
      {
        key: request.dispatchId,
        timeoutMs: boundedTimeout(request.timeoutMs),
        signal: request.signal,
      },
    );
    return {
      waitStatus: waited.waitStatus,
      waitedMs: waited.waitedMs,
      dispatch: waited.item === undefined ? undefined : dispatchView(waited.item),
      completedDuringWait: waited.completedDuringWait.map(dispatchView),
    };
  }

  async result(request: ExternalPageLookup): Promise<ExternalResultPage> {
    const doc = await this.authorize(request.authority);
    const dispatch = this.lookup(doc, request.dispatchId);
    const page = utf8Page(
      dispatch.result ?? dispatch.error ?? '',
      request.cursor,
      boundedLimit(request.limit, 16_384, 65_536, 4),
    );
    return {
      dispatch: dispatchView(dispatch),
      text: page.text,
      nextCursor: page.nextCursor,
    };
  }

  async events(request: ExternalPageLookup): Promise<ExternalEventPage> {
    const doc = await this.authorize(request.authority);
    this.lookup(doc, request.dispatchId);
    const cursor = boundedCursor(request.cursor, Number.MAX_SAFE_INTEGER);
    const limit = boundedLimit(request.limit, 100);
    const matches = doc.events.filter(
      (event) => event.dispatchId === request.dispatchId && event.seq > cursor,
    );
    const items = matches.slice(0, limit);
    return { items, nextCursor: matches.length > items.length ? items.at(-1)?.seq : undefined };
  }

  async transcript(request: ExternalPageLookup): Promise<ExternalTranscriptPage> {
    const doc = await this.authorize(request.authority);
    const dispatch = this.lookup(doc, request.dispatchId);
    const handle = await this.materializeDispatchAgent(doc, dispatch);
    const all = handle.accessor.get(IAgentContextMemoryService).get();
    const cursor = Math.max(dispatch.transcriptStart, boundedCursor(request.cursor, all.length));
    const limit = boundedLimit(request.limit, 50);
    const window = all.slice(cursor, cursor + limit);
    const items = window.map((message, offset) => ({
      index: cursor + offset,
      role: message.role,
      text: contextText(message.content),
    }));
    const end = cursor + window.length;
    return { items, nextCursor: end < all.length ? end : undefined };
  }

  async cancel(request: ExternalDispatchLookup): Promise<ExternalDispatchView> {
    const doc = await this.authorize(request.authority);
    const dispatch = this.lookup(doc, request.dispatchId);
    if (!ACTIVE.has(dispatch.status)) return dispatchView(dispatch);
    this.controllers.get(dispatch.dispatchId)?.abort(new Error('External dispatch cancelled'));
    await this.finish(dispatch.dispatchId, 'cancelled', undefined, 'Cancelled');
    return dispatchView(this.lookup(doc, request.dispatchId));
  }

  private async load(): Promise<void> {
    this.document = await this.store.get<ExternalDelegationDocument>(this.scope, STORE_KEY);
    if (this.document !== undefined) await this.interruptActive('Process restarted');
  }

  private async authorize(authority: ExternalAuthority): Promise<ExternalDelegationDocument> {
    this.assertEnabled();
    await this.ready;
    if (this.document === undefined) {
      const now = Date.now();
      this.document = {
        version: 1,
        delegationId: `delegation_${ulid()}`,
        principalFingerprint: requireFingerprint(authority.principalFingerprint, 'principal'),
        authorityFingerprint: requireFingerprint(authority.authorityFingerprint, 'authority'),
        configFingerprint: requireFingerprint(authority.configFingerprint, 'config'),
        lifecycle: 'active',
        createdAt: now,
        children: {},
        dispatches: {},
        events: [],
        nextEventSeq: 1,
      };
      await this.persist();
    }
    const doc = this.document;
    if (
      doc.principalFingerprint !== authority.principalFingerprint ||
      doc.authorityFingerprint !== authority.authorityFingerprint ||
      doc.configFingerprint !== authority.configFingerprint
    ) {
      throw invalid('External delegation authority does not own this session root.');
    }
    if (doc.lifecycle !== 'active') throw invalid('External delegation root is closed.');
    return doc;
  }

  private async startNamedDispatch(
    doc: ExternalDelegationDocument,
    request: ExternalDispatchRequest,
    message: string,
    dispatchKey: string | undefined,
    reservation: ActiveDispatchKeyReservation,
  ): Promise<ExternalDispatchView> {
    const taskName = request.taskName?.trim();
    if (taskName === undefined || !TASK_NAME.test(taskName)) {
      throw invalid('task_name must match [a-z0-9_]+ and must not be root.');
    }
    const modelAlias = optionalNonblank(request.modelAlias, 'model_alias');
    const thinkingEffort = optionalNonblank(request.thinkingEffort, 'thinking_effort');
    const existing = doc.children[taskName];
    if (existing !== undefined) {
      if (request.profileName !== undefined && request.profileName !== existing.profileName) {
        throw invalid('A named child cannot change profile.');
      }
      const target = await this.existingNamedTarget(doc, taskName);
      if (modelAlias !== undefined && modelAlias !== target.modelAlias) {
        throw invalid('A named child cannot change model_alias.');
      }
      if (thinkingEffort !== undefined && thinkingEffort !== target.thinkingEffort) {
        throw invalid('A named child cannot change thinking_effort.');
      }
      return this.startExistingDispatch(
        doc,
        target,
        message,
        undefined,
        dispatchKey,
        reservation,
      );
    }
    const profileName = requireNonblank(request.profileName, 'profile_name');
    const main = this.requireMain();
    const runtimeLease = main.accessor.get(IAgentRuntimeService).acquire(['process']);
    const view = new RuntimeWorkspaceView(runtimeLease.runtime, this.workspace);
    const controller = new AbortController();
    const dispatchId = `dispatch_${ulid()}`;
    try {
      const run = await this.dispatchDomain.launch({
        delegator: { kind: 'external', delegationId: doc.delegationId },
        requesterAgentId: MAIN_AGENT_ID,
        profileName,
        snapshot: this.profiles.snapshot?.(),
        message,
        name: taskName,
        modelAlias,
        thinkingEffort,
        strictThinkingFromProfile: true,
        runtime: runtimeLease.runtime,
        workDir: view.workDir,
        signal: controller.signal,
        executorPolicy: 'native',
        onCreated: async (child) => {
          doc.children[taskName] = {
            taskName,
            agentId: child.agentId,
            profileName,
            createdAt: Date.now(),
          };
          await this.queueDispatch(
            doc,
            dispatchId,
            targetView(child.agent, taskName, profileName),
            undefined,
            dispatchKey,
            reservation,
          );
        },
      });
      this.controllers.set(dispatchId, controller);
      void this.observeDispatch(dispatchId, run, controller);
      return dispatchView(this.lookup(doc, dispatchId));
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.PROFILE_UNKNOWN) {
        throw invalid(
          `Unknown named-agent profile. Available agent profiles: ${(await this.availableProfileNames()).join(', ')}`,
        );
      }
      if (isError2(error) && error.code === ErrorCodes.AGENT_TYPE_NOT_ALLOWED) {
        throw invalid('Named-agent profile is not admitted.');
      }
      if (
        isError2(error) &&
        error.code === ErrorCodes.REQUEST_INVALID &&
        error.message.includes('Harness executors')
      ) {
        throw invalid('External executors are unsupported for external delegation.');
      }
      throw error;
    } finally {
      runtimeLease.dispose();
    }
  }

  private async availableProfileNames(): Promise<string[]> {
    await this.profiles.ready;
    const main = this.requireMain();
    const available = listAvailableSubagentTargets(
      this.profiles,
      main.accessor.get(IAgentProfileService).data(),
      {
        profiles: this.profiles.list(),
        routes: this.profiles.listRoutes?.() ?? [],
        snapshot: this.profiles.snapshot?.(),
      },
      this.models,
    );
    return available.profiles.map((profile) => profile.name);
  }

  private modelAliasAvailable(alias: string): boolean {
    try {
      return this.models.resolveId(alias) !== undefined;
    } catch {
      return false;
    }
  }

  private async existingNamedTarget(
    doc: ExternalDelegationDocument,
    taskName: string,
  ): Promise<DispatchTarget> {
    const stored = doc.children[taskName];
    if (stored === undefined) throw invalid('Unknown named child.');
    const child = await this.dispatchDomain.resolveOwnedChild(
      { kind: 'external', delegationId: doc.delegationId },
      taskName,
    );
    if (child.agentId !== stored.agentId) {
      throw invalid('Owned agent metadata does not match the named child.');
    }
    return targetView(child.agent, taskName, stored.profileName);
  }

  private async materializeDispatchAgent(
    doc: ExternalDelegationDocument,
    dispatch: StoredDispatch,
  ): Promise<IAgentScopeHandle> {
    if (dispatch.target === 'main') return this.requireMain();
    return (
      await this.dispatchDomain.resolveOwnedChild(
        { kind: 'external', delegationId: doc.delegationId },
        dispatch.taskName!,
      )
    ).agent;
  }

  private async startExistingDispatch(
    doc: ExternalDelegationDocument,
    target: DispatchTarget,
    message: string,
    continuationOf: string | undefined,
    dispatchKey: string | undefined,
    reservation: ActiveDispatchKeyReservation,
  ): Promise<ExternalDispatchView> {
    const active = Object.values(doc.dispatches).find(
      (dispatch) => dispatch.agentId === target.agent.id && ACTIVE.has(dispatch.status),
    );
    if (active !== undefined) throw invalid('The target already has an active dispatch.');
    const controller = new AbortController();
    const dispatchId = `dispatch_${ulid()}`;
    const run = await this.dispatchDomain.runOnExisting(target, message, {
      signal: controller.signal,
      lineage: continuationOf,
      idlePolicy: 'quiescent',
      onBeforeRun: async () => {
        await this.queueDispatch(
          doc,
          dispatchId,
          target,
          continuationOf,
          dispatchKey,
          reservation,
        );
      },
    });
    this.controllers.set(dispatchId, controller);
    void this.observeDispatch(dispatchId, run, controller);
    return dispatchView(this.lookup(doc, dispatchId));
  }

  private async queueDispatch(
    doc: ExternalDelegationDocument,
    dispatchId: string,
    target: DispatchTarget,
    continuationOf: string | undefined,
    dispatchKey: string | undefined,
    reservation: ActiveDispatchKeyReservation,
  ): Promise<void> {
    const dispatch: StoredDispatch = {
      dispatchId,
      target: target.taskName === undefined ? 'main' : 'named',
      taskName: target.taskName,
      profileName: target.taskName === undefined ? undefined : target.profileName,
      agentId: target.agent.id,
      actualProfile: target.profileName,
      modelAlias: target.modelAlias,
      thinkingEffort: target.thinkingEffort,
      status: 'queued',
      nextStep: `wait:${dispatchId}`,
      continueHint:
        target.taskName === undefined
          ? `continue:${dispatchId}`
          : `dispatch:${target.taskName}`,
      createdAt: Date.now(),
      continuationOf,
      transcriptStart: target.agent.accessor.get(IAgentContextMemoryService).get().length,
    };
    doc.dispatches[dispatchId] = dispatch;
    if (target.taskName !== undefined) {
      doc.children[target.taskName]!.latestDispatchId = dispatchId;
      await this.dispatchDomain.recordRun(target.agentId, dispatchId);
    }
    const committed = reservation.commit(dispatchId);
    if (dispatchKey !== undefined) {
      doc.dispatchKeys ??= {};
      doc.dispatchKeys[dispatchKey] = {
        fingerprint: committed.fingerprint,
        dispatchId: committed.result,
      };
    }
    this.appendEvent(doc, dispatchId, 'queued');
    await this.persist();
  }

  private async observeDispatch(
    dispatchId: string,
    dispatchRun: DispatchRun,
    controller: AbortController,
  ): Promise<void> {
    try {
      const run = await dispatchRun.started;
      const doc = this.document;
      const dispatch = doc?.dispatches[dispatchId];
      if (
        doc === undefined ||
        dispatch === undefined ||
        dispatch.status !== 'queued' ||
        controller.signal.aborted
      ) {
        void run.completion.catch(() => undefined);
        return;
      }
      dispatch.status = 'running';
      dispatch.startedAt = Date.now();
      this.appendEvent(doc, dispatchId, 'started');
      await this.persist();
      void run.completion.then(
        (result) => this.finish(dispatchId, 'completed', result.summary, undefined, undefined, result.usage),
        (error) => {
          if (controller.signal.aborted) {
            return this.finish(dispatchId, 'cancelled', undefined, 'Cancelled');
          }
          return this.failDispatch(dispatchId, error);
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        await this.finish(dispatchId, 'cancelled', undefined, 'Cancelled');
      } else {
        await this.failDispatch(dispatchId, error);
      }
    }
  }

  /**
   * Terminal failure path: classify the raw error onto the stable external
   * taxonomy, keep the untrusted original in the server log (with dispatch /
   * session identity), and persist only the category code plus its
   * domain-owned description.
   */
  private async failDispatch(dispatchId: string, error: unknown): Promise<void> {
    const payload = toKimiErrorPayload(error);
    const category: ExternalFailureCategory = classifyExternalFailureCode(payload.code) ?? 'internal';
    this.log.error('External dispatch failed.', {
      dispatchId,
      sessionId: this.sessionId,
      delegationId: this.document?.delegationId,
      code: payload.code,
      category,
      raw: payload.message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    await this.finish(dispatchId, 'failed', undefined, externalFailureDescription(category), category);
  }

  private async finish(
    dispatchId: string,
    status: Extract<ExternalDispatchStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    result?: string,
    error?: string,
    errorCode?: ExternalFailureCategory,
    usage?: TokenUsage,
  ): Promise<void> {
    const doc = this.document;
    const dispatch = doc?.dispatches[dispatchId];
    if (doc === undefined || dispatch === undefined || !ACTIVE.has(dispatch.status)) return;
    dispatch.status = status;
    dispatch.endedAt = Date.now();
    dispatch.result = result;
    dispatch.error = error === undefined ? undefined : safeFailureText(error);
    dispatch.errorCode = errorCode;
    dispatch.usage = usage;
    this.controllers.delete(dispatchId);
    this.appendEvent(doc, dispatchId, status, dispatch.error);
    await this.persist();
  }

  private async interruptActive(message: string): Promise<void> {
    const doc = this.document;
    if (doc === undefined) return;
    let changed = false;
    for (const dispatch of Object.values(doc.dispatches)) {
      if (!ACTIVE.has(dispatch.status)) continue;
      dispatch.status = 'interrupted';
      dispatch.endedAt = Date.now();
      dispatch.error = safeFailureText(message);
      this.appendEvent(doc, dispatch.dispatchId, 'interrupted', dispatch.error);
      changed = true;
    }
    if (changed) await this.persist();
  }

  private appendEvent(
    doc: ExternalDelegationDocument,
    dispatchId: string,
    type: ExternalEventView['type'],
    message?: string,
  ): void {
    doc.events.push({ seq: doc.nextEventSeq++, dispatchId, type, at: Date.now(), message });
    if (doc.events.length > 5_000) doc.events.splice(0, doc.events.length - 5_000);
  }

  private persist(): Promise<void> {
    const doc = this.document;
    if (doc === undefined) return Promise.resolve();
    const write = this.writeQueue
      .then(() => this.store.set(this.scope, STORE_KEY, doc))
      .then(() => this.changed.fire());
    this.writeQueue = write.catch(() => {});
    return write;
  }

  private reserveDispatchKey(
    doc: ExternalDelegationDocument,
    key: string | undefined,
    fingerprint: string,
  ): ReservationResult<string> {
    if (key === undefined) {
      return this.dispatchKeys.reserve(`unkeyed:${ulid()}`, fingerprint, undefined, true);
    }
    const stored = doc.dispatchKeys?.[key];
    return this.dispatchKeys.reserve(
      key,
      fingerprint,
      stored === undefined
        ? undefined
        : { fingerprint: stored.fingerprint, result: stored.dispatchId },
      true,
    );
  }

  private lookup(doc: ExternalDelegationDocument, dispatchId: string): StoredDispatch {
    const dispatch = doc.dispatches[dispatchId];
    if (dispatch === undefined) throw invalid('Unknown external dispatch handle.');
    return dispatch;
  }

  private requireMain(): IAgentScopeHandle {
    const main = this.agents.get(MAIN_AGENT_ID);
    if (main === undefined) throw invalid('Main agent is not materialized.');
    return main;
  }

  private assertEnabled(): void {
    if (!this.flags.enabled(EXTERNAL_DELEGATION_FLAG_ID)) throw invalid('External delegation is disabled.');
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

type ActiveDispatchKeyReservation = Extract<
  ReservationResult<string>,
  { readonly kind: 'reserved' }
>;

function childView(child: StoredChild, doc: ExternalDelegationDocument): ExternalChildView {
  const latest = child.latestDispatchId === undefined ? undefined : doc.dispatches[child.latestDispatchId];
  return {
    taskName: child.taskName,
    profileName: child.profileName,
    latestDispatchId: child.latestDispatchId,
    status: latest?.status,
    usage: latest?.usage === undefined ? undefined : usageView(latest.usage),
  };
}

function dispatchView(dispatch: StoredDispatch): ExternalDispatchView {
  return {
    dispatchId: dispatch.dispatchId,
    target: dispatch.target,
    taskName: dispatch.taskName,
    profileName: dispatch.profileName,
    agentId: dispatch.agentId,
    actualProfile: dispatch.actualProfile,
    modelAlias: dispatch.modelAlias,
    thinkingEffort: dispatch.thinkingEffort,
    status: dispatch.status,
    nextStep: dispatch.nextStep,
    continueHint: dispatch.continueHint,
    createdAt: dispatch.createdAt,
    startedAt: dispatch.startedAt,
    endedAt: dispatch.endedAt,
    continuationOf: dispatch.continuationOf,
    usage: dispatch.usage === undefined ? undefined : usageView(dispatch.usage),
    errorCode: dispatch.errorCode,
  };
}

function usageView(usage: TokenUsage): DispatchUsageView {
  return {
    input: inputTotal(usage),
    output: usage.output,
    cacheRead: usage.inputCacheRead,
    cacheWrite: usage.inputCacheCreation,
  };
}

function dispatchFingerprint(request: ExternalDispatchRequest, message: string): string {
  return JSON.stringify({
    target: request.target,
    taskName: request.taskName?.trim(),
    profileName: request.profileName?.trim(),
    modelAlias: request.modelAlias?.trim(),
    thinkingEffort: request.thinkingEffort?.trim(),
    message,
  });
}

function continueFingerprint(request: ExternalContinueRequest, message: string): string {
  return JSON.stringify({ dispatchId: request.dispatchId, message });
}

function safeFailureText(message: string): string {
  const normalized = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (
    normalized.length === 0 ||
    /(?:https?:\/\/|bearer\s+|authorization|api[-_ ]?key|access[-_ ]?token|password|credential|secret)/i.test(normalized) ||
    /(?:[a-z]:\\|\\\\|\/(?:users|home|tmp|var|etc)\/)/i.test(normalized)
  ) {
    return externalFailureDescription('internal');
  }
  return utf8Prefix(normalized, EXTERNAL_FAILURE_MESSAGE_MAX_BYTES);
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = '';
  let bytes = 0;
  for (const symbol of value) {
    const size = encoder.encode(symbol).byteLength;
    if (bytes + size > maxBytes) break;
    result += symbol;
    bytes += size;
  }
  return result;
}

function utf8Page(
  value: string,
  rawCursor: number | undefined,
  maxBytes: number,
): { readonly text: string; readonly nextCursor?: number } {
  const encoder = new TextEncoder();
  const cursor = boundedTextCursor(value, rawCursor);
  let pageBytes = 0;
  let text = '';
  for (const symbol of value.slice(cursor)) {
    const size = encoder.encode(symbol).byteLength;
    if (pageBytes > 0 && pageBytes + size > maxBytes) break;
    text += symbol;
    pageBytes += size;
    if (pageBytes >= maxBytes) break;
  }
  const end = cursor + text.length;
  return { text, nextCursor: end < value.length ? end : undefined };
}

function requireNonblank(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) throw invalid(`${name} must not be blank.`);
  return trimmed;
}

function optionalNonblank(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : requireNonblank(value, name);
}

interface DispatchTarget extends DispatchChild {
  readonly taskName: string | undefined;
}

function targetView(
  agent: IAgentScopeHandle,
  taskName: string | undefined,
  profileName: string | undefined,
): DispatchTarget {
  const binding = agent.accessor.get(IAgentProfileService).data();
  if (binding.modelAlias === undefined) throw invalid('Target agent has no configured model.');
  return {
    agent,
    agentId: agent.id,
    taskName,
    profileName: profileName ?? binding.routeId ?? binding.profileName ?? 'agent',
    modelAlias: binding.modelAlias,
    thinkingEffort: binding.thinkingLevel,
  };
}

function requireFingerprint(value: string, name: string): string {
  const trimmed = value.trim();
  if (!/^[a-f0-9]{64}$/.test(trimmed)) throw invalid(`${name} fingerprint is invalid.`);
  return trimmed;
}

function boundedCursor(value: number | undefined, max: number): number {
  const cursor = value ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > max) throw invalid('cursor is invalid.');
  return cursor;
}

function boundedTextCursor(value: string, rawCursor: number | undefined): number {
  const cursor = boundedCursor(rawCursor, value.length);
  if (
    cursor > 0 &&
    cursor < value.length &&
    isHighSurrogate(value.charCodeAt(cursor - 1)) &&
    isLowSurrogate(value.charCodeAt(cursor))
  ) {
    throw invalid('cursor is invalid.');
  }
  return cursor;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  max = fallback,
  min = 1,
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < min) throw invalid('limit is invalid.');
  return Math.min(limit, max);
}

function boundedTimeout(value: number | undefined): number {
  const timeoutMs = value ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw invalid('timeout is invalid.');
  return Math.min(timeoutMs, 600_000);
}

function contextText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

function invalid(message: string): Error2 {
  return new Error2(ErrorCodes.REQUEST_INVALID, message);
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExternalDelegationService,
  SessionExternalDelegationService,
  ScopeActivation.OnDemand,
  'externalDelegation',
);
