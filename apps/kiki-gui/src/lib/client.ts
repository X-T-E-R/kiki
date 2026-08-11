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
  CompactSessionRequest,
  CompactSessionResponse,
  ConfigResponse,
  Envelope,
  ForkSessionRequest,
  FsSearchResponse,
  GoalSnapshot,
  ListMcpServersResponse,
  ListModelsResponse,
  ListProvidersResponse,
  ListSessionsQuery,
  ListSkillsResponse,
  ListTasksResponse,
  ListToolsResponse,
  ListWorkspacesResponse,
  Message,
  MetaResponse,
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginQuery,
  OAuthLoginStartRequest,
  OAuthLogoutRequest,
  OAuthLogoutResponse,
  PageResponse,
  PatchConfigRequest,
  PromptAbortResponse,
  PromptListResponse,
  PromptSubmission,
  PromptSubmitResult,
  QuestionDismissResult,
  QuestionRequest,
  QuestionResolveRequest,
  QuestionResolveResult,
  RestartMcpServerResult,
  RestoreSessionResponse,
  Session,
  SessionCreate,
  SessionSnapshotResponse,
  SetDefaultModelResponse,
  UndoSessionResponse,
  UpdateSessionProfileRequest,
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
  TIMEOUT: -2,
  SUCCESS: 0,
  UNAUTHORIZED: 40101,
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
} as const;

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

export interface KikiClientOptions {
  /** Absolute base (`http://host:port`) or '' for same-origin (dev proxy). */
  readonly baseUrl: string;
  readonly token?: string;
  /** Per-request deadline; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

export type AgentTranscriptFrame =
  | { kind: 'text'; frameId: string; role: 'assistant' | 'user'; text: string }
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
}

export interface AgentTranscriptInteraction {
  readonly interactionId: string;
  readonly interactionKind: 'approval' | 'question';
  readonly toolCallId?: string;
  readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  readonly request?: unknown;
  readonly response?: unknown;
}

function joinUrl(baseUrl: string, path: string): string {
  const root = baseUrl === '' ? window.location.origin : baseUrl.replace(/\/+$/, '');
  return `${root}/api/v1${path}`;
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
    } = {},
  ): Promise<T> {
    const url = new URL(joinUrl(this.baseUrl, path));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token !== undefined) headers['Authorization'] = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(options.signal?.reason);
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

  meta(): Promise<MetaResponse> {
    return this.request<MetaResponse>('GET', '/meta');
  }

  listSessions(query: ListSessionsQuery = {}): Promise<PageResponse<Session>> {
    return this.request<PageResponse<Session>>('GET', '/sessions', {
      query: {
        page_size: query.page_size ?? 100,
        before_id: query.before_id,
        after_id: query.after_id,
        busy: query.busy,
        include_archive: query.include_archive,
        archived_only: query.archived_only,
        exclude_empty: query.exclude_empty,
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

  snapshot(sessionId: string): Promise<SessionSnapshotResponse> {
    return this.request<SessionSnapshotResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    );
  }

  getSessionGoal(sessionId: string): Promise<GoalSnapshot | null> {
    return this.request<GoalSnapshot | null>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/goal`,
    );
  }

  getAgentTranscript(
    sessionId: string,
    agentId: string,
  ): Promise<AgentTranscriptResponse> {
    return this.request<AgentTranscriptResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { query: { agent_id: agentId, page_size: 100 } },
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

  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse> {
    return this.request<PromptAbortResponse>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      { body: {}, okCodes: [API_CODES.SUCCESS, API_CODES.PROMPT_ALREADY_COMPLETED] },
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

  cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    return this.request<{ cancelled: true }>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}:cancel`,
      { body: {}, okCodes: [API_CODES.SUCCESS, API_CODES.TASK_ALREADY_FINISHED] },
    );
  }

  listModels(): Promise<ListModelsResponse> {
    return this.request<ListModelsResponse>('GET', '/models');
  }

  getConfig(): Promise<ConfigResponse> {
    return this.request<ConfigResponse>('GET', '/config');
  }

  listWorkspaces(): Promise<ListWorkspacesResponse> {
    return this.request<ListWorkspacesResponse>('GET', '/workspaces');
  }

  getAuth(): Promise<AuthSummary> {
    return this.request<AuthSummary>('GET', '/auth');
  }

  listProviders(): Promise<ListProvidersResponse> {
    return this.request<ListProvidersResponse>('GET', '/providers');
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

  forkSession(sessionId: string, body: ForkSessionRequest = {}): Promise<Session> {
    return this.request<Session>('POST', `/sessions/${encodeURIComponent(sessionId)}:fork`, {
      body,
    });
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

  patchConfig(body: PatchConfigRequest): Promise<ConfigResponse> {
    return this.request<ConfigResponse>('POST', '/config', { body });
  }
}
