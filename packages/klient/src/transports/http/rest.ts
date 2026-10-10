import type {
  HttpRestConfigPatch,
  HttpRestCronTask,
  HttpRestCronTaskQuery,
  HttpRestFacade,
  HttpRestListSessionsQuery,
  HttpRestRequestOptions,
} from '../../core/facade/http-rest.js';
import { personaAvatarForm, personaCardForm } from './persona-form.js';
import { createConnectionsFacade } from './connections.js';
import { createWebAccessFacade } from './web-access.js';
import { createThreadBridgesFacade } from './thread-bridges.js';
import { createUsageExportFacade } from './usage-export.js';
import { createProviderQuotaFacade } from './provider-quota.js';
import { createExternalClientsFacade } from './external-clients.js';
import { listAgentTasksQuerySchema, listAgentTasksResponseSchema } from '../../contract/session/agent-tasks.js';
import type {
  ActivateSkillRequest,
  AuthSummary,
  ConfigResponse,
  FsSearchResponse,
  GetCatalogProviderResponse,
  ListMcpServersResponse,
  CreateNamedAgentProfileRequest,
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
  PersonaImportPreview,
  PersonaImportResponse,
  PersonaSnapshot,
  PersonaSummary,
} from '@kiki/protocol';

export interface HttpRestJsonOptions extends HttpRestRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly rawBody?: unknown;
  readonly query?: Record<string, string | readonly string[] | number | boolean | undefined>;
  readonly headers?: Readonly<Record<string, string>>;
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
    externalClients: createExternalClientsFacade(transport),
    webAccess: createWebAccessFacade(transport),
    connections: createConnectionsFacade(transport),
    threadBridges: createThreadBridgesFacade(transport),
    usageExport: createUsageExportFacade(transport),
    providerQuotas: createProviderQuotaFacade(transport),
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
    requestGovernance: () => transport.json('/usage/realtime'),
    agentActivity: () => transport.json('/usage/realtime/agents'),
    usageRescan: {
      status: () => transport.json('/usage/rescan'),
      start: () => transport.json('/usage/rescan', { method: 'POST' }),
    },
    usagePricing: {
      get: (models) => transport.json('/usage/pricing', { query: { model: models } }),
      set: (update) => transport.json('/usage/pricing', { method: 'PUT', body: update }),
    },

    shortcuts: {
      read: (platform) => transport.json('/gui/shortcuts', { query: { platform } }),
      write: (platform, preferences) => transport.json('/gui/shortcuts', { method: 'PUT', query: { platform }, body: { preferences } }),
      reset: (platform, target = {}) => transport.json('/gui/shortcuts/reset', { method: 'POST', query: { platform }, body: target }),
    },

    browser: {
      list: () => transport.json('/browser/connections'),
      upsert: (id, input) => transport.json(`/browser/connections/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
      remove: (id) => transport.json(`/browser/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      setDefault: (browser) => transport.json('/browser/default', { method: 'PUT', body: { browser } }),
      status: (id) => transport.json(`/browser/connections/${encodeURIComponent(id)}:status`),
      tabs: (id) => transport.json(`/browser/connections/${encodeURIComponent(id)}:tabs`),
      catalog: (id, options) => transport.json(`/browser/connections/${encodeURIComponent(id)}:catalog`, { query: { includeSchema: options?.includeSchema } }),
      check: (id) => transport.json(`/browser/connections/${encodeURIComponent(id)}:check`, { method: 'POST', body: {} }),
      connect: (id) => transport.json(`/browser/connections/${encodeURIComponent(id)}:connect`, { method: 'POST', body: {} }),
      disconnect: (id) => transport.json(`/browser/connections/${encodeURIComponent(id)}:disconnect`, { method: 'POST', body: {} }),
    },

    ssh: {
      list: (workspaceId) => transport.json('/ssh/hosts', { query: { workspace_id: workspaceId } }),
      discover: () => transport.json('/ssh/hosts:discover'),
      upsert: (id, host, workspaceId) => transport.json(`/ssh/hosts/${encodeURIComponent(id)}`, {
        method: 'PUT', body: host, query: { workspace_id: workspaceId },
      }),
      remove: (id, workspaceId) => transport.json(`/ssh/hosts/${encodeURIComponent(id)}`, {
        method: 'DELETE', query: { workspace_id: workspaceId },
      }),
      configSync: () => transport.json('/ssh/config-sync'),
      setConfigSync: (enabled) => transport.json('/ssh/config-sync', { method: 'PUT', body: { enabled } }),
      hostKeys: (id, workspaceId) => transport.json(`/ssh/hosts/${encodeURIComponent(id)}:host-keys`, {
        query: { workspace_id: workspaceId },
      }),
      connectionApproval: () => transport.json('/ssh/connection-approval'),
      setConnectionApproval: (enabled) => transport.json('/ssh/connection-approval', { method: 'PUT', body: { enabled } }),
      writeBack: (id, workspaceId) => transport.json(`/ssh/hosts/${encodeURIComponent(id)}:write-back`, {
        method: 'POST', body: {}, query: { workspace_id: workspaceId },
      }),
      status: (id, workspaceId) => transport.json(`/ssh/hosts/${encodeURIComponent(id)}:status`, {
        query: { workspace_id: workspaceId },
      }),
      disconnect: (id, workspaceId) => transport.json(`/ssh/hosts/${encodeURIComponent(id)}:disconnect`, {
        method: 'POST', body: {}, query: { workspace_id: workspaceId },
      }),
      sessionHosts: (sessionId) => transport.json(`/sessions/${encodeURIComponent(sessionId)}/ssh/hosts`),
      addSessionHost: (sessionId, hostId) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}/ssh/hosts/${encodeURIComponent(hostId)}`, { method: 'PUT', body: {} },
      ),
      removeSessionHost: (sessionId, hostId) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}/ssh/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' },
      ),
      submitApproval: (sessionId, approvalId, body) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}/ssh/approvals/${encodeURIComponent(approvalId)}`,
        { method: 'POST', body },
      ),
      copySharedCredentialsToIsolated: (body) => transport.json('/ssh/credentials:copy-to-isolated', { method: 'POST', body }),
    },

    worktrees: {
      list: (query) => transport.json('/worktrees', { query }),
      get: (id) => transport.json(`/worktrees/${encodeURIComponent(id)}`),
      inspect: (id) => transport.json(`/worktrees/${encodeURIComponent(id)}:inspect`, { method: 'POST', body: {} }),
      remove: (id, body = {}) => transport.json(`/worktrees/${encodeURIComponent(id)}:remove`, { method: 'POST', body }),
      gc: (dryRun) => transport.json('/worktrees:gc', { method: 'POST', body: { dryRun } }),
    },

    sessions: {
      list: (query: HttpRestListSessionsQuery = {}) => transport.json<import('@kiki/protocol').ListSessionsResponse>('/sessions', {
        query: {
          page_size: query.page_size ?? 50,
          before_id: query.before_id,
          after_id: query.after_id,
          busy: query.busy,
          include_archive: query.include_archive,
          include_ephemeral: query.include_ephemeral,
          archived_only: query.archived_only,
          exclude_empty: query.exclude_empty,
          workspace_id: query.workspace_id,
          persona: query.persona,
        },
      }),
      listEphemeral: (query = {}) => transport.json<import('@kiki/protocol').ListEphemeralSessionsResponse>('/sessions/ephemeral', { query: { ...query, page_size: query.page_size ?? 50 } }),
      create: (body: SessionCreate) => transport.json<Session>('/sessions', { method: 'POST', body }),
      saveEphemeral: (sessionId: string) => transport.json<Session>(`/sessions/${encodeURIComponent(sessionId)}/ephemeral/save`, { method: 'POST', body: {} }),
      endEphemeral: (sessionId: string, body = {}) => transport.json<import('@kiki/protocol').EndEphemeralSessionResponse>(`/sessions/${encodeURIComponent(sessionId)}/ephemeral/end`, { method: 'POST', body }),
      compact: (sessionId: string, body = {}) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}:compact`,
        { method: 'POST', body },
      ),
      getAutoCompact: (sessionId: string, agentId: string) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/auto-compact`,
      ),
      setAutoCompact: (sessionId: string, agentId: string, input: import('@kiki/protocol').AutoCompactWrite) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/auto-compact`,
        { method: 'PATCH', body: input },
      ),
      inspectHooks: (sessionId: string, agentId: string) => transport.json<import('@kiki/protocol').AgentHooksInspect>(
        `/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(agentId)}/hooks`,
      ),
      undo: (sessionId: string, body = {}) => transport.json(
        `/sessions/${encodeURIComponent(sessionId)}:undo`,
        { method: 'POST', body },
      ),
      updateProfile: (sessionId: string, body: UpdateSessionProfileRequest) => transport.json<Session>(
        `/sessions/${encodeURIComponent(sessionId)}/profile`,
        { method: 'POST', body },
      ),
      getPersonaSettings: (sessionId: string) => transport.json<import('@kiki/protocol').SessionPersonaSettings>(
        `/sessions/${encodeURIComponent(sessionId)}/persona-settings`,
      ),
      applyPersonaSettings: (sessionId: string, input = {}) => transport.json<import('@kiki/protocol').SessionPersonaSettings>(
        `/sessions/${encodeURIComponent(sessionId)}/persona-settings`, { method: 'POST', body: input },
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
      listTasks: (sessionId: string, query) => transport.json<ListTasksResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/tasks`,
        { query: { status: query?.status, page_size: query?.page_size, offset: query?.offset } },
      ),
      listAgentTasks: async (sessionId, query = {}, options = {}) => {
        const input = listAgentTasksQuerySchema.parse(query);
        return listAgentTasksResponseSchema.parse(await transport.json(
          `/sessions/${encodeURIComponent(sessionId)}/agent-tasks`,
          { ...options, query: { page_size: input.page_size, page_token: input.page_token } },
        ));
      },
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
      media: async (sessionId: string, fileId: string, options) => readBinary(
        transport, `/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fileId)}`,
        { signal: options?.signal, timeoutMs: options?.timeoutMs, headers: mediaHeaders(options) },
      ),
      mediaPreview: async (sessionId: string, fileId: string, options) => readBinary(
        transport, `/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fileId)}/preview`,
        { query: { media_type: options?.mediaType }, signal: options?.signal, timeoutMs: options?.timeoutMs, headers: mediaHeaders(options) }, 64 * 1024,
      ),
      downloadMedia: (sessionId, fileId, sink, options) => transport.raw(
        `/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(fileId)}`,
        { method: 'GET', expectBinary: true, signal: options?.signal, timeoutMs: options?.timeoutMs ?? 0, headers: mediaHeaders(options) },
        (response) => consumeMedia(response, sink, options?.signal),
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

    bots: {
      list: () => transport.json('/bots'),
      enable: (id) => transport.json(`/bots/${encodeURIComponent(id)}/enable`, { method: 'POST' }),
      ensureHomeSession: (id) => transport.json(`/bots/${encodeURIComponent(id)}/home`, { method: 'POST' }),
      update: (id, body) => transport.json(`/bots/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    },
    rooms: {
      list: () => transport.json('/rooms'),
      listItems: () => transport.json('/rooms/items'),
      get: (id) => transport.json(`/rooms/${encodeURIComponent(id)}`),
      create: (body) => transport.json('/rooms', { method: 'POST', body }),
      createFromThreads: (body) => transport.json('/rooms/from-threads', { method: 'POST', body }),
      searchThreads: (query) => transport.json('/rooms/threads', { query }),
      addMember: (id, body) => transport.json(`/rooms/${encodeURIComponent(id)}/members`, { method: 'POST', body }),
      removeMember: (id, memberId) => transport.json(`/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' }),
      update: (id, body) => transport.json(`/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
      delete: async (id) => { await transport.json(`/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
      postUserMessage: (id, body) => transport.json(`/rooms/${encodeURIComponent(id)}/messages`, { method: 'POST', body }),
      pause: (id) => transport.json(`/rooms/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
      continue: (id) => transport.json(`/rooms/${encodeURIComponent(id)}/continue`, { method: 'POST' }),
      stop: (id) => transport.json(`/rooms/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
      log: (id, query) => transport.json(`/rooms/${encodeURIComponent(id)}/log`, { query }),
      usage: (id) => transport.json(`/rooms/${encodeURIComponent(id)}/usage`),
    },
    personas: {
      list: (options) => transport.json<readonly PersonaSummary[]>('/personas', {
        query: { includeArchived: options?.includeArchived },
      }),
      get: (id) => transport.json<PersonaSnapshot>(`/personas/${encodeURIComponent(id)}`),
      ensureHome: (id) => transport.json(`/personas/${encodeURIComponent(id)}/home`, { method: 'POST' }),
      setHome: (id, sessionId) => transport.json(`/personas/${encodeURIComponent(id)}/home`, { method: 'PUT', body: { sessionId } }),
      updateState: (id, body) => transport.json(`/personas/${encodeURIComponent(id)}/state`, { method: 'PATCH', body }),
      put: (input) => transport.json<PersonaSnapshot>(`/personas/${encodeURIComponent(input.definition.id)}`, {
        method: 'PUT',
        body: input,
      }),
      duplicate: (id, options) => transport.json<PersonaSnapshot>(`/personas/${encodeURIComponent(id)}:duplicate`, {
        method: 'POST', body: options ?? {},
      }),
      archive: (id, archived = true) => transport.json(`/personas/${encodeURIComponent(id)}:archive`, {
        method: 'POST', body: { archived },
      }),
      delete: (id, options) => transport.json(`/personas/${encodeURIComponent(id)}`, {
        method: 'DELETE', query: { expectedRevision: options?.expectedRevision },
      }),
      previewImport: (input) => transport.json<PersonaImportPreview>('/personas/import/preview', {
        method: 'POST', rawBody: personaCardForm(input),
      }),
      importCard: (input) => transport.json<PersonaImportResponse>('/personas/import', {
        method: 'POST', rawBody: personaCardForm(input),
      }),
      exportCard: (id, format, options) => readBinary(transport, `/personas/${encodeURIComponent(id)}/export`, {
        query: { format, includeMemory: options?.includeMemory }, signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
      getAvatar: (id, options) => readBinary(transport, `/personas/${encodeURIComponent(id)}/avatar`, {
        signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
      putAvatar: (id, data, mimeType, shape) => transport.json(`/personas/${encodeURIComponent(id)}/avatar`, {
        method: 'PUT', rawBody: personaAvatarForm(data, mimeType, shape),
      }),
      deleteAvatar: (id) => transport.json(`/personas/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' }),
      avatar: ({ id, name, avatarMime, avatarShape }) => ({
        id,
        name,
        avatarUrl: avatarMime === undefined ? undefined : `/api/personas/${encodeURIComponent(id)}/avatar`,
        avatarShape: avatarMime === undefined ? undefined : avatarShape,
      }),
    },

    skills: {
      list: (cwd) => transport.json<ListSkillsResponse>('/skills', { query: { cwd } }),
      readBuiltinContent: (name: string) => transport.json<import('@kiki/protocol').BuiltinSkillContentResponse>(
        `/skills/${encodeURIComponent(name)}:content`,
      ),
      previewHostInstall: (host: 'claude' | 'codex' | 'grok' | 'agents') => transport.json<{
        host: string; directory: string; path: string; overwrites: boolean; revision: string;
      }>('/skills/kiki-as-subagent:preview-install', { method: 'POST', body: { host } }),
      installHost: (host: 'claude' | 'codex' | 'grok' | 'agents', revision: string) => transport.json<{
        host: string; directory: string; path: string; overwrites: boolean; revision: string;
      }>('/skills/kiki-as-subagent:install', { method: 'POST', body: { host, revision, confirmed: true } }),
    },

    skins: {
      // `allowMissingRoute`: a server older than the skin surface answers 404,
      // and an outdated server must not make the appearance page look broken.
      list: () => transport.json<import('@kiki/protocol').ListSkinsResponse>('/skins', {
        allowMissingRoute: true,
      }),
      get: (skinId: string) => transport.json<import('@kiki/protocol').GetSkinResponse>(
        `/skins/${encodeURIComponent(skinId)}`,
      ),
    },

    workspaces: {
      list: () => transport.json('/workspaces'),
      inspect: (root: string) => transport.json('/workspaces:inspect', {
        method: 'POST', body: { root },
      }),
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
      getTrust: (workspaceId: string) => transport.json<import('@kiki/protocol').WorkspaceTrustResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/trust`,
      ),
      trust: (workspaceId: string) => transport.json<import('@kiki/protocol').WorkspaceTrustResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/trust`,
        { method: 'POST' },
      ),
      untrust: (workspaceId: string) => transport.json<import('@kiki/protocol').WorkspaceTrustResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/untrust`,
        { method: 'POST' },
      ),
    },

    homes: {
      presets: () => transport.json<import('@kiki/protocol').SpacePresetsResponse>('/homes/presets'),
      list: () => transport.json<import('@kiki/protocol').ListSpacesResponse>('/homes'),
      detail: (id) => transport.json<import('@kiki/protocol').SpaceDetail>(`/homes/${encodeURIComponent(id)}/settings`),
      preview: (id, body) => transport.json<import('@kiki/protocol').SpacePreview>(`/homes/${encodeURIComponent(id)}/settings/preview`, { method: 'POST', body }),
      apply: (id, body) => transport.json<import('@kiki/protocol').SpaceMutationResponse>(`/homes/${encodeURIComponent(id)}/settings/apply`, { method: 'POST', body }),
      undo: (id, undo_id) => transport.json<import('@kiki/protocol').SpaceMutationResponse>(`/homes/${encodeURIComponent(id)}/settings/undo`, { method: 'POST', body: { undo_id } }),
      importPreferences: (id, body) => transport.json<import('@kiki/protocol').SpacePreferenceImportResponse>(`/homes/${encodeURIComponent(id)}/settings/import-preferences`, { method: 'POST', body }),
      create: (body) => transport.json<import('@kiki/protocol').SpaceRecord>('/homes', { method: 'POST', body }),
      inspect: (body) => transport.json<import('@kiki/protocol').InspectSpacePathResponse>('/homes:inspect', { method: 'POST', body }),
      attach: (body) => transport.json<import('@kiki/protocol').SpaceRecord>('/homes:attach', { method: 'POST', body }),
      sshCopyCandidates: (id) => transport.json<import('@kiki/protocol').SshCopyCandidatesResponse>(`/homes/${encodeURIComponent(id)}/ssh-copy-candidates`),
      update: (id, body) => transport.json<import('@kiki/protocol').UpdateSpaceResponse>(`/homes/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
      remove: (id) => transport.json<import('@kiki/protocol').ListSpacesResponse>(`/homes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      erase: (id, body) => transport.json<import('@kiki/protocol').ListSpacesResponse>(`/homes/${encodeURIComponent(id)}:delete`, { method: 'POST', body }),
    },

    config: {
      get: () => transport.json<ConfigResponse>('/config'),
      patch: (body: HttpRestConfigPatch) => transport.json<ConfigResponse>('/config', {
        method: 'POST',
        body,
      }),
      removeOverride: (body) => transport.json<ConfigResponse>('/config/overrides:remove', { method: 'POST', body }),
      previewModelGenerationMigration: () => transport.json('/config/model-generation-migration'),
      applyModelGenerationMigration: (revision) => transport.json('/config/model-generation-migration/apply', {
        method: 'POST', body: { revision, confirmed: true },
      }),
      restoreModelGenerationMigration: (backupKey, revision) => transport.json('/config/model-generation-migration/restore', {
        method: 'POST', body: { backup_key: backupKey, revision, confirmed: true },
      }),
    },

    catalog: {
      list: (options) => transport.json('/catalog/providers', { signal: options?.signal, timeoutMs: options?.timeoutMs }),
      provider: (providerId: string) => transport.json<GetCatalogProviderResponse>(
        `/catalog/providers/${encodeURIComponent(providerId)}`,
      ),
      importProvider: (input, options) => transport.json('/providers:import_catalog', {
        method: 'POST', body: input, signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
      importRegistry: (input, options) => transport.json('/providers:import_registry', {
        method: 'POST', body: input, signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
    },

    oauth: {
      usage: (provider, options) => transport.json('/oauth/usage', {
        query: { provider }, signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
    },

    providers: {
      probe: (draft, options) => transport.json('/providers:probe', {
        method: 'POST',
        body: draft,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
      test: (providerId, options) => transport.json(`/providers/${encodeURIComponent(providerId)}:test`, {
        method: 'POST', body: {}, signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
      health: () => transport.json('/providers:health'),
    },

    nbSearch: {
      capabilities: () => transport.json('/nb-search/capabilities'),
      keyUsage: (instanceId, refresh = false, options) => transport.json('/nb-search/keys/usage', {
        method: 'POST', body: { instance_id: instanceId, refresh },
        signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
      test: (options) => transport.json('/nb-search/test', {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
      readCredential: (instanceId, reveal) => transport.json('/nb-search/credentials/read', {
        method: 'POST', body: { instance_id: instanceId, reveal },
      }),
      writeCredential: (instanceId, value, expectedVersion, expectedBinding) => transport.json('/nb-search/credentials/write', {
        method: 'POST', body: { instance_id: instanceId, value, expected_version: expectedVersion, expected_binding: expectedBinding },
      }),
    },

    requestIdentity: {
      get: () => transport.json('/request-identity'),
      preview: (body) => transport.json('/request-identity/preview', { method: 'POST', body }),
      duplicateProfile: (from, label) => transport.json('/request-identity/profiles', { method: 'POST', body: { from, label } }),
      updateProfile: (id, draft) => transport.json(`/request-identity/profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: draft }),
      deleteProfile: (id) => transport.json(`/request-identity/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      checkTrack: (track, source) => transport.json(`/request-identity/tracks/${track}/check`, { method: 'POST', body: { source } }),
      applyTrack: (track, version) => transport.json(`/request-identity/tracks/${track}/apply`, { method: 'POST', body: { version } }),
      trackAction: (track, action) => transport.json(`/request-identity/tracks/${track}/${action}`, { method: 'POST', body: {} }),
      pinTrack: (track, pinned) => transport.json(`/request-identity/tracks/${track}/pin`, { method: 'PUT', body: { pinned } }),
      setManifestUrl: (url) => transport.json('/request-identity/manifest', { method: 'PUT', body: { url } }),
    },

    notifications: {
      getSettings: () => transport.json('/notifications/settings'),
      updateSettings: (settings) => transport.json('/notifications/settings', { method: 'PUT', body: settings }),
      listProviders: () => transport.json('/notifications/providers'),
      upsertInstance: (id, instance, slots) => transport.json(`/notifications/instances/${encodeURIComponent(id)}`, { method: 'PUT', body: { instance, slots } }),
      deleteInstance: (id) => transport.json(`/notifications/instances/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      upsertChannel: (id, channel) => transport.json(`/notifications/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: channel }),
      deleteChannel: (id) => transport.json(`/notifications/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      setCredential: (slotId, value) => transport.json(`/notifications/credentials/${encodeURIComponent(slotId)}`, { method: 'PUT', body: { value } }),
      checkCredential: (instanceId) => transport.json(`/notifications/instances/${encodeURIComponent(instanceId)}:check`, { method: 'POST', body: {} }),
      sendTest: (channelId) => transport.json(`/notifications/channels/${encodeURIComponent(channelId)}:test`, { method: 'POST', body: {} }),
      listDeliveries: (channelId) => transport.json('/notifications/deliveries', { query: channelId === undefined ? undefined : { channel_id: channelId } }),
    },

    secrets: {
      reveal: (ref) => transport.json('/secrets:reveal', { method: 'POST', body: { ref } }),
    },

    executors: {
      list: () => transport.json('/executors'),
      listLocalSessions: (executorId, query, options) => transport.json(
        `/executors/${encodeURIComponent(executorId)}/local-sessions`, { ...options, query },
      ),
      getLocalSession: (executorId, localSessionId, options) => transport.json(
        `/executors/${encodeURIComponent(executorId)}/local-sessions/${encodeURIComponent(localSessionId)}`, options,
      ),
      resumeLocalSession: (executorId, localSessionId, body, options) => transport.json(
        `/executors/${encodeURIComponent(executorId)}/local-sessions/${encodeURIComponent(localSessionId)}/resume`,
        { ...options, method: 'POST', body },
      ),
    },

    agents: {
      list: (query?: string | ListNamedAgentProfilesQuery) => transport.json<ListNamedAgentProfilesResponse>('/agents', {
        query: typeof query === 'string' ? { workspace_id: query } : query,
      }),
      previewFile: (body, options) => transport.json(
        '/agent-profiles/file-preview', { ...options, method: 'POST', body },
      ),
      previewExecutorPrompt: (name, body = {}) => transport.json(
        `/agents/${encodeURIComponent(name)}/executor-prompt:preview`, { method: 'POST', body },
      ),
      previewModelMenu: (name, body, options) => transport.json(
        `/agents/${encodeURIComponent(name)}/model-menu:preview`, { ...options, method: 'POST', body },
      ),
      create: (body: CreateNamedAgentProfileRequest) => transport.json<NamedAgentProfile>(
        '/agent-profiles', { method: 'POST', body },
      ),
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
      previewHostFile: (path: string, maxBytes: number) => transport.raw(
        '/fs:content',
        { method: 'GET', query: { path }, headers: { range: `bytes=0-${maxBytes - 1}` } },
        async (response) => ({
          text: await response.text(),
          truncated: response.status === 206 &&
            Number(response.headers.get('content-range')?.split('/')[1]) > maxBytes,
        }),
      ),
      readHostFileBytes: (path: string, options) => readBinary(transport, '/fs:content', {
        query: { path }, signal: options?.signal, timeoutMs: options?.timeoutMs, headers: mediaHeaders(options),
      }),
      readHostMediaPreview: (path, options) => readBinary(transport, '/fs:content', {
        query: { path, preview: 'media' }, signal: options?.signal, timeoutMs: options?.timeoutMs, headers: mediaHeaders(options),
      }, 64 * 1024),
      downloadHostFile: (path, sink, options) => transport.raw('/fs:content', {
        method: 'GET', expectBinary: true, query: { path }, signal: options?.signal, timeoutMs: options?.timeoutMs ?? 0, headers: mediaHeaders(options),
      }, (response) => consumeMedia(response, sink, options?.signal)),
      workspaceFsSearch: (workspace: string, body, options) => transport.json<FsSearchResponse>('/workspace/fs:search', {
        method: 'POST',
        body: { ...body, workspace },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
    },

    threads: {
      messages: (query, options) => transport.json('/threads/messages', {
        query, signal: options?.signal, timeoutMs: options?.timeoutMs,
      }),
    },

    search: {
      messages: (body, options) => transport.json('/search', {
        method: 'POST',
        body,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
      retry: () => transport.json('/search/retry', { method: 'POST' }),
      status: () => transport.json('/search/status', { method: 'GET' }),
    },

    cron: {
      list: (query: HttpRestCronTaskQuery = {}) => transport.json<{
        readonly items: readonly HttpRestCronTask[];
        readonly has_more?: boolean;
        readonly next_offset?: number;
      }>(
        '/cron',
        { query: { session_id: query.session_id, page_size: query.page_size, offset: query.offset } },
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
      navigation: () => transport.json('/plugins/navigation'),
      marketplace: () => transport.json('/plugins/marketplace'),
      preview: (input) => transport.json('/plugins:preview', {
        method: 'POST',
        body: input,
        timeoutMs: 0,
      }),
      install: (input) => transport.json('/plugins', {
        method: 'POST',
        body: typeof input === 'string' ? { source: input } : input,
        timeoutMs: 0,
      }),
      info: (id: string) => transport.json('/plugins/' + encodeURIComponent(id)),
      settings: (id: string) => transport.json(`/plugins/${encodeURIComponent(id)}/settings`),
      setSettings: (id: string, input) => transport.json(`/plugins/${encodeURIComponent(id)}/settings`, { method: 'POST', body: input }),
      setEnabled: (id: string, enabled: boolean) => transport.json(
        `/plugins/${encodeURIComponent(id)}:${enabled ? 'enable' : 'disable'}`,
        { method: 'POST', body: {} },
      ),
      remove: (id: string, options) => transport.json(
        `/plugins/${encodeURIComponent(id)}:remove`,
        { method: 'POST', body: options ?? {} },
      ),
      rollback: (id: string) => transport.json(
        `/plugins/${encodeURIComponent(id)}:rollback`,
        { method: 'POST', body: {} },
      ),
      installPrerequisite: (id: string, input) => transport.json(
        `/plugins/${encodeURIComponent(id)}:install-prerequisite`,
        { method: 'POST', body: input, timeoutMs: 0 },
      ),
      panels: () => transport.json('/plugins/panels'),
      panelDocument: (id: string, panelId: string) => transport.json(
        `/plugins/${encodeURIComponent(id)}/panels/${encodeURIComponent(panelId)}/document`,
      ),
      panelBridge: (id: string, panelId: string, input) => transport.json(
        `/plugins/${encodeURIComponent(id)}/panels/${encodeURIComponent(panelId)}/bridge`,
        { method: 'POST', body: input },
      ),
      commands: () => transport.json('/plugins/commands'),
      recommend: (input) => transport.json('/plugins/recommendations/match', { method: 'POST', body: input }),
      dismissRecommendation: (id: string) => transport.json(
        `/plugins/${encodeURIComponent(id)}:dismiss-recommendation`, { method: 'POST', body: {} },
      ),
    },

    auth: {
      summary: () => transport.json<AuthSummary>('/auth'),
    },
  };
}

function mediaHeaders(options?: import('../../core/facade/http-rest.js').HttpRestMediaOptions): Record<string, string> {
  return { ...(options?.ifNoneMatch === undefined ? {} : { 'if-none-match': options.ifNoneMatch }), ...(options?.range === undefined ? {} : { range: options.range }) };
}

function mediaMetadata(response: Response): Omit<import('../../core/facade/http-rest.js').HttpRestMediaReceipt, 'bytes'> {
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/iu.exec(response.headers.get('content-disposition') ?? '');
  let name = match?.[1];
  if (name !== undefined) { try { name = decodeURIComponent(name); } catch {} }
  const contentRange = response.headers.get('content-range') ?? undefined;
  const length = contentRange?.match(/\/(\d+)$/u)?.[1] ?? response.headers.get('content-length');
  const total = length === null || length === undefined ? undefined : Number(length);
  return { mime, name, etag: response.headers.get('etag') ?? undefined, contentRange, totalBytes: total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined, notModified: response.status === 304 };
}

async function consumeMedia(response: Response, sink: import('../../core/facade/http-rest.js').HttpRestMediaSink, signal?: AbortSignal, maxBytes = Infinity): Promise<import('../../core/facade/http-rest.js').HttpRestMediaReceipt> {
  const metadata = mediaMetadata(response);
  let bytes = 0;
  signal?.throwIfAborted();
  if (response.body === null) return { ...metadata, bytes };
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let complete = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      for (let offset = 0; offset < chunk.value.byteLength; offset += 64 * 1024) {
        signal?.throwIfAborted();
        const value = chunk.value.subarray(offset, Math.min(chunk.value.byteLength, offset + 64 * 1024));
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('Media preview exceeds its byte budget');
        await sink(value, { ...metadata, bytes });
      }
    }
    return { ...metadata, bytes };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readBinary(
  transport: HttpRestTransport,
  path: string,
  options?: Pick<HttpRestJsonOptions, 'query' | 'signal' | 'timeoutMs' | 'expectBinary' | 'headers'>,
  maxBytes?: number,
) {
  return transport.raw(path, { ...options, method: 'GET', expectBinary: true }, async (response) => {
    if (maxBytes === undefined) return { ...mediaMetadata(response), bytes: new Uint8Array(await response.arrayBuffer()) };
    const chunks: Uint8Array[] = [];
    const receipt = await consumeMedia(response, (chunk) => { chunks.push(chunk); }, options?.signal, maxBytes);
    const bytes = new Uint8Array(receipt.bytes);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { ...receipt, bytes };
  });
}
