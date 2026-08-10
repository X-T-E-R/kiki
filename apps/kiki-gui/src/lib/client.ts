/**
 * REST client for the kap-server `/api/v1` surface.
 *
 * Every route replies HTTP 200 with an envelope `{code, msg, data, request_id}`;
 * `code === 0` means success. A few routes use non-zero codes for domain
 * outcomes (question dismiss reports `40909` with a real payload), so callers
 * can widen the accepted-code set per request.
 */

import type {
  ApprovalRequest,
  ApprovalResolveRequest,
  ApprovalResolveResult,
  ArchiveSessionResponse,
  AuthSummary,
  ConfigResponse,
  Envelope,
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
  SUCCESS: 0,
  UNAUTHORIZED: 40101,
  APPROVAL_ALREADY_RESOLVED: 40902,
  PROMPT_ALREADY_COMPLETED: 40903,
  TASK_ALREADY_FINISHED: 40904,
  QUESTION_DISMISSED: 40909,
  APPROVAL_EXPIRED: 41001,
  QUESTION_EXPIRED: 41002,
} as const;

export interface KikiClientOptions {
  /** Absolute base (`http://host:port`) or '' for same-origin (dev proxy). */
  readonly baseUrl: string;
  readonly token?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  const root = baseUrl === '' ? window.location.origin : baseUrl.replace(/\/+$/, '');
  return `${root}/api/v1${path}`;
}

export class KikiClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: KikiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token !== undefined && options.token !== '' ? options.token : undefined;
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

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
    } catch (error) {
      throw new ApiError({
        code: -1,
        msg: error instanceof Error ? error.message : 'network error',
        data: null,
      });
    }

    let envelope: Envelope<unknown>;
    try {
      envelope = (await response.json()) as Envelope<unknown>;
    } catch {
      throw new ApiError({
        code: response.status,
        msg: `HTTP ${response.status} — non-JSON response`,
        data: null,
      });
    }
    const okCodes = options.okCodes ?? [API_CODES.SUCCESS];
    if (!okCodes.includes(envelope.code)) {
      throw new ApiError(envelope);
    }
    return envelope.data as T;
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

  patchConfig(body: PatchConfigRequest): Promise<ConfigResponse> {
    return this.request<ConfigResponse>('POST', '/config', { body });
  }
}
