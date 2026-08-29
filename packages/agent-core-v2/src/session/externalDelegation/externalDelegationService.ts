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
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes, isError2, toKimiErrorPayload } from '#/errors';
import { IFlagService } from '#/app/flag/flag';
import { IConfigService } from '#/app/config/config';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  listAvailableSubagentTargets,
  resolveSnapshotProfileDefinition,
  resolveSubagentTarget,
  type ResolvedSubagentTarget,
} from '#/app/agentProfileCatalog/subagentDispatch';
import {
  aliasIdentity,
  applyLease,
  applySpawnPolicy,
  fillLeasePins,
  spawnConstraintOrigin,
} from '#/app/agentProfileCatalog/applySubagentLease';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ILogService } from '#/_base/log/log';
import { IModelService } from '#/kosong/model/model';
import { IAgentCollaborationRegistry } from '#/session/agentCollaboration/registry';
import {
  canonicalizeSubagentBinding,
  resolveSubagentBinding,
} from '#/session/subagent/configSection';
import { roleConstraintsFromProfile } from '#/session/subagent/modelConstraints';

import { EXTERNAL_DELEGATION_FLAG_ID } from './flag';
import {
  classifyExternalFailureCode,
  externalFailureDescription,
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

interface StoredDispatch extends Omit<ExternalDispatchView, 'status' | 'startedAt' | 'endedAt'> {
  agentId: string;
  status: ExternalDispatchStatus;
  startedAt?: number;
  endedAt?: number;
  transcriptStart: number;
  result?: string;
  error?: string;
  errorCode?: ExternalFailureCategory;
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
  private document: ExternalDelegationDocument | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ISessionContext session: ISessionContext,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionSubagentService private readonly runs: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ILogService private readonly log: ILogService,
    @IAgentCollaborationRegistry private readonly names: IAgentCollaborationRegistry,
    @ISessionManager lifecycle: ISessionManager,
    @IModelService private readonly models: IModelService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.scope = session.scope('external-delegation');
    this.sessionId = session.sessionId;
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
    const dispatchables = available.profiles.map((profile) => ({
      kind: 'named' as const,
      profileName: profile.name,
      description: profile.description,
    }));
    return {
      version: 1,
      delegationId: doc.delegationId,
      lifecycle: doc.lifecycle,
      dispatchables: [{ kind: 'main' }, ...dispatchables],
      children: Object.values(doc.children).map(childView).toSorted((a, b) => a.taskName.localeCompare(b.taskName)),
      continuations: Object.values(doc.dispatches).filter((dispatch) => !ACTIVE.has(dispatch.status)).map(dispatchView),
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
      const target =
        request.target === 'main'
          ? targetView(this.requireMain(), undefined, undefined)
          : await this.namedTarget(
              doc,
              request.taskName,
              request.profileName,
              request.modelAlias,
              request.thinkingEffort,
            );
      return this.startDispatch(doc, target, message, undefined);
    });
  }

  async continue(request: ExternalContinueRequest): Promise<ExternalDispatchView> {
    return this.exclusive(async () => {
      const message = requireNonblank(request.message, 'message');
      const doc = await this.authorize(request.authority);
      const previous = this.lookup(doc, request.dispatchId);
      if (ACTIVE.has(previous.status)) throw invalid('Cannot continue an active dispatch.');
      const target =
        previous.target === 'main'
          ? targetView(this.requireMain(), undefined, undefined)
          : await this.existingNamedTarget(doc, previous.taskName!);
      return this.startDispatch(doc, target, message, previous.dispatchId);
    });
  }

  async status(request: ExternalDispatchLookup): Promise<ExternalDispatchView> {
    const doc = await this.authorize(request.authority);
    return dispatchView(this.lookup(doc, request.dispatchId));
  }

  async result(request: ExternalPageLookup): Promise<ExternalResultPage> {
    const doc = await this.authorize(request.authority);
    const dispatch = this.lookup(doc, request.dispatchId);
    const text = dispatch.result ?? dispatch.error ?? '';
    const cursor = boundedCursor(request.cursor, text.length);
    const limit = boundedLimit(request.limit, 16_384);
    const end = Math.min(text.length, cursor + limit);
    return { dispatch: dispatchView(dispatch), text: text.slice(cursor, end), nextCursor: end < text.length ? end : undefined };
  }

  async events(request: ExternalPageLookup): Promise<ExternalEventPage> {
    const doc = await this.authorize(request.authority);
    this.lookup(doc, request.dispatchId);
    const cursor = boundedCursor(request.cursor, Number.MAX_SAFE_INTEGER);
    const limit = boundedLimit(request.limit, 100);
    const matches = doc.events.filter((event) => event.dispatchId === request.dispatchId && event.seq > cursor);
    const items = matches.slice(0, limit);
    return { items, nextCursor: matches.length > items.length ? items.at(-1)?.seq : undefined };
  }

  async transcript(request: ExternalPageLookup): Promise<ExternalTranscriptPage> {
    const doc = await this.authorize(request.authority);
    const dispatch = this.lookup(doc, request.dispatchId);
    const handle = await this.materialize(dispatch.agentId, dispatch.taskName);
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

  private async namedTarget(
    doc: ExternalDelegationDocument,
    rawTaskName: string | undefined,
    rawProfileName: string | undefined,
    rawModelAlias: string | undefined,
    rawThinkingEffort: string | undefined,
  ): Promise<DispatchTarget> {
    const taskName = rawTaskName?.trim();
    if (taskName === undefined || !TASK_NAME.test(taskName)) throw invalid('task_name must match [a-z0-9_]+ and must not be root.');
    const modelAlias = optionalNonblank(rawModelAlias, 'model_alias');
    const thinkingEffort = optionalNonblank(rawThinkingEffort, 'thinking_effort');
    const existing = doc.children[taskName];
    if (existing !== undefined) {
      if (rawProfileName !== undefined && rawProfileName !== existing.profileName) throw invalid('A named child cannot change profile.');
      const target = await this.existingNamedTarget(doc, taskName);
      if (modelAlias !== undefined && modelAlias !== target.modelAlias) {
        throw invalid('A named child cannot change model_alias.');
      }
      if (thinkingEffort !== undefined && thinkingEffort !== target.thinkingEffort) {
        throw invalid('A named child cannot change thinking_effort.');
      }
      return target;
    }
    const profileName = requireNonblank(rawProfileName, 'profile_name');
    await this.profiles.ready;
    const main = this.requireMain();
    const mainProfile = main.accessor.get(IAgentProfileService);
    const mainData = mainProfile.data();
    if (mainData.modelAlias === undefined) throw invalid('Main agent has no configured model.');
    const snapshot = this.profiles.snapshot?.();
    let target: ResolvedSubagentTarget;
    try {
      target = resolveSubagentTarget(
        this.profiles,
        mainData,
        { profileName, snapshot },
        this.models,
      );
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.PROFILE_UNKNOWN) {
        throw invalid('Unknown named-agent profile.');
      }
      if (isError2(error) && error.code === ErrorCodes.AGENT_TYPE_NOT_ALLOWED) {
        throw invalid('Named-agent profile is not admitted.');
      }
      throw error;
    }
    const selection = target.selection;
    const profile = target.effectiveProfile;
    if ((profile.executor ?? 'native') !== 'native') {
      throw invalid('External executors are unsupported for external delegation.');
    }
    const filled = fillLeasePins(
      { modelAlias, thinkingEffort },
      target.lease,
    );
    const binding = canonicalizeSubagentBinding(
      resolveSubagentBinding(
        this.config,
        filled,
        {
          modelAlias: profile.modelAlias,
          thinkingEffort: profile.thinkingEffort,
        },
        this.models,
        roleConstraintsFromProfile(
          profile,
          spawnConstraintOrigin(target.lease, target.spawnPolicy),
        ),
        { profileName: profile.name, routeId: selection.route?.id },
      ),
      this.models,
    );
    const delegator = { kind: 'external' as const, delegationId: doc.delegationId };
    if (!(await this.names.reserve(taskName, delegator))) throw invalid('Named child task_name is already reserved.');
    const runtimeLease = main.accessor.get(IAgentRuntimeService).acquire(['process']);
    try {
      const child = await this.agents.create({
        binding: {
          profile: selection.baseProfile.name,
          route: selection.route?.id,
          resolvedProfile: selection.baseProfile,
          resolvedRoute: selection.route,
          model: binding.model,
          thinking: binding.thinking,
          strictThinking:
            filled.thinkingEffort !== undefined ||
            profile.thinkingEffort !== undefined,
          lease: target.lease,
          spawnPolicy: target.spawnPolicy,
        },
        runtimeId: runtimeLease.runtime.identity.runtimeId,
        delegator,
        labels: {
          externalDelegationTaskName: taskName,
          externalDelegationProfile: profile.name,
        },
      });
      child.accessor.get(IAgentPermissionModeService).setMode(main.accessor.get(IAgentPermissionModeService).mode);
      child.accessor.get(IAgentUserToolService).inheritUserTools(main.accessor.get(IAgentUserToolService));
      doc.children[taskName] = { taskName, agentId: child.id, profileName: profile.name, createdAt: Date.now() };
      await this.persist();
      this.names.commit(taskName, delegator);
      return targetView(child, taskName, profile.name, profile);
    } catch (error) {
      this.names.release(taskName, delegator);
      throw error;
    } finally {
      runtimeLease.dispose();
    }
  }

  private async existingNamedTarget(
    doc: ExternalDelegationDocument,
    taskName: string,
  ): Promise<DispatchTarget> {
    const child = doc.children[taskName];
    if (child === undefined) throw invalid('Unknown named child.');
    const agent = await this.materialize(child.agentId, taskName);
    const profile = this.resolveTargetProfile(agent, child.profileName);
    if (profile === undefined) throw invalid('Named-agent profile is unavailable.');
    return targetView(agent, taskName, child.profileName, profile);
  }

  private resolveTargetProfile(
    agent: IAgentScopeHandle,
    fallbackProfileName: string,
  ): AgentProfile | undefined {
    const data = agent.accessor.get(IAgentProfileService).data();
    const profileName = data.profileName ?? fallbackProfileName;
    const snapshot = this.profiles.snapshot?.();
    const base =
      data.profileDefinitionId === undefined
        ? this.profiles.get(profileName)
        : snapshot === undefined
          ? undefined
          : resolveSnapshotProfileDefinition(snapshot, data.profileDefinitionId, profileName);
    if (base === undefined) return undefined;
    const resolveId = aliasIdentity(this.models);
    return applySpawnPolicy(
      applyLease(base, data.appliedLease, resolveId),
      data.spawnPolicy,
      resolveId,
    );
  }

  private async materialize(agentId: string, taskName: string | undefined): Promise<IAgentScopeHandle> {
    const live = this.agents.get(agentId);
    if (live !== undefined) return live;
    const meta = (await this.metadata.read()).agents?.[agentId];
    if (meta === undefined || meta.delegator?.kind !== 'external') throw invalid('Owned agent metadata is unavailable.');
    if (taskName !== undefined && meta.labels?.['externalDelegationTaskName'] !== taskName) throw invalid('Owned agent metadata does not match the named child.');
    return this.agents.create({ agentId, labels: labelsFromAgentMeta(meta), delegator: meta.delegator });
  }

  private async startDispatch(
    doc: ExternalDelegationDocument,
    target: DispatchTarget,
    rawMessage: string,
    continuationOf: string | undefined,
  ): Promise<ExternalDispatchView> {
    const active = Object.values(doc.dispatches).find(
      (dispatch) => dispatch.agentId === target.agent.id && ACTIVE.has(dispatch.status),
    );
    if (active !== undefined) throw invalid('The target already has an active dispatch.');
    const loop = target.agent.accessor.get(IAgentLoopService).status();
    if (loop.state !== 'idle' || loop.pendingTurnIds.length > 0 || loop.hasPendingRequests) {
      throw invalid('The target is already running work.');
    }
    let message = rawMessage;
    if (target.profile !== undefined) {
      const lease = target.agent.accessor.get(IAgentRuntimeService).acquire(['process']);
      try {
        const view = new RuntimeWorkspaceView(lease.runtime, this.workspace);
        message = await applyProfilePromptPrefix(target.profile, rawMessage, {
          cwd: view.workDir,
          process: lease.runtime.process!,
          log: this.log,
        });
      } finally {
        lease.dispose();
      }
    }
    const dispatchId = `dispatch_${ulid()}`;
    const dispatch: StoredDispatch = {
      dispatchId,
      target: target.taskName === undefined ? 'main' : 'named',
      taskName: target.taskName,
      profileName: target.profileName,
      modelAlias: target.modelAlias,
      thinkingEffort: target.thinkingEffort,
      agentId: target.agent.id,
      status: 'queued',
      createdAt: Date.now(),
      continuationOf,
      transcriptStart: target.agent.accessor.get(IAgentContextMemoryService).get().length,
    };
    doc.dispatches[dispatchId] = dispatch;
    if (target.taskName !== undefined) doc.children[target.taskName]!.latestDispatchId = dispatchId;
    this.appendEvent(doc, dispatchId, 'queued');
    await this.persist();
    const controller = new AbortController();
    this.controllers.set(dispatchId, controller);
    void this.launchDispatch(dispatchId, target.agent.id, message, controller);
    return dispatchView(dispatch);
  }

  private async launchDispatch(
    dispatchId: string,
    agentId: string,
    message: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const run = await this.runs.run(agentId, { kind: 'prompt', prompt: message }, { signal: controller.signal });
      const doc = this.document;
      const dispatch = doc?.dispatches[dispatchId];
      if (doc === undefined || dispatch === undefined || dispatch.status !== 'queued' || controller.signal.aborted) {
        // Observe the discarded handle so a provider rejection cannot become
        // an unhandled promise after cancellation won the persisted race.
        void run.completion.catch(() => undefined);
        return;
      }
      dispatch.status = 'running';
      dispatch.startedAt = Date.now();
      this.appendEvent(doc, dispatchId, 'started');
      await this.persist();
      void run.completion.then(
        (result) => this.finish(dispatchId, 'completed', result.summary),
        (error) => {
          if (controller.signal.aborted) return this.finish(dispatchId, 'cancelled', undefined, 'Cancelled');
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
  ): Promise<void> {
    const doc = this.document;
    const dispatch = doc?.dispatches[dispatchId];
    if (doc === undefined || dispatch === undefined || !ACTIVE.has(dispatch.status)) return;
    dispatch.status = status;
    dispatch.endedAt = Date.now();
    dispatch.result = result;
    dispatch.error = error === undefined ? undefined : safeFailureText(error);
    dispatch.errorCode = errorCode;
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
    const write = this.writeQueue.then(() => this.store.set(this.scope, STORE_KEY, doc));
    this.writeQueue = write.catch(() => {});
    return write;
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

function childView(child: StoredChild): ExternalChildView {
  return { taskName: child.taskName, profileName: child.profileName, latestDispatchId: child.latestDispatchId };
}

function dispatchView(dispatch: StoredDispatch): ExternalDispatchView {
  return {
    dispatchId: dispatch.dispatchId,
    target: dispatch.target,
    taskName: dispatch.taskName,
    profileName: dispatch.profileName,
    modelAlias: dispatch.modelAlias,
    thinkingEffort: dispatch.thinkingEffort,
    status: dispatch.status,
    createdAt: dispatch.createdAt,
    startedAt: dispatch.startedAt,
    endedAt: dispatch.endedAt,
    continuationOf: dispatch.continuationOf,
    errorCode: dispatch.errorCode,
  };
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

function requireNonblank(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) throw invalid(`${name} must not be blank.`);
  return trimmed;
}

function optionalNonblank(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : requireNonblank(value, name);
}

interface DispatchTarget {
  readonly agent: IAgentScopeHandle;
  readonly taskName: string | undefined;
  readonly profileName: string | undefined;
  readonly profile?: AgentProfile;
  readonly modelAlias: string;
  readonly thinkingEffort: string;
}

function targetView(
  agent: IAgentScopeHandle,
  taskName: string | undefined,
  profileName: string | undefined,
  profile?: AgentProfile,
): DispatchTarget {
  const binding = agent.accessor.get(IAgentProfileService).data();
  if (binding.modelAlias === undefined) throw invalid('Target agent has no configured model.');
  return {
    agent,
    taskName,
    profileName,
    profile,
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

function boundedLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > fallback) throw invalid('limit is invalid.');
  return limit;
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
