/**
 * v2 wiring MVP — an `SDKRpcClientBase` backed by the agent-core-v2 engine
 * (DI × Scope) instead of the v1 `KimiCore` RPC pair. The engine is
 * bootstrapped in-process and reached through the klient facade over the
 * memory transport, so every call crosses the same contract validation and
 * JSON round-trip as the networked transports.
 *
 * Migration model: the base class still carries the v1 method surface. Any
 * method not yet overridden here falls through to `getRpc()`, which fails
 * loudly with `not_implemented` — migrated methods are the ones overridden
 * below. Once every method is migrated, the v1 `getRpc()` dependency (and
 * the v1 core) goes away entirely.
 *
 * Migrated so far:
 * - `getExperimentalFeatures` → `klient.global.flags.list()`
 * - `listWorkspaceSkills` → not covered by the klient facade, so it goes
 *   through the `engineAccessor` escape hatch (the workspace handler's
 *   `IWorkspaceSkillCatalog`) instead.
 * - `getConfig` / `setConfig` / `removeProvider` / `getConfigDiagnostics` →
 *   `klient.global.config.*`, with the v1 `KimiConfig` shape restored by the
 *   pure mapping layer in `src/v2/config-mapper.ts`.
 * - `listPlugins` / `installPlugin` / `setPluginEnabled` /
 *   `setPluginMcpServerEnabled` / `removePlugin` / `reloadPlugins` /
 *   `getPluginInfo` / `listPluginCommands` → `klient.global.plugins.*`. The
 *   wire types are field-identical between the engines, so no mapping layer
 *   is needed. Unlike the config domain, the v2 plugin service serializes
 *   every read behind its own initial load, so there is no ready trap here.
 * - `listSessions` / `createSession` / `renameSession` / `forkSession` /
 *   `closeSession` / `resumeSession` / `reloadSession` / `deleteSession` /
 *   `updateSessionMetadata` / `addAdditionalDir` → the session lifecycle
 *   batch: shared session lifecycle and metadata facade calls, including
 *   explicit create/fork ids and historical fork boundaries. Host event wiring,
 *   reload orchestration, replay shaping and workspace-level add-dir operations
 *   still use {@link engineAccessor}. The v1 `SessionSummary` / `SessionMeta`
 *   shapes are restored by the pure mapping layer in
 *   `src/v2/session-mapper.ts`. The resumed results carry the full v1
 *   per-agent snapshot: the live slices are read from the restored agent
 *   scope (profile / permission / swarm services + the klient agent facade),
 *   while `replay` and `toolStore` are folded from each agent's `wire.jsonl`
 *   through the v1 engine's own restore pipeline
 *   (`src/v2/resume-replay.ts`) — `includeSubagents` and `replayTurnLimit`
 *   included.
 * - `setModel` / `setThinking` / `setPermission` / `setPlanMode` / `getPlan` /
 *   `clearPlan` / `getContext` / `getUsage` / `listCommands` / `runCommand` /
 *   `getTodos` / `undoHistory` / `clearContext` → the klient agent/session
 *   facades, with `getTodos` passing the explicit `interactiveAgentId` to the
 *   session-owned, agent-local todo state. `cancel` also cancels the session
 *   init run through the session facade. `getStatus` aggregates facade reads;
 *   `importContext` keeps only the v1 message/validation/event adaptation in
 *   the SDK while appending through the agent context facade. `createSession`'s
 *   `model` / `thinking` / `permission` options are applied in this batch too.
 * - `prompt` / `steer` / `runShellCommand` / `cancelShellCommand` /
 *   `activateSkill` / `activatePluginCommand` → the klient agent facade;
 *   `generateAgentsMd` / `startBtw` / `getCronTasks` → the klient session
 *   facade. `getSessionWarnings` reads the profile warning through the agent
 *   facade and retains the host filesystem fallback because v2 has no warning
 *   aggregate service.
 * - `createGoal` / `getGoal` / `pauseGoal` / `resumeGoal` / `cancelGoal` /
 *   `listBackgroundTasks` / `getBackgroundTaskOutput` / `stopBackgroundTask` /
 *   `detachBackgroundTask` / session MCP list, startup, reconnect and connect →
 *   klient agent/session facades. The explicit stop path calls
 *   `agentTaskService.stop` rather than the convenience `stopByUser`, so an
 *   omitted reason never gains a user-cancellation stamp. Print-mode policy
 *   remains SDK-owned while task drain/count work uses the session facade.
 * - `listGlobalMcpServers` / `getGlobalMcpServer` /
 *   `listGlobalMcpServerAuthStatuses` /
 *   `addGlobalMcpServer` / `updateGlobalMcpServer` /
 *   `removeGlobalMcpServer` / `beginGlobalMcpServerAuth` /
 *   `completeGlobalMcpServerAuth` / `cancelGlobalMcpServerAuth` /
 *   `resetGlobalMcpServerAuth` / `testGlobalMcpServer` /
 *   `testGlobalMcpServerConfig` / `inspectAppMcpServers` /
 *   `beginMcpServerAuth` / `completeMcpServerAuth` / `cancelMcpServerAuth` /
 *   `resetMcpServerAuth` → `klient.global.mcp.*`: the unified MCP management
 *   plane over the `mcpRegistry` read view — user-level
 *   `mcp.json` CRUD guarded against read-only plugin / project-layer
 *   collisions, the standalone connection probe, the locator-addressed
 *   inspection catalog (plugin entries included), and locator-addressed
 *   OAuth flows keyed by flowId. The managed-server results are mapped back
 *   to the v1 wire shape (config flattened to the top level); the inspection
 *   and auth-status shapes are field-identical between the engines.
 * - `listMcpServers` / `getMcpStartupMetrics` / `reconnectMcpServer` /
 *   `addSessionMcpServer` → the klient agent facade's session-merged MCP
 *   capability. Explicit config connects still reject merged ephemeral views,
 *   and an unpersisted add remains visible to sibling sessions sharing the
 *   workspace manager (the v2 manager has no session-local `caller` scope).
 *   `listWorkspaceMcpServers` remains a workspace-host read through the
 *   engine accessor because no workspace MCP facade exists.
 * - `onEvent` / `receiveEvent` → the base class registries, fed by a
 *   per-live-session wiring (`src/v2/session-wiring.ts`) that subscribes
 *   every live agent's `IEventBus` and translates each `DomainEvent` back
 *   into the v1 `Event` shape (`src/v2/event-mapper.ts`); the klient events
 *   hub is deliberately bypassed because its contract registry exposes only
 *   13 of the bus types (no `shell.*`, no `turn.step.*`, ...). The one
 *   v1-visible fact on the process-global `IEventService`
 *   (`session.meta.updated`) is forwarded from a constructor subscription.
 * - `setApprovalHandler` / `setQuestionHandler` → the base class registries,
 *   driven by the same session wiring: v1's push callbacks
 *   (`requestApproval` / `requestQuestion` / `toolCall`) are fed from the v2
 *   interaction kernel's pending set (`onDidChangePending`), and the outcome
 *   is written back through `ISessionApprovalService.decide` /
 *   `ISessionQuestionService.answer|dismiss` / the kernel's `respond`.
 * - `exportSession` → `ISessionExportService` (app scope, the v2 port of v1's
 *   export) through {@link engineAccessor}; `listSkills` → the klient session
 *   skill catalog; `setSwarmMode` / `swarm` → the klient agent facade (the v2
 *   port of v1's `SwarmMode`), with `swarm()` recomposed over the facade
 *   toggle + `prompt` overrides.
 *   `createSessionWithKaos` / `resumeSessionWithKaos` deliberately keep the
 *   base class's kaos-ignoring degradation (the v2 engine has no kaos
 *   injection point — see the session-lifecycle section header), and
 *   `toolCall` keeps the base class's "not supported" answer, which the
 *   interaction bridge already relies on.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentContextData, ExperimentalFeatureState } from '@kiki/agent-core-v2';

import {
  ensureConfigFile,
  HookDefSchema,
  mergeConfigPatch,
  readConfigFile,
  validateConfigPatch,
} from '#/config';
import { ErrorCodes, isKimiErrorCode, KimiError, type KimiErrorCode } from '#/errors';
import { getRootLogger, type DiagnosticLogHost } from '#/logging';
import type { BeginGlobalMcpServerAuthResult } from '#/protocol';
import { noopTelemetryClient } from '#/protocol/telemetry';
import { limitAgentReplayByTurns } from '#/wire/replay-turns';
import { encodeWorkDirKey } from '@kiki/agent-core-v2/_base/utils/workdir-slug';
import { loadMcpServers } from '@kiki/agent-core-v2/app/mcpConfig/configLoader';
import { IAppendLogStore } from '@kiki/agent-core-v2/persistence/interface/appendLogStore';
import { SessionIndexErrors } from '@kiki/agent-core-v2/app/sessionIndex/errors';
import { AgentStatusUpdated } from '@kiki/agent-core-v2/agent/usage/usageEvents';
import type { McpServerConfig as WorkspaceMcpServerConfig } from '@kiki/agent-core-v2/mcpCore/config-schema';
import {
  bootstrap,
  DEFAULT_AGENT_PROFILE_NAME,
  drainLogCloses,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  ensureKikiHome,
  ensureMainAgent,
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentProfileService,
  IAgentSwarmService,
  IAgentToolPolicyService,
  IAgentToolRegistryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IEventService,
  IHostEnvironment,
  IHostFileSystem,
  ILogService,
  IMcpOAuthService,
  IModelService,
  IProviderService,
  ISessionContext,
  ISessionExportService,
  ISessionIndex,
  ISessionIndexMirror,
  ISessionManager,
  ISessionMetadata,
  ISessionWorkspaceContext,
  ITelemetryService,
  IWorkspaceAliases,
  ISessionActivityView,
  IWorkspaceInstanceManager,
  closeSessionById,
  followSessionLifecycles,
  getLiveSessionById,
  isError2,
  programForSession,
  resumeSessionById,
  sessionDirOf,
  workspacePersistenceScope,
  logSeed,
  MAIN_AGENT_ID,
  prepareSystemPromptContext,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  ProfileError,
  ProfileErrors,
  resolveAgentTaskConfig,
  resolveConfigPath,
  resolveKikiHome,
  resolveLoggingConfig,
  resolvePrintBackgroundMode,
  summarizeSkill,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type McpManagedServer,
  type Scope,
  type ServicesAccessor,
  type SessionSummary as V2SessionSummary,
} from '@kiki/agent-core-v2';
import { RPCError, type AgentHandle, type Klient } from '@kiki/klient';
import { createKlient } from '@kiki/klient/memory';
import { assertKimiHostIdentity, createKimiDefaultHeaders } from '@kiki/oauth';

import { KimiAuthFacade } from '#/auth';
import { KimiHarness } from '#/kimi-harness';
import {
  SDKRpcClientBase,
  type ActivatePluginCommandRpcInput,
  type ActivateSkillRpcInput,
  type ImportContextRpcInput,
  type ReconnectMcpServerRpcInput,
  type ReloadSessionRpcInput,
  type RunCommandRpcInput,
  type SessionIdRpcInput,
  type SwitchSessionRuntimeRpcInput,
  type SessionPromptRpcInput,
  type SessionPromptWithSkillsRpcInput,
  type SetSessionModelRpcInput,
  type SetSessionModelRpcResult,
  type SetSessionPermissionRpcInput,
  type SetSessionPlanModeRpcInput,
  type SetSessionSwarmModeRpcInput,
  type SetSessionThinkingRpcInput,
  type UpdateSessionMetadataRpcInput,
} from '#/rpc';
import type {
  AddAdditionalDirInput,
  AddAdditionalDirResult,
  AgentCommandInfo,
  AgentRuntimeBinding,
  AppMcpServerInspection,
  BackgroundTaskInfo,
  CapabilityStatus,
  CompactOptions,
  ConfigDiagnostics,
  CreateGoalInput,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  FileMeta,
  ForkSessionInput,
  GenerateSessionTitleInput,
  GetConfigOptions,
  GetCronTasksResult,
  GlobalMcpServerAuthStatus,
  GoalSnapshot,
  GoalToolResult,
  JsonObject,
  KimiConfig,
  KimiConfigPatch,
  KimiHarnessOptions,
  KimiHostIdentity,
  ListSessionsOptions,
  McpManagedServerInfo,
  McpServerConfig,
  McpServerInfo,
  McpServerLocator,
  McpStartupMetrics,
  McpTestResult,
  OAuthRefreshOutcome,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  ReloadSummary,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedAgentState,
  ResumedSessionSummary,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionSummaryPage,
  SessionTodoItem,
  SessionUsage,
  SkillSummary,
  TelemetryClient,
  UploadFileOptions,
  WorkspaceTrustInfo,
} from '#/types';
import {
  diagnosticsToConfigDiagnostics,
  planProviderRemoval,
  resolvedConfigToKimiConfig,
} from '#/v2/config-mapper';
import { translateGlobalEvent } from '#/v2/event-mapper';
import { buildImportContextMessage } from '#/v2/import-context';
import { foldAgentWireReplay } from '#/v2/resume-replay';
import {
  mcpConfigWithoutName,
  normalizeServerName,
  parseInlineMcpServer,
  parseReconnectMcpServerConfig,
} from '#/v2/global-mcp';
import { normalizeWorkDir, v2SummaryToSessionSummary } from '#/v2/session-mapper';
import { SessionEventWiring } from '#/v2/session-wiring';

export interface SDKRpcClientOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity;
  /**
   * Explicit skill directories for this process (v1's SDK `skillDirs` /
   * the CLI's `--skills-dir`): when non-empty, default user / project skill
   * discovery is skipped and these directories serve as the user skill
   * source. Passed into the engine through `BootstrapInput.args.skillDirs`.
   */
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
  readonly uiMode?: string;
}

/**
 * Stand-in for the engine's non-optional `clientIdentity` when the SDK host
 * declined to name itself. It names the SDK, never a guessed product: an
 * unnamed host still gets null client attribution on telemetry and no
 * `X-Msh-*` on its managed auth calls.
 */
const ANONYMOUS_SDK_HOST_IDENTITY: KimiHostIdentity = {
  productName: 'kimi-code-sdk',
  version: '0',
  platform: 'kimi_code_sdk',
};

export class SDKRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly klient: Klient;

  private readonly app: Scope;
  /**
   * The engine's config reads (`get`/`getAll`/`inspect`/`diagnostics`) are
   * synchronous over state that only exists once the initial load settles;
   * unlike the mutating methods they do not await `IConfigService.ready`
   * internally, so every config override below awaits this first. Awaiting
   * the engine's own ready handle (via the accessor) instead of issuing a
   * dummy facade call keeps the reads honest no-ops.
   */
  private readonly configReady: Promise<void>;
  /**
   * Per-session print-steer state for `handlePrintMainTurnCompleted`: v1
   * keeps the deadline/turn counters on the `Session` object, so they reset
   * when the session closes (a resume builds a fresh `Session`); mirrored
   * here by deleting the entry in {@link unwireSession}, which every close
   * path (client, engine, delete) funnels through.
   */
  private readonly printSteerStates = new Map<string, { deadline?: number; turns: number }>();
  /**
   * The model/provider registries (`IModelService` / `IProviderService`)
   * share the config service's ready trap: their `get`/`list` reads are
   * synchronous over state that only exists after hydration, and every
   * agent-side model operation (profile bind, `setModel`, capability reads)
   * flows through them. Agent-interaction overrides await this before
   * touching a profile.
   */
  private readonly modelReady: Promise<void>;
  /**
   * The persisted session read model (`ISessionIndex`) refuses reads until a
   * host opens it: `get`/`listRecent`/`count` throw the retryable
   * `session.index_building` while the projection is unbuilt. kap-server
   * prepares it during post-listen warmup; an in-process SDK host has no such
   * hook, so construction kicks the same single-flight `prepare()` in the
   * background and {@link retryWhileSessionIndexBuilding} awaits it only when
   * a read actually loses the race. Blocking every session call on the build
   * instead would make a cold home directory pay the full projection cost
   * before its first `createSession`.
   */
  private readonly sessionIndexReady: Promise<void>;
  /**
   * Per-live-session event/interaction wirings (`src/v2/session-wiring.ts`):
   * created when a session materializes through this client (create / resume /
   * fork / reload), dropped on close (ours or the engine's). Each wiring feeds
   * the base class's event listeners from the session's per-agent event buses
   * and bridges its pending approvals / questions / user-tool calls to the
   * registered handlers.
   */
  private readonly sessionWirings = new Map<string, SessionEventWiring>();
  /**
   * Per-session serialization for the operations that change a session's
   * live ownership: the temporary resume→act→close paths (`renameSession`,
   * `generateSessionTitle`) and the public `resumeSession` / `closeSession`
   * / `reloadSession`. Chaining them through one queue per session id makes
   * the handoff atomic — a public resume either lands first (the temporary
   * path then reuses the live handle and leaves it open) or waits for the
   * temporary close to finish and materializes a fresh scope, so a caller
   * can never receive a handle whose close is already in flight.
   */
  private readonly sessionAccessQueues = new Map<string, Promise<void>>();
  /** App-scope subscriptions (global event forwarding, lifecycle tracking), disposed in {@link close}. */
  private readonly appSubscriptions: IDisposable[] = [];
  /**
   * The engine's logging seam behind the SDK's `log` facade. v1 routed
   * `log.*` through a core-owned root logger; the v2 engine owns both files
   * itself (`AppLogService` → `<homeDir>/logs/kimi-code.log`,
   * `SessionLogService` → `<sessionDir>/logs/kimi-code.log`), so the facade
   * resolves the matching `ILogService` per entry instead of opening sinks of
   * its own. Registered in the constructor, dropped in {@link close}; the
   * newest client wins for untagged entries, which is what makes a second
   * harness log into its own home directory.
   */
  private readonly logHost: DiagnosticLogHost;

  constructor(options: SDKRpcClientOptions = {}) {
    super();
    this.identity =
      options.identity === undefined ? undefined : assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKikiHome(options.homeDir);
    this.configPath = resolveConfigPath({
      homeDir: this.homeDir,
      configPath: options.configPath,
    });
    ensureKikiHome(this.homeDir);
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.auth = new KimiAuthFacade({
      homeDir: this.homeDir,
      configPath: this.configPath,
      identity: this.identity,
      onRefresh: options.onOAuthRefresh,
    });

    const { app } = bootstrap(
      {
        homeDir: this.homeDir,
        configPath: this.configPath,
        // The engine's bootstrap needs a client identity; the SDK's surface
        // keeps one optional. A host that does not name itself is presented as
        // the SDK rather than as an invented product, and keeps its unnamed
        // consequences: no client attribution on telemetry, and no identity
        // headers at all on outbound requests.
        clientIdentity: this.identity ?? ANONYMOUS_SDK_HOST_IDENTITY,
        args: {
          // Host identity headers for the engine's outbound requests (model,
          // WebSearch, registry refresh). Without them the managed vendors go
          // out with the SDK's default User-Agent and no X-Msh-* at all.
          requestHeaders:
            this.identity === undefined
              ? undefined
              : createKimiDefaultHeaders({ homeDir: this.homeDir, ...this.identity }),
          // `--skills-dir` (v1 parity): explicit skill dirs replace default
          // user / project discovery for every session this client hosts.
          skillDirs: options.skillDirs,
        },
      },
      [...logSeed(resolveLoggingConfig({ homeDir: this.homeDir, env: process.env }))],
    );
    this.app = app;
    this.logHost = {
      globalLog: () => app.accessor.get(ILogService),
      sessionLog: (sessionId) =>
        app.accessor.get(ISessionManager).get(sessionId)?.accessor.get(ILogService),
      liveSessionLogs: () =>
        app.accessor
          .get(ISessionManager)
          .list()
          .map((session) => session.accessor.get(ILogService)),
    };
    getRootLogger().bind(this.logHost);
    this.klient = createKlient({ scope: app });
    this.configReady = app.accessor.get(IConfigService).ready;
    this.installEngineTelemetry(options.telemetry);
    this.modelReady = Promise.all([
      this.configReady,
      app.accessor.get(IModelService).ready,
      app.accessor.get(IProviderService).ready,
    ]).then(() => undefined);
    // After `configReady`: the read model sits behind a flag, and `prepare()`
    // is a no-op while `IFlagService` still reads the unhydrated config — a
    // prepare kicked at construction would resolve without opening anything.
    this.sessionIndexReady = this.configReady
      .then(() => app.accessor.get(ISessionIndex).prepare())
      .then(
        () => undefined,
        () => undefined,
      );
    this.appSubscriptions.push(
      // v1's stream carries `session.meta.updated` (the prompt metadata
      // path) — the one v1-visible fact the v2 engine publishes on the
      // process-global IEventService rather than a per-agent bus. Every other
      // global-bus type is a daemon/WS-edge event the in-process v1 client
      // never saw, so the translation filters down to that single type.
      this.app.accessor.get(IEventService).subscribe((event) => {
        const translated = translateGlobalEvent(event);
        if (translated !== undefined) this.receiveEvent(translated);
      }),
      // A session closed without going through this client (archive, an
      // engine-initiated close) drops its wiring with the scope. Close events
      // fire per workspace handler, so follow every handler — present and
      // future — through the App-scope registry.
      followSessionLifecycles(this.app.accessor, (service) =>
        service.onDidCloseSession((closed) => {
          this.unwireSession(closed.sessionId);
        }),
      ),
    );
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFile(this.configPath);
    // Surface a missing Git Bash early, before the TUI starts. The wait is
    // Windows-only: the failure cannot happen on POSIX, and `ready` also
    // covers the login-shell PATH enrichment, which spawns the user's login
    // shell (5s timeout) — config-only commands must not block on that.
    if (process.platform === 'win32') {
      await this.app.accessor.get(IHostEnvironment).ready;
    }
  }

  async close(): Promise<void> {
    for (const wiring of this.sessionWirings.values()) {
      wiring.dispose();
    }
    this.sessionWirings.clear();
    for (const subscription of this.appSubscriptions) {
      subscription.dispose();
    }
    await this.klient.close();
    // Same shutdown order as kap-server: drain the session-index mirror while
    // the query store is still open, then await the asynchronous closes that
    // disposal fires — a host that removes homeDir right after close() must
    // not race an in-flight shard close (ENOTEMPTY on teardown).
    await this.app.accessor.get(ISessionIndexMirror).drain();
    // Await the OAuth service shutdown directly rather than after dispose():
    // its ledger-teardown dispose can queue behind slow async disposables, and
    // the accessor throws once the scope is disposed. shutdown() is
    // idempotent, so the ledger's own teardown turns into a no-op.
    await this.app.accessor.get(IMcpOAuthService).shutdown();
    const appendLogStore = this.app.accessor.get(IAppendLogStore);
    // Past this point the accessor throws, so the facade must stop resolving
    // this client's log services. Disposal itself flushes them synchronously.
    getRootLogger().unbind(this.logHost);
    this.app.dispose();
    await appendLogStore.drainRetirements();
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await drainLogCloses();
  }

  /**
   * Forward engine telemetry to the host-supplied client. Without this the
   * client only served `KimiHarness`-level events and every engine-side event
   * (`track2` facts from agent/session scopes) was dropped on the v2 route.
   * The `ITelemetryAppender` shape is a structural superset of the v1
   * `TelemetryClient`, so the client installs directly. The `telemetry`
   * config section gates engine events the same way the v2 print runner
   * gates them; the host keeps owning the client's lifecycle (flush /
   * shutdown stay with the host, matching the v1 core's arrangement).
   */
  private installEngineTelemetry(client: TelemetryClient | undefined): void {
    if (client === undefined) return;
    const telemetry = this.app.accessor.get(ITelemetryService);
    telemetry.setAppender(withoutEngineSessionStarted(client));
    void this.configReady.then(() => {
      telemetry.setEnabled(this.engineAccessor.get(IConfigService).get('telemetry') !== false);
    });
  }

  /**
   * Escape hatch to the in-process engine's app-scope service accessor, for
   * SDK methods whose capability exists in agent-core-v2 but is not (yet)
   * exposed through the klient facade. This is a deliberate migration
   * pressure valve, not a new public API direction:
   * - it only exists because this client owns the bootstrapped `Scope` —
   *   there is nothing equivalent on a remote (ipc) transport, so anything
   *   built on it is in-process-only by construction;
   * - it resolves App-scope services only. Session/agent services need their
   *   own scope handles (via the lifecycle services), not this accessor;
   * - every use should name the klient facade method it stands in for, and
   *   move onto the facade once one exists. Remove when the migration ends.
   */
  get engineAccessor(): ServicesAccessor {
    return this.app.accessor;
  }

  protected getRpc(): Promise<never> {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'This SDK method is not wired to agent-core-v2 yet.',
    );
  }

  override async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return this.klient.global.flags.list();
  }

  /**
   * `uploadFile` → `klient.global.files.save` (the app-scope `IFileService`).
   * The SDK's single `name` doubles as the engine's `filename`; the engine's
   * `SaveOptions.name` (display name) defaults to it.
   */
  override async uploadFile(data: Uint8Array, options: UploadFileOptions): Promise<FileMeta> {
    return this.klient.global.files.save({
      data,
      filename: options.name,
      mimeType: options.mimeType,
      expiresInSec: options.expiresInSec,
    });
  }

  override async deleteFile(fileId: string): Promise<void> {
    return this.klient.global.files.delete(fileId);
  }

  /**
   * Through the workspace handler's `IWorkspaceSkillCatalog` — the engine's
   * own merged view (builtin / user / explicit / extra / workspace-root /
   * plugin), so the session-less list matches what a session would serve.
   * `handlerFor` is create-or-get: session creation materializes the handler
   * anyway.
   */
  override async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const root = normalizeRequiredWorkDir('listWorkspaceSkills', workDir);
    // Materializing a workspace handler merges the workspace registry from the
    // session index, so this read sits behind the same building gate the
    // session calls do.
    const handler = await this.retryWhileSessionIndexBuilding(() =>
      this.engineAccessor.get(IWorkspaceInstanceManager).getOrCreate({ root }),
    );
    const catalog = handler.program.skills;
    await catalog.ready;
    return catalog.catalog.listSkills().map(summarizeSkill);
  }

  /**
   * klient has no workspace-trust facade; composed directly from the engine
   * via {@link engineAccessor} — the same `handlerFor({ root })` path
   * `createSession` takes (materializing the workspace handler is a no-op
   * cost here: session creation does it anyway). The gated-server list is
   * what the pure config loader sees with project files included vs skipped
   * (the workspaceTrust gate inside the engine's `workspaceMcpConfig`),
   * computed best-effort: an unreadable/invalid project file degrades to an
   * empty list rather than failing the caller.
   */
  override async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    const handler = await this.retryWhileSessionIndexBuilding(() =>
      this.engineAccessor.get(IWorkspaceInstanceManager).getOrCreate({ root: workDir }),
    );
    const trusted = await handler.program.trust.get();
    if (trusted) return { trusted: true, gatedMcpServers: [] };
    try {
      const fs = this.engineAccessor.get(IHostFileSystem);
      const [withProject, userOnly] = await Promise.all([
        loadMcpServers({ fs, cwd: workDir, homeDir: this.homeDir, includeProject: true }),
        loadMcpServers({ fs, cwd: workDir, homeDir: this.homeDir, includeProject: false }),
      ]);
      const gatedMcpServers = Object.entries(withProject)
        .filter(([name]) => !(name in userOnly))
        .map(([name, config]) => describeWorkspaceMcpServer(name, config))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return { trusted: false, gatedMcpServers };
    } catch {
      return { trusted: false, gatedMcpServers: [] };
    }
  }

  /**
   * klient has no workspace-trust facade; see {@link getWorkspaceTrustInfo}.
   * The flip fires `IWorkspaceTrust.onDidChange`, which makes the engine's
   * `workspaceMcpConfig` reload with project files included — project MCP
   * servers connect live, no restart needed.
   */
  override async trustWorkspace(workDir: string): Promise<void> {
    const handler = await this.retryWhileSessionIndexBuilding(() =>
      this.engineAccessor.get(IWorkspaceInstanceManager).getOrCreate({ root: workDir }),
    );
    await handler.program.trust.trust();
  }

  /**
   * v1 returns the whole config.toml document as one `KimiConfig`; v2
   * resolves the same file per config domain. `getAll()` is the effective
   * view (file + env overlays + section defaults), which matches v1's
   * runtime config (`loadRuntimeConfigSafe` + the KIMI_MODEL_* overlay);
   * `reload` mirrors v1's re-read-from-disk option.
   */
  override async getConfig(options?: GetConfigOptions): Promise<KimiConfig> {
    await this.configReady;
    if (options?.reload) {
      await this.klient.global.config.reload();
    }
    return resolvedConfigToKimiConfig(await this.klient.global.config.getAll(), this.readRawConfig());
  }

  /**
   * `KimiConfig.raw` is the config document as written, including the keys no
   * engine domain claims (`theme`, `show_thinking_stream`, ... — the fields a
   * TUI owns). The engine's `getAll()` is the per-domain effective view and has
   * no raw-document accessor, so the SDK reads the same file through its own
   * parser. A file that fails to parse simply has no raw view: `getConfig` still
   * returns the engine's salvaged effective config rather than throwing.
   */
  private readRawConfig(): Record<string, unknown> | undefined {
    try {
      return readConfigFile(this.configPath).raw;
    } catch {
      return undefined;
    }
  }

  override async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    await this.configReady;
    return diagnosticsToConfigDiagnostics(await this.klient.global.config.diagnostics());
  }

  /**
   * A v1 patch is one deep-merge over the whole document; v2 deep-merges
   * per domain with the same plain-object-recursive / array-replace
   * semantics, so the patch fans out one `config.set` per top-level field.
   * Unknown-to-v2 fields (`yolo`, `planMode`, `telemetry`, ...) persist as
   * unregistered pass-through domains, like v1's schema keeping them.
   */
  override async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    await this.configReady;
    // The engine validates each domain against its own section schema, which
    // does not model every constraint the SDK's config contract states; gate the
    // whole patch first so an invalid one is rejected before any write.
    validateConfigPatch(patch);
    mergeConfigPatch(await this.getConfig(), patch);
    for (const [domain, domainPatch] of Object.entries(patch)) {
      if (domainPatch === undefined) continue;
      await this.klient.global.config.set({ domain, patch: domainPatch });
    }
    return this.getConfig();
  }

  /**
   * v1's removal cascades: the provider entry, every model pointing at it,
   * and the default pointers when they dangle. The engine's own
   * `kosong.removeProvider` only clears the default-provider pointer, so the
   * full v1 cascade is computed from the user-layer values (see
   * `planProviderRemoval`) and persisted as ONE atomic multi-section
   * replace — the same single-write shape as v1's `removeKimiProvider`, so a
   * process exit can never leave the file in a halfway-cascaded state.
   */
  override async removeProvider(providerId: string): Promise<KimiConfig> {
    await this.configReady;
    const [providers, models, defaultModel, defaultProvider] = await Promise.all([
      this.klient.global.config.inspect<Record<string, unknown>>('providers'),
      this.klient.global.config.inspect<Record<string, Record<string, unknown>>>('models'),
      this.klient.global.config.inspect<string>('defaultModel'),
      this.klient.global.config.inspect<string>('defaultProvider'),
    ]);
    const plan = planProviderRemoval({
      providers: providers.userValue,
      models: models.userValue,
      defaultModel: defaultModel.userValue,
      defaultProvider: defaultProvider.userValue,
      providerId,
    });
    const sections: Record<string, unknown> = {
      providers: plan.providers,
      models: plan.models,
    };
    if (plan.clearDefaultModel) {
      sections['defaultModel'] = undefined;
    }
    if (plan.clearDefaultProvider) {
      sections['defaultProvider'] = undefined;
    }
    await this.klient.global.config.replaceSections({ sections });
    return this.getConfig();
  }

  override supportsAtomicSectionReplace(): boolean {
    return true;
  }

  override async replaceConfigSections(sections: Record<string, unknown>): Promise<void> {
    await this.configReady;
    await this.klient.global.config.replaceSections({ sections });
  }

  override async listPlugins(): Promise<readonly PluginSummary[]> {
    return this.klient.global.plugins.list();
  }

  override async installPlugin(source: string): Promise<PluginSummary> {
    return this.klient.global.plugins.install(source);
  }

  override async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    return this.klient.global.plugins.setEnabled({ id, enabled });
  }

  override async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    return this.klient.global.plugins.setMcpServerEnabled({ id, server, enabled });
  }

  override async removePlugin(id: string): Promise<void> {
    return this.klient.global.plugins.remove(id);
  }

  override async reloadPlugins(): Promise<ReloadSummary> {
    const summary = await this.klient.global.plugins.reload();
    await this.refreshPluginSessionStarts();
    return summary;
  }

  override async getPluginInfo(id: string): Promise<PluginInfo> {
    // The v2 engine's hook-event union is a superset of v1's (`TurnStarted`,
    // `UserPromptQueued`, `TaskStarted`, `SessionHeartbeat` are v2-only). The
    // SDK contract keeps the v1 `PluginInfo` shape, so hooks using v2-only
    // events are dropped from the projection — mirroring how the config
    // mapper drops config domains v1 does not know.
    const info = await this.klient.global.plugins.info(id);
    const manifest =
      info.manifest === undefined
        ? undefined
        : {
            ...info.manifest,
            hooks: info.manifest.hooks?.filter((hook) =>
              (HookDefSchema.shape.event.options as readonly string[]).includes(hook.event),
            ) as NonNullable<PluginInfo['manifest']>['hooks'],
          };
    return { ...info, manifest };
  }

  /**
   * Capability surface (v2-only): built-in product capabilities (kimi-cu,
   * kimi-webbridge) with layered readiness and idempotent installs. v1 has
   * no capability domain, so these stay off the shared base — callers
   * feature-detect via `in` before use.
   */
  async listCapabilities(): Promise<readonly CapabilityStatus[]> {
    return this.klient.global.capabilities.list();
  }

  async getCapability(id: string): Promise<CapabilityStatus> {
    return this.klient.global.capabilities.get(id);
  }

  async installCapability(id: string): Promise<CapabilityStatus> {
    return this.klient.global.capabilities.install(id);
  }

  /**
   * Scope gap: v1 answers from the session's creation-time snapshot of the
   * enabled plugin commands, while the v2 engine only exposes the app-global
   * live view (`pluginService.listPluginCommands`), so the sessionId is
   * ignored here. The two agree for any session created after the last
   * plugin change; a v1 session predating an install/toggle goes stale where
   * v2 stays live.
   */
  override async listPluginCommands(
    input: SessionIdRpcInput,
  ): Promise<readonly PluginCommandDef[]> {
    void input;
    return this.listPluginCommandsGlobal();
  }

  /** App-global live view of the enabled plugin commands, no session required. */
  override async listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]> {
    return this.klient.global.plugins.listCommands();
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  //
  // The v2 engine splits what v1's SessionStore + in-memory session map did
  // across the app-scope `ISessionIndex` (persisted read model),
  // `ISessionManager` (live session scopes), `IWorkspaceInstanceManager`, and
  // the session-scope metadata/workspace services. The klient facade covers listing and the
  // metadata mutations of a LIVE session; everything that needs an explicit
  // session id, a resume, or a workspace command goes through the
  // `engineAccessor` escape hatch (named per method below).
  //
  // `createSessionWithKaos` / `resumeSessionWithKaos` are deliberately NOT
  // overridden: agent-core-v2 has no kaos injection point (its fs/process
  // abstraction is the engine-internal hostFs domain, resolved at bootstrap),
  // so the base class's degradation — ignore the kaos arguments and run a
  // plain local create/resume — is the honest behavior, the same one every
  // daemon-transport client settles for. Failing loudly instead would break
  // hosts that pass kaos opportunistically (the harness forwards it whenever
  // the host supplies one).
  // -----------------------------------------------------------------------

  private liveSession(sessionId: string): ISessionScopeHandle | undefined {
    return getLiveSessionById(this.engineAccessor, sessionId);
  }

  /**
   * Runs `work` after every previously queued operation on the same session
   * settles; different sessions still run in parallel. The map entry drops
   * itself once the queue drains.
   */
  private runSessionAccess<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionAccessQueues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionAccessQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionAccessQueues.get(sessionId) === tail) {
        this.sessionAccessQueues.delete(sessionId);
      }
    });
    return run;
  }

  /**
   * Multi-key variant of {@link runSessionAccess}: acquires the queues in
   * sorted order so concurrent multi-key operations (fork A→B vs fork B→A)
   * cannot deadlock.
   */
  private runSessionAccessAll<T>(sessionIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const keys = [...new Set(sessionIds)].sort();
    let chained: () => Promise<T> = work;
    for (const key of [...keys].reverse()) {
      const inner = chained;
      chained = () => this.runSessionAccess(key, inner);
    }
    return chained();
  }

  /**
   * Runs `action` against the session without changing its live footprint: a
   * session that is already live (publicly resumed or created through this
   * client) is used in place and left open, while a cold session is resumed
   * for the duration of the action and closed again. Only safe inside
   * {@link runSessionAccess} — the queue is what makes the resume/close pair
   * atomic against the public lifecycle operations.
   */
  private async withTemporarySession<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.liveSession(sessionId) !== undefined) return action();
    const handle = await resumeSessionById(this.engineAccessor, sessionId);
    if (handle === undefined) throw SDKRpcClient.sessionNotFound(sessionId);
    try {
      return await action();
    } finally {
      await closeSessionById(this.engineAccessor, sessionId);
    }
  }

  /** v1's `requireSession` / store lookup failure shape. */
  private static sessionNotFound(sessionId: string): KimiError {
    return new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session "${sessionId}" was not found`, {
      details: { sessionId },
    });
  }

  /** The live session handle, or the error v1 raises for a non-active session. */
  private requireLiveSession(sessionId: string): ISessionScopeHandle {
    const handle = this.liveSession(sessionId);
    if (handle === undefined) throw SDKRpcClient.sessionNotFound(sessionId);
    return handle;
  }

  /**
   * v1's persist-add project guard ported to the workspace loader. This read
   * deliberately includes the project layer even while the workspace is
   * untrusted: a user-level write must not create a shadow that springs into
   * conflict when the workspace is trusted later.
   */
  private async rejectProjectLayerPersistedMcpAdd(
    cwd: string,
    name: string,
  ): Promise<void> {
    const fs = this.engineAccessor.get(IHostFileSystem);
    const [withProject, userOnly] = await Promise.all([
      loadMcpServers({ fs, cwd, homeDir: this.homeDir, includeProject: true }),
      loadMcpServers({ fs, cwd, homeDir: this.homeDir, includeProject: false }),
    ]);
    if (withProject[name] !== undefined && userOnly[name] === undefined) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `MCP server "${name}" is read-only: it is defined in the project MCP config — edit that file instead`,
      );
    }
  }

  /**
   * Attach the event/interaction wiring to a freshly materialized session
   * (idempotent). Unwiring needs no call site of its own: every close path
   * goes through the engine's lifecycle close, whose `onDidCloseSession`
   * subscription (constructor) drops the wiring.
   */
  private wireSession(handle: ISessionScopeHandle): void {
    if (this.sessionWirings.has(handle.id)) return;
    this.sessionWirings.set(handle.id, new SessionEventWiring(handle, this));
  }

  private unwireSession(sessionId: string): void {
    // v1's print-steer counters die with the Session object; drop ours with
    // every close path (ours, the engine's, or a delete).
    this.printSteerStates.delete(sessionId);
    const wiring = this.sessionWirings.get(sessionId);
    if (wiring === undefined) return;
    this.sessionWirings.delete(sessionId);
    wiring.dispose();
  }

  /**
   * The v1 summary of a live session, read from its own scope services (the
   * metadata document, the context's cwd/sessionDir, the workspace context's
   * additional dirs) rather than the index — no disk round-trip, and the
   * additional dirs only exist on the live session in both engines.
   */
  private async liveSessionSummary(handle: ISessionScopeHandle): Promise<SessionSummary> {
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const ctx = handle.accessor.get(ISessionContext);
    const workspace = handle.accessor.get(ISessionWorkspaceContext);
    // The live aggregate is authoritative for a live session: a just-resumed
    // session already has the restored outcome in memory, while the metadata
    // document can lag both the backfill and the clear (a retry started after
    // a failure), so never read the document here.
    const liveOutcome = handle.accessor.get(ISessionActivityView).state().lastTurnReason;
    return {
      id: meta.id,
      title: meta.title,
      titleKind: meta.titleKind,
      lastPrompt: meta.lastPrompt,
      workDir: ctx.cwd,
      sessionDir: ctx.sessionDir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      metadata: meta.custom as JsonObject | undefined,
      // The engine echoes additional dirs back exactly as the caller passed
      // them; every other path on a summary is forward-slashed.
      additionalDirs: workspace.additionalDirs.map(normalizeWorkDir),
      lastTurnReason: liveOutcome,
    };
  }

  /**
   * The `ResumedSessionSummary` of a just-materialized session, including the
   * per-agent snapshot v1 serves: the live slices are read from the restored
   * agent scope (profile / permission / swarm services and the klient agent
   * facade for context / plan / usage / background tasks), while `replay` and
   * `toolStore` are folded from the agent's `wire.jsonl` by
   * {@link foldAgentWireReplay} (v2 has no replay builder of its own).
   * `warning` stays undefined — v2's resume has no migration-warning channel.
   */
  private async resumedSessionSummary(
    handle: ISessionScopeHandle,
    replay?: { readonly includeSubagents?: boolean; readonly replayTurnLimit?: number },
  ): Promise<ResumedSessionSummary> {
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const agents: Record<string, ResumedAgentState> = {};
    // v1 resumes the main agent eagerly; materializing here cold-restores its
    // wire into the scope (create-or-get) and applies the default binding.
    const main = await this.materializeMainAgent(handle);
    agents[MAIN_AGENT_ID] = await this.resumedAgentState(
      handle,
      main,
      'main',
      replay?.replayTurnLimit,
    );
    if (replay?.includeSubagents === true) {
      const agentsDir = join(handle.accessor.get(ISessionContext).sessionDir, 'agents');
      let subagentIds: readonly string[] = [];
      try {
        subagentIds = (await readdir(agentsDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name !== MAIN_AGENT_ID)
          .map((entry) => entry.name);
      } catch {
        // No agents directory at all → the main agent is the whole roster.
      }
      for (const agentId of subagentIds) {
        try {
          // `create` is create-or-get and cold-restores the persisted wire.
          const agent = await handle.accessor.get(IAgentLifecycleService).create({ agentId });
          agents[agentId] = await this.resumedAgentState(
            handle,
            agent,
            'sub',
            replay.replayTurnLimit,
          );
        } catch {
          // Best-effort, same as v1: a subagent whose restore fails is left
          // out of the map (v1 logs a warning and continues with the rest).
        }
      }
    }
    return {
      ...(await this.liveSessionSummary(handle)),
      sessionMetadata: meta,
      agents,
      warning: undefined,
    };
  }

  /**
   * One agent's `ResumedAgentState`: the live slices read straight off the
   * restored agent scope, with `replay` and `toolStore` folded from the
   * agent's `wire.jsonl` by {@link foldAgentWireReplay}.
   */
  private async resumedAgentState(
    session: ISessionScopeHandle,
    agent: IAgentScopeHandle,
    type: 'main' | 'sub',
    replayTurnLimit?: number,
  ): Promise<ResumedAgentState> {
    const facade = this.klient.session(session.id).agent(agent.id);
    const ctx = session.accessor.get(ISessionContext);
    const [context, plan, usage, background, folded] = await Promise.all([
      facade.getContext(),
      facade.getPlan(),
      facade.getUsage(),
      facade.getTasks({ activeOnly: false }),
      foldAgentWireReplay(join(ctx.sessionDir, 'agents', agent.id, 'wire.jsonl')),
    ]);
    const profile = agent.accessor.get(IAgentProfileService).data();
    const toolPolicy = agent.accessor.get(IAgentToolPolicyService);
    const tools = agent.accessor.get(IAgentToolRegistryService).list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      active: toolPolicy.isToolActive(tool.name, tool.source),
      source: tool.source,
    }));
    return {
      type,
      config: {
        modelAlias: profile.modelAlias,
        modelCapabilities: profile.modelCapabilities,
        profileName: profile.profileName,
        thinkingLevel: profile.thinkingLevel,
        systemPrompt: profile.systemPrompt,
      },
      context: context as AgentContextData,
      replay: limitAgentReplayByTurns(folded.replay, replayTurnLimit),
      permission: {
        mode: agent.accessor.get(IAgentPermissionModeService).mode,
        rules: [...agent.accessor.get(IAgentPermissionRulesService).rules],
      } as ResumedAgentState['permission'],
      plan: plan as ResumedAgentState['plan'],
      swarmMode: agent.accessor.get(IAgentSwarmService).isActive,
      usage: usage as ResumedAgentState['usage'],
      tools: tools as ResumedAgentState['tools'],
      toolStore: folded.toolStore,
      background: background as readonly BackgroundTaskInfo[],
    };
  }

  /**
   * Every v2 workspace-id bucket addressing `workDir` (already normalized):
   * the registered workspace's alias set when the catalog knows the root, or
   * the freshly minted bucket key for index-only sessions (mirrors how v1's
   * store lists a bucket that never touched the workspace registry).
   */
  private async workspaceIdsFor(workDir: string): Promise<readonly string[]> {
    const workspaces = await this.klient.global.workspaces.list();
    const match = workspaces.find((workspace) => normalizeWorkDir(workspace.root) === workDir);
    if (match === undefined) return [encodeWorkDirKey(workDir)];
    return this.engineAccessor.get(IWorkspaceAliases).resolveAliasIds(match.id);
  }

  /**
   * The engine throws `Error2`; the SDK's public error contract is `KimiError`
   * (what `isKimiError` branches on, and what a host's `catch` narrows on).
   * Every boundary that hands an engine failure straight back to a caller
   * restates it — see {@link restateEngineError}. Wrap OUTSIDE
   * {@link retryWhileSessionIndexBuilding}, which still needs to recognize the
   * engine's own class.
   */
  private async engineCall<T>(call: () => Promise<T> | T): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw restateEngineError(error);
    }
  }

  /**
   * Absorb the session read model's `session.index_building` on behalf of the
   * caller: the code is retryable by contract, and an SDK host has no sensible
   * way to act on "come back later". Awaits the background prepare kicked at
   * construction, then retries once — a second refusal means the projection is
   * genuinely unavailable and belongs to the caller.
   */
  private async retryWhileSessionIndexBuilding<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!isSessionIndexBuilding(error)) throw error;
      await this.sessionIndexReady;
      await this.engineAccessor.get(ISessionIndex).prepare();
      return operation();
    }
  }

  override async listSessions(input: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    // Full-set semantics: drain keyset pages until the listing is exhausted
    // (an unpaged query currently answers in one page, but a backend may cap
    // it — never silently truncate the unpaged contract).
    const all: SessionSummary[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.listSessionsPage({
        workDir: input.workDir,
        sessionId: input.sessionId,
        before,
      });
      all.push(...page.items);
      if (page.nextCursor === undefined) return all;
      before = page.nextCursor;
    }
  }

  override async listSessionsPage(input: ListSessionsOptions = {}): Promise<SessionSummaryPage> {
    return this.retryWhileSessionIndexBuilding(() => this.listSessionsPageUnguarded(input));
  }

  private async listSessionsPageUnguarded(input: ListSessionsOptions = {}): Promise<SessionSummaryPage> {
    // v1 rejects an empty workDir and bucket-filters by the normalized path;
    // the v2 index filters by workspace-id set instead.
    const workspaceIds =
      input.workDir === undefined
        ? undefined
        : await this.workspaceIdsFor(normalizeRequiredWorkDir('listSessions', input.workDir));
    const workspacesById = new Map(
      (await this.klient.global.workspaces.list()).map((workspace) => [workspace.id, workspace]),
    );
    const collected: SessionSummary[] = [];
    let before = input.before;
    // Entries dropped by the mapping (unrecoverable workDir) shrink the page;
    // keep pulling keyset pages until the requested size is filled so callers
    // never see a short or empty page that still carries a cursor.
    for (;;) {
      const remaining = input.limit === undefined ? undefined : input.limit - collected.length;
      if (remaining !== undefined && remaining <= 0) break;
      const page = await this.klient.global.sessions.list({
        workspaceIds,
        sessionId: input.sessionId,
        limit: remaining,
        before,
      });
      if (page.items.length === 0) return { items: collected, nextCursor: undefined };
      for (const item of page.items) {
        const summary = this.mapIndexSummary(item, workspacesById);
        if (summary !== undefined) collected.push(summary);
      }
      if (page.nextCursor === undefined) return { items: collected, nextCursor: undefined };
      before = page.nextCursor;
      if (input.limit === undefined) return { items: collected, nextCursor: before };
    }
    return { items: collected, nextCursor: before };
  }

  /**
   * Map one v2 index summary to the v1 wire shape, resolving the filesystem
   * facts the index does not carry. Returns `undefined` when the session's
   * workDir is unrecoverable (corrupt metadata, deleted workspace): such a
   * session cannot be resumed on either engine, and v1's store never lists
   * one in the first place.
   */
  private mapIndexSummary(
    item: V2SessionSummary,
    workspacesById: ReadonlyMap<string, { readonly root: string }>,
  ): SessionSummary | undefined {
    const workDir = item.cwd ?? workspacesById.get(item.workspaceId)?.root;
    if (workDir === undefined) return undefined;
    // A live session reports its own outcome; the index may still carry a
    // stale one while the mirror's clear is queued (a fresh turn just
    // started after a failure).
    const liveHandle = getLiveSessionById(this.engineAccessor, item.id);
    const effectiveItem =
      liveHandle === undefined
        ? item
        : {
            ...item,
            lastTurnReason: liveHandle.accessor.get(ISessionActivityView).state().lastTurnReason,
          };
    const bootstrapService = this.engineAccessor.get(IBootstrapService);
    return v2SummaryToSessionSummary(effectiveItem, {
      workDir,
      sessionDir: sessionDirOf(
        bootstrapService.homeDir,
        workspacePersistenceScope(bootstrapService.scope('sessions'), item.workspaceId),
        item.id,
      ),
    });
  }

  /**
   * The shared facade registers the workspace and creates the session, including
   * its explicit id and optional profile binding. The SDK retains eager main
   * materialization for thinking/permission-only inputs, host event wiring,
   * and the caller's metadata in the returned summary. Error conversion stays
   * outside the index-readiness retry so a cold index can finish preparing.
   */
  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    return this.engineCall(() =>
      this.retryWhileSessionIndexBuilding(() => this.createSessionUnguarded(input)),
    );
  }

  private async createSessionUnguarded(input: CreateSessionOptions): Promise<SessionSummary> {
    // An explicit id takes the per-session queue so the check-then-create
    // below is atomic against another create/close of the same id; a random
    // id has no contenders and needs no serialization.
    if (input.id !== undefined) {
      return this.runSessionAccess(input.id, () => this.doCreateSession(input));
    }
    return this.doCreateSession(input);
  }

  private async doCreateSession(input: CreateSessionOptions): Promise<SessionSummary> {
    const workDir = normalizeRequiredWorkDir('createSession', input.workDir);
    if (input.id !== undefined) {
      const existing =
        this.liveSession(input.id) ??
        (await this.retryWhileSessionIndexBuilding(() =>
          this.engineAccessor.get(ISessionIndex).get(input.id!),
        ));
      if (existing !== undefined) {
        throw new KimiError(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${input.id}" already exists`,
        );
      }
    }
    try {
      return await this.withCreateSessionAgentFiles(input.agentFiles, async () => {
        const mainAgentBinding = this.createSessionMainBinding(input);
        const created = await this.klient.global.sessions.create({
          sessionId: input.id,
          workDir,
          additionalDirs: input.additionalDirs,
          mainAgentBinding,
        });
        const handle = this.requireLiveSession(created.id);
        // Wired before the optional main-agent materialization so a profile-bind
        // warning (oversized AGENTS.md) reaches the listeners like v1's create.
        this.wireSession(handle);
        if (
          mainAgentBinding === undefined &&
          (input.thinking !== undefined || input.permission !== undefined)
        ) {
          const agent = await this.materializeMainAgent(
            handle,
            input.thinking === undefined ? undefined : { thinking: input.thinking },
          );
          if (
            input.thinking !== undefined &&
            agent.accessor.get(IAgentProfileService).data().profileName === undefined
          ) {
            await this.engineCall(() =>
              this.klient.session(handle.id).agent(agent.id).setThinking(input.thinking!),
            );
          }
        }
        if (input.permission !== undefined) {
          await this.engineCall(() =>
            this.klient.session(handle.id).agent(MAIN_AGENT_ID).setPermission(input.permission!, { broadcast: false }),
          );
        }
        if (input.metadata !== undefined) {
          await this.klient.session(handle.id).update({ custom: { ...input.metadata } });
        }
        // v1 returns the caller's metadata verbatim on create (not the merged
        // custom map a later listing would report), so override it here too.
        return { ...(await this.liveSessionSummary(handle)), metadata: input.metadata };
      });
    } catch (error) {
      this.mapCreateSessionProfileError(error);
    }
  }

  /**
   * v1 renames through the live session when there is one and at the store
   * level otherwise. The v2 metadata service is session-scoped (and the
   * klient session facade 404s on a non-live session), so a closed session is
   * resumed, renamed, and closed again to land in the same state. The v2
   * `setTitle` does no validation, so v1's trim + empty-title rejection lives
   * here.
   */
  override async renameSession(input: RenameSessionInput): Promise<void> {
    return this.retryWhileSessionIndexBuilding(() => this.renameSessionUnguarded(input));
  }

  private async renameSessionUnguarded(input: RenameSessionInput): Promise<void> {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    await this.runSessionAccess(input.id, () =>
      this.withTemporarySession(input.id, () => this.klient.session(input.id).setTitle(title)),
    );
  }

  /**
   * v2-only (`ISessionTitleService`, session scope). Like `renameSession`, a
   * closed session is resumed, titled, and closed again so generation does
   * not leak a live session. `undefined` means generation was unavailable
   * (no managed OAuth login, no prompt yet, or a custom title is set) — the
   * current title is kept.
   */
  override async generateSessionTitle(
    input: GenerateSessionTitleInput,
  ): Promise<string | undefined> {
    return this.runSessionAccess(input.id, () =>
      this.withTemporarySession(input.id, () =>
        this.klient
          .session(input.id)
          .generateTitle({ force: input.force === true, source: input.source }),
      ),
    );
  }

  /**
   * Fork through the shared facade, including the explicit target id and
   * `turnIndex`. Truncation and the live-source busy rejection stay engine-owned;
   * failures retain the SDK's codes and details
   * (`request.invalid` with `{turnIndex, availableTurns}` /
   * `session.fork_active_turn`). The default title still differs by design
   * (v1: "New Session", v2: "Fork: <source>") — pass an explicit title for
   * identical results.
   */
  override async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    return this.engineCall(() =>
      this.retryWhileSessionIndexBuilding(() => this.forkSessionUnguarded(input)),
    );
  }

  private async forkSessionUnguarded(input: ForkSessionInput): Promise<SessionSummary> {
    // The source session's reads (metadata, wire flush) stay atomic against
    // its close/reload through the per-session queue; an explicit target id
    // takes a second (sorted) queue so fork(A→X) is also atomic against
    // create(X) / fork(B→X).
    return this.runSessionAccessAll(
      input.forkId === undefined ? [input.id] : [input.id, input.forkId],
      async () => {
        const program = await programForSession(this.engineAccessor, input.id);
        if (program === undefined) throw SDKRpcClient.sessionNotFound(input.id);
        const forked = await this.klient.session(input.id).fork({
          newSessionId: input.forkId,
          title: input.title,
          metadata: input.metadata,
          turnIndex: input.turnIndex,
        });
        const handle = this.requireLiveSession(forked.id);
        this.wireSession(handle);
        return this.resumedSessionSummary(handle);
      },
    );
  }

  override async closeSession(input: SessionIdRpcInput): Promise<void> {
    await this.runSessionAccess(input.sessionId, () =>
      this.klient.session(input.sessionId).close(),
    );
  }

  /**
   * The shared lifecycle closes the session before deleting its persisted data.
   * The SDK retains its per-session serialization and missing-session error.
   */
  override async deleteSession(input: SessionIdRpcInput): Promise<void> {
    return this.engineCall(() =>
      this.retryWhileSessionIndexBuilding(() => this.deleteSessionUnguarded(input)),
    );
  }

  private async deleteSessionUnguarded(input: SessionIdRpcInput): Promise<void> {
    return this.runSessionAccess(input.sessionId, async () => {
      try {
        await this.klient.session(input.sessionId).delete();
      } catch (error) {
        if (error instanceof RPCError && error.reason === ErrorCodes.SESSION_NOT_FOUND) {
          throw SDKRpcClient.sessionNotFound(input.sessionId);
        }
        throw error;
      }
    });
  }

  /**
   * Resume through the shared lifecycle without clearing the archived flag.
   * The SDK still wires host events and shapes the returned replay snapshot:
   * `includeSubagents` selects the agents and `replayTurnLimit` bounds each
   * agent's history through the shared `limitAgentReplayByTurns`.
   */
  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    return this.engineCall(() =>
      this.retryWhileSessionIndexBuilding(() => this.resumeSessionUnguarded(input)),
    );
  }

  private async resumeSessionUnguarded(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    return this.runSessionAccess(input.id, async () => {
      const resumed = await this.klient.session(input.id).resume({
        additionalDirs: input.additionalDirs,
      });
      if (!resumed) throw SDKRpcClient.sessionNotFound(input.id);
      const handle = this.requireLiveSession(input.id);
      this.wireSession(handle);
      if (input.agentProfile !== undefined) {
        await this.assertMainProfileBinding(handle, input.agentProfile);
      }
      return this.resumedSessionSummary(handle, {
        includeSubagents: input.includeSubagents,
        replayTurnLimit: input.replayTurnLimit,
      });
    });
  }

  /**
   * A session's main agent keeps the profile it was created with: the profile
   * decides the system prompt, tool policy and delegation surface the recorded
   * conversation was produced under, so resuming it as another profile would
   * reinterpret history. The engine has no equivalent guard for profiles (only
   * for routes, `ROUTE_SWITCH_FORBIDDEN`), so the SDK enforces the switch ban
   * its resume contract states. A resume that requests a profile for a session
   * with no binding is not a switch and is left alone.
   */
  private async assertMainProfileBinding(
    handle: ISessionScopeHandle,
    requested: string,
  ): Promise<void> {
    const agent = await ensureMainAgent(handle);
    const bound = agent.accessor.get(IAgentProfileService).data().profileName;
    if (bound === undefined || bound === requested) return;
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      `agent is already bound to profile "${bound}"; cannot switch to "${requested}" in this session`,
      { details: { sessionId: handle.id, boundProfile: bound, requestedProfile: requested } },
    );
  }

  /**
   * v1's reload: refuse while a turn runs, re-read config + plugins, close
   * the live session, resume from disk. The v2 busy check reads each live
   * agent's activity view (turn lane only — background tasks do not block,
   * matching v1's `hasActiveTurn`). `forcePluginSessionStartReminder` has no
   * v2 channel (the engine owns plugin session-start injection), so reload
   * refreshes the durable guidance snapshot through the Agent service.
   */
  override async reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary> {
    return this.engineCall(() =>
      this.retryWhileSessionIndexBuilding(() => this.reloadSessionUnguarded(input)),
    );
  }

  private async reloadSessionUnguarded(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary> {
    const sessionId = input.sessionId;
    return this.runSessionAccess(sessionId, async () => {
      const live = this.liveSession(sessionId);
      if (live !== undefined) {
        for (const agent of live.accessor.get(IAgentLifecycleService).list()) {
          if (agent.accessor.get(IAgentActivityView).state().turn !== undefined) {
            throw new KimiError(
              ErrorCodes.TURN_AGENT_BUSY,
              `Session "${sessionId}" cannot be reloaded while a turn is running`,
              { details: { sessionId } },
            );
          }
        }
      } else if (
        (await this.retryWhileSessionIndexBuilding(() =>
          this.engineAccessor.get(ISessionIndex).get(sessionId),
        )) === undefined
      ) {
        throw SDKRpcClient.sessionNotFound(sessionId);
      }
      await this.configReady;
      await this.klient.global.config.reload();
      await this.klient.global.plugins.reload();
      await this.refreshPluginSessionStarts(sessionId);
      if (live !== undefined) {
        await this.klient.session(sessionId).close();
      }
      let resumed: boolean;
      try {
        resumed = await this.klient.session(sessionId).resume();
      } catch (error) {
        this.engineAccessor
          .get(ITelemetryService)
          .withContext({ sessionId })
          .track2('session_load_failed', {
            reason:
              isError2(error)
                ? error.code
                : error instanceof RPCError && error.reason !== undefined
                  ? error.reason
                  : error instanceof Error
                    ? error.name
                    : 'unknown',
          });
        throw error;
      }
      if (!resumed) throw SDKRpcClient.sessionNotFound(sessionId);
      const handle = this.liveSession(sessionId);
      if (handle === undefined) throw SDKRpcClient.sessionNotFound(sessionId);
      const main = handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
      if (main !== undefined) {
        await this.engineCall(() =>
          this.klient.session(handle.id).agent(main.id).refreshPluginSessionStart(),
        );
      }
      this.wireSession(handle);
      return this.resumedSessionSummary(handle);
    });
  }

  private async refreshPluginSessionStarts(excludedSessionId?: string): Promise<void> {
    const workspaces = this.engineAccessor.get(IWorkspaceInstanceManager);
    await Promise.all(
      workspaces.list().map(async (handler) => {
        await handler.program.skills.reload();
        const sessions = this.engineAccessor
          .get(ISessionManager)
          .list()
          .filter(
            (session) => session.accessor.get(ISessionContext).workspaceId === handler.id,
          );
        await Promise.all(
          sessions.map(async (session) => {
            if (session.id === excludedSessionId) return;
            const main = session.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
            if (main === undefined) return;
            await this.engineCall(() =>
              this.klient.session(session.id).agent(main.id).refreshPluginSessionStart(),
            );
          }),
        );
      }),
    );
  }

  /**
   * The base-class contract merges the patch into the session's `custom` map
   * (v1 routes through the live session and 404s on a closed one; mirrored
   * here by {@link requireLiveSession}).
   */
  override async updateSessionMetadata(input: UpdateSessionMetadataRpcInput): Promise<void> {
    return this.retryWhileSessionIndexBuilding(() => this.updateSessionMetadataUnguarded(input));
  }

  private async updateSessionMetadataUnguarded(input: UpdateSessionMetadataRpcInput): Promise<void> {
    this.requireLiveSession(input.sessionId);
    const current = await this.klient.session(input.sessionId).get();
    const custom = { ...current.custom, ...input.metadata };
    await this.klient.session(input.sessionId).update({ custom });
  }

  /**
   * Through the session's handler (`IWorkspaceDirs`, workspace scope) — the
   * workspace-level add-dir surface: `persist: true` (default) appends to the
   * project-local `.kiki/local.toml`, `persist: false` joins the
   * handler's shared in-memory set. The set is shared by every session of
   * the workspace (a v1 `persist: false` dir was session-scoped and written
   * into session metadata to survive a resume; the v2 handler keeps it for
   * every session of the workspace until the process exits). Returns the
   * same `{additionalDirs, projectRoot, configPath, persisted}` shape as v1.
   */
  override async addAdditionalDir(input: AddAdditionalDirInput): Promise<AddAdditionalDirResult> {
    const handle = this.requireLiveSession(input.id);
    const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
    const workspace = await this.engineAccessor
      .get(IWorkspaceInstanceManager)
      .getOrCreate({ workspaceId });
    return workspace.program.dirs.addDir({ path: input.path, persist: input.persist });
  }

  /**
   * Through `engineAccessor` (`ISessionExportService`, app scope) — the v2
   * port of v1's export: same payload fields, same zip writer layout, same
   * live-session flush before the read, and the same
   * `SESSION_EXPORT_NOT_FOUND` for a session without an exportable directory.
   * Works on closed sessions on both engines (v1 reads the store, v2 the
   * index). Gaps, pinned in the migration tracker: v2 additionally validates
   * the host `version` (`SESSION_EXPORT_MISSING_VERSION` on blank — v1
   * records it unchecked), the manifest's activity timestamps come from v2's
   * per-agent wire scan (v1 scans only the root `wire.jsonl`), and the
   * manifest carries v2's extra `webLogPath` field (absent unless the host
   * passes a web log, which this client never does). The zip ENTRY LIST is
   * not part of the parity surface: the two engines lay their session
   * directories out differently by design.
   */
  override async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    return this.engineCall(() =>
      this.retryWhileSessionIndexBuilding(() => this.exportSessionUnguarded(input)),
    );
  }

  private async exportSessionUnguarded(input: ExportSessionInput): Promise<ExportSessionResult> {
    return this.engineAccessor.get(ISessionExportService).export({
      sessionId: input.id,
      outputPath: input.outputPath,
      includeGlobalLog: input.includeGlobalLog,
      version: input.version,
      installSource: input.installSource,
      shellEnv: input.shellEnv,
    });
  }

  /** The session-merged live skill catalog, with readiness owned by the shared facade. */
  override async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    this.requireLiveSession(input.sessionId);
    return this.engineCall(() => this.klient.session(input.sessionId).skills.list());
  }

  // -----------------------------------------------------------------------
  // Agent interaction
  //
  // v1 serves these from the session's eagerly-created main agent, already
  // configured with the model/thinking defaults. The v2 engine exposes the
  // agent/session domain calls through the klient facades; SDK-only mapping and
  // host integration stay around those calls. Every override requires a live
  // session (v1's `requireSession`) and resolves the target agent from
  // `interactiveAgentId`: the main agent materializes on first use with the
  // default profile bound (v1's eager equivalent); any other agent must
  // already exist (v1's `AGENT_NOT_FOUND`).
  // -----------------------------------------------------------------------

  private createSessionMainBinding(
    input: CreateSessionOptions,
  ):
    | {
        readonly profile: string;
        readonly model?: string;
        readonly thinking?: string;
      }
    | undefined {
    if (input.model === undefined && input.agentProfile === undefined) {
      return undefined;
    }
    return {
      profile: input.agentProfile ?? DEFAULT_AGENT_PROFILE_NAME,
      model: input.model,
      thinking: input.thinking,
    };
  }

  private async withCreateSessionAgentFiles<T>(
    agentFiles: readonly string[] | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (agentFiles === undefined) return run();
    // The engine loads these paths deep inside profile binding, where a missing
    // one surfaces as a bare `realpath failed: path does not exist` with no path
    // in it. The SDK took the paths from the caller, so it names the one it could
    // not load.
    for (const file of agentFiles) {
      if (!existsSync(file)) {
        throw new KimiError(
          ErrorCodes.AGENT_NOT_FOUND,
          `Agent file not found: ${normalizeWorkDir(file)}`,
          { details: { agentFile: file } },
        );
      }
    }
    const args = this.engineAccessor.get(IBootstrapService).args as {
      agentFiles?: readonly string[];
    };
    const previous = args.agentFiles;
    args.agentFiles = agentFiles;
    try {
      return await run();
    } finally {
      args.agentFiles = previous;
    }
  }

  private mapCreateSessionProfileError(error: unknown): never {
    if (
      (error instanceof ProfileError && error.code === ProfileErrors.codes.PROFILE_UNKNOWN) ||
      (error instanceof RPCError && error.reason === ProfileErrors.codes.PROFILE_UNKNOWN)
    ) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, error.message);
    }
    throw error;
  }

  /**
   * The session's materialized main agent with v1's eager default binding
   * applied: a freshly created agent whose profile is still unbound gets the
   * default profile + configured default model (the same bind kap-server's
   * prompt route performs on first use). A home with no configured model
   * leaves the agent unbound instead of failing — v1's model-less session
   * reads (`model: undefined`, `'off'` thinking, zero capabilities) map onto
   * the unbound state exactly.
   */
  private async materializeMainAgent(
    session: ISessionScopeHandle,
    binding?: { readonly profile?: string; readonly model?: string; readonly thinking?: string },
  ): Promise<IAgentScopeHandle> {
    await this.modelReady;
    const agent = await ensureMainAgent(session);
    const profile = agent.accessor.get(IAgentProfileService);
    if (binding !== undefined || profile.data().profileName === undefined) {
      try {
        await profile.bind({
          profile: binding?.profile ?? DEFAULT_AGENT_PROFILE_NAME,
          model: binding?.model,
          thinking: binding?.thinking,
        });
      } catch (error) {
        if (
          (binding === undefined || binding.model === undefined) &&
          error instanceof ProfileError &&
          error.code === ProfileErrors.codes.MODEL_NOT_CONFIGURED
        ) {
          return agent;
        }
        throw error;
      }
    }
    return agent;
  }

  /** The target agent's live scope handle (see the section header). */
  private async agentScope(sessionId: string): Promise<IAgentScopeHandle> {
    const session = this.requireLiveSession(sessionId);
    const agentId = this.interactiveAgentId;
    if (agentId === MAIN_AGENT_ID) return this.materializeMainAgent(session);
    const agent = session.accessor.get(IAgentLifecycleService).get(agentId);
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" was not found`);
    }
    return agent;
  }

  /**
   * The klient agent facade for the target agent. The scope is resolved
   * first so the main agent exists and carries its default binding before
   * the facade call crosses the channel (the channel's own materialization
   * leaves the profile unbound).
   */
  private async agentFacade(sessionId: string): Promise<AgentHandle> {
    await this.agentScope(sessionId);
    return this.klient.session(sessionId).agent(this.interactiveAgentId);
  }

  /**
   * Facade (`agentProfileService.setModel`). Both engines resolve the alias
   * up front, report the resolved provider name, and reject an unknown alias
   * with `config.invalid` (only the trailing message wording differs).
   */
  override async setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.setModel(input.model);
  }

  /** Sets thinking through the shared facade while retaining model-specific validation. */
  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() => agent.setThinking(input.effort));
  }

  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.setPermission(input.mode);
  }

  /** v1 maps the toggle onto two RPCs (`enterPlan` / `cancelPlan`); so does v2. */
  override async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    if (!input.enabled) return agent.cancelPlan();
    return agent.enterPlan();
  }

  override async getPlan(input: SessionIdRpcInput): Promise<SessionPlan> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getPlan();
  }

  override async clearPlan(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.clearPlan();
  }

  /** Facade (`agentCommandService.list`) — the v2-only contributed-command seam. */
  override async listCommands(input: SessionIdRpcInput): Promise<readonly AgentCommandInfo[]> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.listCommands();
  }

  /** Facade (`agentCommandService.run`) — runs the contribution engine-side. */
  override async runCommand(input: RunCommandRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.runCommand({ name: input.name, args: input.args });
  }

  override async getRuntime(input: SessionIdRpcInput): Promise<AgentRuntimeBinding> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getRuntime();
  }

  override async switchRuntime(input: SwitchSessionRuntimeRpcInput): Promise<AgentRuntimeBinding> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.switchRuntime(input.runtimeId);
  }

  /**
   * Facade (`getContext`, merged client-side from `agentContextMemoryService.get`
   * and `agentTokenCountingService.statusSize`). The v2 `AgentContextData` is the
   * same wire shape as v1's — the cast only bridges the two packages' type
   * declarations (v2's origin union carries kinds a v1 client never sees in
   * practice); the data itself crossed the same JSON boundary on both sides.
   * Token-count semantics differ by design: v1 reports the running estimate,
   * v2 the provider-measured prefix (`0` until the first LLM round) — pinned
   * in the parity KNOWN_DIFFS.
   */
  override async getContext(input: SessionIdRpcInput): Promise<AgentContextData> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getContext() as Promise<AgentContextData>;
  }

  override async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getUsage();
  }

  /**
   * The base class aggregates v1's per-agent `getConfig` / `getContext` /
   * `getPermission` / `getPlan` / `getSwarmMode` / `getUsage` RPCs. The v2
   * rebuild reads the same six slices: the profile's bound model alias and
   * resolved thinking level + capabilities (v1's agent `getConfig` — its
   * `provider?.model` fallback is unreachable without an alias), the
   * facade's context/plan/usage, and the permission-mode and swarm services.
   */
  override async getStatus(input: SessionIdRpcInput): Promise<SessionStatus> {
    await this.agentScope(input.sessionId);
    const facade = this.klient.session(input.sessionId).agent(this.interactiveAgentId);
    const [context, plan, usage, model, thinkingEffort, permission, swarmMode, capability] =
      await Promise.all([
        facade.getContext(),
        facade.getPlan(),
        facade.getUsage(),
        facade.getModel(),
        facade.getThinking(),
        facade.getPermission(),
        facade.getSwarmMode(),
        facade.getModelCapabilities(),
      ]);
    const maxContextTokens = capability.max_input_tokens ?? capability.max_context_tokens;
    const contextTokens = context.tokenCount;
    // Deliberately unclamped, same as the base class (>100% is the documented
    // overflow signal on this path).
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
    const hasUsage =
      usage.byModel !== undefined || usage.total !== undefined || usage.currentTurn !== undefined;
    return {
      model: model === '' ? undefined : model,
      thinkingEffort,
      permission,
      planMode: plan !== null,
      swarmMode,
      contextTokens,
      maxContextTokens,
      contextUsage,
      usage: hasUsage ? usage : undefined,
    };
  }

  /**
   * Facade (`agentLoopService.cancelFromUser`) plus the session-level init
   * run: v1's cancel cascades from the agent's turn to every foreground
   * subagent run of the session, and /init is the one session-level run v2
   * keeps off the agent turn lane — its abort controller lives in
   * session facade's `init` capability (a silent no-op when no init is running).
   */
  override async cancel(input: SessionIdRpcInput): Promise<void> {
    this.requireLiveSession(input.sessionId);
    await this.engineCall(() => this.klient.session(input.sessionId).init.cancelInit());
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancel();
  }

  /** Starts manual compaction through the shared facade; an active compaction remains a no-op. */
  override async compact(input: SessionIdRpcInput & CompactOptions): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() => agent.compact({ instruction: input.instruction }));
  }

  /** Cancels active compaction through the shared facade; a no-op when idle. */
  override async cancelCompaction(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() => agent.cancelCompaction());
  }

  /**
   * The session todo service stores one undoable todo state per agent. Pass the
   * interactive agent id explicitly so a child never reads or mutates the main
   * agent's todo list through the service default.
   */
  override async getTodos(input: SessionIdRpcInput): Promise<readonly SessionTodoItem[]> {
    await this.agentScope(input.sessionId);
    const todos = await this.engineCall(() =>
      this.klient.session(input.sessionId).todos.get(this.interactiveAgentId),
    );
    return todos.map((todo) => ({ title: todo.title, status: todo.status }));
  }

  override async undoHistory(input: SessionIdRpcInput & { count: number }): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() => agent.undo(input.count));
  }

  /**
   * v1's `context.clear` has no busy check and does not touch queued or running
   * prompts; the context-memory facade method preserves that behavior.
   */
  override async clearContext(input: SessionIdRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() => agent.clearContext());
  }

  /**
   * The SDK keeps v1's byte-identical message formatting in
   * `src/v2/import-context.ts`; busy, capacity, and append are one atomic core
   * context-mutation operation so no prompt or compaction can start between
   * those checks and the write. The reported post-import token-count gap is
   * unchanged and pinned in the parity KNOWN_DIFFS.
   */
  override async importContext(input: ImportContextRpcInput): Promise<void> {
    const agent = await this.agentScope(input.sessionId);
    const facade = this.klient.session(input.sessionId).agent(this.interactiveAgentId);
    const message = buildImportContextMessage(input.content, input.source);
    await this.engineCall(() => facade.appendImportedContext(message));
    // AgentStatusUpdated is the SDK's compatibility event adaptation; the
    // append itself is delegated through the atomic core operation.
    agent.accessor.get(IEventBus).publish(new AgentStatusUpdated({}));
  }

  /**
   * Facade (`agentPromptService.submit`). The launch result (`{turn_id}`, or
   * `undefined` when the prompt queued behind a running turn) is dropped —
   * v1's RPC returns void. The pre-provider surface matches v1: the metadata
   * update (title/lastPrompt) runs through the same shared helpers before the
   * turn launches, and a model-less turn fails asynchronously exactly like
   * v1's. One enqueue-semantics gap vs v1, pinned in the migration tracker:
   * v1 drops a prompt submitted while a turn is active (error event only)
   * where v2 queues it FIFO.
   */
  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    // Resolving the agent facade materializes the main agent, which is where a
    // model that cannot be resolved surfaces — so the restatement has to cover
    // it, not just the launch.
    await this.engineCall(async () => {
      const agent = await this.agentFacade(input.sessionId);
      await agent.prompt({
        input: input.input,
        disabledTools: input.disabledTools,
        promptId: input.promptId,
      });
    });
  }

  /**
   * Facade (`agentSkillService.promptWithSkills`) — bundled skill submission:
   * the engine renders every skill activation into the prompt's own user
   * message, so the bundle launches as one turn and undoes as a single
   * anchor. v2-only: the base class rejects this method on the v1 engine.
   * The launch result is dropped like `prompt` (v1's RPC shape returns void).
   */
  override async promptWithSkills(input: SessionPromptWithSkillsRpcInput): Promise<void> {
    await this.engineCall(async () => {
      const agent = await this.agentFacade(input.sessionId);
      await agent.promptWithSkills({
        input: input.input,
        skills: input.skills,
      });
    });
  }

  /**
   * Facade (`agentPromptService.submitSteer`). Matches v1 on both paths: mid-turn
   * steers join the running turn, and an idle-session steer degrades to
   * launching a fresh turn (the enqueue launches it directly) while
   * title/lastPrompt are updated like a prompt's.
   */
  override async steer(input: SessionPromptRpcInput): Promise<void> {
    await this.engineCall(async () => {
      const agent = await this.agentFacade(input.sessionId);
      await agent.steer({ input: input.input });
    });
  }

  /**
   * Facade (`agentShellCommandService.run`) — the same builtin-Bash execution
   * and `shell_command`-origin history records as v1, with an identical
   * `{stdout, stderr, isError?, backgrounded?}` result shape. The `commandId`
   * event stream (`shell.output` / `shell.started` / `shell.completed`) is
   * engine-side on both; translating it into SDK events is the event batch's
   * job, not this one's. Model-less gap, not pinned: v1's builtin tools only
   * exist on a profiled agent, so a model-less v1 session answers "Bash tool
   * is not available." where v2 runs the command.
   */
  override async runShellCommand(input: {
    sessionId: string;
    command: string;
    commandId?: string;
  }): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.runShellCommand({ command: input.command, commandId: input.commandId });
  }

  /** Facade (`agentShellCommandService.cancel`) — an unknown id is a silent no-op on both engines. */
  override async cancelShellCommand(input: {
    sessionId: string;
    commandId: string;
  }): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.cancelShellCommand({ commandId: input.commandId });
  }

  /** Activate through the shared facade; completion still arrives through the SDK event stream. */
  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() => agent.activateSkill({ name: input.name, args: input.args }));
  }

  /**
   * Through the agent facade's plugin-command capability: the same
   * `request.invalid` rejection text for an unknown command, the same
   * argument expansion, the activation event, the prompt enqueue, and the
   * main-agent-only metadata update. Two gaps vs v1,
   * pinned in the migration tracker: v1 resolves the command against the
   * session's creation-time snapshot (v2 uses the app-global live view), and
   * v1 drops the activation while a turn runs where v2 queues it.
   */
  override async activatePluginCommand(input: ActivatePluginCommandRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() =>
      agent.activatePluginCommand({
        pluginId: input.pluginId,
        commandName: input.commandName,
        args: input.args,
      }),
    );
  }

  /**
   * Through the session facade's `init.generateAgentsMd` capability, the
   * engine's port of v1's `Session.generateAgentsMd` — a session-level
   * operation pinned to the main agent on both engines, so
   * `interactiveAgentId` does not apply; the main agent is materialized first
   * (v1 creates it eagerly at createSession). The success path is a real
   * subagent LLM round (`/init` brief), so parity covers only the model-less
   * rejection: both engines fail with `session.init_failed`, with different
   * messages (v1 wraps the provider-resolution failure, v2 preflights the
   * missing binding) — pinned in the parity tests.
   */
  override async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    const session = this.requireLiveSession(input.sessionId);
    await this.materializeMainAgent(session);
    await this.engineCall(() =>
      this.klient.session(input.sessionId).init.generateAgentsMd(),
    );
  }

  /**
   * No v2 service implements the session-warnings aggregate, so the SDK rebuilds v1's
   * `Session.getSessionWarnings` over v2 primitives: the profile's cached
   * `agentsMdWarning` (computed on every bind, v1's bootstrap-time cache),
   * recomputed through the engine's own `prepareSystemPromptContext` when the
   * cache is empty — v1 recomputes on demand whenever no warning is cached,
   * so an AGENTS.md that outgrows the budget mid-session surfaces on both
   * engines. The single warning shape (`agents-md-oversized`, severity
   * `warning`) mirrors v1's assembly.
   */
  override async getSessionWarnings(input: SessionIdRpcInput) {
    await this.agentScope(input.sessionId);
    const facade = this.klient.session(input.sessionId).agent(this.interactiveAgentId);
    let warning = await this.engineCall(() => facade.getAgentsMdWarning());
    if (warning === undefined) {
      const session = this.requireLiveSession(input.sessionId);
      const prepared = await prepareSystemPromptContext(
        {
          fs: this.engineAccessor.get(IHostFileSystem),
          homeDir: this.engineAccessor.get(IHostEnvironment).homeDir,
        },
        session.accessor.get(ISessionContext).cwd,
        this.engineAccessor.get(IBootstrapService).homeDir,
        { additionalDirs: session.accessor.get(ISessionWorkspaceContext).additionalDirs },
      );
      warning = prepared.agentsMdWarning;
    }
    return warning === undefined
      ? []
      : [{ code: 'agents-md-oversized', message: warning, severity: 'warning' as const }];
  }

  /**
   * Through the session facade's `btw` capability. The v2 service is the port
   * of v1's btw fork: same inherited
   * profile/context, same byte-identical side-question reminder, same
   * tool-call deny, and the same return (the forked child's agent id). The
   * main agent is materialized first — both engines fork it as the source,
   * and v2's `fork('main')` throws on a missing source. Gaps, pinned in the
   * migration tracker: v2 always forks MAIN where v1 forks the agent
   * `interactiveAgentId` addresses (SDK hosts only ever btw the main agent),
   * and the v2 child is a regular persisted agent where v1's is memory-only
   * (`InMemoryAgentRecordPersistence`, no metadata).
   */
  override async startBtw(input: SessionIdRpcInput): Promise<string> {
    const session = this.requireLiveSession(input.sessionId);
    await this.materializeMainAgent(session);
    return this.engineCall(() => this.klient.session(input.sessionId).btw.start());
  }

  /**
   * Through the agent facade's swarm and context-injector capabilities. The v2
   * service is the port of v1's `SwarmMode`:
   * enter is idempotent and injects the byte-identical enter reminder for
   * non-`tool` triggers, exit pops that reminder when it is the last message
   * (appending the exit reminder otherwise), and `task` / `tool` triggers
   * auto-exit on turn end. The base class's private enter/exit pair is
   * replaced wholesale; `swarm()` below recomposes it over this override.
   */
  override async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    if (input.enabled) {
      await this.engineCall(() => agent.enterSwarm(input.trigger));
    } else {
      await this.engineCall(() => agent.exitSwarm());
    }
    await this.engineCall(() => agent.reconcileContextWhenIdle('swarm_mode'));
  }

  /** v1's `swarm()` composition: enter with the one-shot `task` trigger, then prompt. */
  override async swarm(input: SessionPromptRpcInput): Promise<void> {
    await this.setSwarmMode({ sessionId: input.sessionId, enabled: true, trigger: 'task' });
    return this.prompt(input);
  }

  // -----------------------------------------------------------------------
  // Goal / cron / background tasks / print policy
  //
  // The goal service is the v2 port of v1's `GoalMode` (same state machine,
  // same validations, same error codes), so the goal overrides are thin
  // forwards through the agent scope. Cron and the task manager moved from
  // per-agent (v1) to session/agent-scope services with field-identical
  // wire shapes; the two print-policy methods have no v2 service at all
  // (the native v2 print runner re-implements the same policy inline), so
  // they are rebuilt here over the engine's config helpers and the session's
  // per-agent task services.
  // -----------------------------------------------------------------------

  /** Goal lifecycle uses the shared facade and retains the engine's main-agent restriction. */
  override async createGoal(input: SessionIdRpcInput & CreateGoalInput): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return this.engineCall(() => agent.createGoal({ objective: input.objective, replace: input.replace }));
  }

  override async getGoal(input: SessionIdRpcInput): Promise<GoalToolResult> {
    const agent = await this.agentFacade(input.sessionId);
    return this.engineCall(() => agent.getGoal());
  }

  override async pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return this.engineCall(() => agent.pauseGoal());
  }

  override async resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return this.engineCall(() => agent.resumeGoal());
  }

  override async cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const agent = await this.agentFacade(input.sessionId);
    return this.engineCall(() => agent.cancelGoal());
  }

  /**
   * Through the session facade's cron capability. v1's cron manager is
   * per-agent: the main agent's
   * manager is what the v2 session-level service ports (it borrows the main
   * agent to steer fires), and a v1 subagent reports `[]` (`cron` is null) —
   * mirrored here for a non-main `interactiveAgentId`. The v1 snapshot shape
   * is restored field-by-field: `recurring` defaults to true, and the
   * post-jitter `nextFireAt` comes from the same scheduler read v1's
   * `listTaskSnapshots` forwards to.
   */
  override async getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult> {
    await this.agentScope(input.sessionId);
    if (this.interactiveAgentId !== MAIN_AGENT_ID) return { tasks: [] };
    const cron = this.klient.session(input.sessionId).cron;
    const tasks = await this.engineCall(() => cron.list());
    const nextFireAt = await Promise.all(
      tasks.map((task) => this.engineCall(() => cron.nextFireAt(task.id))),
    );
    return {
      tasks: tasks.map((task, index) => ({
        id: task.id,
        cron: task.cron,
        recurring: task.recurring !== false,
        createdAt: task.createdAt,
        lastFiredAt: task.lastFiredAt,
        nextFireAt: nextFireAt[index] ?? null,
      })),
    };
  }

  /**
   * Facade (`agentTaskService.list`). The v2 `AgentTaskInfo` union is the
   * same wire shape as v1's `BackgroundTaskInfo` — the process / agent /
   * question kinds are field-identical ports — so the cast only bridges the
   * two packages' type declarations. One content gap, pinned in the parity
   * KNOWN_DIFFS: after a detach, v2 rewrites the reported `timeoutMs` to the
   * detach deadline where v1 keeps the foreground one.
   */
  override async listBackgroundTasks(
    input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getTasks({ activeOnly: input.activeOnly, limit: input.limit }) as Promise<
      readonly BackgroundTaskInfo[]
    >;
  }

  /**
   * Facade (`agentTaskService.readOutput`) — same unknown-id-returns-`''`
   * behavior and the same trailing-characters `tail` semantics as v1.
   */
  override async getBackgroundTaskOutput(
    input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getTaskOutput({ taskId: input.taskId, tail: input.tail });
  }

  /**
   * Uses the facade's explicit-reason path rather than `stopTask`: omitting a
   * reason must call the engine's generic stop and must not stamp the
   * user-cancellation reason used by the public convenience method.
   */
  override async stopBackgroundTask(
    input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() =>
      agent.stopTaskWithReason({ taskId: input.taskId, reason: input.reason }),
    );
  }

  /**
   * Facade (`agentTaskService.detach`): releases the foreground tool-call
   * waiter and returns the live/ghost info or `undefined` for an unknown id.
   */
  override async detachBackgroundTask(
    input: SessionIdRpcInput & { taskId: string },
  ): Promise<BackgroundTaskInfo | undefined> {
    const agent = await this.agentFacade(input.sessionId);
    return this.engineCall(() => agent.detachTask(input.taskId)) as Promise<BackgroundTaskInfo | undefined>;
  }

  /**
   * v1's `Session.waitForBackgroundTasksOnPrint`, with the SDK-owned policy
   * gate and ceiling preserved. The shared session facade delegates the drain
   * to the core lifecycle service, which owns suppression, cross-agent
   * re-enumeration, and timer clamping. Config timing note: v1 reads the
   * `background` section captured at session creation; v2 resolves the live
   * config (the `[task]` section layered over `[background]`) — identical
   * unless the config changes mid-session.
   */
  override async waitForBackgroundTasksOnPrint(input: SessionIdRpcInput): Promise<void> {
    this.requireLiveSession(input.sessionId);
    await this.configReady;
    const config = this.engineAccessor.get(IConfigService);
    if (resolvePrintBackgroundMode(config) !== 'drain') return;
    const ceilingS =
      resolveAgentTaskConfig(config)?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    await this.engineCall(() =>
      this.klient.session(input.sessionId).drainBackgroundTasks(ceilingS * 1000),
    );
  }

  /**
   * v1's `Session.handlePrintMainTurnCompleted`, with exit/drain/steer policy
   * and the SDK-owned deadline/turn state preserved. Drain/count operations
   * delegate through the shared session facade so the core owns task
   * suppression and cross-agent enumeration.
   */
  override async handlePrintMainTurnCompleted(
    input: SessionIdRpcInput,
  ): Promise<'finish' | 'continue'> {
    this.requireLiveSession(input.sessionId);
    await this.configReady;
    const config = this.engineAccessor.get(IConfigService);
    const taskConfig = resolveAgentTaskConfig(config);
    const ceilingS = taskConfig?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    const mode = resolvePrintBackgroundMode(config);
    if (mode === 'exit') return 'finish';
    if (mode === 'drain') {
      await this.engineCall(() =>
        this.klient.session(input.sessionId).drainBackgroundTasks(ceilingS * 1000),
      );
      return 'finish';
    }
    // 'steer'
    const maxTurns = taskConfig?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT;
    const state = this.printSteerStates.get(input.sessionId) ?? { deadline: undefined, turns: 0 };
    this.printSteerStates.set(input.sessionId, state);
    const now = Date.now();
    state.deadline ??= now + ceilingS * 1000;
    state.turns += 1;
    if (now >= state.deadline) return 'finish';
    if (state.turns > maxTurns) return 'finish';
    const pendingCount = await this.engineCall(() =>
      this.klient.session(input.sessionId).countPendingBackgroundTasks(),
    );
    if (pendingCount > 0) return 'continue';
    return 'finish';
  }

  // -----------------------------------------------------------------------
  // MCP: the management plane (user-global CRUD, the standalone probe, the
  // locator-addressed inspection catalog, OAuth flows) delegates to the
  // `klient.global.mcp` facade; the session-level reads and connection
  // operations go through the agent facade's seeded MCP capability.
  // -----------------------------------------------------------------------

  private async mcpManagement<T>(
    call: (management: Klient['global']['mcp']) => Promise<T>,
  ): Promise<T> {
    return this.engineCall(() => call(this.klient.global.mcp));
  }

  override async listGlobalMcpServers(
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.list({ cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  override async getGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpManagedServerInfo> {
    const server = await this.mcpManagement((management) =>
      management.get({ name, cwd: options.cwd }),
    );
    return toManagedServerInfo(server);
  }

  override async listGlobalMcpServerAuthStatuses(
    options: { readonly cwd?: string; readonly verify?: boolean } = {},
  ): Promise<readonly GlobalMcpServerAuthStatus[]> {
    const statuses = await this.mcpManagement((management) =>
      management.authStatuses({ cwd: options.cwd, verify: options.verify }),
    );
    // The legacy surface never reports `unavailable` (no ambiguity check
    // here), so the engine's wider state union narrows to the v1 wire one.
    return statuses as readonly GlobalMcpServerAuthStatus[];
  }

  override async inspectAppMcpServers(
    targets?: readonly McpServerLocator[],
    options: { readonly cwd?: string } = {},
  ): Promise<readonly AppMcpServerInspection[]> {
    const inspections = await this.mcpManagement((management) =>
      management.inspect({ targets, cwd: options.cwd }),
    );
    // Field-identical with the v1 wire shape (the engines' locator /
    // config-view / auth-state declarations match structurally).
    return inspections as readonly AppMcpServerInspection[];
  }

  override async addGlobalMcpServer(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.add({ server, cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  override async updateGlobalMcpServer(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.update({ server, cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  override async removeGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = await this.mcpManagement((management) =>
      management.remove({ name, cwd: options.cwd }),
    );
    return servers.map(toManagedServerInfo);
  }

  /**
   * The legacy name-only entry point resolves its locator first: exactly one
   * enabled entry may own the runtime name, so a global/plugin collision
   * rejects instead of guessing which credential the flow acts on.
   */
  override async beginGlobalMcpServerAuth(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return this.mcpManagement(async (management) => {
      const query = { cwd: options.cwd };
      const locator = await management.resolveByName({ name, cwd: query.cwd });
      return management.beginAuth({ locator, cwd: query.cwd });
    });
  }

  override async beginMcpServerAuth(
    locator: McpServerLocator,
    options: { readonly cwd?: string } = {},
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return this.mcpManagement((management) =>
      management.beginAuth({ locator, cwd: options.cwd }),
    );
  }

  override async completeGlobalMcpServerAuth(
    input: {
      readonly flowId: string;
      readonly timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.completeMcpServerAuth(input, signal);
  }

  override async completeMcpServerAuth(
    input: {
      readonly flowId: string;
      readonly timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    return this.mcpManagement((management) =>
      management.completeAuth(input, { signal }),
    );
  }

  override async cancelGlobalMcpServerAuth(flowId: string): Promise<void> {
    return this.cancelMcpServerAuth(flowId);
  }

  override async cancelMcpServerAuth(flowId: string): Promise<void> {
    return this.mcpManagement((management) => management.cancelAuth({ flowId }));
  }

  override async resetGlobalMcpServerAuth(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<void> {
    return this.mcpManagement(async (management) => {
      const query = { cwd: options.cwd };
      const locator = await management.resolveByName({ name, cwd: query.cwd });
      return management.resetAuth({ locator, cwd: query.cwd });
    });
  }

  override async resetMcpServerAuth(
    locator: McpServerLocator,
    options: { readonly cwd?: string } = {},
  ): Promise<void> {
    return this.mcpManagement((management) =>
      management.resetAuth({ locator, cwd: options.cwd }),
    );
  }

  override async testGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return this.mcpManagement((management) =>
      management.test({ name, cwd: options.cwd }),
    );
  }

  /**
   * The inline-config channel of v1's `testGlobalMcpServer`: the same
   * schema-validated, unsaved probe — nothing has to be persisted first.
   */
  override async testGlobalMcpServerConfig(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return this.mcpManagement((management) =>
      management.test({ server, cwd: options.cwd }),
    );
  }

  /**
   * Through the agent facade's session-merged MCP view. This is a live
   * snapshot: create/resume no longer waits for MCP startup, so entries may
   * still be pending. The v2 `McpServerEntry` is field-identical with v1's
   * `McpServerInfo` (the cast bridges the two packages' type declarations).
   */
  override async listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]> {
    const agent = await this.agentFacade(input.sessionId);
    return agent.getMcpServers() as Promise<readonly McpServerInfo[]>;
  }

  /**
   * Workspace-level MCP view (the handler's one shared connection set), so
   * `/mcp` is inspectable on a v2 session-less startup before any session
   * exists. Awaits `ready` so a fresh handler's initial connect settles
   * before the list is read.
   * Same `McpServerEntry`-as-`McpServerInfo` cast as listMcpServers.
   */
  override async listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerInfo[]> {
    const handler = await this.engineAccessor
      .get(IWorkspaceInstanceManager)
      .getOrCreate({ root: normalizeRequiredWorkDir('listWorkspaceMcpServers', workDir) });
    const mcp = handler.program.mcp;
    await mcp.ready;
    return mcp.connectionManager().list() as readonly McpServerInfo[];
  }

  override async getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics> {
    const agent = await this.agentFacade(input.sessionId);
    await this.engineCall(() => agent.waitForMcpInitialLoad());
    const durationMs = await this.engineCall(() => agent.getMcpStartupDuration());
    return { durationMs };
  }

  /**
   * The session-merged MCP agent facade preserves the manager's reconnect and
   * explicit-config behavior. A merged ephemeral view still rejects the
   * explicit-config path through the core service rather than being flattened
   * into a generic JSON runtime surface.
   */
  override async reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void> {
    const agent = await this.agentFacade(input.sessionId);
    if (input.config === undefined) {
      await this.engineCall(() => agent.reconnectMcpServer(input.name));
      return;
    }
    const replacement = parseReconnectMcpServerConfig(input.name, input.config);
    // Parity with v1's manager reconnect: a disabled replacement is rejected
    // before anything is applied, not upserted over the live connection.
    if (replacement.enabled === false) {
      throw new KimiError(
        ErrorCodes.MCP_SERVER_DISABLED,
        `MCP server is disabled: ${input.name}`,
      );
    }
    await this.engineCall(() =>
      agent.connectMcpServer({ name: input.name, config: replacement }),
    );
  }

  /**
   * v1's `addSessionMcpServer`: validate, optionally persist to the user-level
   * file, then connect through the agent MCP facade. The v2 entry carries no
   * `source`/`config` tags, and an unpersisted add remains visible to sibling
   * sessions sharing the workspace manager; both are existing engine gaps.
   */
  override async addSessionMcpServer(input: {
    readonly sessionId: string;
    readonly server: McpServerConfig;
    readonly persist?: boolean;
  }): Promise<McpServerInfo> {
    const session = this.requireLiveSession(input.sessionId);
    const agent = await this.agentFacade(input.sessionId);
    const parsed = parseInlineMcpServer(input.server);
    // The store trims names; keep the manager entry and the persisted key on
    // the same normalized identity, like v1's addSessionMcpServer does.
    const target = { ...parsed, name: normalizeServerName(parsed.name) };
    if (input.persist === true) {
      const cwd = session.accessor.get(ISessionWorkspaceContext).workDir;
      await this.rejectProjectLayerPersistedMcpAdd(cwd, target.name);
      await this.mcpManagement((management) => management.add({ server: target, cwd }));
    }
    await this.engineCall(() =>
      agent.connectMcpServer({ name: target.name, config: mcpConfigWithoutName(target) }),
    );
    const entry = (await this.engineCall(() => agent.getMcpServers())).find(
      (candidate) => candidate.name === target.name,
    );
    if (entry === undefined) {
      throw new KimiError(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
        `MCP server "${target.name}" was not connected`,
      );
    }
    return entry as McpServerInfo;
  }
}

export function createKimiHarness(options: KimiHarnessOptions): KimiHarness {
  const rpc = new SDKRpcClient(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    // v1-core-owned ingestion limits; the v2 engine has no equivalent yet, so
    // ingestion falls back to env / built-in defaults like daemon-client hosts.
    imageLimits: undefined,
    sessionStartedProperties: options.sessionStartedProperties,
  });
}

/** v1's `requiredWorkDir`: reject blank and normalize to the canonical spelling. */
function normalizeRequiredWorkDir(operation: string, workDir: string): string {
  if (typeof workDir !== 'string' || workDir.trim() === '') {
    throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, `${operation} requires workDir`);
  }
  return normalizeWorkDir(workDir);
}

function isSessionIndexBuilding(error: unknown): boolean {
  const building: string = SessionIndexErrors.codes.SESSION_INDEX_BUILDING;
  if (isError2(error)) return error.code === building;
  // Reads that go through the klient facade get the same refusal restated as an
  // `RPCError`, which keeps the engine's code in `reason`. Without this the guard
  // only covered the calls made straight against engine services.
  return error instanceof RPCError && error.reason === building;
}

/**
 * Restate engine `Error2` and facade `RPCError` reasons in the SDK's public
 * `KimiError` shape. Failures without a domain reason (DI resolution bugs,
 * aborts and uncoded transport errors) pass through untouched.
 *
 * An engine code this build's registry does not declare (a newer engine than
 * the pinned SDK) restates as `internal` — stamping the unknown code would
 * mint a `KimiError` that `toKimiErrorPayload` cannot serialize (its
 * `KIMI_ERROR_INFO` lookup throws on undeclared codes).
 */
function restateEngineError(error: unknown): unknown {
  if (error instanceof RPCError && error.reason !== undefined) {
    return new KimiError(isKimiErrorCode(error.reason) ? error.reason : ErrorCodes.INTERNAL, error.message, {
      details: error.details as Record<string, unknown> | undefined,
      cause: error,
    });
  }
  if (!isError2(error)) return error;
  const code: KimiErrorCode = isKimiErrorCode(error.code) ? error.code : ErrorCodes.INTERNAL;
  return new KimiError(code, error.message, {
    details: error.details as Record<string, unknown> | undefined,
    cause: error.cause,
  });
}

/**
 * `session_started` belongs to the harness on the SDK route: its event is the one
 * carrying client attribution, ui mode and the host's process-level properties.
 * The engine tracks its own two-field `session_started` for every session scope
 * it activates, so forwarding that one as well would double count every session
 * start and hand the host a second event with a different payload under the same
 * name. Every other engine event passes through untouched.
 */
function withoutEngineSessionStarted(client: TelemetryClient): TelemetryClient {
  const filtered: TelemetryClient = {
    track: (event, properties) => {
      if (event === 'session_started') return;
      client.track(event, properties);
    },
  };
  if (client.withContext !== undefined) {
    filtered.withContext = (patch) => withoutEngineSessionStarted(client.withContext!(patch));
  }
  if (client.setContext !== undefined) {
    filtered.setContext = (patch) => {
      client.setContext!(patch);
    };
  }
  return filtered;
}

/**
 * v1's `toManagedServerInfo` over the engine's managed view: flatten the
 * config to the top level (mutable entries carry the full values, read-only
 * entries the redacted `envKeys` / `headerKeys` lists) and tag it with the
 * source metadata.
 */
function toManagedServerInfo(server: McpManagedServer): McpManagedServerInfo {
  return {
    name: server.name,
    ...server.config,
    source: server.source,
    origin: server.origin,
    mutable: server.mutable,
    plugin: server.plugin,
  } as McpManagedServerInfo;
}

function describeWorkspaceMcpServer(
  name: string,
  config: WorkspaceMcpServerConfig,
): WorkspaceTrustInfo['gatedMcpServers'][number] {
  if (config.transport === 'stdio') {
    return {
      name,
      transport: config.transport,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
    };
  }
  return { name, transport: config.transport, url: config.url };
}
