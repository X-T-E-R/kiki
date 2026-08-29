/**
 * REST client for the kap-server `/api/v1` surface.
 *
 * Every route replies HTTP 200 with an envelope `{code, msg, data, request_id}`;
 * `code === 0` means success. A few routes use non-zero codes for domain
 * outcomes (question dismiss reports `40909` with a real payload), so callers
 * can widen the accepted-code set per request.
 */

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
  Envelope,
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
  NamedAgentModelProfile as ProtocolNamedAgentModelProfile,
  NamedAgentRoute as ProtocolNamedAgentRoute,
  NamedAgentSpawnConstraints as ProtocolNamedAgentSpawnConstraints,
  NamedAgentSubagentLease as ProtocolNamedAgentSubagentLease,
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
  SessionSnapshotResponse,
  SetDefaultModelResponse,
  Task,
  Terminal,
  UndoSessionResponse,
  UpdateSessionProfileRequest,
  Workspace,
} from '@moonshot-ai/protocol';

export class ApiError extends Error {
  readonly code: number;
  readonly requestId: string | undefined;
  readonly data: unknown;

  constructor(envelope: { code: number; msg: string; data: unknown; request_id?: string }) {
    super(`${envelope.msg} (code ${envelope.code})`);
    this.name = 'ApiError';
    this.code = envelope.code;
    this.data = envelope.data;
    this.requestId = envelope.request_id;
  }
}

export const API_CODES = {
  INVALID_RESPONSE: -3,
  TIMEOUT: -2,
  SUCCESS: 0,
  UNAUTHORIZED: 40101,
  SESSION_NOT_FOUND: 40401,
  PROMPT_NOT_FOUND: 40402,
  SKILL_NOT_FOUND: 40415,
  SESSION_BUSY: 40901,
  APPROVAL_ALREADY_RESOLVED: 40902,
  PROMPT_ALREADY_COMPLETED: 40903,
  TASK_ALREADY_FINISHED: 40904,
  QUESTION_DISMISSED: 40909,
  COMPACTION_UNABLE: 40910,
  SESSION_UNDO_UNAVAILABLE: 40911,
  SKILL_NOT_ACTIVATABLE: 40912,
  APPROVAL_EXPIRED: 41001,
  QUESTION_EXPIRED: 41002,
  TERMINAL_NOT_FOUND: 40414,
  MESSAGE_ACTION_UNAVAILABLE: 40936,
  SESSION_CURSOR_MISMATCH: 40937,
  SESSION_INDEX_BUILDING: 40939,
} as const;

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
 * re-exported by `@moonshot-ai/protocol`, so they are hand-rolled here from
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
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
}

export type KikiConfigResponse = Omit<ConfigResponse, 'subagent'> & RuntimeConfigProjection & {
  readonly subagent?: NonNullable<ConfigResponse['subagent']> & {
    readonly denyModels?: string[];
  };
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
  readonly tools?: { readonly enabled?: string[]; readonly disabled?: string[] };
}

export type KikiConfigPatch = Omit<
  PatchConfigRequest,
  'subagent' | 'replace_domains' | 'request_identity'
> & RuntimeConfigPatch & {
  readonly request_identity?: RequestIdentityPolicyWire | null;
  readonly subagent?: NonNullable<PatchConfigRequest['subagent']> & {
    readonly deny_models?: string[];
  };
  readonly replace_domains?: readonly string[];
};

// Named-agent wire shapes alias the protocol contract types directly so the
// GUI can never drift from the /agents schema (the subagent lease in
// particular carries the full constraint field set).
export type NamedAgentRoute = ProtocolNamedAgentRoute;
export type NamedAgentModelProfile = ProtocolNamedAgentModelProfile;
export type NamedAgentSpawnConstraints = ProtocolNamedAgentSpawnConstraints;
export type NamedAgentSubagentLease = ProtocolNamedAgentSubagentLease;

export interface NamedAgentProfile {
  readonly name: string;
  readonly description?: string;
  readonly when_to_use?: string;
  readonly source: string;
  readonly workspace_id?: string;
  /** Merged /agents view: every workspace this name+source+file applies to. */
  readonly workspace_ids?: string[];
  readonly source_file?: string;
  /** Curated main-profile flag from the engine catalog. */
  readonly main: boolean;
  /** File profile explicitly overriding the same-named built-in profile. */
  readonly override?: boolean;
  readonly executor?: string;
  readonly executor_protocol?: string;
  readonly executor_options?: Readonly<Record<string, string | number | boolean>>;
  readonly pinned_model_alias?: string;
  readonly thinking_effort?: string;
  readonly service_tier?: 'auto' | 'default' | 'flex' | 'priority';
  readonly tools?: string[];
  readonly disallowed_tools?: string[];
  readonly disabled: boolean;
  readonly routes: NamedAgentRoute[];
  readonly model_profiles?: NamedAgentModelProfile[];
  readonly spawn_constraints?: NamedAgentSpawnConstraints;
  readonly subagents?: (string | NamedAgentSubagentLease)[];
}

export interface ListNamedAgentProfilesResponse {
  readonly items: NamedAgentProfile[];
}

export interface UpdateNamedAgentProfileRequest {
  readonly scope: 'user' | 'project' | 'extra';
  readonly workspace_id: string;
  readonly description?: string;
  readonly when_to_use?: string | null;
  readonly pinned_model_alias?: string | null;
  readonly thinking_effort?: string | null;
  readonly service_tier?: 'auto' | 'default' | 'flex' | 'priority' | null;
  readonly tools?: readonly string[] | null;
  readonly disallowed_tools?: readonly string[] | null;
  readonly routes?: readonly {
    readonly id: string;
    readonly description?: string;
    readonly model_alias?: string | null;
  }[];
  readonly raw_text?: string;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

/** Which layer an entry came from. Only `global` (user-level) entries are writable. */
export type McpServerSource = 'global' | 'plugin' | 'caller';

interface McpCommonConfig {
  readonly enabled?: boolean;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabledTools?: readonly string[];
  readonly disabledTools?: readonly string[];
}

export type McpServerConfig =
  | (McpCommonConfig & {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
      readonly executor?: 'local' | 'kaos';
      readonly runtime_id?: string;
    })
  | (McpCommonConfig & {
      readonly transport: 'http' | 'sse';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly auth?: 'oauth';
      readonly bearerTokenEnvVar?: string;
    });

/**
 * What the management plane returns. Writable entries carry the full config so
 * the editor can prefill; read-only ones are redacted to sorted key lists and
 * never disclose secret values.
 */
export type McpServerConfigView =
  | (Omit<Extract<McpServerConfig, { readonly transport: 'stdio' }>, 'env'> & {
      readonly envKeys?: readonly string[];
    })
  | (Omit<Exclude<McpServerConfig, { readonly transport: 'stdio' }>, 'headers'> & {
      readonly headerKeys?: readonly string[];
    });

/** Writable entries arrive as the full config; read-only ones as the redacted view. */
export type McpManagedServerConfig = McpServerConfig | McpServerConfigView;

export interface McpManagedServer {
  readonly name: string;
  readonly config: McpManagedServerConfig;
  readonly source: McpServerSource;
  /** The file or plugin the effective entry was last defined in. */
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: { readonly id: string; readonly name: string };
}

/** The management plane writes the user-level file; the body carries the name. */
export type McpManagedServerInput = McpServerConfig & { readonly name: string };

export interface McpServerTestResult {
  readonly success: boolean;
  readonly output: string;
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
      state: 'running' | 'done' | 'error';
      input?: unknown;
      output?: unknown;
      display?: unknown;
      error?: string;
      inputText?: string;
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
     * discriminated union lives in `@moonshot-ai/transcript`; GUI only
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

export interface SnapshotOptions {
  readonly transcript?: boolean;
}

/** Cursor / page options for {@link KikiClient.getAgentTranscript}. */
export interface GetAgentTranscriptOptions {
  /** Page toward older turns (`before_turn`). Mutually exclusive with `afterTurn`. */
  readonly beforeTurn?: string;
  /** Page toward newer turns (`after_turn`). Mutually exclusive with `beforeTurn`. */
  readonly afterTurn?: string;
  /** Turns per page (`page_size`). Defaults to 100, matching the historical client. */
  readonly pageSize?: number;
}

/**
 * `GET /sessions` query widened with `workspace_id` — kap-server accepts it
 * (`sessionsListQueryCoercion`) but `@moonshot-ai/protocol`'s
 * `ListSessionsQuery` has not caught up, so the client advertises it locally.
 */
export interface ListSessionsOptions extends ListSessionsQuery {
  readonly workspace_id?: string;
}

/** kap-server exposes v1 and v2 side by side; the MCP management plane is v2-only. */
type ApiVersion = 'v1' | 'v2';

function joinUrl(baseUrl: string, path: string, version: ApiVersion = 'v1'): string {
  const root = baseUrl === '' ? window.location.origin : baseUrl.replace(/\/+$/, '');
  return `${root}/api/${version}${path}`;
}

export class KikiClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: KikiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token !== undefined && options.token !== '' ? options.token : undefined;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      /** Envelope codes treated as success (defaults to [0]). */
      okCodes?: readonly number[];
      signal?: AbortSignal;
      apiVersion?: ApiVersion;
    } = {},
  ): Promise<T> {
    const url = new URL(joinUrl(this.baseUrl, path, options.apiVersion));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token !== undefined) headers['Authorization'] = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => { controller.abort(options.signal?.reason); };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        throw new ApiError({
          code: timedOut ? API_CODES.TIMEOUT : -1,
          msg: timedOut
            ? `Request timed out after ${this.timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : 'network error',
          data: null,
        });
      }

      let envelope: Envelope<unknown>;
      try {
        envelope = (await response.json()) as Envelope<unknown>;
      } catch {
        if (timedOut) {
          throw new ApiError({
            code: API_CODES.TIMEOUT,
            msg: `Request timed out after ${this.timeoutMs}ms`,
            data: null,
          });
        }
        throw new ApiError({
          code: response.status,
          msg: `HTTP ${response.status} — non-JSON response`,
          data: null,
        });
      }
      const okCodes = options.okCodes ?? [API_CODES.SUCCESS];
      if (!okCodes.includes(envelope.code)) throw new ApiError(envelope);
      return envelope.data as T;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** `GET /healthz` — auth-exempt liveness probe used by "detect local server". */
  async healthz(baseUrlOverride?: string): Promise<boolean> {
    try {
      const response = await fetch(joinUrl(baseUrlOverride ?? this.baseUrl, '/healthz'), {
        headers: { Accept: 'application/json' },
      });
      const envelope = (await response.json()) as Envelope<{ ok: boolean } | null>;
      return envelope.code === 0 && envelope.data?.ok === true;
    } catch {
      return false;
    }
  }

  meta(): Promise<MetaResponse & { experimental_flags?: Record<string, boolean> }> {
    return this.request<MetaResponse & { experimental_flags?: Record<string, boolean> }>('GET', '/meta');
  }

  listSessions(query: ListSessionsOptions = {}): Promise<PageResponse<Session>> {
    return this.request<PageResponse<Session>>('GET', '/sessions', {
      query: {
        page_size: query.page_size ?? 100,
        before_id: query.before_id,
        after_id: query.after_id,
        busy: query.busy,
        include_archive: query.include_archive,
        archived_only: query.archived_only,
        exclude_empty: query.exclude_empty,
        workspace_id: query.workspace_id,
      },
    });
  }

  createSession(body: SessionCreate): Promise<Session> {
    return this.request<Session>('POST', '/sessions', { body });
  }

  getSession(sessionId: string): Promise<Session> {
    return this.request<Session>('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Rename etc. — `POST /sessions/{id}/profile` with a SessionUpdate body. */
  updateSessionProfile(
    sessionId: string,
    body: UpdateSessionProfileRequest,
  ): Promise<Session> {
    return this.request<Session>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/profile`,
      { body },
    );
  }

  archiveSession(sessionId: string): Promise<ArchiveSessionResponse> {
    return this.request<ArchiveSessionResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}:archive`,
      { body: {} },
    );
  }

  restoreSession(sessionId: string): Promise<RestoreSessionResponse> {
    return this.request<RestoreSessionResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}:restore`,
      { body: {} },
    );
  }

  snapshot(sessionId: string, options?: SnapshotOptions): Promise<SessionSnapshotResponse> {
    return this.request<SessionSnapshotResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      { query: { mode: options?.transcript === true ? 'transcript' : undefined } },
    );
  }

  getSessionGoal(sessionId: string): Promise<GoalSnapshot | null> {
    return this.request<GoalSnapshot | null>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/goal`,
    );
  }

  getTranscriptOps(
    sessionId: string,
    agentId: string,
    since: { readonly seq: number; readonly epoch?: string },
    grade: 'turn' | 'block' | 'delta' = 'delta',
  ): Promise<{
    readonly session_id: string;
    readonly agent_id: string;
    readonly epoch: string;
    readonly batches: readonly { readonly seq: number; readonly ops: readonly unknown[] }[];
    readonly through_seq: number;
    readonly complete: boolean;
  }> {
    return this.request(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/transcript/ops`,
      {
        query: {
          agent_id: agentId,
          since_seq: since.seq,
          epoch: since.epoch,
          grade,
        },
      },
    );
  }

  getAgentTranscript(
    sessionId: string,
    agentId: string,
    options?: GetAgentTranscriptOptions,
  ): Promise<AgentTranscriptResponse> {
    if (options?.beforeTurn !== undefined && options?.afterTurn !== undefined) {
      return Promise.reject(
        new Error('beforeTurn and afterTurn are mutually exclusive'),
      );
    }
    return this.request<AgentTranscriptResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/transcript`,
      {
        query: {
          agent_id: agentId,
          before_turn: options?.beforeTurn,
          after_turn: options?.afterTurn,
          page_size: options?.pageSize ?? 100,
        },
      },
    );
  }

  /** Older-history pages: `?before_id=<oldest loaded message id>&page_size=N`. */
  listMessages(
    sessionId: string,
    query: { before_id?: string; page_size?: number } = {},
  ): Promise<PageResponse<Message>> {
    return this.request<PageResponse<Message>>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      { query: { before_id: query.before_id, page_size: query.page_size ?? 50 } },
    );
  }

  listPrompts(sessionId: string): Promise<PromptListResponse> {
    return this.request<PromptListResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/prompts`,
    );
  }

  submitPrompt(sessionId: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    return this.request<PromptSubmitResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts`,
      { body },
    );
  }

  replacePrompt(
    sessionId: string,
    promptId: string,
    body: PromptReplaceRequest,
  ): Promise<PromptReplaceResult> {
    return this.request<PromptReplaceResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:replace`,
      { body },
    );
  }

  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse> {
    return this.request<PromptAbortResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      { body: {}, okCodes: [API_CODES.SUCCESS, API_CODES.PROMPT_ALREADY_COMPLETED] },
    );
  }

  /**
   * Steer a queued prompt into the currently running turn (`POST …:steer`):
   * the server merges its content into the active turn immediately instead of
   * waiting for the turn to end, and the prompt leaves the queue. The server
   * answers PROMPT_NOT_FOUND when no turn is active or the prompt already
   * left the queue.
   */
  steerPrompt(sessionId: string, promptId: string): Promise<PromptSteerResult> {
    return this.request<PromptSteerResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:steer`,
      { body: {} },
    );
  }

  listPendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
    return this.request<{ items: ApprovalRequest[] }>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/approvals`,
      { query: { status: 'pending' } },
    ).then((data) => data.items);
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    body: ApprovalResolveRequest,
  ): Promise<ApprovalResolveResult> {
    return this.request<ApprovalResolveResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { body },
    );
  }

  listPendingQuestions(sessionId: string): Promise<QuestionRequest[]> {
    return this.request<{ items: QuestionRequest[] }>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/questions`,
      { query: { status: 'pending' } },
    ).then((data) => data.items);
  }

  resolveQuestion(
    sessionId: string,
    questionId: string,
    body: QuestionResolveRequest,
  ): Promise<QuestionResolveResult> {
    return this.request<QuestionResolveResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`,
      { body },
    );
  }

  /** Dismiss reports envelope code 40909 with a real payload — still a success. */
  dismissQuestion(sessionId: string, questionId: string): Promise<QuestionDismissResult> {
    return this.request<QuestionDismissResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}:dismiss`,
      { body: {}, okCodes: [API_CODES.SUCCESS, API_CODES.QUESTION_DISMISSED] },
    );
  }

  listTasks(sessionId: string): Promise<ListTasksResponse> {
    return this.request<ListTasksResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/tasks`,
    );
  }

  /** Single task; `with_output` opts into the tail-of-log preview (≤32KB default). */
  getTask(
    sessionId: string,
    taskId: string,
    query: { with_output?: boolean; output_bytes?: number } = {},
  ): Promise<Task> {
    return this.request<Task>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
      { query: { with_output: query.with_output, output_bytes: query.output_bytes } },
    );
  }

  cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    return this.request<{ cancelled: true }>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}:cancel`,
      { body: {}, okCodes: [API_CODES.SUCCESS, API_CODES.TASK_ALREADY_FINISHED] },
    );
  }

  /**
   * Terminal lifecycle over REST (`/sessions/{id}/terminals*`). I/O (attach,
   * input, resize) rides the shared WebSocket as `terminal_*` control frames —
   * see `lib/ws.ts`. PTYs are loopback-only on kap-server
   * (`exposureClass === 'loopback'` gates the routes).
   */
  listTerminals(sessionId: string): Promise<ListTerminalsResponse> {
    return this.request<ListTerminalsResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/terminals`,
    );
  }

  createTerminal(sessionId: string, body: CreateTerminalRequest = {}): Promise<Terminal> {
    return this.request<Terminal>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/terminals`,
      { body },
    );
  }

  getTerminal(sessionId: string, terminalId: string): Promise<GetTerminalResponse> {
    return this.request<GetTerminalResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}`,
    );
  }

  /** `POST /sessions/{id}/terminals/{tid}:close` — kills the PTY. */
  closeTerminal(sessionId: string, terminalId: string): Promise<CloseTerminalResponse> {
    return this.request<CloseTerminalResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}:close`,
      { body: {} },
    );
  }

  listModels(): Promise<ListModelsResponse> {
    return this.request<ListModelsResponse>('GET', '/models');
  }

  async getConfig(): Promise<KikiConfigResponse> {
    return parseKikiConfigResponse(await this.request<unknown>('GET', '/config'));
  }

  listNamedAgentProfiles(): Promise<ListNamedAgentProfilesResponse> {
    return this.request<ListNamedAgentProfilesResponse>('GET', '/agents');
  }

  updateNamedAgentProfile(
    name: string,
    body: UpdateNamedAgentProfileRequest,
  ): Promise<NamedAgentProfile> {
    return this.request<NamedAgentProfile>('PATCH', `/agents/${encodeURIComponent(name)}`, { body });
  }

  async readHostFile(path: string): Promise<string> {
    const response = await this.fetchHostFile(path, 'text/plain');
    return await response.text();
  }

  /**
   * Binary variant of readHostFile (fs:content streams raw bytes with a
   * sniffed/extension MIME; the Accept header is ignored server-side).
   */
  async readHostFileBytes(path: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const response = await this.fetchHostFile(path, 'application/octet-stream');
    const mime =
      response.headers.get('content-type')?.split(';', 1)[0]?.trim() ||
      'application/octet-stream';
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime };
  }

  /** Read a canonical transcript attachment (or its staged-upload fallback). */
  async readSessionMediaBytes(
    sessionId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
    const url = new URL(
      joinUrl(
        this.baseUrl,
        `/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fileId)}`,
      ),
    );
    const response = await this.fetchRawFile(url, 'application/octet-stream');
    const mime =
      response.headers.get('content-type')?.split(';', 1)[0]?.trim() ||
      'application/octet-stream';
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    let name = match?.[1];
    if (name !== undefined) {
      try {
        name = decodeURIComponent(name);
      } catch {
        // Keep the server-provided token when it is not URI encoded.
      }
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime, name };
  }

  private async fetchHostFile(path: string, accept: string): Promise<Response> {
    const url = new URL(joinUrl(this.baseUrl, '/fs:content'));
    url.searchParams.set('path', path);
    return await this.fetchRawFile(url, accept);
  }

  private async fetchRawFile(url: URL, accept: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept };
    if (this.token !== undefined) headers['Authorization'] = `Bearer ${this.token}`;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (response.ok) return response;
      const envelope = await response.clone().json().catch(() => undefined) as Envelope<unknown> | undefined;
      if (envelope !== undefined && typeof envelope.code === 'number') throw new ApiError(envelope);
      throw new ApiError({ code: response.status, msg: `HTTP ${response.status}`, data: null });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError({
        code: timedOut ? API_CODES.TIMEOUT : -1,
        msg: timedOut
          ? `Request timed out after ${this.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'network error',
        data: null,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  listWorkspaces(): Promise<ListWorkspacesResponse> {
    return this.request<ListWorkspacesResponse>('GET', '/workspaces');
  }

  /** `PATCH /workspaces/{id}` — display-name rename (server echos the workspace). */
  renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
    return this.request<Workspace>(
      'PATCH',
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      { body: { name } },
    );
  }

  /** `PATCH /workspaces/{id}` — pin / unpin (server echos the workspace). */
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<Workspace> {
    return this.request<Workspace>(
      'PATCH',
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      { body: { pinned } },
    );
  }

  /** `DELETE /workspaces/{id}` — unregister (does not remove on-disk content). */
  removeWorkspace(workspaceId: string): Promise<{ deleted: true }> {
    return this.request<{ deleted: true }>(
      'DELETE',
      `/workspaces/${encodeURIComponent(workspaceId)}`,
    );
  }

  getAuth(): Promise<AuthSummary> {
    return this.request<AuthSummary>('GET', '/auth');
  }

  listProviders(): Promise<ListProvidersResponse> {
    return this.request<ListProvidersResponse>('GET', '/providers');
  }

  /**
   * `POST /providers/{id}:refresh` — server-side model probe. Uses the stored
   * key and avoids a browser-direct `/models` fetch (CORS / missing secret).
   */
  refreshProvider(providerId: string): Promise<RefreshProviderModelsResponse> {
    return this.request<RefreshProviderModelsResponse>(
      'POST',
      `/providers/${encodeURIComponent(providerId)}:refresh`,
    );
  }

  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    return this.request<SetDefaultModelResponse>(
      'POST',
      `/models/${encodeURIComponent(modelId)}:set_default`,
    );
  }

  getOAuthStatus(query: OAuthLoginQuery = {}): Promise<OAuthFlowSnapshot | null> {
    return this.request<OAuthFlowSnapshot | null>('GET', '/oauth/login', { query });
  }

  startOAuthLogin(body: OAuthLoginStartRequest = {}): Promise<OAuthFlowStart> {
    return this.request<OAuthFlowStart>('POST', '/oauth/login', { body });
  }

  cancelOAuthLogin(query: OAuthLoginQuery = {}): Promise<{ cancelled: boolean; status: string }> {
    return this.request<{ cancelled: boolean; status: string }>('DELETE', '/oauth/login', {
      query,
    });
  }

  logoutOAuth(body: OAuthLogoutRequest = {}): Promise<OAuthLogoutResponse> {
    return this.request<OAuthLogoutResponse>('POST', '/oauth/logout', { body });
  }

  listTools(sessionId?: string): Promise<ListToolsResponse> {
    return this.request<ListToolsResponse>('GET', '/tools', {
      query: sessionId !== undefined ? { session_id: sessionId } : {},
    });
  }

  listMcpServers(): Promise<ListMcpServersResponse> {
    return this.request<ListMcpServersResponse>('GET', '/mcp/servers');
  }

  /**
   * The `/api/v2/mcp/*` management plane. `cwd` widens resolution to the
   * project layers of that workspace; writes always land in the user-level
   * `mcp.json`, and every mutation echoes the refreshed list.
   */
  listManagedMcpServers(cwd?: string): Promise<readonly McpManagedServer[]> {
    return this.request<readonly McpManagedServer[]>('GET', '/mcp/servers', {
      apiVersion: 'v2',
      query: { cwd },
    });
  }

  addManagedMcpServer(
    server: McpManagedServerInput,
    cwd?: string,
  ): Promise<readonly McpManagedServer[]> {
    return this.request<readonly McpManagedServer[]>('POST', '/mcp/servers', {
      apiVersion: 'v2',
      query: { cwd },
      body: server,
    });
  }

  /** The path owns the identity, so the body carries the config without a name. */
  updateManagedMcpServer(
    name: string,
    config: McpServerConfig,
    cwd?: string,
  ): Promise<readonly McpManagedServer[]> {
    return this.request<readonly McpManagedServer[]>(
      'PUT',
      `/mcp/servers/${encodeURIComponent(name)}`,
      { apiVersion: 'v2', query: { cwd }, body: config },
    );
  }

  removeManagedMcpServer(name: string, cwd?: string): Promise<readonly McpManagedServer[]> {
    return this.request<readonly McpManagedServer[]>(
      'DELETE',
      `/mcp/servers/${encodeURIComponent(name)}`,
      { apiVersion: 'v2', query: { cwd } },
    );
  }

  /** Probe a real connection without persisting anything. */
  testManagedMcpServer(
    target: { readonly name?: string; readonly server?: McpManagedServerInput; readonly cwd?: string },
  ): Promise<McpServerTestResult> {
    return this.request<McpServerTestResult>('POST', '/mcp/servers::test', {
      apiVersion: 'v2',
      body: target,
    });
  }

  restartMcpServer(serverId: string): Promise<RestartMcpServerResult> {
    return this.request<RestartMcpServerResult>(
      'POST',
      `/mcp/servers/${encodeURIComponent(serverId)}:restart`,
      { body: {} },
    );
  }

  listWorkspaceSkills(workspaceId: string): Promise<ListSkillsResponse> {
    return this.request<ListSkillsResponse>(
      'GET',
      `/workspaces/${encodeURIComponent(workspaceId)}/skills`,
    );
  }

  /** Session-scoped skill catalog — feeds the composer's slash menu. */
  listSessionSkills(sessionId: string): Promise<ListSkillsResponse> {
    return this.request<ListSkillsResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/skills`,
    );
  }

  /**
   * `POST /sessions/{id}/skills/{name}:activate` — the wire-correct path for
   * slash commands: the server renders the skill prompt and starts a turn
   * (`skill_activation` origin); progress arrives over the WS stream.
   */
  activateSkill(
    sessionId: string,
    skillName: string,
    body: ActivateSkillRequest = {},
  ): Promise<ActivateSkillResult> {
    return this.request<ActivateSkillResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(skillName)}:activate`,
      { body },
    );
  }

  /**
   * `POST /files` — multipart upload for prompt file attachments. Kept off the
   * JSON `request` helper: the body is a FormData stream (the browser sets the
   * multipart boundary); the reply is the same envelope shape.
   */
  async uploadFile(file: File): Promise<FileMeta> {
    const form = new FormData();
    form.append('file', file, file.name === '' ? 'attachment' : file.name);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token !== undefined) headers['Authorization'] = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await fetch(joinUrl(this.baseUrl, '/files'), {
        method: 'POST',
        headers,
        body: form,
      });
    } catch (error) {
      throw new ApiError({
        code: -1,
        msg: error instanceof Error ? error.message : 'network error',
        data: null,
      });
    }
    const envelope = (await response.json()) as Envelope<unknown>;
    if (envelope.code !== API_CODES.SUCCESS) throw new ApiError(envelope);
    return envelope.data as FileMeta;
  }

  /**
   * `POST /sessions/{id}/fs:search` — workspace-scoped fuzzy file search; an
   * empty query lists the workspace root's top-level entries. This is the
   * documented feed for `@`-mention file pickers (`rest/fs.ts`).
   */
  fsSearch(
    sessionId: string,
    body: { query: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<FsSearchResponse> {
    return this.request<FsSearchResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/fs:search`,
      { body, signal },
    );
  }

  /**
   * `POST /workspace/fs:search` — session-less variant for the /new draft:
   * `workspace` is a registered workspace id or an absolute root path.
   */
  workspaceFsSearch(
    workspace: string,
    body: { query: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<FsSearchResponse> {
    return this.request<FsSearchResponse>('POST', '/workspace/fs:search', {
      body: { ...body, workspace },
      signal,
    });
  }

  /** `POST /search` — global full-text search across all sessions. */
  searchMessages(body: SearchMessagesBody, signal?: AbortSignal): Promise<SearchMessagesResponse> {
    return this.request<SearchMessagesResponse>('POST', '/search', { body, signal });
  }

  /**
   * `POST /sessions/{id}:fork` — copy the session. The message-closure pair
   * (`through_message_id` + `expected_cursor`) forks only the history through
   * that message and guards against a concurrent rewrite (40937).
   */
  forkSession(sessionId: string, body: KikiForkSessionRequest = {}): Promise<Session> {
    return this.request<Session>('POST', `/sessions/${encodeURIComponent(sessionId)}:fork`, {
      body,
    });
  }

  /**
   * `POST /sessions/{sid}/messages/{mid}:edit` — full-replacement edit of a
   * user message: the server truncates everything from the target onward and
   * resubmits the new content as a fresh prompt (PromptSubmitResult). 40936
   * when the message cannot be edited, 40937 on cursor mismatch, 40901 busy.
   */
  editMessage(
    sessionId: string,
    messageId: string,
    body: EditMessageRequest,
  ): Promise<PromptSubmitResult> {
    return this.request<PromptSubmitResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}:edit`,
      { body },
    );
  }

  /**
   * `POST /sessions/{sid}/messages/{mid}:regenerate` — drop the target
   * assistant reply (and anything after it) and rerun its turn. Same result
   * and error codes as :edit.
   */
  regenerateMessage(
    sessionId: string,
    messageId: string,
    body: RegenerateMessageRequest,
  ): Promise<PromptSubmitResult> {
    return this.request<PromptSubmitResult>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}:regenerate`,
      { body },
    );
  }

  /** Compacts older context. 40901 while busy, 40910 when nothing compactable. */
  compactSession(
    sessionId: string,
    body: CompactSessionRequest = {},
  ): Promise<CompactSessionResponse> {
    return this.request<CompactSessionResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}:compact`,
      { body },
    );
  }

  /** Removes the last `count` turns. 40911 when there is nothing to undo. */
  undoSession(
    sessionId: string,
    body: { count?: number; page_size?: number } = {},
  ): Promise<UndoSessionResponse> {
    return this.request<UndoSessionResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}:undo`,
      { body },
    );
  }

  /**
   * `POST /sessions/{id}/export` replies with a raw zip stream (not an
   * envelope), so it bypasses `request()`. Returns the archive bytes plus the
   * filename from Content-Disposition when the server provides one.
   */
  async exportSession(sessionId: string): Promise<{ blob: Blob; filename: string }> {
    const url = joinUrl(this.baseUrl, `/sessions/${encodeURIComponent(sessionId)}/export`);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token !== undefined) headers['Authorization'] = `Bearer ${this.token}`;
    const response = await fetch(url, { method: 'POST', headers, body: '{}' });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || contentType.includes('application/json')) {
      // Failure replies keep the JSON envelope shape.
      try {
        const envelope = (await response.json()) as Envelope<unknown>;
        throw new ApiError(envelope);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError({ code: response.status, msg: `HTTP ${response.status}`, data: null });
      }
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const filename = match?.[1] ?? `kiki-session-${sessionId}.zip`;
    return { blob: await response.blob(), filename };
  }

  async patchConfig(body: KikiConfigPatch): Promise<KikiConfigResponse> {
    return parseKikiConfigResponse(await this.request<unknown>('POST', '/config', { body }));
  }
}
