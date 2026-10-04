/**
 * Compatibility adapter for the GUI's historical client method names.
 * Transport, envelopes, deadlines, cancellation, and API paths belong to
 * `@kiki/klient`; this module only preserves GUI-facing wire shapes.
 */

import { nbSearchCapabilitiesSchema, nbSearchKeyUsageViewSchema, nbSearchTestStatusSchema, nbSearchManagedCredentialViewSchema, requestIdentityCatalogSchema, requestIdentityPreviewSchema, revealedSecretSchema, type NbSearchKeyUsageView, type NbSearchManagedCredentialView } from '@kiki/protocol';
import { createConnectionTransport, createKlient, HTTP_TRANSPORT_TIMEOUT_REASON } from '@kiki/klient/http';
import { translate } from '@kiki/session-core/i18n';
import { contentOriginalFileId, type ContentRef } from '@kiki/transcript';
import { createSessionTransport } from '@kiki/session-core/session/klientTransport';
import type {
  ActivateSkillRequest,
  ActivateSkillResult,
  ApprovalRequest,
  ApprovalResolveRequest,
  ApprovalResolveResult,
  ArchiveSessionResponse,
  AuthSummary,
  CancelTaskQuery,
  CloseTerminalResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  ConfigResponse,
  CreateModelRequest,
  CreateProviderRequest,
  CreateTerminalRequest,
  FileMeta,
  FsSearchResponse,
  GetTaskQuery,
  GetTerminalResponse,
  GoalFollowUpTiming,
  GoalSnapshot,
  GetCatalogProviderResponse,
  ListDiscoveredModelsResponse,
  ListMcpServersResponse,
  ListModelsResponse,
  ListProvidersResponse,
  ListSessionsQuery,
  ListSkillsResponse,
  ListTasksResponse,
  ListTerminalsResponse,
  ListToolsResponse,
  ListWorkspacesResponse,
  Message,
  MessageContent,
  MetaResponse,
  ModelEntity,
  PatchModelRequest,
  PatchProviderRequest,
  ProviderEntity,
  CreateNamedAgentProfileRequest as ProtocolCreateNamedAgentProfileRequest,
  ListNamedAgentProfilesResponse as ProtocolListNamedAgentProfilesResponse,
  ListShippedAgentProfilesResponse as ProtocolListShippedAgentProfilesResponse,
  NamedAgentModelProfile as ProtocolNamedAgentModelProfile,
  NamedAgentProfile as ProtocolNamedAgentProfile,
  NamedAgentRoute as ProtocolNamedAgentRoute,
  NamedAgentSpawnConstraints as ProtocolNamedAgentSpawnConstraints,
  NamedAgentSubagentLease as ProtocolNamedAgentSubagentLease,
  NbSearchCapabilities,
  NbSearchTestStatus,
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginQuery,
  OAuthLoginStartRequest,
  OAuthLogoutRequest,
  OAuthLogoutResponse,
  PageResponse,
  PatchConfigRequest,
  PermissionMode,
  PromptAbortResponse,
  TurnAbortResponse,
  PromptPlanGate,
  RequestIdentityPolicyWire,
  PromptListResponse,
  PromptMoveRequest,
  PromptMoveResult,
  PromptReplaceRequest,
  PromptReplaceResult,
  PromptSteerResult,
  PromptSubmission,
  PromptSubmitResult,
  PromptTimingRequest,
  PromptTimingResult,
  QuestionDismissResult,
  QuestionRequest,
  QuestionResolveRequest,
  QuestionResolveResult,
  RefreshProviderModelsResponse,
  RestartMcpServerResult,
  RestoreSessionResponse,
  Session,
  SessionCreate,
  SessionPersonaSettings,
  ApplyPersonaSettingsRequest,
  SetDefaultModelResponse,
  ShippedAgentProfile as ProtocolShippedAgentProfile,
  Task,
  TaskStatus,
  Terminal,
  UndoSessionResponse,
  UpdateNamedAgentProfileRequest as ProtocolUpdateNamedAgentProfileRequest,
  UpdateSessionProfileRequest,
  Workspace,
  PersonaAvatarDeleteResponse,
  PersonaAvatarShape,
  PersonaAvatarUploadResponse,
  PersonaCardFormat,
  PersonaDeleteResponse,
  PersonaImportPreview,
  PersonaImportResponse,
  PersonaPutInput,
  PersonaSnapshot,
  PersonaSummary,
} from '@kiki/protocol';

import { RPCError, type AgentFacade, type AgentEventPayloads, type HttpRestCronTask, type OAuthMethodStatus, type SessionViewFacade } from '@kiki/klient';
import { MAIN_AGENT_ID } from '@kiki/session-core/session';
import {
  fetchRemoteModels,
  providerTemplateFor,
  type ProviderModelDraft,
  type RemoteModelsProbe,
} from '@kiki/session-core/settings';
import { API_CODES, ApiError } from '@kiki/session-core/transport';

import { recordConnectionEvent } from '../state/connectionDiagnostics';
import type { UsageResponseWire } from './usageV2';

export { API_CODES, ApiError } from '@kiki/session-core/transport';

export function isSessionIndexBuildingError(error: unknown): boolean {
  return error instanceof ApiError && error.code === API_CODES.SESSION_INDEX_BUILDING;
}

/**
 * True when a human-readable load error (ApiError's `${msg} (code ${code})`
 * string) reports a missing session — drives the /s/:id auto-fallback.
 */
export function isSessionNotFoundMessage(message: string): boolean {
  return (
    message.includes('session.not_found') || message.includes(`code ${API_CODES.SESSION_NOT_FOUND}`)
  );
}

/**
 * Wire shapes for `POST /search` — the global cross-session message search.
 * These live in kap-server (`src/protocol/rest-search.ts`) and are not
 * re-exported by `@kiki/protocol`, so they are hand-rolled here from
 * that schema (snake_case on the wire).
 */
export interface SearchMessagesBody {
  query: string;
  mode?: 'terms' | 'literal';
  op?: 'AND' | 'OR';
  container?: { session_id?: string; agent_id?: string };
  workspace_id?: string;
  role?: 'user' | 'assistant' | 'title';
  start_time?: number;
  end_time?: number;
  sort?: 'score' | 'time_desc' | 'time_asc';
  page_size?: number;
  page_token?: string;
}

export interface SearchMessageHit {
  session_id: string;
  workspace_id: string;
  session_title: string;
  agent_id: string;
  role: 'user' | 'assistant' | 'title';
  snippet: string;
  /** Epoch milliseconds (the index normalizes seconds vs ms server-side). */
  time: number;
  turn?: number;
  step_id?: string;
  score: number;
}

export interface SearchMessagesResponse {
  items: SearchMessageHit[];
  has_more: boolean;
  page_token?: string;
  incomplete?: 'candidate_cap' | 'postings_budget' | 'deadline';
  index_state: {
    state: 'building' | 'ready' | 'readonly' | 'unavailable';
    indexed_sessions: number;
    total_sessions: number;
    documents: number;
    stale?: boolean;
    degraded?: string;
    reason?:
      | 'disabled'
      | 'indexer_backoff'
      | 'memory_budget'
      | 'wal_stuck'
      | 'disk_low'
      | 'corrupt_rebuilding'
      | 'sqlite_unavailable'
      | 'runtime_disabled';
  };
  source: 'live' | 'index';
}

/**
 * Optimistic-concurrency cursor for the message-closure routes
 * (`messages/{mid}:edit|regenerate`, `:fork` with a truncation point). The
 * server compares it against the session journal watermark and answers 40937
 * when the client acted on a stale view.
 */
export interface SessionCursor {
  readonly seq: number;
  readonly epoch?: string;
}

/** Optional per-run execution overrides shared by :edit / :regenerate. */
export interface MessageRunOverrides {
  readonly model?: string;
  readonly thinking?: string;
  readonly permission_mode?: PermissionMode;
  readonly plan_gate?: PromptPlanGate;
  readonly plan_mode?: boolean;
}

/** `POST /sessions/{sid}/messages/{mid}:edit` body — full replacement semantics. */
export interface EditMessageRequest extends MessageRunOverrides {
  readonly content: MessageContent[];
  readonly expected_cursor: SessionCursor;
}

/** `POST /sessions/{sid}/messages/{mid}:regenerate` body. */
export interface RegenerateMessageRequest extends MessageRunOverrides {
  readonly expected_cursor: SessionCursor;
}

/** `:fork` extension: truncate the forked history at a message (paired fields).
 * Fully local mirror (title/metadata echo ForkSessionRequest) so the app does
 * not depend on the in-flux protocol type. */
export interface KikiForkSessionRequest {
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly through_message_id?: string;
  readonly expected_cursor?: SessionCursor;
}

export interface RuntimeConfigProjection {
  readonly cron?: {
    readonly debug: boolean;
    readonly noJitter: boolean;
    readonly noStale: boolean;
    readonly disabled: boolean;
    readonly manualTick: boolean;
    readonly clock?: string;
    readonly pollIntervalMs?: number | null;
  };
  readonly thread_communication?: { readonly enabled: boolean };
  readonly token_counting?: { readonly strategy: 'measured+estimated' | 'measured' | 'estimated' };
  readonly workspace_instance?: { readonly idleTtlMs?: number };
  readonly image?: { readonly maxEdgePx?: number; readonly readByteBudget?: number };
  readonly task?: {
    readonly maxRunningTasks?: number;
    readonly keepAliveOnExit?: boolean;
    readonly bashAutoBackgroundOnTimeout?: boolean;
    readonly bashTaskTimeoutS?: number;
    readonly killGracePeriodMs?: number;
    readonly printWaitCeilingS?: number;
    readonly printBackgroundMode?: 'exit' | 'drain' | 'steer';
    readonly printMaxTurns?: number;
    readonly bashFileToolHints?: boolean;
  };
  readonly identity?: {
    readonly name?: string;
    readonly slug?: string;
    readonly advertiseAsKimiCode?: boolean;
  };
  readonly extra_agent_dirs?: string[];
  readonly skip_builtin_profile_installation?: string[];
  readonly disabled_named_profiles?: string[];
  readonly mcp?: { readonly startupTimeoutMs?: number; readonly toolTimeoutMs?: number };
  readonly plugins?: { readonly marketplaceUrl?: string };
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
  readonly agents?: {
    readonly enabled?: boolean;
    readonly notify_parent?: boolean;
    readonly delegation?: { readonly sub?: boolean; readonly independent?: boolean };
  };
  readonly loop_control?: {
    readonly maxStepsPerTurn?: number;
    readonly maxAttemptsPerStep?: number;
    readonly subagentContextStrategy?: 'summarize' | 'auto' | 'fresh';
  };
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly policies?: ReadonlyArray<{
      readonly match: string;
      readonly maxAttempts?: number;
      readonly backoff?: number;
      readonly retry?: boolean;
    }>;
  };
  readonly thinking?: { readonly enabled?: boolean; readonly effort?: string; readonly keep?: string };
}

export type KikiConfigResponse = Omit<ConfigResponse, 'subagent'> & RuntimeConfigProjection & {
  readonly subagent?: NonNullable<ConfigResponse['subagent']> & {
    readonly denyModels?: string[];
  };
  /**
   * Canonical nb_search patch object (snake_case subtree preserved verbatim
   * by kap-server's key conversion). Not in the shared protocol schema yet;
   * the Search & retrieval leaf owns its structured editing.
   */
  readonly nb_search?: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseConfigStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return [...new Set(value)];
  }
  throw new ApiError({
    code: API_CODES.INVALID_RESPONSE,
    msg: `Invalid config response: ${field} must be a string or string array`,
    data: value,
  });
}

/** Validate and canonicalize the config payload before it can reach shared UI caches. */
export function parseKikiConfigResponse(data: unknown): KikiConfigResponse {
  if (!isPlainObject(data)) {
    throw new ApiError({
      code: API_CODES.INVALID_RESPONSE,
      msg: 'Invalid config response: data must be a plain object',
      data,
    });
  }

  const toolsValue = data['tools'];
  if (toolsValue !== undefined && toolsValue !== null && !isPlainObject(toolsValue)) {
    throw new ApiError({
      code: API_CODES.INVALID_RESPONSE,
      msg: 'Invalid config response: tools must be a plain object',
      data: toolsValue,
    });
  }
  const tools = toolsValue === undefined || toolsValue === null ? {} : toolsValue;

  return {
    ...data,
    extra_agent_dirs: parseConfigStringList(data['extra_agent_dirs'], 'extra_agent_dirs'),
    skip_builtin_profile_installation: parseConfigStringList(
      data['skip_builtin_profile_installation'],
      'skip_builtin_profile_installation',
    ),
    disabled_named_profiles: parseConfigStringList(
      data['disabled_named_profiles'],
      'disabled_named_profiles',
    ),
    tools: {
      ...tools,
      enabled: parseConfigStringList(tools['enabled'], 'tools.enabled'),
      disabled: parseConfigStringList(tools['disabled'], 'tools.disabled'),
    },
  } as KikiConfigResponse;
}

export interface RuntimeConfigPatch {
  readonly cron?: {
    readonly debug: boolean;
    readonly no_jitter: boolean;
    readonly no_stale: boolean;
    readonly disabled: boolean;
    readonly manual_tick: boolean;
    readonly clock?: string;
    readonly poll_interval_ms?: number | null;
  };
  readonly thread_communication?: { readonly enabled: boolean };
  readonly token_counting?: { readonly strategy: 'measured+estimated' | 'measured' | 'estimated' };
  readonly workspace_instance?: { readonly idle_ttl_ms?: number };
  readonly image?: { readonly max_edge_px?: number; readonly read_byte_budget?: number };
  readonly task?: {
    readonly max_running_tasks?: number;
    readonly keep_alive_on_exit?: boolean;
    readonly bash_auto_background_on_timeout?: boolean;
    readonly bash_task_timeout_s?: number;
    readonly kill_grace_period_ms?: number;
    readonly print_wait_ceiling_s?: number;
    readonly print_background_mode?: 'exit' | 'drain' | 'steer';
    readonly print_max_turns?: number;
    readonly bash_file_tool_hints?: boolean;
  };
  readonly identity?: {
    readonly name?: string;
    readonly slug?: string;
    readonly advertise_as_kimi_code?: boolean;
  };
  readonly extra_agent_dirs?: string[];
  readonly skip_builtin_profile_installation?: string[];
  readonly disabled_named_profiles?: string[];
  readonly mcp?: { readonly startup_timeout_ms?: number; readonly tool_timeout_ms?: number };
  readonly plugins?: { readonly marketplace_url?: string };
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
  readonly agents?: {
    readonly enabled?: boolean;
    readonly notify_parent?: boolean;
    readonly delegation?: { readonly sub?: boolean; readonly independent?: boolean };
  };
  readonly retry?: {
    readonly max_attempts?: number;
    readonly policies?: ReadonlyArray<{
      readonly match: string;
      readonly max_attempts?: number;
      readonly backoff?: number;
      readonly retry?: boolean;
    }>;
  };
  readonly thinking?: { readonly enabled?: boolean; readonly effort?: string; readonly keep?: string };
}

export type KikiConfigPatch = Omit<
  PatchConfigRequest,
  'subagent' | 'replace_domains' | 'request_identity'
> & RuntimeConfigPatch & {
  readonly request_identity?: RequestIdentityPolicyWire | null;
  /** Full-domain nb_search replace body; always paired with replace_domains. */
  readonly nb_search?: Record<string, unknown>;
  readonly subagent?: NonNullable<PatchConfigRequest['subagent']> & {
    readonly deny_models?: string[];
  };
  readonly replace_domains?: readonly string[];
};

export type { OAuthMethodStatus };
export type NamedAgentRoute = ProtocolNamedAgentRoute;
export type NamedAgentModelProfile = ProtocolNamedAgentModelProfile;
export type NamedAgentSpawnConstraints = ProtocolNamedAgentSpawnConstraints;
export type NamedAgentSubagentLease = ProtocolNamedAgentSubagentLease;
export type NamedAgentProfile = ProtocolNamedAgentProfile;
export type ListNamedAgentProfilesResponse = ProtocolListNamedAgentProfilesResponse;
export type CreateNamedAgentProfileRequest = ProtocolCreateNamedAgentProfileRequest;
export type UpdateNamedAgentProfileRequest = ProtocolUpdateNamedAgentProfileRequest;
export type ShippedAgentProfile = ProtocolShippedAgentProfile;
export type ListShippedAgentProfilesResponse = ProtocolListShippedAgentProfilesResponse;
/**
 * `POST /executors/{id}/check` result. Mirrors `executorCheckResponseSchema`
 * (the protocol exports the schema but no inferred type).
 */
export interface ExecutorCheckResult {
  readonly id: string;
  readonly status: 'ready' | 'warning' | 'unavailable';
  readonly version?: string;
  readonly command: string;
  readonly selected_source?: string;
  readonly resolved_args: readonly string[];
  readonly login_status: 'logged_in' | 'logged_out' | 'unknown';
  /** Which credential the engine already has. Absent from servers that predate it. */
  readonly credential_source?: import('@kiki/protocol').ExecutorCredentialSource;
  readonly credential_detail?: string;
  readonly diagnostics: readonly { readonly code?: string; readonly severity: 'info' | 'warning' | 'error'; readonly message: string }[];
  /** Setup order: declared dependencies, then the launched program. Absent from servers that predate it. */
  readonly requirements?: readonly import('@kiki/protocol').ExecutorRequirement[];
}

/**
 * Goal-control inputs mirrored from the engine's goal service (the klient
 * agent facade types them out of agent-core, which apps must not import).
 * `updateAgentGoal` rides `expectedRevision` for optimistic concurrency: a
 * stale revision fails with 40001 so the editor can reload and re-apply.
 */
export interface CreateAgentGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly followUpTiming?: GoalFollowUpTiming;
  readonly initialStatus?: 'active' | 'paused';
  readonly replace?: boolean;
}

export interface UpdateAgentGoalInput {
  readonly goalId: string;
  readonly expectedRevision?: number;
  readonly objective?: string;
  readonly completionCriterion?: string | null;
  readonly followUpTiming?: GoalFollowUpTiming;
}

export interface ResumeAgentGoalInput {
  readonly continueIfPaused?: boolean;
  readonly continueIfBlocked?: boolean;
}

/**
 * Aggregated cron task from `GET /api/cron` (typed in klient's rest facade —
 * see `HttpRestCronTask`). Paused tasks carry `next_fire_at: null` and sort last.
 */
export type CronTask = HttpRestCronTask;

export interface ListCronTasksResponse {
  readonly items: readonly CronTask[];
  readonly has_more?: boolean;
  readonly next_offset?: number;
}

/**
 * Memory wire shapes (`/api/memory/*`, kap-server `routes/memory.ts`; the
 * entry and journal types mirror agent-core-v2 `app/memory/memoryStore.ts`).
 * Not part of `@kiki/protocol`, so they are hand-rolled here.
 */
/** `persona*` scopes are one persona's own namespace (global, or inside one workspace). */
export type MemoryScopeKind = 'global' | 'workspace' | 'persona' | 'persona_workspace';
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export type MemoryStatus = 'active' | 'pending' | 'superseded' | 'archived';
export type MemoryWriter = 'user' | 'agent' | 'consolidator' | 'import';
export type MemoryApproval = 'auto' | 'review' | 'off';

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

export interface MemoryEntry {
  readonly id: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  readonly status: MemoryStatus;
  readonly pinned: boolean;
  readonly created: string;
  readonly updated: string;
  readonly source: { readonly writer: MemoryWriter; readonly session?: string; readonly turn?: number | string; readonly step?: string };
  readonly reason: string;
  readonly superseded_by?: string;
  readonly supersedes?: string;
  readonly supersedes_revision?: string;
  /**
   * Set on a pending review candidate: the action accepting it will perform on
   * the entry it supersedes. The candidate's own id and revision are what a
   * decision is made against; accepting an `update` keeps the original entry's
   * id, and `archive` archives that entry rather than the candidate.
   */
  readonly pending_action?: 'update' | 'archive';
  readonly revision: string;
}

export interface MemorySettings {
  readonly enabled: boolean;
  readonly approval: MemoryApproval;
  readonly budget: number;
  readonly workspaces: Readonly<Record<string, boolean>>;
  readonly effective_enabled?: boolean;
}

export interface MemoryWorkspaceSettings {
  readonly workspace_id: string;
  /** `null` follows the global switch. */
  readonly enabled: boolean | null;
  readonly effective_enabled: boolean;
}

export interface MemoryJournalRecord {
  readonly operationId: string;
  readonly action: string;
  readonly id: string;
  readonly at: string;
  readonly writer: MemoryWriter;
  readonly before: string | null;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
}

/**
 * Which store a memory call addresses: `workspaceId` is required for the two
 * workspace scopes, `personaId` for the two persona scopes.
 */
export interface MemoryTarget {
  readonly scope: MemoryScopeKind;
  readonly workspaceId?: string;
  readonly personaId?: string;
}

export interface MemoryPutBody {
  readonly action?: 'create' | 'update' | 'supersede' | 'archive';
  readonly type: MemoryType;
  readonly title: string;
  readonly body: string;
  readonly reason: string;
  readonly expected_revision?: string;
  readonly pinned?: boolean;
}

export interface MemoryListQuery {
  readonly query?: string;
  readonly type?: MemoryType;
  readonly include_inactive?: boolean;
}

/** 40423 / 40944 on the memory routes. */
export const MEMORY_NOT_FOUND = 40423;
export const MEMORY_REVISION_CONFLICT = 40944;

export interface CapabilityStatus {
  readonly id: 'kimi-cu' | 'kimi-webbridge' | 'kiki-computer' | 'kiki-browser';
  readonly pluginId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supported: boolean;
  readonly state: 'not_installed' | 'partial' | 'ready' | 'unsupported';
  /** Installed release, when the entry reports one. */
  readonly version?: string;
  readonly steps: readonly {
    readonly id: string;
    readonly state: 'ok' | 'missing' | 'failed';
    /**
     * Machine-readable reason the client localizes. `detail` is the detector's
     * own sentence and belongs in folded diagnostics, not the first screen —
     * see the WebBridge readiness card in `PluginsSection`.
     */
    readonly reason?: string;
    readonly detail?: string;
    readonly optional?: boolean;
  }[];
  readonly install: { readonly running: boolean; readonly step?: string; readonly percent?: number; readonly error?: string; readonly note?: string };
  readonly plan?: {
    readonly artifact: { readonly version: string; readonly url: string; readonly sha256: string; readonly metadataUrl: string; readonly maxBytes: number };
    readonly destination: string;
    readonly browserExtensionUrl?: string;
    readonly note: string;
  };
}

/** Agent hosts that can load the `kiki-as-subagent` skill from their user skills folder. */
export type HostSkillTarget = 'claude' | 'codex' | 'grok' | 'agents';

/** Preview/result of installing the external-host skill (`revision` pins the previewed target). */
export interface HostSkillInstallPreview {
  readonly host: string;
  readonly directory: string;
  readonly path: string;
  readonly overwrites: boolean;
  readonly revision: string;
}

/** GitHub update status from `pluginService.checkUpdates` (GitHub installs only). */
export interface PluginUpdateStatus {
  readonly id: string;
  readonly source: 'local-path' | 'zip-url' | 'github';
  readonly current?: { readonly kind: 'branch' | 'tag' | 'sha'; readonly value: string };
  readonly latest: { readonly kind: 'branch' | 'tag' | 'sha'; readonly value: string };
  /** Tag, or the first 12 hex of the tracked branch's head commit. */
  readonly displayVersion: string;
  readonly updateAvailable: boolean;
}

/** Installed plugin summary from GET /api/plugins. */
export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  /** Manifest icon inlined as a `data:` URI (svg/png); inert in an `<img>`. */
  readonly icon?: string;
  readonly enabled: boolean;
  readonly state: 'ok' | 'error';
  readonly skillCount: number;
  readonly mcpServerCount: number;
  readonly enabledMcpServerCount: number;
  readonly hookCount: number;
  readonly commandCount: number;
  readonly hasErrors: boolean;
  readonly source: 'local-path' | 'zip-url' | 'github';
  readonly originalSource?: string;
  readonly github?: {
    readonly owner: string;
    readonly repo: string;
    readonly ref: { readonly kind: 'branch' | 'tag' | 'sha'; readonly value: string };
    readonly installedSha?: string;
  };
  readonly zipSha256?: string;
  /** The previous managed copy a rollback switches back to. */
  readonly rollback?: {
    readonly version?: string;
    readonly source: 'local-path' | 'zip-url' | 'github';
    readonly originalSource?: string;
  };
}

export interface ListPluginsResponse {
  readonly plugins: readonly PluginSummary[];
}

export interface PluginMarketplaceEntry {
  readonly id: string;
  readonly tier: 'official' | 'curated' | 'third-party';
  readonly displayName: string;
  readonly description?: string;
  readonly homepage?: string;
  /** `data:` URI (local official entries, inlined by the server) or http(s) URL. */
  readonly icon?: string;
  readonly keywords?: readonly string[];
  readonly relevance?: {
    readonly cwd?: readonly string[];
    readonly fileGlobs?: readonly string[];
    readonly commands?: readonly string[];
    readonly dependencies?: readonly string[];
  };
  readonly version?: string;
  readonly source: string;
  readonly installed?: { readonly version?: string; readonly enabled: boolean };
  readonly updateAvailable?: boolean;
}

export interface PluginMarketplaceResponse {
  readonly configured: boolean;
  readonly source?: string;
  readonly entries: readonly PluginMarketplaceEntry[];
}

export interface PluginMcpServerInfo {
  readonly name: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export interface PluginDiagnostic {
  readonly severity: 'error' | 'warn' | 'info';
  readonly message: string;
}

export interface PluginInfo extends PluginSummary {
  readonly root: string;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly manifestKind?: 'kimi-plugin-root' | 'kimi-plugin-dir';
  readonly manifestPath?: string;
  readonly manifest?: Readonly<Record<string, unknown>>;
  readonly prerequisites?: {
    readonly origin: 'kiki-compatibility' | 'plugin-declared';
    readonly items: { readonly schemaVersion: 1; readonly items: readonly {
      readonly id: string; readonly kind: string; readonly required: boolean;
      readonly version?: string; readonly setting?: string; readonly executionHost?: string;
    }[] };
  };
  readonly mcpServers: readonly PluginMcpServerInfo[];
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface KikiClientTransport {
  readonly fetch: typeof fetch;
  readonly eventsUrl: string;
}

export function createRemoteSpaceClient(options: {
  endpoint: string;
  token: string;
  connectionId: string;
  timeoutMs?: number;
  onSessionMutation?: (sessionId: string) => void;
}): KikiClient {
  const endpoint = options.endpoint === '' ? globalThis.location.origin : options.endpoint;
  return new KikiClient({
    baseUrl: endpoint, token: options.token, timeoutMs: options.timeoutMs,
    onSessionMutation: options.onSessionMutation,
    transport: createConnectionTransport({ ...options, endpoint }),
  });
}

export interface KikiClientOptions {
  readonly transport?: KikiClientTransport;
  /** Absolute base (`http://host:port`) or '' for same-origin (dev proxy). */
  readonly baseUrl: string;
  readonly token?: string;
  /** Per-request deadline; defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Refresh connection-scoped attention data after an acknowledged user action. */
  readonly onSessionMutation?: (sessionId: string) => void;
}

export type AgentTranscriptFrame =
  | {
      kind: 'text';
      frameId: string;
      role: 'assistant' | 'user';
      text: string;
      /** Linked task entity for user-role inputs about a task. */
      taskId?: string;
      /** Engine prompt origin for non-typed user inputs (e.g. {kind:'task'}). */
      origin?: unknown;
    }
  | { kind: 'thinking'; frameId: string; text: string }
  | {
      kind: 'tool';
      frameId: string;
      toolCallId: string;
      name: string;
      state: 'running' | 'done' | 'error' | 'interrupted';
      input?: unknown;
      output?: unknown;
      display?: unknown;
      error?: string;
      inputText?: string;
      startedAt?: string;
      endedAt?: string;
      progress?: { text?: string };
      /** Agents spawned by this call. */
      agentRefs?: readonly { readonly agentId: string; readonly role?: 'child' }[];
    }
  | { kind: 'notice'; frameId: string; level: 'error' | 'warning' | 'info'; message: string };

export interface AgentTranscriptTurn {
  readonly kind: 'turn';
  readonly turnId: string;
  readonly prompt?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  /**
   * External-executor turn metadata (`executor.turn.metadata` →
   * `TranscriptTurn.execution`); opaque passthrough, validated in the
   * projection (`turnExecutionFromItem`).
   */
  readonly execution?: unknown;
  readonly steps: readonly {
    stepId: string;
    startedAt?: string;
    endedAt?: string;
    frames: readonly AgentTranscriptFrame[];
  }[];
}

/**
 * Session-global interaction entity (approval/question).
 *
 * Gap: the wire entity has no origin / parent-agent field. Origin is implied
 * by the requested `agent_id` (and the unpaginated `agents` roster), not
 * shipped per interaction. Do not invent one client-side.
 */
export interface AgentTranscriptInteraction {
  readonly interactionId: string;
  readonly interactionKind: 'approval' | 'question';
  readonly toolCallId?: string;
  readonly origin?: unknown;
  readonly anchor?: unknown;
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  readonly request?: unknown;
  readonly response?: unknown;
}

/**
 * One entry of the unpaginated `agents` roster on a transcript page.
 * Local mirror of the transcript-package `AgentDescriptor` (that package is
 * not a GUI dependency).
 */
export interface AgentTranscriptAgent {
  readonly agentId: string;
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string;
  readonly delegator?:
    | { readonly kind: 'agent'; readonly agentId: string }
    | { readonly kind: 'external'; readonly delegationId: string };
  readonly label?: string;
  readonly createdAt?: string;
  readonly disposedAt?: string;
}

/**
 * Engine `TokenUsage` wire shape (`stepUsageSchema`), copied through opaquely
 * on task and agent-status usage slices.
 */
export interface AgentTranscriptStepUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

/** Unpaginated task entity (`tasks[]` on every transcript page). */
export interface AgentTranscriptTask {
  readonly taskId: string;
  readonly kind: 'shell' | 'subagent' | 'tool' | 'other';
  readonly state: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  readonly detached: boolean;
  readonly name?: string;
  readonly subagentName?: string;
  readonly description?: string;
  readonly agentId?: string;
  readonly outputTail: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly stateReason?: string;
  /** Token usage of the finished run (`subagent.completed`). */
  readonly usage?: AgentTranscriptStepUsage;
}

/** Unpaginated attachment metadata (`attachments[]`; bytes never ride this API). */
export interface AgentTranscriptAttachment {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly name?: string;
  readonly size?: number;
  readonly source?:
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'file'; readonly fileId: string }
    | { readonly kind: 'session_media'; readonly fileId: string };
  readonly placeholder?: string;
}

/** Unpaginated todo document (`todos[]`). */
export interface AgentTranscriptTodo {
  readonly todoId: string;
  readonly items: readonly {
    readonly title: string;
    readonly status: 'pending' | 'in_progress' | 'done';
  }[];
  readonly updatedAt?: string;
}

/** Unpaginated prompt-queue entity (`prompts[]`). */
export interface AgentTranscriptPrompt {
  readonly promptId: string;
  readonly status: 'running' | 'queued' | 'blocked' | 'completed' | 'failed' | 'aborted';
  readonly userMessageId?: string;
  readonly content?: unknown;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly steeredAt?: string;
}

/** Unpaginated floating meta (`meta`). */
export interface AgentTranscriptMeta {
  readonly goal?: {
    readonly objective: string;
    readonly status: 'active' | 'paused' | 'blocked' | 'complete';
    readonly completionCriterion?: string;
    readonly budgetUsed?: number;
    readonly budgetLimit?: number;
  };
  readonly modes?: {
    readonly plan?: { readonly reviewPath?: string; readonly version?: number };
  };
  readonly activity?: 'idle' | 'turn' | 'disposing' | 'unknown';
  readonly agent?: {
    readonly model?: string;
    readonly thinkingEffort?: string;
    readonly usage?: {
      readonly byModel?: Readonly<Record<string, AgentTranscriptStepUsage>>;
      readonly currentTurn?: AgentTranscriptStepUsage;
      readonly total?: AgentTranscriptStepUsage;
    };
    readonly contextTokens?: number;
    readonly maxContextTokens?: number;
    readonly contextUsage?: number;
    readonly permission?: 'manual' | 'yolo' | 'auto';
    /**
     * Wire-owned `agentPhaseSchema` (idle / running / streaming / tool_call /
     * retrying / awaiting_approval / interrupted / ended). The full
     * discriminated union lives in `@kiki/transcript`; GUI only
     * pass-throughs it.
     */
    readonly phase?: { readonly kind: string; readonly [key: string]: unknown };
  };
}

/**
 * `GET /sessions/{id}/transcript` page. `items` / `has_more` are the turn
 * window; `agents`, `tasks`, `interactions`, `attachments`, `todos`,
 * `prompts`, `meta`, and `pending_interactions` are session-global and ship
 * with every page. Newer fields stay optional so a compact legacy body still
 * type-checks.
 */
export interface AgentTranscriptResponse {
  readonly agent_id: string;
  /** Complete agent-history count; absent when only a partial history is known. */
  readonly tool_call_count?: number;
  readonly items: readonly (
    | AgentTranscriptTurn
    | { kind: 'marker'; markerId: string; marker: string; at?: string }
    | { kind: 'taskref'; refId: string; taskId: string; at?: string }
  )[];
  readonly has_more: boolean;
  /** Session-global interaction entities (approval/question), shipped
   * unpaginated with every transcript response. `request`/`response` carry
   * the engine payloads (v2 field names: toolName/action/display/questions). */
  readonly interactions?: readonly AgentTranscriptInteraction[];
  readonly agents?: readonly AgentTranscriptAgent[];
  readonly tasks?: readonly AgentTranscriptTask[];
  readonly todos?: readonly AgentTranscriptTodo[];
  readonly prompts?: readonly AgentTranscriptPrompt[];
  readonly meta?: AgentTranscriptMeta;
  readonly pending_interactions?: readonly string[];
  /** Op-batch watermark: this state includes every batch with seq <= N. */
  readonly seq?: number;
  readonly attachments?: readonly AgentTranscriptAttachment[];
  readonly origin?: unknown;
  readonly anchor?: unknown;
}

/**
 * `GET /sessions` query widened with `workspace_id` — kap-server accepts it
 * (`sessionsListQueryCoercion`) but `@kiki/protocol`'s
 * `ListSessionsQuery` has not caught up, so the client advertises it locally.
 */
export interface ListSessionsOptions extends ListSessionsQuery {
  readonly workspace_id?: string;
}

/**
 * Durable-mailbox acceptance for a message sent to a persisted external agent.
 * `null` means the target is a native agent: its message takes the ordinary
 * prompt path, which has no mailbox receipt to report.
 */
export type AgentMessageReceipt = Awaited<
  ReturnType<ReturnType<ReturnType<typeof createKlient>['session']>['sendUserAgentMessage']>
>;

export class ExternalAgentAttachmentUnsupportedError extends Error {
  constructor() {
    super('External agent messages support text only. Remove attachments and retry.');
    this.name = 'ExternalAgentAttachmentUnsupportedError';
  }
}

export class NativeChildPromptSendError extends Error {
  constructor(cause: unknown) {
    super('Native child prompt result unknown', { cause });
    this.name = 'NativeChildPromptSendError';
  }
}

export class NativeChildPromptConflictError extends NativeChildPromptSendError {
  constructor(cause: unknown) {
    super(cause);
    this.name = 'NativeChildPromptConflictError';
  }
}

/** Model-switch contract types, derived from the agent facade so the wire shape has one owner. */
export type ModelSwitchInput = Parameters<AgentFacade['switchModel']>[0];
export type ModelSwitchReceipt = Awaited<ReturnType<AgentFacade['switchModel']>>;
export type QueuedModelSwitch = Awaited<ReturnType<AgentFacade['listModelSwitches']>>[number];
export type ModelSwitchState = ModelSwitchReceipt['state'];
export type ModelSwitchMode = ModelSwitchInput['mode'];
export type AgentModelSwitchEvent =
  | { readonly kind: 'queued'; readonly entry: AgentEventPayloads['prompt.model_switch_queued']['entry']; readonly queueIndex: number }
  | { readonly kind: 'status'; readonly operationId: string; readonly receipt: ModelSwitchReceipt };

export class KikiClient {
  readonly baseUrl: string;
  readonly klient: ReturnType<typeof createKlient>;
  readonly sessions: ReturnType<typeof createSessionTransport>;
  private readonly token: string | undefined;
  private readonly transport: KikiClientTransport | undefined;
  private serverLeaseId: string | undefined;
  private readonly previewBytes = new Map<string, { bytes: Uint8Array; mime: string; name?: string; etag: string }>();
  private previewCacheBytes = 0;
  private readonly onSessionMutation: KikiClientOptions['onSessionMutation'];

  constructor(options: KikiClientOptions) {
    this.onSessionMutation = options.onSessionMutation;
    this.transport = options.transport;
    this.baseUrl = options.baseUrl;
    this.token = options.token !== undefined && options.token !== '' ? options.token : undefined;
    this.klient = createKlient({
      endpoint: this.baseUrl,
      token: this.token,
      timeoutMs: options.timeoutMs,
      onSocketDiagnostic: (event) => { recordConnectionEvent(event); },
      ...options.transport,
    });
    const sessions = createSessionTransport(this.klient);
    // Controllers consume this transport directly, not the convenience methods below.
    this.sessions = {
      ...sessions,
      submitPrompt: (...args) => this.runSessionMutation(args[0], () => sessions.submitPrompt(...args)),
      editMessage: (...args) => this.runSessionMutation(args[0], () => sessions.editMessage(...args)),
      regenerateMessage: (...args) => this.runSessionMutation(args[0], () => sessions.regenerateMessage(...args)),
      abortPrompt: (...args) => this.runSessionMutation(args[0], () => sessions.abortPrompt(...args)),
      abortTurn: (...args) => this.runSessionMutation(args[0], () => sessions.abortTurn(...args)),
      movePrompt: (...args) => this.runSessionMutation(args[0], () => sessions.movePrompt(...args)),
      replacePrompt: (...args) => this.runSessionMutation(args[0], () => sessions.replacePrompt(...args)),
      timingPrompt: (...args) => this.runSessionMutation(args[0], () => sessions.timingPrompt(...args)),
      steerPrompt: (...args) => this.runSessionMutation(args[0], () => sessions.steerPrompt(...args)),
      resolveApproval: (...args) => this.runSessionMutation(args[0], () => sessions.resolveApproval(...args)),
      resolveQuestion: (...args) => this.runSessionMutation(args[0], () => sessions.resolveQuestion(...args)),
      dismissQuestion: (...args) => this.runSessionMutation(args[0], () => sessions.dismissQuestion(...args)),
      cancelTask: (...args) => this.runSessionMutation(args[0], () => sessions.cancelTask(...args)),
    };
  }

  /** Also used by specialized approval routes that bypass the session transport. */
  async runSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const result = await operation();
    this.onSessionMutation?.(sessionId);
    return result;
  }

  sessionView(sessionId: string): SessionViewFacade {
    const view = this.klient.session(sessionId).view;
    return {
      snapshot: async (options) => {
        const snapshotKlient = createKlient({
          endpoint: this.baseUrl,
          token: this.token,
          timeoutMs: 0,
          ...this.transport,
        });
        try {
          return await this.run(() => snapshotKlient.session(sessionId).view.snapshot(options));
        } finally {
          await snapshotKlient.close();
        }
      },
      transcript: view.transcript,
      subscribe: (input, onSignal) => view.subscribe(input, onSignal),
    };
  }

  private get rest(): import('@kiki/klient').HttpRestFacade {
    const rest = this.klient.rest;
    if (rest === undefined) throw new Error('KAP REST domains are unavailable on this transport');
    return rest;
  }

  private async run<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T> {
    try {
      return await (typeof operation === 'function' ? operation() : operation);
    } catch (error) {
      if (error instanceof RPCError) {
        const timedOut = error.reason === HTTP_TRANSPORT_TIMEOUT_REASON;
        throw new ApiError({
          code: timedOut ? API_CODES.TIMEOUT : error.code,
          msg: timedOut ? error.message.replace('call timed out', translate('en', 'common.requestTimedOut')) : error.message,
          data: error.data ?? null,
          details: error.details,
          request_id: error.requestId,
        });
      }
      throw error;
    }
  }

  healthz(baseUrlOverride?: string): Promise<boolean> {
    return this.rest.healthz(baseUrlOverride);
  }

  meta(): Promise<MetaResponse & { experimental_flags?: Record<string, boolean> }> {
    return this.run(() => this.rest.meta());
  }

  async renewLease(_body: { readonly clientId: string; readonly kind: 'gui' }): Promise<void> {
    const lease = await this.run(() => this.rest.renewLease({ lease_id: this.serverLeaseId }));
    if (lease !== undefined) this.serverLeaseId = lease.lease_id;
  }

  listSessions(query: ListSessionsOptions = {}): Promise<import('@kiki/protocol').ListSessionsResponse> {
    return this.run(() => this.rest.sessions.list(query));
  }

  listEphemeralSessions(query?: Pick<ListSessionsOptions, 'before_id' | 'page_size' | 'workspace_id' | 'persona'>): Promise<import('@kiki/protocol').ListEphemeralSessionsResponse> {
    return this.run(() => this.rest.sessions.listEphemeral(query));
  }

  createSession(body: SessionCreate): Promise<Session> {
    return this.run(() => this.rest.sessions.create(body));
  }

  saveEphemeralSession(sessionId: string): Promise<Session> {
    return this.run(() => this.rest.sessions.saveEphemeral(sessionId));
  }

  endEphemeralSession(sessionId: string, worktree?: 'keep' | 'remove'): Promise<import('@kiki/protocol').EndEphemeralSessionResponse> {
    return this.run(() => this.rest.sessions.endEphemeral(sessionId, { worktree }));
  }

  getRequestGovernance(): Promise<import('@kiki/protocol').RequestGovernanceSnapshot> {
    return this.run(() => this.rest.requestGovernance());
  }

  /**
   * Replaces the request limit rules (Usage → Limits). Add, edit, toggle, and
   * delete all send the full list: the config write replaces the section's
   * rule array wholesale and the change is live on the next request.
   */
  setRequestGovernanceRules(
    rules: readonly import('@kiki/protocol').RequestGovernanceSnapshot['rules'][number][],
  ): Promise<KikiConfigResponse> {
    return this.patchConfig({
      request_governance: {
        rules: rules.map((rule) => ({
          id: rule.id,
          scope: rule.scope,
          ...(rule.models !== undefined ? { models: [...rule.models] } : {}),
          ...(rule.providers !== undefined ? { providers: [...rule.providers] } : {}),
          subagents_only: rule.subagentsOnly,
          ...(rule.maxConcurrent !== undefined ? { max_concurrent: rule.maxConcurrent } : {}),
          overflow: rule.overflow,
          ...(rule.maxWaitMs !== undefined ? { max_wait_ms: rule.maxWaitMs } : {}),
          enabled: rule.enabled,
        })),
      },
    });
  }

  getUsageRescan(): Promise<import('@kiki/protocol').UsageRescanStatus> {
    return this.run(() => this.rest.usageRescan.status());
  }

  startUsageRescan(): Promise<import('@kiki/protocol').UsageRescanStatus> {
    return this.run(() => this.rest.usageRescan.start());
  }

  /** Cross-session usage aggregation. Filter axes travel in the query. */
  getUsage(
    query: Record<string, string | number | boolean | undefined>,
  ): Promise<UsageResponseWire> {
    return this.run(() => this.rest.usage(query));
  }

  /** Per-model prices the usage estimate uses, with where each came from. */
  getUsagePricing(models?: readonly string[]): Promise<import('@kiki/protocol').UsagePricingResponse> {
    return this.run(() => this.rest.usagePricing.get(models));
  }

  /** Set (a price) or clear (`null`) per-model overrides; unlisted models keep theirs. */
  setUsagePricing(update: import('@kiki/protocol').UsagePricingUpdate): Promise<import('@kiki/protocol').UsagePricingResponse> {
    return this.run(() => this.rest.usagePricing.set(update));
  }

  getSession(sessionId: string): Promise<Session> {
    return this.sessions.getSession(sessionId);
  }

  /** Rename etc. — `POST /api/sessions/{id}/profile`. */
  updateSessionProfile(
    sessionId: string,
    body: UpdateSessionProfileRequest,
  ): Promise<Session> {
    return this.run(() => this.rest.sessions.updateProfile(sessionId, body));
  }

  /** The persona copy this conversation runs, against the persona's current one. */
  getPersonaSettings(sessionId: string): Promise<SessionPersonaSettings> {
    return this.run(() => this.rest.sessions.getPersonaSettings(sessionId));
  }

  /**
   * Apply the persona's current settings to this conversation at its next idle
   * boundary. `restoreDefaults` also drops the conversation's own overrides.
   */
  applyPersonaSettings(sessionId: string, input: ApplyPersonaSettingsRequest = {}): Promise<SessionPersonaSettings> {
    return this.run(() => this.rest.sessions.applyPersonaSettings(sessionId, input));
  }

  archiveSession(sessionId: string): Promise<ArchiveSessionResponse> {
    return this.run(() => this.rest.sessions.archive(sessionId));
  }

  restoreSession(sessionId: string): Promise<RestoreSessionResponse> {
    return this.run(() => this.rest.sessions.restore(sessionId));
  }

  getSessionGoal(sessionId: string): Promise<GoalSnapshot | null> {
    return this.run(() => this.rest.sessions.goal(sessionId));
  }

  /**
   * Goal control rides the main agent's facade (goal ownership is main-agent
   * only). `GET /sessions/{id}/goal` stays the read path — it resolves the
   * real goalId the transcript projection cannot carry.
   */
  createAgentGoal(sessionId: string, input: CreateAgentGoalInput): Promise<GoalSnapshot> {
    return this.run(() => this.klient.session(sessionId).agent(MAIN_AGENT_ID).createGoal(input));
  }

  updateAgentGoal(sessionId: string, input: UpdateAgentGoalInput): Promise<GoalSnapshot> {
    return this.run(() => this.klient.session(sessionId).agent(MAIN_AGENT_ID).updateGoal(input));
  }

  pauseAgentGoal(sessionId: string): Promise<GoalSnapshot> {
    return this.run(() => this.klient.session(sessionId).agent(MAIN_AGENT_ID).pauseGoal());
  }

  resumeAgentGoal(sessionId: string, input: ResumeAgentGoalInput = {}): Promise<GoalSnapshot> {
    return this.run(() => this.klient.session(sessionId).agent(MAIN_AGENT_ID).resumeGoal(input));
  }

  cancelAgentGoal(sessionId: string): Promise<GoalSnapshot> {
    return this.run(() => this.klient.session(sessionId).agent(MAIN_AGENT_ID).cancelGoal());
  }

  /**
   * Cold-recovery release: no-op unless the engine is holding a restored
   * queue (`recoveryHold`), so a stale click is harmless.
   */
  resumeRecoveredQueue(sessionId: string): Promise<void> {
    return this.run(() => this.klient.session(sessionId).agent(MAIN_AGENT_ID).resumeRecoveredPromptQueue());
  }

  /** Older-history pages: `?before_id=<oldest loaded message id>&page_size=N`. */
  listMessages(
    sessionId: string,
    query: { before_id?: string; page_size?: number } = {},
  ): Promise<PageResponse<Message>> {
    return this.run(() => this.rest.sessions.listMessages(sessionId, query));
  }

  listPrompts(sessionId: string): Promise<PromptListResponse> {
    return this.run(() => this.rest.sessions.listPrompts(sessionId));
  }

  submitPrompt(sessionId: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    return this.sessions.submitPrompt(sessionId, body);
  }

  replacePrompt(sessionId: string, promptId: string, body: PromptReplaceRequest): Promise<PromptReplaceResult> {
    return this.sessions.replacePrompt(sessionId, promptId, body);
  }

  movePrompt(sessionId: string, promptId: string, body: PromptMoveRequest): Promise<PromptMoveResult> {
    return this.sessions.movePrompt(sessionId, promptId, body);
  }

  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse> {
    return this.sessions.abortPrompt(sessionId, promptId);
  }

  abortTurn(sessionId: string, turnId: number): Promise<TurnAbortResponse> {
    return this.sessions.abortTurn(sessionId, turnId);
  }

  /**
   * Steer a queued prompt into the currently running turn (`POST …:steer`):
   * the server merges its content into the active turn immediately instead of
   * waiting for the turn to end, and the prompt leaves the queue. The server
   * answers PROMPT_NOT_FOUND when no turn is active or the prompt already
   * left the queue.
   */
  steerPrompt(sessionId: string, promptId: string): Promise<PromptSteerResult> {
    return this.sessions.steerPrompt(sessionId, promptId);
  }

  /**
   * Re-time a queued prompt (`POST …/prompts/{pid}:timing`). The body carries
   * the last known scheduling `revision` as `expected_revision` so a stale
   * client loses with 40001 instead of silently overwriting a newer pick.
   */
  timingPrompt(sessionId: string, promptId: string, body: PromptTimingRequest): Promise<PromptTimingResult> {
    return this.sessions.timingPrompt(sessionId, promptId, body);
  }

  listPendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
    return this.run(() => this.rest.sessions.listApprovals(sessionId));
  }

  /**
   * `selected_option_id` is the external-permission round-trip (design §9):
   * the exact ACP option id the user picked. Additive on the REST schema —
   * until kap-server ships it the field rides the body harmlessly (the zod
   * object strips unknown keys), and once it lands the same body shape is
   * authoritative.
   */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    body: ApprovalResolveRequest & { readonly selected_option_id?: string },
  ): Promise<ApprovalResolveResult> {
    return this.sessions.resolveApproval(sessionId, approvalId, body);
  }

  listPendingQuestions(sessionId: string): Promise<QuestionRequest[]> {
    return this.run(() => this.rest.sessions.listQuestions(sessionId));
  }

  resolveQuestion(sessionId: string, questionId: string, body: QuestionResolveRequest): Promise<QuestionResolveResult> {
    return this.sessions.resolveQuestion(sessionId, questionId, body);
  }

  dismissQuestion(sessionId: string, questionId: string): Promise<QuestionDismissResult> {
    return this.sessions.dismissQuestion(sessionId, questionId);
  }

  listTasks(sessionId: string, query?: { status?: TaskStatus; page_size?: number; offset?: number }): Promise<ListTasksResponse> {
    return this.run(() => this.rest.sessions.listTasks(sessionId, query));
  }

  /** Single task; `with_output` opts into the tail-of-log preview (≤32KB default). */
  getTask(sessionId: string, taskId: string, query: GetTaskQuery = {}): Promise<Task> {
    return this.run(() => this.rest.sessions.getTask(sessionId, taskId, query));
  }

  cancelTask(
    sessionId: string,
    taskId: string,
    query: CancelTaskQuery = {},
  ): Promise<{ cancelled: boolean }> {
    return this.sessions.cancelTask(sessionId, taskId, query);
  }

  /** Stop a subagent dispatch task through the task-owning agent's facade. */
  stopAgentTask(sessionId: string, agentId: string, taskId: string): Promise<void> {
    return this.run(this.klient.session(sessionId).agent(agentId).stopTask({ taskId }));
  }

  /**
   * Fork a side agent (`/btw`) from the main agent's current context. The
   * side agent has no tools and answers from what the conversation already
   * holds; the main turn is not interrupted. Resolves to the new agent id.
   */
  startSideQuestion(sessionId: string): Promise<string> {
    return this.run(() => this.klient.session(sessionId).btw.start());
  }

  /** Whether `agentId` runs on kiki's own engine (steerable) or an external executor (mailbox only). */
  async isNativeAgent(sessionId: string, agentId: string): Promise<boolean> {
    if (agentId === MAIN_AGENT_ID) return true;
    const agents = await this.run(() => this.klient.session(sessionId).agents());
    return (agents[agentId]?.executor ?? 'native') === 'native';
  }

  async sendAgentMessage(
    sessionId: string,
    agentId: string,
    text: string,
    content: readonly MessageContent[] | undefined,
    idempotencyKey: string,
    afterModelSwitch?: string,
  ): Promise<AgentMessageReceipt | null> {
    const session = this.klient.session(sessionId);
    const agents = await this.run(() => session.agents());
    if (agents[agentId] !== undefined && (agents[agentId].executor ?? 'native') !== 'native') {
      if (content?.some((part) => part.type !== 'text')) {
        throw new ExternalAgentAttachmentUnsupportedError();
      }
      return this.run(() => session.sendUserAgentMessage({
        targetAgentId: agentId,
        content: text,
        idempotencyKey,
      }));
    }
    const promptContent = content === undefined ? [{ type: 'text' as const, text }] : [...content];
    const keyedNativeChild = agentId !== MAIN_AGENT_ID && promptContent.every((part) => part.type === 'text');
    try {
      await this.submitPrompt(sessionId, {
        content: promptContent,
        agent_id: agentId,
        after_model_switch: afterModelSwitch,
        // Attachments and main retain their ordinary prompt semantics.
        prompt_id: keyedNativeChild ? idempotencyKey : undefined,
      });
    } catch (error) {
      // A 40938 may mean mismatched content, a concurrent first submission,
      // or an accepted prompt without a replayable receipt. None is success.
      if (keyedNativeChild && error instanceof ApiError && error.code === 40938) {
        throw new NativeChildPromptConflictError(error);
      }
      if (agentId !== MAIN_AGENT_ID) throw new NativeChildPromptSendError(error);
      throw error;
    }
    return null;
  }

  /** Rebind a live agent's model (agent-scoped profile call). */
  setAgentModel(sessionId: string, agentId: string, model: string) {
    return this.run(this.klient.session(sessionId).agent(agentId).setModel(model));
  }

  /** Rebind a live agent's thinking effort (agent-scoped profile call). */
  setAgentEffort(sessionId: string, agentId: string, effort: string) {
    return this.run(this.klient.session(sessionId).agent(agentId).setEffort(effort));
  }

  /**
   * Accept a three-mode model switch (direct / compact / fresh) as a queued
   * control item. The same operationId retries return the same receipt.
   */
  switchAgentModel(sessionId: string, agentId: string, input: ModelSwitchInput): Promise<ModelSwitchReceipt> {
    return this.run(this.klient.session(sessionId).agent(agentId).switchModel(input));
  }

  /** One switch operation by id; null when the engine never accepted it. */
  async getAgentModelSwitch(sessionId: string, agentId: string, operationId: string): Promise<ModelSwitchReceipt | null> {
    return (await this.run(this.klient.session(sessionId).agent(agentId).getModelSwitch(operationId))) ?? null;
  }

  /** Every switch operation this agent still tracks, with queue positions. */
  listAgentModelSwitches(sessionId: string, agentId: string): Promise<readonly QueuedModelSwitch[]> {
    return this.run(this.klient.session(sessionId).agent(agentId).listModelSwitches());
  }

  /** Edit a still-pending switch (target model / mode); the revision guards races. */
  updateAgentModelSwitch(sessionId: string, agentId: string, input: ModelSwitchInput, expectedRevision?: number): Promise<ModelSwitchReceipt> {
    return this.run(this.klient.session(sessionId).agent(agentId).updateModelSwitch(input, expectedRevision));
  }

  /** Cancel a still-pending switch; preparing operations reject by contract. */
  cancelAgentModelSwitch(sessionId: string, agentId: string, operationId: string): Promise<ModelSwitchReceipt> {
    return this.run(this.klient.session(sessionId).agent(agentId).cancelModelSwitch(operationId));
  }

  /**
   * Recover a failed switch: retry the accepted input (optionally as a
   * fresh-context switch — same operation id, so dependent messages keep
   * waiting on it), or release them onto the original binding.
   */
  recoverAgentModelSwitch(
    sessionId: string,
    agentId: string,
    operationId: string,
    action: 'retry' | 'keep_original',
    mode?: ModelSwitchMode,
  ): Promise<ModelSwitchReceipt> {
    const agent = this.klient.session(sessionId).agent(agentId);
    // `mode` is only part of the retry contract; keep_original rejects it.
    return this.run(action === 'retry' ? agent.recoverModelSwitch(operationId, action, mode) : agent.recoverModelSwitch(operationId, action));
  }

  /**
   * Subscribe to this agent's switch queue events. Listeners attach before
   * `ready` resolves; dispose detaches both. Reconnect re-attachment is the
   * transport's job — the hook re-reads the list on `ready`.
   */
  subscribeAgentModelSwitches(
    sessionId: string,
    agentId: string,
    listener: (event: AgentModelSwitchEvent) => void,
  ): { readonly ready: Promise<void>; dispose(): void } {
    const events = this.klient.session(sessionId).agent(agentId).events;
    const queued = events.on('prompt.model_switch_queued', (event) => {
      listener({ kind: 'queued', entry: event.entry, queueIndex: event.queueIndex });
    });
    const status = events.on('prompt.model_switch_status', (event) => {
      listener({ kind: 'status', operationId: event.operationId, receipt: event.receipt });
    });
    return {
      ready: Promise.all([queued.ready, status.ready]).then(() => undefined),
      dispose: () => {
        queued.dispose();
        status.dispose();
      },
    };
  }

  /** Loopback-only PTY lifecycle, owned by the shared Klient HTTP capability. */
  listTerminals(sessionId: string): Promise<ListTerminalsResponse> {
    return this.klient.terminal.listTerminals(sessionId);
  }

  createTerminal(sessionId: string, body: CreateTerminalRequest = {}): Promise<Terminal> {
    return this.klient.terminal.createTerminal(sessionId, body);
  }

  getTerminal(sessionId: string, terminalId: string): Promise<GetTerminalResponse> {
    return this.klient.terminal.getTerminal(sessionId, terminalId);
  }

  closeTerminal(sessionId: string, terminalId: string): Promise<CloseTerminalResponse> {
    return this.klient.terminal.closeTerminal(sessionId, terminalId);
  }

  listModels(): Promise<ListModelsResponse> {
    return this.run(this.klient.global.kosong.listModels().then((items) => ({ items: [...items] })));
  }

  /**
   * GUI skin files in the connected server's themes directory. An older server
   * without the route answers `undefined` rather than throwing, so the
   * appearance page degrades to built-in skins only.
   */
  listSkins(): Promise<import('@kiki/protocol').ListSkinsResponse | undefined> {
    return this.run(() => this.rest.skins.list());
  }

  getSkin(skinId: string): Promise<import('@kiki/protocol').GetSkinResponse> {
    return this.run(() => this.rest.skins.get(skinId));
  }

  async getConfig(): Promise<KikiConfigResponse> {
    return parseKikiConfigResponse(await this.run(this.rest.config.get()));
  }

  previewModelGenerationMigration(): Promise<import('@kiki/protocol').ModelGenerationMigrationPreviewResponse> {
    return this.run(this.rest.config.previewModelGenerationMigration());
  }

  applyModelGenerationMigration(revision: string): Promise<import('@kiki/protocol').ModelGenerationMigrationApplyResponse> {
    return this.run(this.rest.config.applyModelGenerationMigration(revision));
  }

  restoreModelGenerationMigration(backupKey: string, revision: string): Promise<import('@kiki/protocol').ModelGenerationMigrationRestoreResponse> {
    return this.run(this.rest.config.restoreModelGenerationMigration(backupKey, revision));
  }

  /** `GET /api/nb-search/capabilities` — secret-free provider/lane/pipeline descriptors. */
  async getNbSearchCapabilities(): Promise<NbSearchCapabilities> {
    return nbSearchCapabilitiesSchema.parse(await this.run(this.rest.nbSearch.capabilities()));
  }

  /** `GET /api/nb-search/test` — on-demand readiness check; callers pass a signal so the panel can cancel. */
  async testNbSearch(signal?: AbortSignal): Promise<NbSearchTestStatus> {
    return nbSearchTestStatusSchema.parse(await this.run(this.rest.nbSearch.test({ signal })));
  }

  /**
   * `POST /api/nb-search/keys/usage` — per-key state and, for the providers
   * that report one, balance. Never called on mount: a cold cache can reach the
   * provider even with `refresh: false`, so the panel passes that flag only
   * from an explicit refresh.
   */
  async readNbSearchKeyUsage(instanceId: string, refresh = false, signal?: AbortSignal): Promise<NbSearchKeyUsageView> {
    return nbSearchKeyUsageViewSchema.parse(await this.run(this.rest.nbSearch.keyUsage(instanceId, refresh, { signal })));
  }

  async readNbSearchCredential(instanceId: string, reveal = false): Promise<NbSearchManagedCredentialView> {
    return nbSearchManagedCredentialViewSchema.parse(await this.run(this.rest.nbSearch.readCredential(instanceId, reveal)));
  }

  /** `POST /api/secrets:reveal` — one secret value with its source, fetched only on explicit request. */
  async revealSecret(ref: import('@kiki/protocol').SecretRef): Promise<import('@kiki/protocol').RevealedSecret> {
    return revealedSecretSchema.parse(await this.run(this.rest.secrets.reveal(ref)));
  }

  async writeNbSearchCredential(instanceId: string, value: string | null, expectedVersion: string, expectedBinding: string): Promise<NbSearchManagedCredentialView> {
    return nbSearchManagedCredentialViewSchema.parse(await this.run(this.rest.nbSearch.writeCredential(instanceId, value, expectedVersion, expectedBinding)));
  }

  /** `/api/request-identity/*`, parsed against the protocol schemas with errors mapped like every other call. */
  get requestIdentity() {
    const api = this.rest.requestIdentity;
    const catalog = async (call: Promise<unknown>) => requestIdentityCatalogSchema.parse(await this.run(call));
    return {
      get: () => catalog(api.get()),
      preview: async (body: import('@kiki/protocol').RequestIdentityPreviewRequest) =>
        requestIdentityPreviewSchema.parse(await this.run(api.preview(body))),
      duplicateProfile: (from: string, label?: string) => catalog(api.duplicateProfile(from, label)),
      updateProfile: (id: string, draft: import('@kiki/protocol').RequestIdentityProfileDraft) => catalog(api.updateProfile(id, draft)),
      deleteProfile: (id: string) => catalog(api.deleteProfile(id)),
      checkTrack: (track: import('@kiki/protocol').RequestIdentityTrackId, source: import('@kiki/protocol').RequestIdentityUpdateSource) =>
        catalog(api.checkTrack(track, source)),
      applyTrack: (track: import('@kiki/protocol').RequestIdentityTrackId, version: string) => catalog(api.applyTrack(track, version)),
      trackAction: (track: import('@kiki/protocol').RequestIdentityTrackId, action: 'dismiss' | 'rollback' | 'reset') =>
        catalog(api.trackAction(track, action)),
      pinTrack: (track: import('@kiki/protocol').RequestIdentityTrackId, pinned: boolean) => catalog(api.pinTrack(track, pinned)),
      setManifestUrl: (url: string | null) => catalog(api.setManifestUrl(url)),
    };
  }

  /** `/api/notifications/*` (nb-IM), with errors mapped like every other call. Credential values are write-only; read one through `revealSecret`. */
  get notifications(): import('@kiki/klient').HttpRestFacade['notifications'] {
    const api = this.rest.notifications;
    const wrap = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => (...args: A): Promise<R> => this.run(() => call(...args));
    return {
      getSettings: wrap(api.getSettings.bind(api)),
      updateSettings: wrap(api.updateSettings.bind(api)),
      listProviders: wrap(api.listProviders.bind(api)),
      upsertInstance: wrap(api.upsertInstance.bind(api)),
      deleteInstance: wrap(api.deleteInstance.bind(api)),
      upsertChannel: wrap(api.upsertChannel.bind(api)),
      deleteChannel: wrap(api.deleteChannel.bind(api)),
      setCredential: wrap(api.setCredential.bind(api)),
      checkCredential: wrap(api.checkCredential.bind(api)),
      sendTest: wrap(api.sendTest.bind(api)),
      listDeliveries: wrap(api.listDeliveries.bind(api)),
    };
  }

  listNamedAgentProfiles(
    query?: string | import('@kiki/protocol').ListNamedAgentProfilesQuery,
  ): Promise<ListNamedAgentProfilesResponse> {
    return this.run(this.rest.agents.list(query));
  }

  getAgentCapabilities(
    query: import('@kiki/protocol').AgentCapabilitiesQuery,
    signal?: AbortSignal,
  ): Promise<import('@kiki/protocol').AgentCapabilitiesResponse> {
    return this.run(this.klient.global.agentPanel.read(query, { signal }));
  }

  createAgentProfile(body: CreateNamedAgentProfileRequest): Promise<NamedAgentProfile> {
    return this.run(this.rest.agents.create(body));
  }

  updateNamedAgentProfile(
    name: string,
    body: UpdateNamedAgentProfileRequest,
  ): Promise<NamedAgentProfile> {
    return this.run(this.rest.agents.update(name, body));
  }

  listShippedAgentProfiles(): Promise<ListShippedAgentProfilesResponse> {
    return this.run(this.rest.agents.shipped.list());
  }

  restoreShippedAgentProfile(id: string): Promise<ShippedAgentProfile> {
    return this.run(this.rest.agents.shipped.restore(id));
  }

  async readHostFile(path: string): Promise<string> {
    return this.run(this.rest.filesystem.readHostFile(path));
  }

  async readBuiltinSkill(name: string): Promise<string> {
    const result = await this.run(this.rest.skills.readBuiltinContent(name));
    return result.content;
  }

  /** Where the external-host skill would land for `host` and whether it replaces a file; writes nothing. */
  previewHostSkillInstall(host: HostSkillTarget): Promise<HostSkillInstallPreview> {
    return this.run(this.rest.skills.previewHostInstall(host));
  }

  /** Writes the external-host skill; the server rejects (40001) when the target changed since `revision`. */
  installHostSkill(host: HostSkillTarget, revision: string): Promise<HostSkillInstallPreview> {
    return this.run(this.rest.skills.installHost(host, revision));
  }

  async previewHostFile(path: string, maxBytes = 512_001): Promise<{ text: string; truncated: boolean }> {
    return this.run(this.rest.filesystem.previewHostFile(path, maxBytes));
  }

  private async cachedPreviewBytes(
    key: string,
    read: (etag?: string) => Promise<{ bytes: Uint8Array; mime: string; name?: string; etag?: string; notModified?: boolean }>,
  ): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
    const cached = this.previewBytes.get(key);
    const result = await this.run(read(cached?.etag));
    if (result.notModified) {
      if (cached === undefined) throw new Error('Preview cache is missing a validated response');
      return cached;
    }
    if (cached !== undefined) {
      this.previewBytes.delete(key);
      this.previewCacheBytes -= cached.bytes.byteLength;
    }
    if (result.etag !== undefined && result.bytes.byteLength <= 32 * 1024 * 1024) {
      this.previewBytes.set(key, { ...result, etag: result.etag });
      this.previewCacheBytes += result.bytes.byteLength;
      while (this.previewBytes.size > 8 || this.previewCacheBytes > 32 * 1024 * 1024) {
        const oldest = this.previewBytes.keys().next().value!;
        this.previewCacheBytes -= this.previewBytes.get(oldest)!.bytes.byteLength;
        this.previewBytes.delete(oldest);
      }
    }
    return result;
  }

  /** Binary variant of readHostFile, retaining the server MIME. */
  readHostFileBytes(path: string, options?: import('@kiki/klient').HttpRestMediaOptions): Promise<{ bytes: Uint8Array; mime: string }> {
    return this.run(this.rest.filesystem.readHostFileBytes(path, options));
  }

  readHostMediaPreviewBytes(path: string, options?: import('@kiki/klient').HttpRestMediaOptions): Promise<{ bytes: Uint8Array; mime: string }> {
    return this.cachedPreviewBytes(`host-preview:${path}`, (etag) =>
      this.rest.filesystem.readHostMediaPreview(path, { ...options, ifNoneMatch: etag }));
  }

  downloadHostFile(path: string, sink: import('@kiki/klient').HttpRestMediaSink, options?: import('@kiki/klient').HttpRestMediaOptions): Promise<import('@kiki/klient').HttpRestMediaReceipt> {
    return this.run(this.rest.filesystem.downloadHostFile(path, sink, options));
  }

  /** Read a canonical transcript attachment (or its staged-upload fallback). */
  readSessionMediaBytes(
    sessionId: string,
    fileId: string,
    options?: import('@kiki/klient').HttpRestMediaOptions,
  ): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
    return this.run(this.rest.sessions.media(sessionId, fileId, options));
  }

  readSessionMediaPreviewBytes(
    sessionId: string,
    fileId: string,
    options?: import('@kiki/klient').HttpRestMediaOptions,
  ): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
    return this.cachedPreviewBytes(`media-preview:${sessionId}:${fileId}:${options?.mediaType ?? ''}`, (etag) =>
      this.rest.sessions.mediaPreview(sessionId, fileId, { ...options, ifNoneMatch: etag }));
  }

  downloadSessionMedia(
    sessionId: string,
    fileId: string,
    sink: import('@kiki/klient').HttpRestMediaSink,
    options?: import('@kiki/klient').HttpRestMediaOptions,
  ): Promise<import('@kiki/klient').HttpRestMediaReceipt> {
    return this.run(this.rest.sessions.downloadMedia(sessionId, fileId, sink, options));
  }

  downloadTranscriptContent(
    sessionId: string, agentId: string, ref: ContentRef, sink: import('@kiki/klient').HttpRestMediaSink,
    options?: import('@kiki/klient').HttpRestMediaOptions,
  ): Promise<import('@kiki/klient').HttpRestMediaReceipt> {
    const fileId = contentOriginalFileId(agentId, ref);
    if (fileId === undefined) return Promise.reject(new Error('This content has no original-file consumer'));
    return this.downloadSessionMedia(sessionId, fileId, sink, options);
  }

  listWorkspaces(): Promise<ListWorkspacesResponse> {
    return this.run(this.rest.workspaces.list());
  }

  /** `PATCH /api/workspaces/{id}` — display-name rename. */
  renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
    return this.run(this.rest.workspaces.rename(workspaceId, name));
  }

  /** `PATCH /api/workspaces/{id}` — pin / unpin. */
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<Workspace> {
    return this.run(this.rest.workspaces.setPinned(workspaceId, pinned));
  }

  /** `DELETE /api/workspaces/{id}` — unregister (does not remove on-disk content). */
  removeWorkspace(workspaceId: string): Promise<{ deleted: true }> {
    return this.run(this.rest.workspaces.remove(workspaceId));
  }

  getAuth(): Promise<AuthSummary> {
    return this.run(this.rest.auth.summary());
  }

  listProviders(): Promise<ListProvidersResponse> {
    return this.run(this.klient.global.kosong.listProviders().then((items) => ({ items: [...items] })));
  }

  /** The models.dev directory: every provider the server can import, with why some cannot be. */
  listCatalogProviders(): Promise<import('@kiki/protocol').ListCatalogProvidersResponse> {
    return this.run(() => this.rest.catalog.list());
  }

  /** Import (or re-import, refreshing config and aliases) one directory entry as a configured provider. */
  importCatalogProvider(body: { catalog_id: string; id?: string; api_key?: string; base_url?: string }): Promise<import('@kiki/protocol').ImportCatalogProviderResponse> {
    return this.run(() => this.rest.catalog.importProvider(body, { timeoutMs: 90_000 }));
  }

  /** A managed account's quota as the vendor reports it (Kimi Code). Not session token usage. */
  getManagedUsage(provider: string): Promise<import('@kiki/protocol').ManagedUsageResult> {
    return this.run(() => this.rest.oauth.usage(provider));
  }

  getCatalogProvider(providerId: string): Promise<GetCatalogProviderResponse> {
    return this.run(this.rest.catalog.provider(providerId));
  }

  /** Server-side model probe, optionally with an unsaved API key for this request only. */
  refreshProvider(providerId: string, apiKey?: string): Promise<RefreshProviderModelsResponse> {
    return this.run(this.klient.global.kosong.refreshProviders({ providerId, apiKey }));
  }

  /**
   * Probe an UNSAVED provider draft — onboarding's "Test connection". The
   * values checked are exactly what the form currently holds; nothing is
   * persisted. Goes through kap-server's `POST /providers:probe` (a browser
   * fetch to some providers dies on CORS); an older server without the route
   * falls back to the browser-direct `/models` fetch. A structured
   * `{ ok: false }` answer is definitive and never falls back.
   */
  async probeProviderDraft(probe: RemoteModelsProbe): Promise<ProviderModelDraft[]> {
    const toDrafts = (remoteIds: readonly string[]): ProviderModelDraft[] => {
      const contextSize = providerTemplateFor(probe.type).defaultContextSize;
      return remoteIds.map((remoteId) => ({
        id: '',
        remoteId,
        maxContextSize: contextSize,
        displayName: '',
        capabilities: [],
        supportEfforts: [],
        requestIdentityChoice: 'inherit' as const,
        requestIdentityOverridesJson: '',
        imageAcceptedTypes: null,
        imageConvertUnsupported: null,
      }));
    };
    try {
      const result = await this.run(this.rest.providers.probe({
        type: probe.type,
        base_url: probe.baseUrl,
        api_key: probe.apiKey,
      }));
      if (!result.ok) throw new Error(result.error.message);
      return toDrafts(result.models);
    } catch (error) {
      // Only transport-level failures (route missing on an older server, or
      // the server unreachable) fall back — the browser-direct fetch can
      // still answer those. In-band errors above rethrow as plain Errors.
      if (!(error instanceof ApiError)) throw error;
      return fetchRemoteModels(probe);
    }
  }

  /**
   * The explicit user-triggered fetch of every configured provider's model
   * list. Only the managed OAuth provider writes its models back; every other
   * provider's result is a suggestion until the user saves it.
   */
  refreshAllProviders(): Promise<RefreshProviderModelsResponse> {
    return this.run(this.klient.global.kosong.refreshProviders());
  }

  /**
   * Model suggestions from earlier explicit fetches, grouped by provider. This
   * is a read: it never contacts a provider and never writes configuration.
   */
  listDiscoveredModels(): Promise<ListDiscoveredModelsResponse> {
    return this.run(
      this.klient.global.kosong.listDiscoveredModels().then((response) => ({
        items: [...response.items],
      })),
    );
  }

  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    return this.run(this.klient.global.kosong.setDefaultModel(modelId));
  }

  /** One configured model: local alias, exact remote id, revision, issues. */
  getModel(modelId: string): Promise<ModelEntity> {
    return this.run(this.klient.global.kosong.readModel(modelId));
  }

  createModel(input: CreateModelRequest): Promise<ModelEntity> {
    return this.run(this.klient.global.kosong.createModel(input));
  }

  /** Sparse patch: unlisted fields (even unknown ones) stay untouched. */
  updateModel(modelId: string, patch: PatchModelRequest): Promise<ModelEntity> {
    return this.run(this.klient.global.kosong.updateModel(modelId, patch));
  }

  deleteModel(modelId: string, options?: { readonly baseRevision?: string }): Promise<void> {
    return this.run(this.klient.global.kosong.deleteModel(modelId, options));
  }

  /** One connection plus the revision its next patch must carry. */
  getProviderEntity(providerId: string): Promise<ProviderEntity> {
    return this.run(this.klient.global.kosong.readProviderEntity(providerId));
  }

  createProvider(input: CreateProviderRequest): Promise<ProviderEntity> {
    return this.run(this.klient.global.kosong.createProvider(input));
  }

  /** Sparse connection patch; it never carries a model list. */
  updateProvider(providerId: string, patch: PatchProviderRequest): Promise<ProviderEntity> {
    return this.run(this.klient.global.kosong.updateProvider(providerId, patch));
  }

  deleteProviderEntity(providerId: string): Promise<void> {
    return this.run(this.klient.global.kosong.deleteProviderEntity(providerId));
  }

  getOAuthStatus(query: OAuthLoginQuery = {}): Promise<OAuthFlowSnapshot | null> {
    return this.run(this.klient.global.auth.flow(query.provider)).then((value) => value ?? null);
  }

  startOAuthLogin(body: OAuthLoginStartRequest = {}): Promise<OAuthFlowStart> {
    return this.run(this.klient.global.auth.startLogin(body.provider));
  }

  cancelOAuthLogin(query: OAuthLoginQuery = {}): Promise<{ cancelled: boolean; status: string }> {
    return this.run(this.klient.global.auth.cancelLogin(query.provider));
  }

  /** Saved shortcut overrides plus the bindings and conflicts they resolve to on `platform`. */
  readShortcuts(platform: import('@kiki/protocol').ShortcutPlatform): Promise<import('@kiki/protocol').ShortcutResponse> {
    return this.run(() => this.rest.shortcuts.read(platform));
  }

  /** Replace every platform's overrides; a conflicting set is rejected (40001) without writing. */
  writeShortcuts(
    platform: import('@kiki/protocol').ShortcutPlatform,
    preferences: import('@kiki/protocol').ShortcutPreferences,
  ): Promise<import('@kiki/protocol').ShortcutResponse> {
    return this.run(() => this.rest.shortcuts.write(platform, preferences));
  }

  /** Back to the shipped defaults: one action, one platform, or (`{}`) everything. */
  resetShortcuts(
    platform: import('@kiki/protocol').ShortcutPlatform,
    target: { platform?: import('@kiki/protocol').ShortcutPlatform; action?: import('@kiki/protocol').ShortcutAction },
  ): Promise<import('@kiki/protocol').ShortcutResponse> {
    return this.run(() => this.rest.shortcuts.reset(platform, target));
  }

  /** Account sign-in methods (Kimi Code is one of several) and whether each is signed in. */
  listOAuthMethods(): Promise<readonly OAuthMethodStatus[]> {
    return this.run(this.klient.global.auth.methods());
  }

  /**
   * What the original vendor's own sign-in on this machine looks like, read
   * without running it: the account behind it, where it is stored, and whether
   * Kiki could attach to that. Safe to call repeatedly; it moves nothing.
   * `provider` is a method id, not the `managed:` provider id.
   */
  probeOriginalOAuth(body: import('@kiki/protocol').OriginalOAuthRequest): Promise<import('@kiki/protocol').OriginalOAuthProbe> {
    return this.run(this.klient.global.auth.probeOriginal(body));
  }

  /**
   * Point a connection at the original vendor's own sign-in. `expected_account_id`
   * is the account the person was shown by the probe, so a credential that was
   * replaced on the machine in the meantime is refused rather than silently
   * adopted.
   */
  connectOriginalOAuth(body: import('@kiki/protocol').ConnectOriginalOAuthRequest): Promise<import('@kiki/protocol').OriginalOAuthProbe> {
    return this.run(this.klient.global.auth.connectOriginal(body));
  }

  /** Last persisted connection-test result per provider (secret-free, revision-scoped). */
  listProviderHealth(): Promise<import('@kiki/protocol').ListProviderHealthResponse> {
    return this.run(this.rest.providers.health());
  }

  /** One real request against a saved connection; the server persists and returns the result. */
  testProviderConnection(providerId: string): Promise<import('@kiki/protocol').ProviderConnectionTestResult> {
    return this.run(this.rest.providers.test(providerId, { timeoutMs: 90_000 }));
  }

  /** Registered execution engines and whether each one's binary was found. */
  listExecutors(): Promise<import('@kiki/protocol').ListExecutorsResponse> {
    return this.run(this.rest.executors.list());
  }

  /** Bounded local Claude/Codex history for one executor; read-only, imports nothing. */
  listLocalSessions(executorId: string, limit?: number): Promise<import('@kiki/protocol').LocalSessionDirectory> {
    return this.run(() => this.rest.executors.listLocalSessions(executorId, { limit }));
  }

  /** Bounded transcript preview of one local session (`partial` / `warnings` are not completeness claims). */
  getLocalSession(executorId: string, localSessionId: string): Promise<import('@kiki/protocol').LocalSessionDetail> {
    return this.run(() => this.rest.executors.getLocalSession(executorId, localSessionId));
  }

  /** Attach a local session to Kiki; `created: false` returns the session it is already bound to. */
  resumeLocalSession(
    executorId: string,
    localSessionId: string,
    body: import('@kiki/protocol').ResumeLocalSessionRequest,
  ): Promise<import('@kiki/protocol').ResumeLocalSessionResponse> {
    return this.run(() => this.rest.executors.resumeLocalSession(executorId, localSessionId, body));
  }

  /** One page of cross-thread messages (`GET /threads/messages`); an empty page may still carry a cursor. */
  listThreadMessages(
    query: import('@kiki/protocol').ListThreadMessagesQuery,
  ): Promise<import('@kiki/protocol').ListThreadMessagesResponse> {
    return this.run(() => this.rest.threads.messages(query));
  }

  /**
   * `GET /executors/{id}` — one engine's declared capabilities and connection.
   * The klient REST facade only exposes `list`, so this goes through the
   * shared envelope request below.
   */
  getExecutor(id: string): Promise<import('@kiki/protocol').ExecutorCatalogItem> {
    return this.memoryRequest('GET', `/executors/${encodeURIComponent(id)}`);
  }

  /** `POST /executors/{id}/check` — re-probe the binary and the declared login command. */
  checkExecutor(id: string): Promise<ExecutorCheckResult> {
    return this.memoryRequest('POST', `/executors/${encodeURIComponent(id)}/check`);
  }

  /** Antigravity ACP CLI cache: the release Kiki would fetch, installed versions, the active one. */
  getAntigravityBinaries(): Promise<import('@kiki/protocol').AntigravityStatusResponse> {
    return this.memoryRequest('GET', '/executors/antigravity-acp/binaries');
  }

  /** Download + unpack a 1.x release (`version` absent = the default release) into Kiki's cache. */
  installAntigravityBinary(version?: string): Promise<import('@kiki/protocol').AntigravityStatusResponse> {
    // The route answers after the download and unpack finish.
    // A minute past the server's download deadline, so its timeout reply (and pushed failure) arrives first.
    return this.memoryRequest('POST', '/executors/antigravity-acp/binaries/install', { body: version === undefined ? {} : { version }, timeoutMs: 11 * 60_000 });
  }

  activateAntigravityBinary(version: string): Promise<import('@kiki/protocol').AntigravityStatusResponse> {
    return this.memoryRequest('POST', '/executors/antigravity-acp/binaries/activate', { body: { version } });
  }

  /** Begin a Google sign-in; answers `already_signed_in` or the URL to open and the flow handle. */
  startAntigravityLogin(methodId: 'oauth-personal' | 'oauth-business' | 'gemini-api-key' | 'agent-platform'): Promise<import('@kiki/protocol').AntigravityLoginStartResponse> {
    return this.memoryRequest('POST', '/executors/antigravity-acp/login/start', { body: { method_id: methodId } });
  }

  /** Finish a sign-in with the address the browser landed on; `retryable` keeps the flow open. */
  completeAntigravityLogin(handle: string, redirectUrl: string): Promise<import('@kiki/protocol').AntigravityLoginOutcomeResponse> {
    return this.memoryRequest('POST', '/executors/antigravity-acp/login/complete', { body: { handle, redirect_url: redirectUrl } });
  }

  cancelAntigravityLogin(handle: string): Promise<{ cancelled: true }> {
    return this.memoryRequest('POST', '/executors/antigravity-acp/login/cancel', { body: { handle } });
  }

  logoutAntigravity(): Promise<{ signed_out: true }> {
    return this.memoryRequest('POST', '/executors/antigravity-acp/logout', { body: {} });
  }

  previewExecutorPrompt(name: string, workspace: string, executor: string): Promise<import('@kiki/protocol').ExecutorPromptPreviewResponse> {
    return this.memoryRequest('POST', `/agents/${encodeURIComponent(name)}/executor-prompt:preview`,
      { body: { workspace, executor } });
  }

  /** `[subagent].default_model`; an empty value clears the key. */
  async setSubagentDefaultModel(model: string): Promise<void> {
    const trimmed = model.trim();
    await this.patchConfig({ subagent: { default_model: trimmed === '' ? null : trimmed } });
  }

  /** Top-level `fast_model`; an empty value removes it. */
  async setFastModel(model: string): Promise<void> {
    const trimmed = model.trim();
    await this.patchConfig({ fast_model: trimmed === '' ? null : trimmed });
  }

  logoutOAuth(body: OAuthLogoutRequest = {}): Promise<OAuthLogoutResponse> {
    return this.run(this.klient.global.auth.logout(body.provider));
  }

  listTools(sessionId?: string): Promise<ListToolsResponse> {
    return this.run(this.rest.runtime.listTools(sessionId));
  }

  listMcpServers(): Promise<ListMcpServersResponse> {
    return this.run(this.rest.runtime.listMcpServers());
  }

  listPlugins(): Promise<ListPluginsResponse> {
    return this.run(this.klient.global.plugins.list().then((plugins) => ({ plugins: [...plugins] })));
  }

  /**
   * Update check for GitHub-installed plugins (the catalog covers the rest).
   * Read-only: it resolves the tracked ref remotely and never installs.
   */
  checkPluginUpdates(): Promise<readonly PluginUpdateStatus[]> {
    return this.run(this.klient.global.plugins.checkUpdates());
  }

  listPluginMarketplace(): Promise<PluginMarketplaceResponse> {
    return this.run(this.rest.plugins.marketplace());
  }

  /**
   * Plugin detail over REST: the klient contract's manifest schema strips the
   * Kiki extension (tools, panels, themes, permissions), which the detail and
   * consent views read.
   */
  getPlugin(pluginId: string): Promise<PluginInfo> {
    return this.run(this.rest.plugins.info(pluginId) as Promise<PluginInfo>);
  }

  /** The plugin's declared settings form, stored values, and which secrets are set (never their values). */
  getPluginSettings(pluginId: string): Promise<import('@kiki/protocol').PluginSettingsResponse> {
    return this.run(this.rest.plugins.settings(pluginId));
  }

  /** Per-key write: a value sets it, null removes it; keys not sent are kept. */
  setPluginSettings(
    pluginId: string,
    values: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<import('@kiki/protocol').PluginSettingsResponse> {
    return this.run(this.rest.plugins.setSettings(pluginId, { values: { ...values } }));
  }

  installPlugin(source: string): Promise<PluginSummary> {
    return this.run(this.rest.plugins.install(source) as Promise<PluginSummary>);
  }

  listCapabilities(): Promise<readonly CapabilityStatus[]> {
    return this.run(this.klient.global.capabilities.list() as Promise<readonly CapabilityStatus[]>);
  }

  getCapability(id: string): Promise<CapabilityStatus> {
    return this.run(this.klient.global.capabilities.get(id) as Promise<CapabilityStatus>);
  }

  installCapability(id: string, expectedSha256: string, browserMode?: 'driver-only' | 'managed-browser'): Promise<CapabilityStatus> {
    return this.run(this.klient.global.capabilities.install(id, expectedSha256, browserMode) as Promise<CapabilityStatus>);
  }

  cancelCapability(id: string): Promise<CapabilityStatus> {
    return this.run(this.klient.global.capabilities.cancel(id) as Promise<CapabilityStatus>);
  }

  setPluginEnabled(pluginId: string, enabled: boolean): Promise<{ readonly ok: true }> {
    return this.run(this.rest.plugins.setEnabled(pluginId, enabled));
  }

  removePlugin(pluginId: string, options?: { readonly deleteData?: boolean }): Promise<{ readonly ok: true }> {
    return this.run(this.rest.plugins.remove(pluginId, options));
  }

  /** Download + parse a candidate without running any of its code. */
  previewPlugin(source: string, sha256?: string): Promise<import('@kiki/protocol').PluginInstallPlan> {
    return this.run(this.rest.plugins.preview({ source, sha256 }));
  }

  /** Install exactly the previewed candidate (its fingerprint pins the bytes). */
  installPreviewedPlugin(input: {
    readonly source: string;
    readonly sha256?: string;
    readonly fingerprint: string;
    readonly consent: boolean;
  }): Promise<PluginSummary> {
    return this.run(this.rest.plugins.install(input) as Promise<PluginSummary>);
  }

  rollbackPlugin(pluginId: string): Promise<{ readonly ok: true }> {
    return this.run(this.rest.plugins.rollback(pluginId));
  }

  installPluginPrerequisite(pluginId: string, prerequisiteId: string): Promise<{ readonly ok: true }> {
    return this.run(this.rest.plugins.installPrerequisite(pluginId, { id: prerequisiteId, consent: true }));
  }

  recommendPlugins(input: {
    readonly cwd?: string;
    readonly files?: readonly string[];
    readonly commands?: readonly string[];
    readonly dependencies?: readonly string[];
  }): Promise<{ readonly entries: readonly PluginMarketplaceEntry[] }> {
    return this.run(this.rest.plugins.recommend(input) as Promise<{ readonly entries: readonly PluginMarketplaceEntry[] }>);
  }

  dismissPluginRecommendation(pluginId: string): Promise<{ readonly ok: true }> {
    return this.run(this.rest.plugins.dismissRecommendation(pluginId));
  }

  listPluginPanels(): Promise<{ readonly panels: readonly import('@kiki/protocol').PluginPanelSummary[] }> {
    return this.run(this.rest.plugins.panels());
  }

  getPluginPanelDocument(pluginId: string, panelId: string): Promise<import('@kiki/protocol').PluginPanelDocument> {
    return this.run(this.rest.plugins.panelDocument(pluginId, panelId));
  }

  callPluginPanelBridge(
    pluginId: string,
    panelId: string,
    input: import('@kiki/protocol').PluginPanelBridgeRequest,
  ): Promise<import('@kiki/protocol').PluginPanelBridgeResponse> {
    return this.run(this.rest.plugins.panelBridge(pluginId, panelId, input));
  }

  restartMcpServer(serverId: string): Promise<RestartMcpServerResult> {
    return this.run(this.rest.runtime.restartMcpServer(serverId));
  }

  listWorkspaceSkills(workspaceId: string): Promise<ListSkillsResponse> {
    return this.run(this.rest.workspaces.listSkills(workspaceId));
  }

  /** Session-scoped skill catalog — feeds the composer's slash menu. */
  listSessionSkills(sessionId: string): Promise<ListSkillsResponse> {
    return this.run(this.rest.sessions.listSkills(sessionId));
  }

  rebuildContext(sessionId: string): Promise<import('@kiki/klient').ContextRebuildResult> {
    return this.run(this.klient.session(sessionId).agent('main').rebuildContext());
  }

  /** Activate a slash skill and start its turn. */
  activateSkill(
    sessionId: string,
    skillName: string,
    body: ActivateSkillRequest = {},
  ): Promise<ActivateSkillResult> {
    return this.run(this.rest.sessions.activateSkill(sessionId, skillName, body));
  }

  /** Upload prompt bytes through the shared global file facade. */
  async uploadFile(file: File): Promise<FileMeta> {
    const data = new Uint8Array(await file.arrayBuffer());
    return this.run(this.klient.global.files.save({
      data,
      filename: file.name === '' ? 'attachment' : file.name,
      mimeType: file.type === '' ? undefined : file.type,
    }, { timeoutMs: 0 }));
  }

  /** Session-scoped fuzzy file search. */
  fsSearch(
    sessionId: string,
    body: { query: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<FsSearchResponse> {
    return this.run(this.rest.sessions.fsSearch(sessionId, body, { signal }));
  }

  /** Session-less fuzzy file search for the /new draft. */
  workspaceFsSearch(
    workspace: string,
    body: { query: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<FsSearchResponse> {
    return this.run(this.rest.filesystem.workspaceFsSearch(workspace, body, { signal }));
  }

  /** Global full-text search across all sessions. */
  searchMessages(body: SearchMessagesBody, signal?: AbortSignal): Promise<SearchMessagesResponse> {
    return this.run(this.rest.search.messages(body, { signal })).then((result) => ({
      ...result,
      items: [...result.items],
    }));
  }

  searchIndexStatus(): Promise<{ index_state: SearchMessagesResponse['index_state'] }> {
    return this.run(this.rest.search.status());
  }

  /** Clear the SQLite indexer's retry backoff and restart it. */
  retrySearchIndexer(): Promise<{ retried: boolean }> {
    return this.run(this.rest.search.retry());
  }

  /** `GET /api/cron` — paged cross-workspace scheduled tasks, next-fire order. */
  listCronTasks(query: { session_id?: string; page_size?: number; offset?: number } = {}): Promise<ListCronTasksResponse> {
    return this.run(this.rest.cron.list(query));
  }

  /** `sessionId` disambiguates a task id shared by several sessions (else 40001). */
  pauseCronTask(taskId: string, sessionId?: string): Promise<{ readonly task: CronTask }> {
    return this.run(this.rest.cron.pause(taskId, { session_id: sessionId }));
  }

  resumeCronTask(taskId: string, sessionId?: string): Promise<{ readonly task: CronTask }> {
    return this.run(this.rest.cron.resume(taskId, { session_id: sessionId }));
  }

  /** Fire the task once immediately; its schedule is untouched. */
  runCronTask(taskId: string, sessionId?: string): Promise<{ readonly triggered: true }> {
    return this.run(this.rest.cron.run(taskId, { session_id: sessionId }));
  }

  deleteCronTask(taskId: string, sessionId?: string): Promise<{ readonly deleted: true }> {
    return this.run(this.rest.cron.remove(taskId, { session_id: sessionId }));
  }

  /**
   * Memory REST calls. klient's typed REST facade has no memory domain (and
   * no PUT verb) yet, so these go through `memoryRequest` with the same
   * bearer auth and `{code,msg,data}` envelope handling.
   */
  getMemorySettings(): Promise<MemorySettings> {
    return this.memoryRequest('GET', '/memory/settings');
  }

  patchMemorySettings(patch: { readonly enabled?: boolean; readonly approval?: MemoryApproval; readonly budget?: number }): Promise<MemorySettings> {
    return this.memoryRequest('PATCH', '/memory/settings', { body: patch });
  }

  getWorkspaceMemorySettings(workspaceId: string): Promise<MemoryWorkspaceSettings> {
    return this.memoryRequest('GET', `/memory/workspaces/${encodeURIComponent(workspaceId)}/settings`);
  }

  patchWorkspaceMemorySettings(workspaceId: string, enabled: boolean | null): Promise<MemoryWorkspaceSettings> {
    return this.memoryRequest('PATCH', `/memory/workspaces/${encodeURIComponent(workspaceId)}/settings`, { body: { enabled } });
  }

  listMemory(target: MemoryTarget, query: MemoryListQuery = {}): Promise<{ readonly items: readonly MemoryEntry[] }> {
    return this.memoryRequest('GET', `/memory/${target.scope}`, {
      target,
      query: {
        query: query.query !== undefined && query.query.trim() !== '' ? query.query.trim() : undefined,
        type: query.type,
        include_inactive: query.include_inactive === true ? 'true' : undefined,
      },
    });
  }

  getMemory(target: MemoryTarget, id: string): Promise<MemoryEntry> {
    return this.memoryRequest('GET', `/memory/${target.scope}/${encodeURIComponent(id)}`, { target });
  }

  /** `id: 'new'` creates; otherwise `expected_revision` guards the update (40944 on a stale revision). */
  putMemory(target: MemoryTarget, id: string, body: MemoryPutBody): Promise<{ readonly entry: MemoryEntry; readonly operationId: string }> {
    return this.memoryRequest('PUT', `/memory/${target.scope}/${encodeURIComponent(id)}`, { target, body });
  }

  deleteMemory(target: MemoryTarget, id: string, expectedRevision: string): Promise<{ readonly operation_id: string }> {
    return this.memoryRequest('DELETE', `/memory/${target.scope}/${encodeURIComponent(id)}`, {
      target,
      query: { expected_revision: expectedRevision },
    });
  }

  memoryJournal(target: MemoryTarget, id?: string): Promise<readonly MemoryJournalRecord[]> {
    return this.memoryRequest('GET', `/memory/${target.scope}/journal`, { target, query: { id } });
  }

  memoryInbox(target: MemoryTarget): Promise<readonly MemoryEntry[]> {
    return this.memoryRequest('GET', `/memory/${target.scope}/inbox`, { target });
  }

  undoMemory(target: MemoryTarget, operationId: string): Promise<{ readonly entry: MemoryEntry | null }> {
    return this.memoryRequest('POST', `/memory/${target.scope}/undo`, { target, body: { operation_id: operationId } });
  }

  private async memoryRequest<T>(
    method: 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE',
    path: string,
    options: { readonly target?: MemoryTarget; readonly query?: Record<string, string | undefined>; readonly body?: unknown; readonly timeoutMs?: number } = {},
  ): Promise<T> {
    const root = this.baseUrl.replace(/\/+$/u, '');
    const url = root === '' ? new URL(`/api${path}`, globalThis.location?.origin ?? 'http://localhost') : new URL(`${root}/api${path}`);
    const scope = options.target?.scope;
    const query = {
      ...options.query,
      workspace_id: scope === 'workspace' || scope === 'persona_workspace' ? options.target?.workspaceId : undefined,
      persona_id: scope === 'persona' || scope === 'persona_workspace' ? options.target?.personaId : undefined,
    };
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await (this.transport?.fetch ?? fetch)(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ApiError({ code: API_CODES.TIMEOUT, msg: translate('en', 'common.requestTimedOut'), data: null });
      }
      throw error;
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      envelope = null;
    }
    if (envelope === null || typeof envelope !== 'object' || !('code' in envelope) || typeof envelope.code !== 'number'
      || !('msg' in envelope) || typeof envelope.msg !== 'string') {
      throw new ApiError({ code: API_CODES.INVALID_RESPONSE, msg: `HTTP ${response.status} — non-JSON response`, data: null });
    }
    if (envelope.code !== 0) {
      throw new ApiError({ code: envelope.code, msg: envelope.msg, data: 'data' in envelope ? envelope.data ?? null : null,
        details: 'details' in envelope ? envelope.details : undefined,
        request_id: 'request_id' in envelope && typeof envelope.request_id === 'string' ? envelope.request_id : undefined });
    }
    return ('data' in envelope ? envelope.data : null) as T;
  }

  /**
   * `POST /sessions/{id}:fork` — copy the session. The message-closure pair
   * (`through_message_id` + `expected_cursor`) forks only the history through
   * that message and guards against a concurrent rewrite (40937).
   */
  forkSession(sessionId: string, body: KikiForkSessionRequest = {}): Promise<Session> {
    return this.sessions.forkSession(sessionId, body);
  }

  editMessage(sessionId: string, messageId: string, body: EditMessageRequest): Promise<PromptSubmitResult> {
    return this.sessions.editMessage(sessionId, messageId, body);
  }

  regenerateMessage(sessionId: string, messageId: string, body: RegenerateMessageRequest): Promise<PromptSubmitResult> {
    return this.sessions.regenerateMessage(sessionId, messageId, body);
  }

  /** Compacts older context. 40901 while busy, 40910 when nothing compactable. */
  compactSession(
    sessionId: string,
    body: CompactSessionRequest = {},
  ): Promise<CompactSessionResponse> {
    return this.run(this.rest.sessions.compact(sessionId, body));
  }

  /** Effective automatic-compaction point for one agent of a session. */
  getAutoCompact(sessionId: string, agentId: string): Promise<import('@kiki/protocol').AutoCompactStatus> {
    return this.run(this.rest.sessions.getAutoCompact(sessionId, agentId));
  }

  /**
   * Read-only inspection of the hook rules an agent currently runs with:
   * every rule's source path, event, active flag and cadence state. Powers
   * the agent panel's "Injected rules" section.
   */
  getAgentHooksInspect(sessionId: string, agentId: string): Promise<import('@kiki/protocol').AgentHooksInspect> {
    return this.run(this.rest.sessions.inspectHooks(sessionId, agentId));
  }

  /**
   * Sets (or with `tokens: null` clears) this agent's per-model session
   * override; `save` also writes the token point as a model/profile/global
   * default. The response says whether the new default took over.
   */
  setAutoCompact(
    sessionId: string,
    agentId: string,
    input: import('@kiki/protocol').AutoCompactWrite,
  ): Promise<import('@kiki/protocol').AutoCompactWriteResult> {
    return this.run(this.rest.sessions.setAutoCompact(sessionId, agentId, input));
  }

  /**
   * Effective context-renewal strategy for one agent of a session and the
   * layer it came from. The klient REST facade has no domain for this route
   * yet, so it goes through the plain enveloped request.
   */
  getContextStrategy(sessionId: string, agentId: string): Promise<import('@kiki/protocol').ContextStrategyStatus> {
    return this.memoryRequest('GET', `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/context-strategy`);
  }

  /**
   * Sets (or with `strategy: null` clears) the main agent's session override;
   * `save: 'global'` writes the choice to the global default instead and
   * drops the override.
   */
  setContextStrategy(
    sessionId: string,
    agentId: string,
    input: { readonly strategy: import('@kiki/protocol').ContextStrategyStatus['strategy'] | null; readonly save?: 'global' },
  ): Promise<import('@kiki/protocol').ContextStrategyStatus> {
    return this.memoryRequest('PATCH', `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/context-strategy`, { body: input });
  }

  /** Removes the last `count` turns. 40911 when there is nothing to undo. */
  undoSession(
    sessionId: string,
    body: { count?: number; page_size?: number } = {},
  ): Promise<UndoSessionResponse> {
    return this.run(this.rest.sessions.undo(sessionId, body));
  }

  /** Download the diagnostic archive and preserve its server filename. */
  exportSession(sessionId: string): Promise<{ blob: Blob; filename: string }> {
    return this.run(this.rest.sessions.export(sessionId));
  }

  async patchConfig(body: KikiConfigPatch): Promise<KikiConfigResponse> {
    return parseKikiConfigResponse(await this.run(this.rest.config.patch(body as import('@kiki/klient').HttpRestConfigPatch)));
  }

  // Personas (`/api/personas/*`) through klient's REST facade; File inputs
  // become bytes here so the rest of the GUI keeps passing browser files.

  listPersonas(options: { readonly includeArchived?: boolean } = {}): Promise<readonly PersonaSummary[]> {
    return this.run(() => this.rest.personas.list(options));
  }

  getPersona(id: string): Promise<PersonaSnapshot> {
    return this.run(() => this.rest.personas.get(id));
  }

  /** Create (no `revision`) or update; a stale `revision` fails with 40946. */
  putPersona(input: PersonaPutInput): Promise<PersonaSnapshot> {
    return this.run(() => this.rest.personas.put(input));
  }

  duplicatePersona(id: string, options: { readonly id?: string; readonly name?: string } = {}): Promise<PersonaSnapshot> {
    return this.run(() => this.rest.personas.duplicate(id, options));
  }

  archivePersona(id: string, archived: boolean): Promise<{ readonly version: 1; readonly archived: boolean }> {
    return this.run(() => this.rest.personas.archive(id, archived));
  }

  deletePersona(id: string, expectedRevision?: string): Promise<PersonaDeleteResponse> {
    return this.run(() => this.rest.personas.delete(id, { expectedRevision }));
  }

  /** Parses a CCv3 card without writing anything. */
  async previewPersonaImport(file: File): Promise<PersonaImportPreview> {
    const data = new Uint8Array(await file.arrayBuffer());
    return this.run(() => this.rest.personas.previewImport({ data, filename: file.name, format: personaCardFormatOf(file) }));
  }

  async importPersonaCard(file: File, fields: { readonly id?: string; readonly name?: string } = {}): Promise<PersonaImportResponse> {
    const data = new Uint8Array(await file.arrayBuffer());
    return this.run(() => this.rest.personas.importCard({ data, filename: file.name, format: personaCardFormatOf(file), ...fields }));
  }

  async exportPersonaCard(id: string, format: PersonaCardFormat): Promise<{ readonly blob: Blob; readonly filename: string }> {
    const file = await this.run(() => this.rest.personas.exportCard(id, format));
    return { blob: new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mime }), filename: file.name ?? `${id}.${format}` };
  }

  /** `null` when the persona has no avatar (the route needs the bearer header an <img> cannot send). */
  async getPersonaAvatar(id: string, signal?: AbortSignal): Promise<Blob | null> {
    try {
      const file = await this.rest.personas.getAvatar(id, { signal });
      return new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mime });
    } catch {
      return null;
    }
  }

  async putPersonaAvatar(id: string, file: File, shape?: PersonaAvatarShape): Promise<PersonaAvatarUploadResponse> {
    const data = new Uint8Array(await file.arrayBuffer());
    return this.run(() => this.rest.personas.putAvatar(id, data, file.type, shape));
  }

  /** Back to the initial / profile face. */
  deletePersonaAvatar(id: string): Promise<PersonaAvatarDeleteResponse> {
    return this.run(() => this.rest.personas.deleteAvatar(id));
  }
}

/** Persona error codes (`@kiki/protocol` error-codes). */
export const PERSONA_NOT_FOUND = 40425;
export const PERSONA_ALREADY_EXISTS = 40945;
export const PERSONA_REVISION_CONFLICT = 40946;

/** Card format from the file name; PNG cards carry their data in a tEXt chunk. */
export function personaCardFormatOf(file: { readonly name: string; readonly type: string }): PersonaCardFormat {
  const name = file.name.toLowerCase();
  if (file.type === 'image/png' || name.endsWith('.png')) return 'png';
  if (name.endsWith('.charx')) return 'charx';
  return 'json';
}
