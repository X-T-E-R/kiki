import type {
  HttpRestConfigPatch,
  HttpRestCronTask,
  HttpRestCronTaskQuery,
  HttpRestFacade,
  HttpRestListSessionsQuery,
  HttpRestRequestOptions,
} from '../../core/facade/http-rest.js';
import type {
  ActivateSkillRequest,
  AuthSummary,
  ConfigResponse,
  FsSearchResponse,
  GetCatalogProviderResponse,
  ListMcpServersResponse,
  ListNamedAgentProfilesQuery,
  ListNamedAgentProfilesResponse,
  ListShippedAgentProfilesResponse,
  ListSkillsResponse,
  ListTasksResponse,
  ListToolsResponse,
  Message,
  MetaResponse,
  NamedAgentProfile,
  PageResponse,
  PromptListResponse,
  QuestionRequest,
  Session,
  SessionCreate,
  ShippedAgentProfile,
  Task,
  UpdateNamedAgentProfileRequest,
  UpdateSessionProfileRequest,
} from '@kiki/protocol';

export interface HttpRestJsonOptions extends HttpRestRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly okCodes?: readonly number[];
  readonly allowMissingRoute?: boolean;
  readonly expectBinary?: boolean;
  readonly jsonErrorOnSuccess?: boolean;
  readonly skipAuth?: boolean;
  readonly baseUrl?: string;
}

export interface HttpRestTransport {
  json<T>(path: string, options?: HttpRestJsonOptions): Promise<T>;
  raw<T>(
    path: string,
    options: HttpRestJsonOptions | undefined,
    consume: (response: Response) => Promise<T>,
  ): Promise<T>;
}

export function createHttpRestFacade(transport: HttpRestTransport): HttpRestFacade {
  return {
    healthz: async (baseUrlOverride) => {
      try {
        const data = await transport.json<{ readonly ok?: boolean } | null>('/healthz', {
          baseUrl: baseUrlOverride,
          timeoutMs: 0,
          skipAuth: true,
        });
        return data?.ok === true;
      } catch {
        return false;
      }
    },

    meta: () => transport.json<MetaResponse & { readonly experimental_flags?: Record<string, boolean> }>('/meta'),

    renewLease: (body) => transport.json<{
      readonly lease_id: string;
      readonly expires_at: number;
    } | undefined>('/leases', {
      method: 'POST',
      body,
      allowMissingRoute: true,
    }),

    usage: (query) => transport.json('/usage', { query }),

    sessions: {
      list: (query: HttpRestListSessionsQuery = {}) => transport.json<PageResponse<Session>>('/sessions', {
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
      }),
      create: (body: SessionCreate) => transport.json<Session>('/sessions', { method: 'POST', body }),
      compact: (sessionId: string, body = {}) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}:compact`,
        { method: 'POST', body },
      ),
      undo: (sessionId: string, body = {}) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}:undo`,
        { method: 'POST', body },
      ),
      updateProfile: (sessionId: string, body: UpdateSessionProfileRequest) => transport.json<Session>(
        `/sessions/${encodeURIComponent(sessionId)}/profile`,
        { method: 'POST', body },
      ),
      archive: (sessionId: string) => transport.json('/sessions/' + encodeURIComponent(sessionId) + ':archive', {
        method: 'POST', body: {},
      }),
      restore: (sessionId: string) => transport.json('/sessions/' + encodeURIComponent(sessionId) + ':restore', {
        method: 'POST', body: {},
      }),
      goal: (sessionId: string) => transport.json('/sessions/' + encodeURIComponent(sessionId) + '/goal'),
      listMessages: (sessionId: string, query = {}) => transport.json<PageResponse<Message>>(
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
        { query: { before_id: query.before_id, page_size: query.page_size ?? 50 } },
      ),
      listPrompts: (sessionId: string) => transport.json<PromptListResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/prompts`,
      ),
      listApprovals: async (sessionId: string) => {
        const result = await transport.json<{ readonly items: import('@kiki/protocol').ApprovalRequest[] }>(
          `/sessions/${encodeURIComponent(sessionId)}/approvals`,
          { query: { status: 'pending' } },
        );
        return result.items;
      },
      listQuestions: async (sessionId: string) => {
        const result = await transport.json<{ readonly items: QuestionRequest[] }>(
          `/sessions/${encodeURIComponent(sessionId)}/questions`,
          { query: { status: 'pending' } },
        );
        return result.items;
      },
      listTasks: (sessionId: string) => transport.json<ListTasksResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/tasks`,
      ),
      getTask: (sessionId: string, taskId: string, query = {}) => transport.json<Task>(
        `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
        {
          query: {
            with_output: query.with_output,
            output_bytes: query.output_bytes,
            agent_id: query.agent_id,
          },
        },
      ),
      listSkills: (sessionId: string) => transport.json<ListSkillsResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/skills`,
      ),
      activateSkill: (sessionId: string, skillName: string, body: ActivateSkillRequest = {}) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(skillName)}:activate`,
        { method: 'POST', body },
      ),
      fsSearch: (sessionId: string, body, options) => transport.json<FsSearchResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/fs:search`,
        { method: 'POST', body, signal: options?.signal, timeoutMs: options?.timeoutMs },
      ),
      media: async (sessionId: string, fileId: string) => readBinary(
        transport,
        `/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fileId)}`,
      ),
      export: (sessionId: string) => transport.raw(
        `/sessions/${encodeURIComponent(sessionId)}/export`,
        { method: 'POST', body: {}, timeoutMs: 0, expectBinary: true, jsonErrorOnSuccess: true },
        async (response) => {
          const disposition = response.headers.get('content-disposition') ?? '';
          const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/iu.exec(disposition);
          return {
            blob: await response.blob(),
            filename: match?.[1] ?? `kiki-session-${sessionId}.zip`,
          };
        },
      ),
    },

    skills: {
      readBuiltinContent: (name: string) => transport.json<import('@kiki/protocol').BuiltinSkillContentResponse>(
        `/skills/${encodeURIComponent(name)}:content`,
      ),
    },

    workspaces: {
      list: () => transport.json('/workspaces'),
      rename: (workspaceId: string, name: string) => transport.json(
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { method: 'PATCH', body: { name } },
      ),
      setPinned: (workspaceId: string, pinned: boolean) => transport.json(
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { method: 'PATCH', body: { pinned } },
      ),
      remove: (workspaceId: string) => transport.json(
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { method: 'DELETE' },
      ),
      listSkills: (workspaceId: string) => transport.json<ListSkillsResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/skills`,
      ),
    },

    config: {
      get: () => transport.json<ConfigResponse>('/config'),
      patch: (body: HttpRestConfigPatch) => transport.json<ConfigResponse>('/config', {
        method: 'POST',
        body,
      }),
    },

    catalog: {
      provider: (providerId: string) => transport.json<GetCatalogProviderResponse>(
        `/catalog/providers/${encodeURIComponent(providerId)}`,
      ),
    },

    nbSearch: {
      capabilities: () => transport.json('/nb-search/capabilities'),
      test: (options) => transport.json('/nb-search/test', {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
    },

    agents: {
      list: (query?: string | ListNamedAgentProfilesQuery) => transport.json<ListNamedAgentProfilesResponse>('/agents', {
        query: typeof query === 'string' ? { workspace_id: query } : query,
      }),
      update: (name: string, body: UpdateNamedAgentProfileRequest) => transport.json<NamedAgentProfile>(
        `/agents/${encodeURIComponent(name)}`,
        { method: 'PATCH', body },
      ),
      shipped: {
        list: () => transport.json<ListShippedAgentProfilesResponse>('/agents/shipped'),
        restore: (id: string) => transport.json<ShippedAgentProfile>(
          `/agents/shipped/${encodeURIComponent(id)}:restore`,
          { method: 'POST', body: {} },
        ),
      },
    },

    filesystem: {
      readHostFile: (path: string) => transport.raw(
        '/fs:content',
        { method: 'GET', query: { path } },
        (response) => response.text(),
      ),
      readHostFileBytes: (path: string) => readBinary(transport, '/fs:content', { query: { path } }),
      workspaceFsSearch: (workspace: string, body, options) => transport.json<FsSearchResponse>('/workspace/fs:search', {
        method: 'POST',
        body: { ...body, workspace },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
    },

    search: {
      messages: (body, options) => transport.json('/search', {
        method: 'POST',
        body,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
    },

    cron: {
      list: (query: HttpRestCronTaskQuery = {}) => transport.json<{ readonly items: readonly HttpRestCronTask[] }>(
        '/cron',
        { query: { session_id: query.session_id } },
      ),
      pause: (taskId, query: HttpRestCronTaskQuery = {}) => transport.json<{ readonly task: HttpRestCronTask }>(
        `/cron/${encodeURIComponent(taskId)}:pause`,
        { method: 'POST', body: {}, query: { session_id: query.session_id } },
      ),
      resume: (taskId, query: HttpRestCronTaskQuery = {}) => transport.json<{ readonly task: HttpRestCronTask }>(
        `/cron/${encodeURIComponent(taskId)}:resume`,
        { method: 'POST', body: {}, query: { session_id: query.session_id } },
      ),
      run: (taskId, query: HttpRestCronTaskQuery = {}) => transport.json<{ readonly triggered: true }>(
        `/cron/${encodeURIComponent(taskId)}:run`,
        { method: 'POST', body: {}, query: { session_id: query.session_id } },
      ),
      remove: (taskId, query: HttpRestCronTaskQuery = {}) => transport.json<{ readonly deleted: true }>(
        `/cron/${encodeURIComponent(taskId)}`,
        { method: 'DELETE', query: { session_id: query.session_id } },
      ),
    },

    runtime: {
      listTools: (sessionId) => transport.json<ListToolsResponse>('/tools', {
        query: sessionId === undefined ? undefined : { session_id: sessionId },
      }),
      listMcpServers: () => transport.json<ListMcpServersResponse>('/mcp/runtime/servers'),
      restartMcpServer: (serverId) => transport.json('/mcp/runtime/servers/' + encodeURIComponent(serverId) + ':restart', {
        method: 'POST',
        body: {},
      }),
    },

    plugins: {
      marketplace: () => transport.json('/plugins/marketplace'),
      install: (source: string) => transport.json('/plugins', {
        method: 'POST',
        body: { source },
        timeoutMs: 0,
      }),
      info: (id: string) => transport.json('/plugins/' + encodeURIComponent(id)),
      setEnabled: (id: string, enabled: boolean) => transport.json(
        `/plugins/${encodeURIComponent(id)}:${enabled ? 'enable' : 'disable'}`,
        { method: 'POST', body: {} },
      ),
      remove: (id: string) => transport.json(
        `/plugins/${encodeURIComponent(id)}:remove`,
        { method: 'POST', body: {} },
      ),
    },

    auth: {
      summary: () => transport.json<AuthSummary>('/auth'),
    },
  };
}

async function readBinary(
  transport: HttpRestTransport,
  path: string,
  options?: Pick<HttpRestJsonOptions, 'query' | 'signal' | 'expectBinary'>,
) {
  return transport.raw(
    path,
    { ...options, method: 'GET', expectBinary: true },
    async (response) => {
      const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
      const disposition = response.headers.get('content-disposition') ?? '';
      const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/iu.exec(disposition);
      let name = match?.[1];
      if (name !== undefined) {
        try {
          name = decodeURIComponent(name);
        } catch {
        }
      }
      return { bytes: new Uint8Array(await response.arrayBuffer()), mime, name };
    },
  );
}
