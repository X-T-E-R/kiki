/**
 * Compatibility adapter for the GUI's historical client method names.
 * Transport, envelopes, deadlines, cancellation, and API paths belong to
 * `@kiki/klient`; this module only preserves GUI-facing wire shapes.
 */

import { nbSearchCapabilitiesSchema, nbSearchTestStatusSchema } from '@kiki/protocol';
import { createKlient, HTTP_TRANSPORT_TIMEOUT_REASON } from '@kiki/klient/http';
import { createSessionTransport } from '@kiki/session-core/session/klientTransport';
import type {
  ActivateSkillRequest,
  ActivateSkillResult,
  ApprovalRequest,
  ApprovalResolveRequest,
  ApprovalResolveResult,
  ArchiveSessionResponse,
  AuthSummary,
  CloseTerminalResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  ConfigResponse,
  CreateTerminalRequest,
  FileMeta,
  FsSearchResponse,
  GetTerminalResponse,
  GoalSnapshot,
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
  ListNamedAgentProfilesResponse as ProtocolListNamedAgentProfilesResponse,
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
  PromptPlanGate,
  RequestIdentityPolicyWire,
  PromptListResponse,
  PromptReplaceRequest,
  PromptReplaceResult,
  PromptSteerResult,
  PromptSubmission,
  PromptSubmitResult,
  QuestionDismissResult,
  QuestionRequest,
  QuestionResolveRequest,
  QuestionResolveResult,
  RefreshProviderModelsResponse,
  RestartMcpServerResult,
  RestoreSessionResponse,
  Session,
  SessionCreate,
  SetDefaultModelResponse,
  Task,
  Terminal,
  UndoSessionResponse,
  UpdateNamedAgentProfileRequest as ProtocolUpdateNamedAgentProfileRequest,
  UpdateSessionProfileRequest,
  Workspace,
} from '@kiki/protocol';

import { RPCError, type SessionViewFacade } from '@kiki/klient';
import { API_CODES, ApiError } from '@kiki/session-core/transport';

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
    state: 'building' | 'ready' | 'readonly';
    indexed_sessions: number;
    total_sessions: number;
    documents: number;
    stale?: boolean;
    degraded?: string;
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
  readonly swarm_mode?: boolean;
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
  };
  readonly identity?: { readonly name?: string; readonly slug?: string };
  readonly extra_agent_dirs?: string[];
  readonly disabled_builtin_profiles?: string[];
  readonly disabled_named_profiles?: string[];
  readonly mcp?: { readonly startupTimeoutMs?: number; readonly toolTimeoutMs?: number };
  readonly plugins?: { readonly marketplaceUrl?: string };
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
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
    disabled_builtin_profiles: parseConfigStringList(
      data['disabled_builtin_profiles'],
      'disabled_builtin_profiles',
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
  };
  readonly identity?: { readonly name?: string; readonly slug?: string };
  readonly extra_agent_dirs?: string[];
  readonly disabled_builtin_profiles?: string[];
  readonly disabled_named_profiles?: string[];
  readonly mcp?: { readonly startup_timeout_ms?: number; readonly tool_timeout_ms?: number };
  readonly plugins?: { readonly marketplace_url?: string };
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
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

export type NamedAgentRoute = ProtocolNamedAgentRoute;
export type NamedAgentModelProfile = ProtocolNamedAgentModelProfile;
export type NamedAgentSpawnConstraints = ProtocolNamedAgentSpawnConstraints;
export type NamedAgentSubagentLease = ProtocolNamedAgentSubagentLease;
export type NamedAgentProfile = ProtocolNamedAgentProfile;
export type ListNamedAgentProfilesResponse = ProtocolListNamedAgentProfilesResponse;
export type UpdateNamedAgentProfileRequest = ProtocolUpdateNamedAgentProfileRequest;

/**
 * Installed-plugin summary from `GET /api/plugins` (mirrors the
 * kap-server `pluginSummarySchema`): identity + enabled/error state + the
 * contribution counts the settings Plugins leaf renders.
 */
export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
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
  readonly keywords?: readonly string[];
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
  readonly mcpServers: readonly PluginMcpServerInfo[];
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface KikiClientOptions {
  /** Absolute base (`http://host:port`) or '' for same-origin (dev proxy). */
  readonly baseUrl: string;
  readonly token?: string;
  /** Per-request deadline; defaults to 30 seconds. */
  readonly timeoutMs?: number;
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
      /** Agents spawned by this call (AgentRun / AgentSwarm). */
      agentRefs?: readonly { readonly agentId: string; readonly role?: 'child' | 'member' }[];
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
    readonly swarm?: { readonly trigger?: string };
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

export class KikiClient {
  readonly baseUrl: string;
  readonly klient: ReturnType<typeof createKlient>;
  readonly sessions: ReturnType<typeof createSessionTransport>;
  private readonly token: string | undefined;
  private serverLeaseId: string | undefined;

  constructor(options: KikiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token !== undefined && options.token !== '' ? options.token : undefined;
    this.klient = createKlient({
      endpoint: this.baseUrl,
      token: this.token,
      timeoutMs: options.timeoutMs,
    });
    this.sessions = createSessionTransport(this.klient);
  }

  sessionView(sessionId: string): SessionViewFacade {
    const view = this.klient.session(sessionId).view;
    return {
      snapshot: async () => {
        const snapshotKlient = createKlient({
          endpoint: this.baseUrl,
          token: this.token,
          timeoutMs: 0,
        });
        try {
          return await this.run(() => snapshotKlient.session(sessionId).view.snapshot());
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
          msg: timedOut ? error.message.replace('call timed out', 'Request timed out') : error.message,
          data: error.data ?? null,
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

  listSessions(query: ListSessionsOptions = {}): Promise<PageResponse<Session>> {
    return this.run(() => this.rest.sessions.list(query));
  }

  createSession(body: SessionCreate): Promise<Session> {
    return this.run(() => this.rest.sessions.create(body));
  }

  /** Cross-session usage aggregation. Filter axes travel in the query. */
  getUsage(
    query: Record<string, string | number | boolean | undefined>,
  ): Promise<UsageResponseWire> {
    return this.run(() => this.rest.usage(query));
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

  archiveSession(sessionId: string): Promise<ArchiveSessionResponse> {
    return this.run(() => this.rest.sessions.archive(sessionId));
  }

  restoreSession(sessionId: string): Promise<RestoreSessionResponse> {
    return this.run(() => this.rest.sessions.restore(sessionId));
  }

  getSessionGoal(sessionId: string): Promise<GoalSnapshot | null> {
    return this.run(() => this.rest.sessions.goal(sessionId));
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

  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse> {
    return this.sessions.abortPrompt(sessionId, promptId);
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

  listTasks(sessionId: string): Promise<ListTasksResponse> {
    return this.run(() => this.rest.sessions.listTasks(sessionId));
  }

  /** Single task; `with_output` opts into the tail-of-log preview (≤32KB default). */
  getTask(
    sessionId: string,
    taskId: string,
    query: { with_output?: boolean; output_bytes?: number } = {},
  ): Promise<Task> {
    return this.run(() => this.rest.sessions.getTask(sessionId, taskId, query));
  }

  cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: boolean }> {
    return this.sessions.cancelTask(sessionId, taskId);
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

  async getConfig(): Promise<KikiConfigResponse> {
    return parseKikiConfigResponse(await this.run(this.rest.config.get()));
  }

  /** `GET /api/nb-search/capabilities` — secret-free provider/lane/pipeline descriptors. */
  async getNbSearchCapabilities(): Promise<NbSearchCapabilities> {
    return nbSearchCapabilitiesSchema.parse(await this.run(this.rest.nbSearch.capabilities()));
  }

  /** `GET /api/nb-search/test` — on-demand readiness check; callers pass a signal so the panel can cancel. */
  async testNbSearch(signal?: AbortSignal): Promise<NbSearchTestStatus> {
    return nbSearchTestStatusSchema.parse(await this.run(this.rest.nbSearch.test({ signal })));
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

  updateNamedAgentProfile(
    name: string,
    body: UpdateNamedAgentProfileRequest,
  ): Promise<NamedAgentProfile> {
    return this.run(this.rest.agents.update(name, body));
  }

  async readHostFile(path: string): Promise<string> {
    return this.run(this.rest.filesystem.readHostFile(path));
  }

  /** Binary variant of readHostFile, retaining the server MIME. */
  async readHostFileBytes(path: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const result = await this.run(this.rest.filesystem.readHostFileBytes(path));
    return { bytes: result.bytes, mime: result.mime };
  }

  /** Read a canonical transcript attachment (or its staged-upload fallback). */
  async readSessionMediaBytes(
    sessionId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
    return this.run(this.rest.sessions.media(sessionId, fileId));
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

  /** Server-side model probe using the configured provider credentials. */
  refreshProvider(providerId: string): Promise<RefreshProviderModelsResponse> {
    return this.run(this.klient.global.kosong.refreshProviders({ providerId }));
  }

  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    return this.run(this.klient.global.kosong.setDefaultModel(modelId));
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

  listPluginMarketplace(): Promise<PluginMarketplaceResponse> {
    return this.run(this.rest.plugins.marketplace());
  }

  getPlugin(pluginId: string): Promise<PluginInfo> {
    return this.run(this.klient.global.plugins.info(pluginId) as Promise<PluginInfo>);
  }

  installPlugin(source: string): Promise<PluginSummary> {
    return this.run(this.rest.plugins.install(source) as Promise<PluginSummary>);
  }

  setPluginEnabled(pluginId: string, enabled: boolean): Promise<{ readonly ok: true }> {
    return this.run(this.rest.plugins.setEnabled(pluginId, enabled));
  }

  removePlugin(pluginId: string): Promise<{ readonly ok: true }> {
    return this.run(this.rest.plugins.remove(pluginId));
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
}
