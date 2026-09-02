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
import { Emitter, Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes, isError2, toKimiErrorPayload, type ErrorCode } from '#/errors';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2Class } from '#/app/event/event2';
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
import { IWireService } from '#/wire/wire';
import {
  ISessionDispatchService,
  type DispatchChild,
  type DispatchRun,
} from '#/session/dispatch/dispatch';
import {
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
} from '#/session/agentCollaboration/messageMailbox';
import { ISessionApprovalService, type ApprovalResponse } from '#/session/approval/approval';
import { buildProfileCatalogEntries } from '#/session/dispatch/profileCatalogProjection';
import {
  ISessionInteractionService,
  type Interaction,
} from '#/session/interaction/interaction';
import { ISessionQuestionService, type QuestionResult } from '#/session/question/question';
import {
  KeyReservationRegistry,
  type ReservationResult,
} from '#/session/dispatch/reservation';

import { EXTERNAL_DELEGATION_FLAG_ID } from './flag';
import {
  constrainExternalPermissionMode,
  resolveExternalPermissionCeiling,
} from './permissionCeiling';
import {
  EXTERNAL_INTERACTION_NOT_OWNED_CODE,
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
  type ExternalEventsLookup,
  type ExternalEventView,
  type ExternalFailureCategory,
  type ExternalInteractionPage,
  type ExternalInteractionsRequest,
  type ExternalInteractionView,
  type ExternalPageLookup,
  type ExternalRespondRequest,
  type ExternalRespondView,
  type ExternalResultPage,
  type ExternalRootView,
  type ExternalSendRequest,
  type ExternalTranscriptItemsPage,
  type ExternalTranscriptLookup,
  type ExternalTranscriptPage,
  type ExternalTurnEventPage,
  ISessionExternalDelegationService,
} from './externalDelegation';
import { AgentTurnProjection } from './turnProjection';

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
  transcriptEnd?: number;
  transcriptTurnId?: number;
  transcriptCursorVersion?: 2;
  legacyTranscriptStart?: number;
  legacyTranscriptEnd?: number;
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
  truncatedBeforeEventSeq?: number;
}

interface ProjectionCacheEntry {
  generation: number;
  snapshot?: {
    readonly generation: number;
    readonly projection: AgentTurnProjection;
  };
  rebuilding?: {
    readonly generation: number;
    readonly promise: Promise<AgentTurnProjection>;
  };
}

interface DispatchTranscriptBoundary {
  readonly turnId: number;
  readonly generation: number;
  readonly legacyTranscriptEnd: number;
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
  private readonly executionSettled = new Map<
    string,
    Promise<DispatchTranscriptBoundary | undefined>
  >();
  private readonly terminalizations = new Map<string, Promise<void>>();
  private readonly projectionCache = new Map<string, ProjectionCacheEntry>();
  private readonly interactionConsumerId: string;
  private readonly permissionCeiling: PermissionMode;
  private interactionConsumerActive = false;
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
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @ISessionApprovalService private readonly approvals: ISessionApprovalService,
    @ISessionQuestionService private readonly questions: ISessionQuestionService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ILogService private readonly log: ILogService,
    @ISessionManager lifecycle: ISessionManager,
    @IModelService private readonly models: IModelService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    super();
    this.permissionCeiling = resolveExternalPermissionCeiling((name) => bootstrap.getEnv(name));
    this.scope = session.scope('external-delegation');
    this.sessionId = session.sessionId;
    this.interactionConsumerId = `external-delegation:${this.sessionId}`;
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
        this.releaseInteractionConsumer();
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
      const fingerprint = dispatchFingerprint(request, message);
      const reservation = this.reserveDispatchKey(doc, key, fingerprint);
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
              fingerprint,
              reservation,
            )
          : await this.startNamedDispatch(doc, request, message, key, fingerprint, reservation);
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
      const fingerprint = continueFingerprint(request, message);
      const reservation = this.reserveDispatchKey(doc, key, fingerprint);
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
          fingerprint,
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

  async interactions(request: ExternalInteractionsRequest): Promise<ExternalInteractionPage> {
    const doc = await this.authorize(request.authority);
    const pending = this.ownedInteractionEntries(doc);
    const cursor = boundedCursor(request.cursor, pending.length);
    const window = pending.slice(cursor, cursor + 100);
    const items = window.map(({ interaction, dispatch }) => interactionView(interaction, dispatch));
    const end = cursor + window.length;
    return { items, nextCursor: end < pending.length ? end : undefined };
  }

  async respond(request: ExternalRespondRequest): Promise<ExternalRespondView> {
    const interactionId = requireNonblank(request.interactionId, 'interaction_id');
    const doc = await this.authorize(request.authority);
    const interaction = this.requireOwnedInteraction(doc, interactionId);
    if (request.kind !== interaction.kind) throw invalid('response kind does not match the interaction.');
    if (interaction.kind === 'approval') {
      if (!isApprovalResponse(request.response)) throw invalid('response is invalid for an approval interaction.');
      this.approvals.decide(interactionId, request.response);
    } else {
      if (!isQuestionResult(request.response)) throw invalid('response is invalid for a question interaction.');
      this.questions.answer(interactionId, request.response);
    }
    return { interactionId, status: 'resolved' };
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
        onDidChange: Event.any(
          this.changed.event,
          Event.map(this.interaction.onDidChangePending, () => undefined),
        ),
        read: () => Object.values(doc.dispatches),
        key: (dispatch) => dispatch.dispatchId,
        terminal: (dispatch) => !ACTIVE.has(dispatch.status),
        blockedKey: () => this.ownedInteractionEntries(doc, request.dispatchId)[0]?.dispatch.dispatchId,
      },
      {
        key: request.dispatchId,
        timeoutMs: boundedTimeout(request.timeoutMs),
        signal: request.signal,
      },
    );
    const interactions = waited.waitStatus === 'blocked'
      ? this.ownedInteractionEntries(doc, waited.item?.dispatchId).map(({ interaction, dispatch }) =>
          interactionView(interaction, dispatch),
        )
      : [];
    return {
      waitStatus: waited.waitStatus === 'blocked' ? 'interaction_pending' : waited.waitStatus,
      waitedMs: waited.waitedMs,
      dispatch: waited.item === undefined ? undefined : dispatchView(waited.item),
      completedDuringWait: waited.completedDuringWait.map(dispatchView),
      interactions,
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

  events(request: ExternalEventsLookup & { readonly detail: 'turn' }): Promise<ExternalTurnEventPage>;
  events(request: ExternalEventsLookup): Promise<ExternalEventPage>;
  async events(request: ExternalEventsLookup): Promise<ExternalEventPage | ExternalTurnEventPage> {
    const doc = await this.authorize(request.authority);
    const dispatch = this.lookup(doc, request.dispatchId);
    const cursor = boundedCursor(request.cursor, Number.MAX_SAFE_INTEGER);
    const limit = boundedLimit(request.limit, 100);
    if (request.detail === 'turn') {
      await this.terminalizations.get(dispatch.dispatchId);
      const handle = await this.materializeDispatchAgent(doc, dispatch);
      const projection = await this.buildTurnProjection(handle);
      const start = dispatch.transcriptStart;
      const end = ACTIVE.has(dispatch.status) ? projection.cursor : dispatch.transcriptEnd!;
      if (cursor > end) throw invalid('cursor is invalid.');
      return projection.eventPage(dispatch.dispatchId, start, end, cursor, limit);
    }
    const matches = doc.events.filter(
      (event) => event.dispatchId === request.dispatchId && event.seq > cursor,
    );
    const items = matches.slice(0, limit);
    return {
      items,
      nextCursor: matches.length > items.length ? items.at(-1)?.seq : undefined,
      truncated_before_seq: doc.truncatedBeforeEventSeq,
    };
  }

  transcript(request: ExternalTranscriptLookup & { readonly detail: 'items' }): Promise<ExternalTranscriptItemsPage>;
  transcript(request: ExternalTranscriptLookup): Promise<ExternalTranscriptPage>;
  async transcript(
    request: ExternalTranscriptLookup,
  ): Promise<ExternalTranscriptPage | ExternalTranscriptItemsPage> {
    const doc = await this.authorize(request.authority);
    const dispatch = this.lookup(doc, request.dispatchId);
    const limit = boundedLimit(request.limit, 50);
    if (request.detail === 'items') {
      await this.terminalizations.get(dispatch.dispatchId);
      const cursor = boundedCursor(request.cursor, Number.MAX_SAFE_INTEGER);
      const handle = await this.materializeDispatchAgent(doc, dispatch);
      const projection = await this.buildTurnProjection(handle);
      const start = dispatch.transcriptStart;
      const end = ACTIVE.has(dispatch.status) ? projection.cursor : dispatch.transcriptEnd!;
      if (cursor > end) throw invalid('cursor is invalid.');
      return projection.itemPage(start, end, cursor, limit);
    }
    await this.terminalizations.get(dispatch.dispatchId);
    const handle = await this.materializeDispatchAgent(doc, dispatch);
    const all = handle.accessor.get(IAgentContextMemoryService).get();
    const legacyStart = dispatch.legacyTranscriptStart!;
    const legacyEnd = ACTIVE.has(dispatch.status) ? all.length : dispatch.legacyTranscriptEnd!;
    const cursor = Math.max(legacyStart, boundedCursor(request.cursor, legacyEnd));
    const window = all.slice(cursor, Math.min(cursor + limit, legacyEnd));
    const items = window.map((message, offset) => ({
      index: cursor + offset,
      role: message.role,
      text: contextText(message.content),
    }));
    const end = cursor + window.length;
    return { items, nextCursor: end < legacyEnd ? end : undefined };
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
    if (this.document !== undefined) {
      await this.migrateTranscriptBounds(this.document);
      await this.interruptActive('Process restarted');
    }
  }

  private async migrateTranscriptBounds(doc: ExternalDelegationDocument): Promise<void> {
    const projections = new Map<string, AgentTurnProjection>();
    let changed = false;
    for (const dispatch of Object.values(doc.dispatches)) {
      const terminal = !ACTIVE.has(dispatch.status);
      if (
        dispatch.transcriptCursorVersion === 2 &&
        (!terminal || dispatch.transcriptEnd !== undefined) &&
        (!terminal || dispatch.legacyTranscriptEnd !== undefined)
      ) {
        continue;
      }
      let projection = projections.get(dispatch.agentId);
      if (projection === undefined) {
        const handle = await this.materializeDispatchAgent(doc, dispatch);
        projection = await this.buildTurnProjection(handle);
        projections.set(dispatch.agentId, projection);
      }
      if (dispatch.transcriptCursorVersion !== 2) {
        const legacyTranscriptStart = dispatch.transcriptStart;
        const range = dispatch.endedAt === undefined
          ? undefined
          : projection.cursorRange(dispatch.createdAt, dispatch.endedAt);
        const start = ACTIVE.has(dispatch.status)
          ? projection.cursorAt(dispatch.createdAt)
          : range?.start ?? projection.cursor;
        dispatch.transcriptStart = start;
        dispatch.transcriptEnd = ACTIVE.has(dispatch.status)
          ? undefined
          : range?.end ?? projection.cursor;
        dispatch.transcriptCursorVersion = 2;
        dispatch.legacyTranscriptStart = legacyTranscriptStart;
        changed = true;
      } else if (!ACTIVE.has(dispatch.status) && dispatch.transcriptEnd === undefined) {
        dispatch.transcriptEnd = dispatch.transcriptTurnId === undefined
          ? projection.cursorBefore(dispatch.endedAt ?? dispatch.createdAt)
          : projection.turnEndCursor(dispatch.transcriptTurnId);
        changed = true;
      }
      if (!ACTIVE.has(dispatch.status) && dispatch.legacyTranscriptEnd === undefined) {
        dispatch.legacyTranscriptEnd = dispatch.legacyTranscriptStart!;
        changed = true;
      }
    }
    if (changed) await this.persist();
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
    fingerprint: string,
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
        fingerprint,
        reservation,
      );
    }
    const profileName = requireNonblank(request.profileName, 'profile_name');
    const recovered = await this.recoverNamedTarget(doc, taskName);
    if (recovered !== undefined) {
      if (profileName !== recovered.profileName) {
        throw invalid('A named child cannot change profile.');
      }
      if (modelAlias !== undefined && modelAlias !== recovered.modelAlias) {
        throw invalid('A named child cannot change model_alias.');
      }
      if (thinkingEffort !== undefined && thinkingEffort !== recovered.thinkingEffort) {
        throw invalid('A named child cannot change thinking_effort.');
      }
      return this.startExistingDispatch(
        doc,
        recovered,
        message,
        undefined,
        dispatchKey,
        fingerprint,
        reservation,
        {
          taskName,
          agentId: recovered.agentId,
          profileName,
          createdAt: Date.now(),
        },
      );
    }
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
        permissionMode: constrainExternalPermissionMode(
          main.accessor.get(IAgentPermissionModeService).mode,
          this.permissionCeiling,
        ),
        strictThinkingFromProfile: true,
        runtime: runtimeLease.runtime,
        workDir: view.workDir,
        signal: controller.signal,
        onCreated: async (child) => {
          await this.queueDispatch(
            doc,
            dispatchId,
            targetView(child.agent, taskName, profileName),
            undefined,
            dispatchKey,
            fingerprint,
            reservation,
            {
              taskName,
              agentId: child.agentId,
              profileName,
              createdAt: Date.now(),
            },
          );
        },
      });
      this.controllers.set(dispatchId, controller);
      this.trackExecutionSettlement(dispatchId, run);
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

  private async recoverNamedTarget(
    doc: ExternalDelegationDocument,
    taskName: string,
  ): Promise<DispatchTarget | undefined> {
    try {
      const child = await this.dispatchDomain.resolveOwnedChild(
        { kind: 'external', delegationId: doc.delegationId },
        taskName,
      );
      return targetView(child.agent, taskName, child.profileName);
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.AGENT_NOT_FOUND) return undefined;
      throw error;
    }
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

  private projectionEntry(handle: IAgentScopeHandle): ProjectionCacheEntry {
    let entry = this.projectionCache.get(handle.id);
    if (entry !== undefined) return entry;
    entry = { generation: 0 };
    this.projectionCache.set(handle.id, entry);
    this._register(handle.accessor.get(IEventBus).subscribe((event) => {
      if ((event.constructor as Event2Class).durable) entry!.generation++;
    }));
    return entry;
  }

  private async buildTurnProjection(
    handle: IAgentScopeHandle,
    cached = true,
    requiredGeneration?: number,
    requiredTurnId?: number,
  ): Promise<AgentTurnProjection> {
    const wire = handle.accessor.get(IWireService);
    const entry = this.projectionEntry(handle);
    if (!cached) {
      await wire.flush();
      return AgentTurnProjection.build(wire.readJournal());
    }
    const required = requiredGeneration ?? entry.generation;
    for (;;) {
      if (
        entry.snapshot !== undefined &&
        entry.snapshot.generation >= required &&
        (requiredTurnId === undefined || entry.snapshot.projection.hasTurnEnd(requiredTurnId))
      ) {
        return entry.snapshot.projection;
      }
      let rebuilding = entry.rebuilding;
      if (rebuilding === undefined || rebuilding.generation !== required) {
        const generation = Math.max(required, entry.generation);
        const promise = (async () => {
          await wire.flush();
          const projection = await AgentTurnProjection.build(wire.readJournal());
          if (entry.snapshot === undefined || entry.snapshot.generation <= generation) {
            entry.snapshot = { generation, projection };
          }
          return projection;
        })();
        rebuilding = { generation, promise };
        entry.rebuilding = rebuilding;
      }
      try {
        await rebuilding.promise;
      } finally {
        if (entry.rebuilding === rebuilding) entry.rebuilding = undefined;
      }
    }
  }

  private captureTranscriptBoundary(
    handle: IAgentScopeHandle,
    turnId: number,
  ): DispatchTranscriptBoundary {
    return {
      turnId,
      generation: this.projectionEntry(handle).generation,
      legacyTranscriptEnd: handle.accessor.get(IAgentContextMemoryService).get().length,
    };
  }

  private async captureTranscriptEnd(
    doc: ExternalDelegationDocument,
    dispatch: StoredDispatch,
    boundary: DispatchTranscriptBoundary | undefined,
  ): Promise<void> {
    dispatch.legacyTranscriptEnd ??= boundary?.legacyTranscriptEnd ?? dispatch.legacyTranscriptStart;
    if (boundary === undefined) {
      dispatch.transcriptEnd = dispatch.transcriptStart;
      return;
    }
    const handle = await this.materializeDispatchAgent(doc, dispatch);
    const projection = await this.buildTurnProjection(
      handle,
      true,
      boundary.generation,
      boundary.turnId,
    );
    dispatch.transcriptEnd = projection.turnEndCursor(boundary.turnId);
  }

  private async startExistingDispatch(
    doc: ExternalDelegationDocument,
    target: DispatchTarget,
    message: string,
    continuationOf: string | undefined,
    dispatchKey: string | undefined,
    fingerprint: string,
    reservation: ActiveDispatchKeyReservation,
    newChild?: StoredChild,
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
          fingerprint,
          reservation,
          newChild,
        );
      },
    });
    this.controllers.set(dispatchId, controller);
    this.trackExecutionSettlement(dispatchId, run);
    void this.observeDispatch(dispatchId, run, controller);
    return dispatchView(this.lookup(doc, dispatchId));
  }

  private async queueDispatch(
    doc: ExternalDelegationDocument,
    dispatchId: string,
    target: DispatchTarget,
    continuationOf: string | undefined,
    dispatchKey: string | undefined,
    fingerprint: string,
    reservation: ActiveDispatchKeyReservation,
    newChild?: StoredChild,
  ): Promise<void> {
    const legacyTranscriptStart = target.agent.accessor.get(IAgentContextMemoryService).get().length;
    const projection = await this.buildTurnProjection(target.agent, false);
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
      transcriptStart: projection.cursor,
      transcriptCursorVersion: 2,
      legacyTranscriptStart,
    };
    const event: ExternalEventView = {
      seq: doc.nextEventSeq,
      dispatchId,
      type: 'queued',
      at: Date.now(),
    };
    const publish = (targetDoc: ExternalDelegationDocument): void => {
      targetDoc.dispatches[dispatchId] = { ...dispatch };
      if (newChild !== undefined) targetDoc.children[newChild.taskName] = { ...newChild };
      if (target.taskName !== undefined) {
        targetDoc.children[target.taskName]!.latestDispatchId = dispatchId;
      }
      if (dispatchKey !== undefined) {
        targetDoc.dispatchKeys ??= {};
        targetDoc.dispatchKeys[dispatchKey] = { fingerprint, dispatchId };
      }
      this.publishEvent(targetDoc, event);
    };
    const write = this.writeQueue
      .then(async () => {
        const candidate = structuredClone(doc);
        publish(candidate);
        await this.store.set(this.scope, STORE_KEY, candidate);
        publish(doc);
        this.changed.fire();
      });
    this.writeQueue = write.catch(() => {});
    await write;
    reservation.commit(dispatchId);
    this.syncInteractionConsumer(doc);
    if (target.taskName !== undefined) {
      void this.dispatchDomain.recordRun(target.agentId, dispatchId).catch((error: unknown) => {
        this.log.error('Failed to record external dispatch run.', {
          dispatchId,
          sessionId: this.sessionId,
          agentId: target.agentId,
          error,
        });
      });
    }
  }

  private trackExecutionSettlement(dispatchId: string, dispatchRun: DispatchRun): void {
    this.executionSettled.set(
      dispatchId,
      dispatchRun.started.then(
        (run) => run.completion.then(
          () => this.captureTranscriptBoundary(dispatchRun.child.agent, run.turn.id),
          () => this.captureTranscriptBoundary(dispatchRun.child.agent, run.turn.id),
        ),
        () => undefined,
      ),
    );
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
      dispatch.transcriptTurnId = run.turn.id;
      this.appendEvent(doc, dispatchId, 'started');
      void run.completion.then(
        (result) => {
          const boundary = this.captureTranscriptBoundary(dispatchRun.child.agent, run.turn.id);
          return this.finish(
            dispatchId,
            'completed',
            result.summary,
            undefined,
            undefined,
            result.usage,
            boundary,
          );
        },
        (error) => {
          const boundary = this.captureTranscriptBoundary(dispatchRun.child.agent, run.turn.id);
          if (controller.signal.aborted) {
            return this.finish(
              dispatchId,
              'cancelled',
              undefined,
              'Cancelled',
              undefined,
              undefined,
              boundary,
            );
          }
          return this.failDispatch(dispatchId, error, boundary);
        },
      );
      await this.persist();
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
  private async failDispatch(
    dispatchId: string,
    error: unknown,
    boundary?: DispatchTranscriptBoundary,
  ): Promise<void> {
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
    await this.finish(
      dispatchId,
      'failed',
      undefined,
      externalFailureDescription(category),
      category,
      undefined,
      boundary,
    );
  }

  private async finish(
    dispatchId: string,
    status: Extract<ExternalDispatchStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    result?: string,
    error?: string,
    errorCode?: ExternalFailureCategory,
    usage?: TokenUsage,
    boundary?: DispatchTranscriptBoundary,
  ): Promise<void> {
    const claimed = this.terminalizations.get(dispatchId);
    if (claimed !== undefined) return;
    const doc = this.document;
    const dispatch = doc?.dispatches[dispatchId];
    if (doc === undefined || dispatch === undefined || !ACTIVE.has(dispatch.status)) return;
    if (boundary !== undefined) {
      dispatch.transcriptTurnId = boundary.turnId;
      dispatch.legacyTranscriptEnd = boundary.legacyTranscriptEnd;
    }
    dispatch.status = status;
    dispatch.endedAt = Date.now();
    dispatch.result = result;
    dispatch.error = error === undefined ? undefined : safeFailureText(error);
    dispatch.errorCode = errorCode;
    dispatch.usage = usage;
    this.controllers.delete(dispatchId);
    this.appendEvent(doc, dispatchId, status, dispatch.error);
    this.syncInteractionConsumer(doc);
    const published = this.persist();
    const terminalization = (async () => {
      const settledBoundary = await this.executionSettled.get(dispatchId);
      const terminalBoundary = boundary ?? settledBoundary;
      if (terminalBoundary !== undefined) {
        dispatch.transcriptTurnId = terminalBoundary.turnId;
        dispatch.legacyTranscriptEnd = terminalBoundary.legacyTranscriptEnd;
      }
      await this.captureTranscriptEnd(doc, dispatch, terminalBoundary);
      await published;
      await this.persist();
    })();
    this.terminalizations.set(dispatchId, terminalization);
    void terminalization.then(
      () => {
        this.executionSettled.delete(dispatchId);
        this.terminalizations.delete(dispatchId);
      },
      () => this.executionSettled.delete(dispatchId),
    );
    await published;
  }

  private async interruptActive(message: string): Promise<void> {
    const doc = this.document;
    if (doc === undefined) return;
    const claimed: string[] = [];
    for (const dispatch of Object.values(doc.dispatches)) {
      if (!ACTIVE.has(dispatch.status)) continue;
      claimed.push(dispatch.dispatchId);
      await this.finish(dispatch.dispatchId, 'interrupted', undefined, message);
    }
    await Promise.all(claimed.map((dispatchId) => this.terminalizations.get(dispatchId)));
  }

  private appendEvent(
    doc: ExternalDelegationDocument,
    dispatchId: string,
    type: ExternalEventView['type'],
    message?: string,
  ): void {
    this.publishEvent(doc, { seq: doc.nextEventSeq, dispatchId, type, at: Date.now(), message });
  }

  private publishEvent(doc: ExternalDelegationDocument, event: ExternalEventView): void {
    doc.nextEventSeq = Math.max(doc.nextEventSeq, event.seq + 1);
    const index = doc.events.findIndex((candidate) => candidate.seq > event.seq);
    if (index === -1) doc.events.push(event);
    else doc.events.splice(index, 0, event);
    if (doc.events.length > 5_000) {
      doc.events.splice(0, doc.events.length - 5_000);
      doc.truncatedBeforeEventSeq = doc.events[0]!.seq;
    }
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

  private ownedInteractionEntries(
    doc: ExternalDelegationDocument,
    dispatchId?: string,
  ): readonly { readonly interaction: Interaction; readonly dispatch: StoredDispatch }[] {
    return this.interaction
      .listPending()
      .filter((interaction) => interaction.kind === 'approval' || interaction.kind === 'question')
      .flatMap((interaction) => {
        const agentId = interaction.origin.agentId;
        if (agentId === undefined) return [];
        const dispatch = this.owningDispatch(doc, agentId, dispatchId);
        return dispatch === undefined ? [] : [{ interaction, dispatch }];
      })
      .toSorted((left, right) =>
        left.interaction.createdAt - right.interaction.createdAt ||
        left.interaction.id.localeCompare(right.interaction.id),
      );
  }

  private owningDispatch(
    doc: ExternalDelegationDocument,
    agentId: string,
    dispatchId?: string,
  ): StoredDispatch | undefined {
    const roots = new Map(
      Object.values(doc.dispatches)
        .filter((dispatch) => ACTIVE.has(dispatch.status))
        .filter((dispatch) => dispatchId === undefined || dispatch.dispatchId === dispatchId)
        .map((dispatch) => [dispatch.agentId, dispatch]),
    );
    const seen = new Set<string>();
    let current: string | undefined = agentId;
    while (current !== undefined && !seen.has(current)) {
      const dispatch = roots.get(current);
      if (dispatch !== undefined) return dispatch;
      seen.add(current);
      current = this.dispatchDomain.parentAgentId(current);
    }
    return undefined;
  }

  private requireOwnedInteraction(
    doc: ExternalDelegationDocument,
    interactionId: string,
  ): Interaction {
    const interaction = this.ownedInteractionEntries(doc)
      .find((entry) => entry.interaction.id === interactionId)?.interaction;
    if (interaction === undefined) throw interactionNotOwned();
    return interaction;
  }

  private syncInteractionConsumer(doc: ExternalDelegationDocument): void {
    const active = Object.values(doc.dispatches).some((dispatch) => ACTIVE.has(dispatch.status));
    if (active === this.interactionConsumerActive) return;
    if (active) {
      this.interaction.acquireConsumer(this.interactionConsumerId, {
        kind: 'agent_subtrees',
        roots: () => new Set(
          Object.values(this.document?.dispatches ?? {})
            .filter((dispatch) => ACTIVE.has(dispatch.status))
            .map((dispatch) => dispatch.agentId),
        ),
        parent: (agentId) => this.dispatchDomain.parentAgentId(agentId),
      });
      this.interactionConsumerActive = true;
    } else {
      this.releaseInteractionConsumer();
    }
  }

  private releaseInteractionConsumer(): void {
    if (!this.interactionConsumerActive) return;
    this.interactionConsumerActive = false;
    this.interaction.releaseConsumer(this.interactionConsumerId);
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

function interactionView(
  interaction: Interaction,
  dispatch: StoredDispatch,
): ExternalInteractionView {
  return {
    interactionId: interaction.id,
    kind: interaction.kind as 'approval' | 'question',
    taskName: dispatch.taskName ?? MAIN_AGENT_ID,
    payload: interaction.payload,
    createdAt: interaction.createdAt,
  };
}

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

function isApprovalResponse(value: unknown): value is ApprovalResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ['decision', 'scope', 'feedback', 'selectedLabel', 'selectedOptionId'])) {
    return false;
  }
  if (value['decision'] !== 'approved' && value['decision'] !== 'rejected' && value['decision'] !== 'cancelled') {
    return false;
  }
  return (value['scope'] === undefined || value['scope'] === 'session') &&
    (value['feedback'] === undefined || typeof value['feedback'] === 'string') &&
    (value['selectedLabel'] === undefined || typeof value['selectedLabel'] === 'string') &&
    (value['selectedOptionId'] === undefined || typeof value['selectedOptionId'] === 'string');
}

function isQuestionResult(value: unknown): value is QuestionResult {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (isQuestionAnswers(value)) return true;
  if (!hasOnlyKeys(value, ['answers', 'method']) || !isQuestionAnswers(value['answers'])) return false;
  return value['method'] === undefined ||
    value['method'] === 'enter' ||
    value['method'] === 'space' ||
    value['method'] === 'number_key';
}

function isQuestionAnswers(value: unknown): value is Record<string, string | true> {
  return isRecord(value) && Object.values(value).every((answer) => typeof answer === 'string' || answer === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const admitted = new Set(keys);
  return Object.keys(value).every((key) => admitted.has(key));
}

function interactionNotOwned(): Error2 {
  return new Error2(
    EXTERNAL_INTERACTION_NOT_OWNED_CODE as ErrorCode,
    'Interaction is not owned by this delegation.',
    { details: { failure_code: EXTERNAL_INTERACTION_NOT_OWNED_CODE } },
  );
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
