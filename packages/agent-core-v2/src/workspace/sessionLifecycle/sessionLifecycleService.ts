import { createHash, randomUUID } from 'node:crypto';

import { join } from 'pathe';
import { ulid } from 'ulid';

import type { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { AsyncEmitter, Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { drainLogCloses } from '#/_base/log/logService';
import { DEFAULT_PLAN_MODE_SECTION } from '#/features/plan/configSection';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLoopService } from '#/agent/loop/loop';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  CREATED_BY_AGENT_ID_KEY,
  CREATED_BY_SESSION_ID_KEY,
  ISessionIndex,
  ISessionIndexMirror,
  PARENT_SESSION_ID_KEY,
  type SessionUsageSummary,
} from '#/app/sessionIndex/sessionIndex';
import { IRetainedUsageService } from '#/app/retainedUsage/retainedUsage';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import {
  type AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IFileSystemStorageService,
  type IStorageLock,
} from '#/persistence/interface/storage';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IAgentUsageService } from '#/agent/usage/usage';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { sessionEphemeralMcpServersSeed } from '#/session/mcp/ephemeralMcpServers';
import { sessionAgentProfileCatalogSeed } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
import { externalClientMetaOf, ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { ISessionHookWorkspace } from '#/features/externalHooks/session/hookRules';
import { drainSessionMetadataWrites, toEpochMs } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionTerminalService } from '#/session/terminal/terminalService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  type WireRecord,
} from '#/wire/record';
import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { repairWireJournal } from '#/wire/repair';
import { WIRE_TRANSCRIPT_RECEIPT_KEY } from '#/wire/transcriptReceipt';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import {
  IExplicitAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import {
  IExtraAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import {
  IWorkspaceAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { externalAcpForkRecords } from './internal/externalFork';
import { externalMaterialForkRecords } from './internal/externalMaterialFork';
import { IWorkspaceSkillCatalog } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalog';
import { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import { PLUGIN_SKILL_SOURCE_ID } from '#/app/skillCatalog/skillSource';
import { IPluginService } from '#/app/plugin/plugin';

import { agentScopeOf, sessionDirOf, sessionScopeOf } from './internal/addressing';
import { SessionArchived } from './sessionLifecycleEvents';
import {
  assertForkTurnIndex,
  sliceMainRecordsAtTurn,
  sliceSubagentRecordsAtTime,
} from './internal/forkTurnSlice';
import {
  type CreateChildSessionOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type ResumeSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  type SessionWillCloseEvent,
  type SessionWillCreateEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';

type MaterializeSessionOptions = Omit<CreateSessionOptions, 'sessionId'> & {
  readonly sessionId: string;
  readonly rollbackOnMaterializationFailure?: boolean;
};

const NO_ABORT = new AbortController().signal;
const SESSION_LOCK_SCOPE = 'session-locks';
const CHECKPOINT_IDLE_DELAY_MS = 1_000;

const SESSION_CREATE_RELOAD_SKILL_SOURCES: readonly string[] = [
  'user',
  'explicit',
  'extra',
  PLUGIN_SKILL_SOURCE_ID,
];

function addUsageByModel(
  target: Record<string, TokenUsage>,
  byModel: Readonly<Record<string, TokenUsage>> | undefined,
): TokenUsage | undefined {
  if (byModel === undefined) return undefined;
  let total: TokenUsage | undefined;
  for (const [model, usage] of Object.entries(byModel)) {
    target[model] = target[model] === undefined ? { ...usage } : addUsage(target[model], usage);
    total = total === undefined ? { ...usage } : addUsage(total, usage);
  }
  return total;
}

function aggregateSessionUsage(handle: ISessionScopeHandle): SessionUsageSummary | undefined {
  let total: TokenUsage | undefined;
  const byModel: Record<string, TokenUsage> = {};
  for (const agent of handle.accessor.get(IAgentLifecycleService).list()) {
    try {
      const status = agent.accessor.get(IAgentUsageService).status();
      const byModelTotal = addUsageByModel(byModel, status.byModel);
      const agentTotal = status.total ?? byModelTotal;
      if (agentTotal !== undefined) {
        total = total === undefined ? { ...agentTotal } : addUsage(total, agentTotal);
      }
    } catch {}
  }
  if (total === undefined) return undefined;
  return {
    total,
    byModel: Object.keys(byModel).length === 0 ? undefined : byModel,
    wireComplete: true,
  };
}

export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly _onWillCreateSession = this._register(
    new Emitter<SessionWillCreateEvent>(),
  );
  readonly onWillCreateSession: Event<SessionWillCreateEvent> =
    this._onWillCreateSession.event;
  private readonly _onDidCreateSession = this._register(
    new AsyncEmitter<SessionCreatedEvent & IWaitUntil>(),
  );
  readonly onDidCreateSession: Event<SessionCreatedEvent & IWaitUntil> =
    this._onDidCreateSession.event;
  private readonly _onWillCloseSession = this._register(
    new AsyncEmitter<SessionWillCloseEvent & IWaitUntil>(),
  );
  readonly onWillCloseSession: Event<SessionWillCloseEvent & IWaitUntil> =
    this._onWillCloseSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  private readonly sessionLocks = new Map<string, IStorageLock>();
  private readonly lockReleases = new Map<string, Promise<void>>();
  private readonly deferredSessionLockReleases = new Set<string>();
  private readonly resumeFailures = new Map<string, Error>();
  private readonly ephemeralSessions = new Set<string>();
  private readonly checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly checkpointSaves = new Map<string, Promise<boolean>>();
  private readonly checkpointSubscriptions = new Map<string, IDisposable>();

  constructor(
    private readonly instantiation: IInstantiationService,
    @IWorkspaceContext private readonly workspaceContext: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly indexMirror: ISessionIndexMirror,
    @IRetainedUsageService private readonly retainedUsage: IRetainedUsageService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly log: ILogService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ICronTaskPersistence private readonly cronStore: ICronTaskPersistence,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWorkspaceAgentProfileLoader
    private readonly workspaceAgentProfileLoader: IWorkspaceAgentProfileLoader,
    @IExtraAgentProfileLoader
    private readonly extraAgentProfileLoader: IExtraAgentProfileLoader,
    @IExplicitAgentProfileLoader
    private readonly explicitAgentProfileLoader: IExplicitAgentProfileLoader,
    @IUserAgentProfileLoader
    private readonly userAgentProfileLoader: IUserAgentProfileLoader,
    @IPluginAgentProfileLoader
    private readonly pluginAgentProfileLoader: IPluginAgentProfileLoader,
    @IWorkspaceDirs private readonly workspaceDirs: IWorkspaceDirs,
    @IWorkspaceSkillCatalog private readonly workspaceSkillCatalog: IWorkspaceSkillCatalog,
    @IWorkspaceInstructionsService private readonly workspaceInstructions: IWorkspaceInstructionsService,
    @IWorkspaceMcpService private readonly workspaceMcp: IWorkspaceMcpService,
    @IPluginService private readonly plugins: IPluginService,
    @IModelService private readonly models: IModelService,
    @IProviderService private readonly providers: IProviderService,
    private readonly acquireWorkspaceReference: () => IDisposable,
    onDispose?: () => void,
    private readonly hookWorkspace?: ISessionHookWorkspace,
  ) {
    super();
    if (onDispose !== undefined) this._register({ dispose: onDispose });
    this._register({
      dispose: () => {
        for (const sessionId of this.sessionLocks.keys()) void this.releaseSessionLock(sessionId);
      },
    });
  }

  override dispose(): void {
    for (const timer of this.checkpointTimers.values()) clearTimeout(timer);
    this.checkpointTimers.clear();
    for (const subscription of this.checkpointSubscriptions.values()) subscription.dispose();
    this.checkpointSubscriptions.clear();
    this.checkpointSaves.clear();
    for (const [sessionId, handle] of [...this.sessions].reverse()) {
      this.sessions.delete(sessionId);
      handle.dispose();
    }
    super.dispose();
  }

  private get workspaceId(): string {
    return this.workspaceContext.workspaceId;
  }

  private get handlerScope(): string {
    return this.workspaceContext.persistenceScope;
  }

  private sessionScope(sessionId: string): string {
    const root = this.ephemeralSessions.has(sessionId)
      ? `${this.bootstrap.scope('ephemeral')}/${this.workspaceId}`
      : this.handlerScope;
    return sessionScopeOf(root, sessionId);
  }

  private async acquireSessionLock(sessionId: string, waitForSessionMs = 0): Promise<void> {
    if (this.sessionLocks.has(sessionId)) return;
    const releasing = this.lockReleases.get(sessionId);
    if (releasing !== undefined) await releasing;
    const lockKey = `${createHash('sha256')
      .update(this.sessionScope(sessionId))
      .digest('hex')}.lock`;
    const lock = await this.storage.acquireLock(SESSION_LOCK_SCOPE, lockKey, {
      waitForMs: Math.max(0, waitForSessionMs),
      owner: {
        sessionId,
        workspaceId: this.workspaceId,
        scope: this.sessionScope(sessionId),
      },
    });
    this.sessionLocks.set(sessionId, lock);
  }

  private releaseSessionLock(sessionId: string): Promise<void> {
    if (this.deferredSessionLockReleases.has(sessionId)) return Promise.resolve();
    const releasing = this.lockReleases.get(sessionId);
    if (releasing !== undefined) return releasing;
    const lock = this.sessionLocks.get(sessionId);
    if (lock === undefined) return Promise.resolve();
    this.sessionLocks.delete(sessionId);
    const promise = lock.release().finally(() => this.lockReleases.delete(sessionId));
    this.lockReleases.set(sessionId, promise);
    return promise;
  }

  private async assertNewSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId) || (await this.index.get(sessionId)) !== undefined) {
      throw new Error2(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${sessionId}" already exists`);
    }
    for (const scope of new Set([this.sessionScope(sessionId), sessionScopeOf(this.handlerScope, sessionId)])) {
      try {
        await this.hostFs.stat(join(this.bootstrap.homeDir, scope));
      } catch (error) {
        if (isMissingFileError(error)) continue;
        throw error;
      }
      throw new Error2(ErrorCodes.SESSION_ALREADY_EXISTS, `Session "${sessionId}" already exists`);
    }
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    if (opts.localSession !== undefined && (sessionId.startsWith('external:') || sessionId === opts.localSession.externalId)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'External source IDs cannot be used as Kiki session IDs');
    }
    await this.assertNewSession(sessionId);
    if (opts.ephemeral === true) this.ephemeralSessions.add(sessionId);
    await this.workspaceSkillCatalog
      .reloadSources(SESSION_CREATE_RELOAD_SKILL_SOURCES)
      .catch(() => undefined);
    let handle: ISessionScopeHandle;
    try {
      handle = await this.materializeSession({
        ...opts,
        sessionId,
        rollbackOnMaterializationFailure: true,
      });
    } catch (error) {
      this.ephemeralSessions.delete(sessionId);
      throw error;
    }
    try {
      const main =
        opts.mainAgentBinding === undefined && opts.delivery === undefined
          ? undefined
          : await handle.accessor.get(IAgentLifecycleService).create({
              agentId: MAIN_AGENT_ID,
              binding: opts.mainAgentBinding,
            });
      if (main !== undefined || opts.delivery !== undefined) {
        const delivery = handle.accessor.get(ISessionDeliveryService);
        const profileDelivery = main?.accessor.get(IAgentProfileService).data().persona?.definition.delivery;
        await delivery.set(opts.delivery ?? profileDelivery ?? delivery.mode());
      }
      if (this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true) {
        const planAgent = main ?? (await ensureMainAgent(handle));
        await planAgent.accessor.get(IAgentPlanService).enter();
      }
      if (opts.localSession !== undefined) {
        const agent = main ?? await ensureMainAgent(handle);
        await agent.accessor.get(IAgentExecutionService).attachLocalSession(opts.localSession);
        const metadata = handle.accessor.get(ISessionMetadata);
        const meta = await metadata.read();
        await metadata.update({ custom: { ...meta.custom, local_session: opts.localSession } }, { touchUpdatedAt: false });
      }
      if (opts.worktree !== undefined) {
        await handle.accessor.get(ISessionMetadata).update({ worktree: opts.worktree }, { touchUpdatedAt: false });
      }
      if (opts.ephemeral !== true) {
        await this.appendSessionIndexEntry(sessionId, opts.workDir, opts.worktree?.sourceRoot);
      }
    } catch (error) {
      const sessionDir = handle.accessor.get(ISessionContext).sessionDir;
      return this.rollbackSession(sessionId, handle, sessionDir, error);
    }
    await this.announceCreated({ sessionId, handle, source: 'startup' });
    return handle;
  }

  private async materializeSession(opts: MaterializeSessionOptions): Promise<ISessionScopeHandle> {
    const workspaceId = this.workspaceId;
    const sessionScope = this.sessionScope(opts.sessionId);
    const sessionDir = join(this.bootstrap.homeDir, sessionScope);
    const metaScope = sessionScope;
    await Promise.all([this.config.ready, this.models.ready, this.providers.ready]);
    await this.workspaceDirs.ready;
    await this.workspaceDirs.mergeAdditionalDirs(opts.workDir, opts.additionalDirs ?? []);
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      ephemeral: this.ephemeralSessions.has(opts.sessionId),
      metaScope,
      cwd: opts.workDir,
      scope: (subKey?: string): string =>
        subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
    };
    let workspaceReference: IDisposable | undefined;
    let handle: ISessionScopeHandle;
    try {
      await this.acquireSessionLock(opts.sessionId, opts.waitForSessionMs);
      if (opts.rollbackOnMaterializationFailure === true) await this.assertNewSession(opts.sessionId);
      workspaceReference = this.acquireWorkspaceReference();
      handle = createScopedChildHandle(
        this.instantiation,
        LifecycleScope.Session,
        opts.sessionId,
        {
          seeds: [
            ...sessionContextSeed(ctx),
            [ITelemetryService, this.telemetry.withContext({ sessionId: opts.sessionId })],
            ...sessionAgentProfileCatalogSeed({
              _serviceBrand: undefined,
              workspaceKey: workspaceId,
            }),
            [ISessionSkillCatalogData, this.workspaceSkillCatalog.sessionData()],
            [ISessionInstructionsProvider, this.workspaceInstructions.sessionProvider()],
            [ISessionContextSourceReloader, {
              _serviceBrand: undefined,
              reload: async () => {
                const beforeInstructions = JSON.stringify(this.workspaceInstructions.snapshot);
                const beforePlugins = JSON.stringify({
                  systemPrompts: await this.plugins.enabledSystemPrompts(),
                  sessionStarts: await this.plugins.enabledSessionStarts(),
                });
                await this.plugins.reloadPlugins();
                await Promise.all([
                  this.workspaceAgentProfileLoader.reload(),
                  this.extraAgentProfileLoader.reload(),
                  this.explicitAgentProfileLoader.reload(),
                  this.userAgentProfileLoader.reload(),
                  this.pluginAgentProfileLoader.reload(),
                  this.workspaceSkillCatalog.reload(),
                  this.workspaceInstructions.reload(),
                ]);
                const afterPlugins = JSON.stringify({
                  systemPrompts: await this.plugins.enabledSystemPrompts(),
                  sessionStarts: await this.plugins.enabledSessionStarts(),
                });
                return {
                  instructionsChanged: beforeInstructions !== JSON.stringify(this.workspaceInstructions.snapshot),
                  pluginsChanged: beforePlugins !== afterPlugins,
                };
              },
            }],
            [ISessionMcpHandle, this.workspaceMcp.sessionHandle()],
            [ISessionWorkspaceInfo, this.workspaceDirs.sessionInfo()],
            ...sessionEphemeralMcpServersSeed(opts.mcpServers ?? {}),
          ],
          configureContainer: (container) => {
            if (this.hookWorkspace !== undefined) container.provide(ISessionHookWorkspace, this.hookWorkspace);
            container.anchorKernelEntry(
              () => void this.releaseSessionLock(opts.sessionId),
              'sessionLifecycle:sessionLock',
            );
            container.anchorKernelEntry(
              () => workspaceReference?.dispose(),
              'sessionLifecycle:workspaceReference',
            );
            this._onWillCreateSession.fire({
              sessionId: opts.sessionId,
              readSeed: (id) => container.invokeFunction((accessor) => accessor.get(id)),
              contributeSeed: (id, value) => {
                container.provide(id, value);
              },
              onSessionDispose: (dispose) => {
                container.anchorKernelEntry(dispose, 'sessionLifecycle:willCreateParticipant');
              },
            });
          },
        },
      ) as ISessionScopeHandle;
    } catch (error) {
      workspaceReference?.dispose();
      await this.releaseSessionLock(opts.sessionId);
      throw error;
    }
    try {
      await handle.accessor.get(ISessionMetadata).ready;
      await handle.accessor.get(ISessionToolPolicy).ready;
      await Promise.all([
        this.workspaceAgentProfileLoader.ready,
        this.extraAgentProfileLoader.ready,
        this.explicitAgentProfileLoader.ready,
        this.userAgentProfileLoader.ready,
        this.pluginAgentProfileLoader.ready,
      ]);
    } catch (error) {
      void this.explicitAgentProfileLoader.reload().catch(() => undefined);
      if (opts.rollbackOnMaterializationFailure === true) {
        return this.rollbackSession(opts.sessionId, handle, sessionDir, error);
      }
      handle.dispose();
      await this.releaseSessionLock(opts.sessionId);
      throw error;
    }
    this.sessions.set(opts.sessionId, handle);
    this.installCheckpointScheduling(opts.sessionId, handle);
    return handle;
  }

  private async appendSessionIndexEntry(sessionId: string, workDir: string, sourceRoot?: string): Promise<void> {
    const sessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', {
      sessionId,
      sessionDir,
      workDir,
      ...(sourceRoot === undefined ? {} : { sourceRoot }),
    });
    await this.appendLogStore.flush();
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await this._onDidCreateSession.fireAsync(event, NO_ABORT);
    event.handle.accessor
      .get(ITelemetryService)
      .track2('session_started', { resumed: event.source === 'resume' });
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    if (this.resuming.has(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string, opts?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    this.resumeFailures.delete(sessionId);
    const promise = this.doResume(sessionId, opts)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ sessionId })
          .track2('session_load_failed', {
            reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        this.resumeFailures.set(sessionId, error instanceof Error ? error : new Error('session resume failed'));
        throw error;
      })
      .finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  async whenResumeSettled(sessionId: string): Promise<void> {
    await this.resuming.get(sessionId);
    const failure = this.resumeFailures.get(sessionId);
    if (failure !== undefined) throw failure;
  }

  private async doResume(
    sessionId: string,
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined || summary.workspaceId !== this.workspaceId) return undefined;
    const workDir = summary.cwd ?? this.workspaceContext.cwd;

    const handle = await this.materializeSession({
      sessionId,
      workDir,
      additionalDirs: opts?.additionalDirs,
      waitForSessionMs: opts?.waitForSessionMs,
      mcpServers: opts?.mcpServers,
    });
    try {
      const agents = handle.accessor.get(IAgentLifecycleService);
      if (agents.get(MAIN_AGENT_ID) === undefined) {
        await agents.create({ agentId: MAIN_AGENT_ID });
      }
      await this.announceCreated({ sessionId, handle, source: 'resume' });
    } catch (error) {
      this.sessions.delete(sessionId);
      handle.dispose();
      throw error;
    }
    return handle;
  }

  list(): readonly ISessionScopeHandle[] {
    const ready: ISessionScopeHandle[] = [];
    for (const [id, handle] of this.sessions) {
      if (!this.resuming.has(id)) ready.push(handle);
    }
    return ready;
  }

  private installCheckpointScheduling(sessionId: string, handle: ISessionScopeHandle): void {
    this.checkpointSubscriptions.get(sessionId)?.dispose();
    try {
      const activity = handle.accessor.get(ISessionActivityView);
      this.checkpointSubscriptions.set(
        sessionId,
        activity.onDidChange((event) => {
          if (event.cause !== 'turn_ended' && event.cause !== 'background') return;
          if (event.state.busy || event.state.pendingInteraction !== 'none') return;
          this.scheduleCheckpoint(sessionId, handle);
        }),
      );
    } catch {
      this.checkpointSubscriptions.delete(sessionId);
    }
  }

  private scheduleCheckpoint(sessionId: string, handle: ISessionScopeHandle): void {
    const previous = this.checkpointTimers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.checkpointTimers.delete(sessionId);
      void this.saveReplayCheckpoints(sessionId, handle).catch(() => undefined);
    }, CHECKPOINT_IDLE_DELAY_MS);
    timer.unref?.();
    this.checkpointTimers.set(sessionId, timer);
  }

  private async saveReplayCheckpoints(
    sessionId: string,
    handle: ISessionScopeHandle,
  ): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (current !== handle) return false;
    const ongoing = this.checkpointSaves.get(sessionId);
    if (ongoing !== undefined) return ongoing;
    const activity = handle.accessor.get(ISessionActivityView).state();
    if (activity.busy || activity.pendingInteraction !== 'none') return false;
    const save = this.writeReplayCheckpoints(handle);
    this.checkpointSaves.set(sessionId, save);
    try {
      return await save;
    } finally {
      if (this.checkpointSaves.get(sessionId) === save) this.checkpointSaves.delete(sessionId);
    }
  }

  private async writeReplayCheckpoints(handle: ISessionScopeHandle): Promise<boolean> {
    let saved = true;
    for (const agent of handle.accessor.get(IAgentLifecycleService).list()) {
      const dispatcher = agent.accessor.get(IEventDispatcher);
      if (dispatcher.saveReplayCheckpoint === undefined || !(await dispatcher.saveReplayCheckpoint())) {
        saved = false;
      }
    }
    return saved;
  }

  private disposeCheckpointScheduling(sessionId: string): void {
    const timer = this.checkpointTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.checkpointTimers.delete(sessionId);
    this.checkpointSubscriptions.get(sessionId)?.dispose();
    this.checkpointSubscriptions.delete(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    await this.saveReplayCheckpoints(sessionId, handle);
    this.disposeCheckpointScheduling(sessionId);
    const usageFallback = aggregateSessionUsage(handle);
    this.sessions.delete(sessionId);
    await this.drainAgents(handle);
    await this.persistUsage(handle, usageFallback);
    await this.appendLogStore.drainRetirements();
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    handle.dispose();
    await drainLogCloses();
    await this.releaseSessionLock(sessionId);
    this._onDidCloseSession.fire({ sessionId, reason: 'exit' });
  }

  async unload(sessionId: string, canCommit: () => boolean = () => true): Promise<boolean> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return false;
    const activity = handle.accessor.get(ISessionActivityView).state();
    if (activity.busy || activity.pendingInteraction !== 'none') return false;
    const agents = handle.accessor.get(IAgentLifecycleService);
    if (this.hasUnloadBlockers(handle)) return false;
    if (agents.countPendingBackgroundTasks() > 0) return false;
    if (handle.accessor.get(ISessionTerminalService).countLiveTerminals() > 0) return false;
    const externalRoot = await this.docs.get(
      join(sessionScopeOf(this.handlerScope, sessionId), 'external-delegation'),
      'root',
    );
    if (externalRoot !== undefined) return false;
    if (!(await this.saveReplayCheckpoints(sessionId, handle))) return false;
    this.disposeCheckpointScheduling(sessionId);
    const usageFallback = aggregateSessionUsage(handle);
    await this.persistUsage(handle, usageFallback);
    await this.appendLogStore.drainRetirements();
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    if (!canCommit()) return false;
    const finalActivity = handle.accessor.get(ISessionActivityView).state();
    if (finalActivity.busy || finalActivity.pendingInteraction !== 'none') return false;
    if (agents.countPendingBackgroundTasks() > 0) return false;
    if (handle.accessor.get(ISessionTerminalService).countLiveTerminals() > 0) return false;
    if (this.hasUnloadBlockers(handle)) return false;
    this.sessions.delete(sessionId);
    handle.dispose();
    await drainLogCloses();
    await this.releaseSessionLock(sessionId);
    this._onDidCloseSession.fire({ sessionId, reason: 'evict' });
    return true;
  }

  private hasUnloadBlockers(handle: ISessionScopeHandle): boolean {
    for (const agent of handle.accessor.get(IAgentLifecycleService).list()) {
      const prompts = agent.accessor.get(IAgentPromptService).list();
      if (prompts.active !== undefined || prompts.launching !== undefined || prompts.pending.length > 0 || prompts.hold !== undefined) return true;
      const loop = agent.accessor.get(IAgentLoopService).status();
      if (loop.state !== 'idle' || loop.pendingTurnIds.length > 0 || loop.hasPendingRequests) return true;
      if (agent.accessor.get(IAgentExecutionService).status().state !== 'idle') return true;
    }
    return false;
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    await meta.setArchived(true);
    await this.saveReplayCheckpoints(sessionId, handle);
    this.disposeCheckpointScheduling(sessionId);
    const usageFallback = aggregateSessionUsage(handle);
    await this.drainAgents(handle);
    await this.persistUsage(handle, usageFallback);
    await this.appendLogStore.drainRetirements();
    this.event.publish(new SessionArchived({ payload: { sessionId } }));
    await this.announceWillClose({ sessionId, handle, reason: 'archive' });
    this.sessions.delete(sessionId);
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    handle.dispose();
    await drainLogCloses();
    await this.releaseSessionLock(sessionId);
    this._onDidArchiveSession.fire({ sessionId });
  }

  async restore(
    sessionId: string,
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const handle = await this.resume(sessionId, opts);
    if (handle === undefined) return undefined;
    await handle.accessor.get(ISessionMetadata).setArchived(false);
    return handle;
  }

  async saveEphemeral(sessionId: string): Promise<void> {
    if (!this.ephemeralSessions.has(sessionId)) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `temporary session ${sessionId} does not exist`);
    }
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `temporary session ${sessionId} is closed`);
    }
    const activity = handle.accessor.get(ISessionActivityView).state();
    if (activity.busy || activity.pendingInteraction !== 'none') {
      throw new Error2(ErrorCodes.SESSION_BUSY, 'temporary session must be idle before saving');
    }
    const context = handle.accessor.get(ISessionContext);
    await this.close(sessionId);
    const meta = await this.docs.get<SessionMeta>(this.sessionScope(sessionId), 'state.json');
    if (meta === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `temporary session ${sessionId} metadata is missing`);
    await this.storage.moveDirectory(this.sessionScope(sessionId), sessionScopeOf(this.handlerScope, sessionId));
    this.ephemeralSessions.delete(sessionId);
    this.indexMirror.record({
      id: sessionId,
      workspaceId: this.workspaceId,
      cwd: context.cwd,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      archivedAt: meta.archivedAt,
      custom: meta.custom,
      lastTurnReason: meta.lastTurnReason,
      usage: meta.usage,
      worktree: meta.worktree,
    });
    await this.appendSessionIndexEntry(sessionId, context.cwd, meta.worktree?.sourceRoot);
  }

  async delete(sessionId: string, onRemoved?: () => void): Promise<void> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) {
      await inflight.catch(() => undefined);
    }
    const ephemeral = this.ephemeralSessions.has(sessionId);
    const handle = this.sessions.get(sessionId);
    const summary = ephemeral ? undefined : await this.index.get(sessionId);
    const persistedHere = summary !== undefined && summary.workspaceId === this.workspaceId;
    if (handle === undefined && !persistedHere && !ephemeral) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    if (handle !== undefined) await this.close(sessionId);
    if (ephemeral) await this.retainedUsage.retainEphemeralUsage?.(this.sessionScope(sessionId), this.workspaceId);
    else await this.retainedUsage.retainDeletedSession((await this.index.get(sessionId))!);
    await this.hostFs.remove(join(this.bootstrap.homeDir, this.sessionScope(sessionId)));
    this.ephemeralSessions.delete(sessionId);
    try {
      if (!ephemeral) {
        await this.index.remove(sessionId);
        this.appendLogStore.append('', 'session_index.jsonl', { sessionId, deleted: true });
        await this.appendLogStore.flush();
      }
    } finally {
      try {
        onRemoved?.();
      } catch {
        this.log.error('session removal callback failed after the session directory was deleted', {
          sessionId, eventType: 'session.removalCallbackFailed',
        });
      }
    }
  }

  private async announceWillClose(event: SessionWillCloseEvent): Promise<void> {
    await this._onWillCloseSession.fireAsync(event, NO_ABORT);
  }

  private async persistUsage(
    handle: ISessionScopeHandle,
    fallback: SessionUsageSummary | undefined,
  ): Promise<void> {
    const metadata = handle.accessor.get(ISessionMetadata);
    const current = metadata.usage();
    const usage = current?.wireComplete === true ? current : fallback ?? current;
    if (usage === undefined) return;
    await metadata.update({ usage }, { touchUpdatedAt: false });
  }

  private async drainAgents(handle: ISessionScopeHandle): Promise<void> {
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent.id);
    }
  }

  private async rollbackSession(
    sessionId: string,
    handle: ISessionScopeHandle | undefined,
    sessionDir: string | undefined,
    error: unknown,
  ): Promise<never> {
    this.sessions.delete(sessionId);
    this.deferredSessionLockReleases.add(sessionId);
    const cleanupErrors: unknown[] = [];
    if (handle !== undefined) {
      try {
        await this.drainAgents(handle);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await drainSessionMetadataWrites();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (handle !== undefined) {
      try {
        handle.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (sessionDir !== undefined) {
      try {
        await this.hostFs.remove(sessionDir);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!this.ephemeralSessions.has(sessionId)) {
      try {
        await this.index.remove(sessionId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    this.ephemeralSessions.delete(sessionId);
    this.deferredSessionLockReleases.delete(sessionId);
    try {
      await this.releaseSessionLock(sessionId);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `failed to roll back session ${sessionId}`, {
        cause: error,
      });
    }
    throw error;
  }

  /** Forks a session into a new Session scope. Fails before allocating or copying a target when the
   *  source holds an external-delegation root: that root is Session-scoped authority rather than
   *  ordinary conversation state, and with no authority-transfer protocol in the MVP, cloning it
   *  would leave its child ownership dangling. */
  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    const sourceId = opts.sourceSessionId;

    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (
      (sourceHandle === undefined && indexSummary === undefined) ||
      (indexSummary !== undefined && indexSummary.workspaceId !== this.workspaceId)
    ) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }
    if (sourceHandle !== undefined) {
      for (const agent of sourceHandle.accessor.get(IAgentLifecycleService).list()) {
        if (opts.externalMaterialOnly === true && agent.id !== MAIN_AGENT_ID) continue;
        if (agent.accessor.get(IAgentActivityView).state().turn !== undefined) {
          throw new Error2(
            ErrorCodes.SESSION_FORK_ACTIVE_TURN,
            `Session "${sourceId}" cannot be forked while a turn is running`,
            { details: { sessionId: sourceId } },
          );
        }
      }
    }
    assertForkTurnIndex(opts.turnIndex);

    let targetId: string | undefined;
    let target: ISessionScopeHandle | undefined;
    let targetSessionDir: string | undefined;
    try {
      await drainSessionMetadataWrites();
      const sourceMeta =
        sourceHandle !== undefined
          ? await sourceHandle.accessor.get(ISessionMetadata).read()
          : await this.readMetaFromDisk(sourceId);

      const externalRoot = await this.docs.get(
        join(sessionScopeOf(this.handlerScope, sourceId), 'external-delegation'),
        'root',
      );
      if (externalRoot !== undefined) {
        throw new Error2(
          ErrorCodes.SESSION_FORK_EXTERNAL_DELEGATION,
          'A Session with an external delegation root cannot be forked.',
        );
      }
      if (opts.externalMaterialOnly === true && externalClientMetaOf(sourceMeta ?? {}) === undefined) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          'externalMaterialOnly requires an external-client source session.',
        );
      }

      targetId = opts.newSessionId ?? createSessionId();
      await this.assertNewSession(targetId);

      const turnSlice =
        opts.turnIndex === undefined
          ? undefined
          : sliceMainRecordsAtTurn(
              await this.readSourceWireRecords(sourceHandle, sourceId, MAIN_AGENT_ID),
              sourceId,
              opts.turnIndex,
              opts.throughUserMessage,
            );

      await this.acquireSessionLock(targetId);
      try {
        await this.assertNewSession(targetId);
      } catch (error) {
        await this.releaseSessionLock(targetId);
        throw error;
      }
      targetSessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, targetId);
      await this.copySessionFiles(
        sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sourceId),
        targetSessionDir,
      );
      if (opts.externalMaterialOnly === true) {
        await this.pruneExternalMaterialForkFiles(targetSessionDir);
      }

      target = await this.materializeSession({
        sessionId: targetId,
        workDir: this.workspaceContext.cwd,
      });
      const targetCtx = target.accessor.get(ISessionContext);
      const targetMeta = target.accessor.get(ISessionMetadata);

      const sourceAgents = sourceMeta?.agents ?? {};
      const agentIds = opts.externalMaterialOnly === true
        ? [MAIN_AGENT_ID]
        : Object.keys(sourceAgents);
      const retainedAgentIds: string[] = [];
      for (const agentId of agentIds) {
        let slicedRecords: readonly WireRecord[] | undefined;
        if (turnSlice !== undefined) {
          if (agentId === MAIN_AGENT_ID) {
            slicedRecords = turnSlice.records;
          } else {
            const subagentRecords = sliceSubagentRecordsAtTime(
              await this.readSourceWireRecords(sourceHandle, sourceId, agentId),
              turnSlice.cutoffTime,
            );
            if (subagentRecords.length === 0) continue;
            slicedRecords = subagentRecords;
          }
        }
        await this.copyAgentWire({
          sourceHandle,
          sourceSessionId: sourceId,
          agentId,
          targetSessionId: targetCtx.sessionId,
          records: externalAcpForkRecords(
            (opts.externalMaterialOnly === true && agentId === MAIN_AGENT_ID
              ? externalMaterialForkRecords(slicedRecords ?? await this.readSourceWireRecords(sourceHandle, sourceId, agentId))
              : slicedRecords ?? await this.readSourceWireRecords(sourceHandle, sourceId, agentId)),
            (id) => this.instantiation.invokeFunction((accessor) => accessor.get(IAgentExecutorRegistry).get(id)?.protocol === 'acp-v1'),
            agentId === MAIN_AGENT_ID && opts.throughUserMessage === true,
          ),
        });
        retainedAgentIds.push(agentId);
      }

      if (turnSlice !== undefined) {
        await this.pruneTruncatedForkFiles(targetSessionDir, agentIds, retainedAgentIds);
      }

      const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;

      for (const agentId of retainedAgentIds) {
        const sourceAgent = sourceAgents[agentId] ?? { type: 'main' as const };
        await target.accessor.get(IAgentLifecycleService).create({
          agentId,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
          delegator: sourceAgent.delegator,
        });
      }

      let forkedCustom = forkCustomMetadata(sourceMeta?.custom, opts.metadata);
      if (opts.externalMaterialOnly === true && forkedCustom !== undefined) {
        delete forkedCustom['externalClient'];
        if (Object.keys(forkedCustom).length === 0) forkedCustom = undefined;
      }
      await targetMeta.update({
        title,
        titleKind: opts.title !== undefined ? 'custom' : 'replaceable',
        forkedFrom: sourceId,
        archived: false,
        updatedAt: toEpochMs(sourceMeta?.updatedAt) || Date.now(),
        lastPrompt: turnSlice === undefined ? sourceMeta?.lastPrompt : turnSlice.lastPrompt,
        lastTurnReason: sourceMeta?.lastTurnReason,
        usage: aggregateSessionUsage(target),
        custom: forkedCustom,
      });

      if (turnSlice === undefined) {
        await this.duplicateCronTasks(sourceId, targetId);
      }

      await this.appendSessionIndexEntry(targetId, this.workspaceContext.cwd);
      this._onDidForkSession.fire({
        sourceSessionId: sourceId,
        sessionId: targetId,
        handle: target,
      });
      await this.announceCreated({ sessionId: targetId, handle: target, source: 'fork' });
      return target;
    } catch (error) {
      if (targetId === undefined || targetSessionDir === undefined) throw error;
      return this.rollbackSession(targetId, target, targetSessionDir, error);
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    const title =
      opts.title ??
      `Child: ${(await this.resolveSourceTitle(opts.sourceSessionId)) ?? opts.sourceSessionId}`;
    const metadata = {
      ...opts.metadata,
      [PARENT_SESSION_ID_KEY]: opts.sourceSessionId,
      [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
    };
    return this.fork({
      sourceSessionId: opts.sourceSessionId,
      newSessionId: opts.newSessionId,
      title,
      metadata,
    });
  }

  private async resolveSourceTitle(sourceId: string): Promise<string | undefined> {
    const live = this.sessions.get(sourceId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sourceId))?.title;
  }

  private async copyAgentWire(args: {
    readonly sourceHandle: ISessionScopeHandle | undefined;
    readonly sourceSessionId: string;
    readonly agentId: string;
    readonly targetSessionId: string;
    readonly records?: readonly WireRecord[];
  }): Promise<void> {
    const records = [
      ...(args.records ??
        (await this.readSourceWireRecords(args.sourceHandle, args.sourceSessionId, args.agentId))),
    ];
    if (records.length === 0) {
      records.push(createWireMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(createWireMetadataRecord());
    }
    records.push(forkedRecord());

    await this.appendLogStore.rewrite(
      agentScopeOf(sessionScopeOf(this.handlerScope, args.targetSessionId), args.agentId),
      AGENT_WIRE_RECORD_KEY,
      records,
    );
  }

  private async readSourceWireRecords(
    sourceHandle: ISessionScopeHandle | undefined,
    sourceSessionId: string,
    agentId: string,
  ): Promise<WireRecord[]> {
    if (sourceHandle !== undefined) {
      const agentHandle = sourceHandle.accessor.get(IAgentLifecycleService).get(agentId);
      if (agentHandle !== undefined) {
        await agentHandle.accessor.get(IEventDispatcher).flush();
      }
    }
    const scope = agentScopeOf(sessionScopeOf(this.handlerScope, sourceSessionId), agentId);
    let truncation: AppendLogTruncation | undefined;
    const records = await collect(
      this.appendLogStore.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, {
        onTruncate: (info) => {
          truncation = info;
        },
      }),
    );
    if (truncation !== undefined) {
      await repairWireJournal(
        {
          appendLog: this.appendLogStore,
          storage: this.storage,
          log: this.log,
          telemetry: this.telemetry,
        },
        scope,
        AGENT_WIRE_RECORD_KEY,
        records,
        truncation,
      );
    }
    return records;
  }

  private async pruneExternalMaterialForkFiles(targetSessionDir: string): Promise<void> {
    const agentsDir = join(targetSessionDir, 'agents');
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(agentsDir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await Promise.all(entries
      .filter((entry) => entry.name !== MAIN_AGENT_ID)
      .map((entry) => this.hostFs.remove(join(agentsDir, entry.name))));
    await Promise.all([
      this.hostFs.remove(join(agentsDir, MAIN_AGENT_ID, 'tasks')),
      this.hostFs.remove(join(agentsDir, MAIN_AGENT_ID, 'cron')),
    ]);
  }

  private async pruneTruncatedForkFiles(
    targetSessionDir: string,
    agentIds: readonly string[],
    retainedAgentIds: readonly string[],
  ): Promise<void> {
    const retained = new Set(retainedAgentIds);
    const removals: Promise<void>[] = [];
    for (const agentId of agentIds) {
      if (retained.has(agentId)) continue;
      removals.push(this.hostFs.remove(join(targetSessionDir, 'agents', agentId)));
    }
    for (const agentId of retainedAgentIds) {
      const agentDir = join(targetSessionDir, 'agents', agentId);
      removals.push(this.hostFs.remove(join(agentDir, 'tasks')));
      removals.push(this.hostFs.remove(join(agentDir, 'cron')));
    }
    await Promise.all(removals);
  }

  private async copySessionFiles(sourceDir: string, targetDir: string): Promise<void> {
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(sourceDir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await this.copySessionDirEntries(sourceDir, targetDir, entries, '');
  }

  private async copySessionDirEntries(
    sourceDir: string,
    targetDir: string,
    entries: readonly HostDirEntry[],
    relBase: string,
  ): Promise<void> {
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (
        rel === 'state.json' ||
        rel === 'logs' ||
        rel === 'external-delegation' ||
        rel === 'upcoming-goals.json' ||
        entry.name === AGENT_WIRE_RECORD_KEY ||
        entry.name === WIRE_TRANSCRIPT_RECEIPT_KEY
      ) {
        continue;
      }
      if (entry.isSymbolicLink === true) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory) {
        let children: readonly HostDirEntry[];
        try {
          children = await this.hostFs.readdir(sourcePath);
        } catch (error) {
          if (isMissingFileError(error)) continue;
          throw error;
        }
        await this.hostFs.mkdir(targetPath, { recursive: true });
        await this.copySessionDirEntries(sourcePath, targetPath, children, rel);
      } else if (entry.isFile) {
        const data = await this.hostFs.readBytes(sourcePath);
        await this.hostFs.mkdir(targetDir, { recursive: true });
        await this.hostFs.writeBytes(targetPath, data);
      }
    }
  }

  private async duplicateCronTasks(sourceId: string, targetId: string): Promise<void> {
    const tasks = await this.cronStore.list({ workspaceId: this.workspaceId });
    for (const task of tasks) {
      if (task.tags?.[CRON_SESSION_TAG] !== sourceId) continue;
      const clone: CronTask = {
        ...task,
        id: ulid(),
        tags: { ...task.tags, [CRON_SESSION_TAG]: targetId },
      };
      await this.cronStore.save(this.workspaceId, clone);
    }
  }

  private async readMetaFromDisk(sessionId: string): Promise<SessionMeta | undefined> {
    return this.docs.get<SessionMeta>(sessionScopeOf(this.handlerScope, sessionId), 'state.json');
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function forkedRecord(): WireRecord {
  return { type: 'forked', time: Date.now() };
}

function forkCustomMetadata(
  source: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const inherited = withoutGoal(source);
  delete inherited[CREATED_BY_SESSION_ID_KEY];
  delete inherited[CREATED_BY_AGENT_ID_KEY];
  const merged = { ...inherited, ...withoutGoal(input) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function withoutGoal(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const { goal: _drop, ...rest } = value as { goal?: unknown; [key: string]: unknown };
  return rest;
}
