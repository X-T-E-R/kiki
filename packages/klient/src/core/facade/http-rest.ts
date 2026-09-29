import type { PluginInfo, PluginSummary } from '@kiki/agent-core-v2/app/plugin/types';

import type {
  ActivateSkillRequest,
  ActivateSkillResult,
  ApprovalRequest,
  ArchiveSessionResponse,
  AuthSummary,
  ConfigResponse,
  FsSearchResponse,
  GetTaskQuery,
  GoalSnapshot,
  GetCatalogProviderResponse,
  ListMcpServersResponse,
  CreateNamedAgentProfileRequest,
  ListNamedAgentProfilesQuery,
  ListNamedAgentProfilesResponse,
  ListShippedAgentProfilesResponse,
  ListSkillsResponse,
  ListTasksResponse,
  ListToolsResponse,
  ListSessionsQuery,
  Message,
  MetaResponse,
  NamedAgentProfile,
  PageResponse,
  PatchConfigRequest,
  ProbeProviderRequest,
  ProbeProviderResponse,
  PromptListResponse,
  RestoreSessionResponse,
  Session,
  SessionCreate,
  ShippedAgentProfile,
  Task,
  UpdateNamedAgentProfileRequest,
  UpdateSessionProfileRequest,
} from '@kiki/protocol';
import type { UsageResponse } from '@kiki/protocol';

/** HTTP deadlines and cancellation remain active until the response body is consumed. */
export interface HttpRestRequestOptions {
  readonly signal?: AbortSignal;
  /** Zero disables the deadline; omission uses the channel default. */
  readonly timeoutMs?: number;
}

export interface HttpRestListSessionsQuery extends ListSessionsQuery {
  readonly workspace_id?: string;
}

export interface HttpRestSearchMessagesBody {
  readonly query: string;
  readonly mode?: 'terms' | 'literal';
  readonly op?: 'AND' | 'OR';
  readonly container?: { readonly session_id?: string; readonly agent_id?: string };
  readonly workspace_id?: string;
  readonly role?: 'user' | 'assistant' | 'title';
  readonly start_time?: number;
  readonly end_time?: number;
  readonly sort?: 'score' | 'time_desc' | 'time_asc';
  readonly page_size?: number;
  readonly page_token?: string;
}

export interface HttpRestSearchMessageHit {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly session_title: string;
  readonly agent_id: string;
  readonly role: 'user' | 'assistant' | 'title';
  readonly snippet: string;
  readonly time: number;
  readonly turn?: number;
  readonly step_id?: string;
  readonly score: number;
}

export interface HttpRestSearchMessagesResponse {
  readonly items: readonly HttpRestSearchMessageHit[];
  readonly has_more: boolean;
  readonly page_token?: string;
  readonly incomplete?: 'candidate_cap' | 'postings_budget' | 'deadline';
  readonly index_state: {
    readonly state: 'building' | 'ready' | 'readonly' | 'unavailable';
    readonly indexed_sessions: number;
    readonly total_sessions: number;
    readonly documents: number;
    readonly stale?: boolean;
    readonly degraded?: string;
    readonly reason?:
      | 'disabled'
      | 'indexer_backoff'
      | 'memory_budget'
      | 'wal_stuck'
      | 'disk_low'
      | 'corrupt_rebuilding'
      | 'sqlite_unavailable'
      | 'runtime_disabled';
  };
  readonly source: 'live' | 'index';
}

export interface HttpRestPluginMarketplaceEntry {
  readonly id: string;
  readonly tier: 'official' | 'curated' | 'third-party';
  readonly displayName: string;
  readonly description?: string;
  readonly homepage?: string;
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

export interface HttpRestPluginMarketplaceResponse {
  readonly configured: boolean;
  readonly source?: string;
  readonly entries: readonly HttpRestPluginMarketplaceEntry[];
}

export interface HttpRestBinaryFile {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly name?: string;
  readonly etag?: string;
  readonly notModified?: boolean;
}

export interface HttpRestSessionArchive {
  readonly blob: Blob;
  readonly filename: string;
}

/**
 * Aggregated cron task wire shape from `GET /api/cron` (kap-server
 * `src/protocol/rest-cron.ts`; snake_case, not re-exported by `@kiki/protocol`).
 * Paused tasks carry `next_fire_at: null` and sort after live ones.
 */
export interface HttpRestCronTask {
  readonly id: string;
  readonly session_id: string | null;
  readonly workspace_id: string;
  readonly cron: string;
  readonly human_schedule: string;
  readonly prompt_preview: string;
  readonly next_fire_at: string | null;
  readonly recurring: boolean;
  readonly paused: boolean;
  readonly age_days: number;
  readonly stale: boolean;
  readonly created_at: string;
  readonly last_fired_at: string | null;
}

/** `session_id` disambiguates a task id that exists in several sessions. */
export interface HttpRestCronTaskQuery {
  readonly session_id?: string;
  readonly page_size?: number;
  readonly offset?: number;
}

export type HttpRestConfigPatch = PatchConfigRequest & {
  readonly [key: string]: unknown;
};

/**
 * Typed KAP REST gaps that are intentionally HTTP-only. The transport owns
 * authentication, envelopes, cancellation, and deadlines; this surface has no
 * arbitrary URL or untyped request escape hatch.
 */
export interface HttpRestFacade {
  healthz(baseUrlOverride?: string): Promise<boolean>;
  meta(): Promise<MetaResponse & { readonly experimental_flags?: Record<string, boolean> }>;
  renewLease(body: { readonly lease_id?: string }): Promise<{
    readonly lease_id: string;
    readonly expires_at: number;
  } | undefined>;
  usage(query: Record<string, string | number | boolean | undefined>): Promise<UsageResponse>;

  readonly ssh: {
    list(workspaceId?: string): Promise<{ readonly hosts: readonly import('@kiki/protocol').SshHost[] }>;
    discover(): Promise<{ readonly hosts: readonly import('@kiki/protocol').SshHost[] }>;
    upsert(id: string, host: import('@kiki/protocol').SshHostInput, workspaceId?: string): Promise<{ readonly host: import('@kiki/protocol').SshHost }>;
    remove(id: string, workspaceId?: string): Promise<{ readonly removed: true }>;
    setConfigSync(enabled: boolean): Promise<{ readonly enabled: boolean }>;
    connectionApproval(): Promise<{ readonly enabled: boolean }>;
    setConnectionApproval(enabled: boolean): Promise<{ readonly enabled: boolean }>;
    writeBack(id: string, workspaceId?: string): Promise<{ readonly written: true }>;
    status(id: string, workspaceId?: string): Promise<import('@kiki/protocol').SshHostStatus>;
    disconnect(id: string, workspaceId?: string): Promise<{ readonly disconnected: true }>;
    sessionHosts(sessionId: string): Promise<import('@kiki/protocol').SshSessionHostsResponse>;
    addSessionHost(sessionId: string, hostId: string): Promise<{ readonly host: import('@kiki/protocol').SshHost }>;
    removeSessionHost(sessionId: string, hostId: string): Promise<{ readonly removed: true }>;
    submitApproval(sessionId: string, approvalId: string, body: import('@kiki/protocol').SshApprovalSubmit): Promise<{ readonly resolved: true }>;
  };

  readonly worktrees: {
    list(query?: { readonly workspace_id?: string; readonly state?: import('@kiki/protocol').WorktreeRecord['state'] }): Promise<{ readonly worktrees: readonly import('@kiki/protocol').WorktreeRecord[] }>;
    get(id: string): Promise<import('@kiki/protocol').WorktreeRecord>;
    inspect(id: string): Promise<import('@kiki/protocol').WorktreeInspection>;
    remove(id: string, body?: import('@kiki/protocol').WorktreeRemoveRequest): Promise<{ readonly outcome: import('@kiki/protocol').WorktreeRemovalOutcome }>;
    gc(dryRun: boolean): Promise<{ readonly candidates: readonly { readonly id: string; readonly outcome: import('@kiki/protocol').WorktreeRemovalOutcome }[] }>;
  };

  readonly sessions: {
    list(query?: HttpRestListSessionsQuery): Promise<PageResponse<Session>>;
    create(body: SessionCreate): Promise<Session>;
    compact(sessionId: string, body?: { readonly instruction?: string }): Promise<import('@kiki/protocol').CompactSessionResponse>;
    getAutoCompact(sessionId: string, agentId: string): Promise<import('@kiki/protocol').AutoCompactStatus>;
    setAutoCompact(sessionId: string, agentId: string, input: import('@kiki/protocol').AutoCompactWrite): Promise<import('@kiki/protocol').AutoCompactWriteResult>;
    undo(sessionId: string, body?: { readonly count?: number; readonly page_size?: number }): Promise<import('@kiki/protocol').UndoSessionResponse>;
    updateProfile(sessionId: string, body: UpdateSessionProfileRequest): Promise<Session>;
    archive(sessionId: string): Promise<ArchiveSessionResponse>;
    restore(sessionId: string): Promise<RestoreSessionResponse>;
    goal(sessionId: string): Promise<GoalSnapshot | null>;
    listMessages(
      sessionId: string,
      query?: { readonly before_id?: string; readonly page_size?: number },
    ): Promise<PageResponse<Message>>;
    listPrompts(sessionId: string): Promise<PromptListResponse>;
    listApprovals(sessionId: string): Promise<ApprovalRequest[]>;
    listQuestions(sessionId: string): Promise<import('@kiki/protocol').QuestionRequest[]>;
    listTasks(sessionId: string, query?: { readonly status?: import('@kiki/protocol').TaskStatus; readonly page_size?: number; readonly offset?: number }): Promise<ListTasksResponse>;
    getTask(sessionId: string, taskId: string, query?: GetTaskQuery): Promise<Task>;
    listSkills(sessionId: string): Promise<ListSkillsResponse>;
    activateSkill(
      sessionId: string,
      skillName: string,
      body?: ActivateSkillRequest,
    ): Promise<ActivateSkillResult>;
    fsSearch(
      sessionId: string,
      body: { readonly query: string; readonly limit?: number },
      options?: HttpRestRequestOptions,
    ): Promise<FsSearchResponse>;
    media(sessionId: string, fileId: string, options?: { readonly ifNoneMatch?: string }): Promise<HttpRestBinaryFile>;
    export(sessionId: string): Promise<HttpRestSessionArchive>;
  };

  readonly skills: {
    readBuiltinContent(name: string): Promise<import('@kiki/protocol').BuiltinSkillContentResponse>;
  };

  /** GUI skin files in the server's Kiki themes directory. Read-only by design. */
  readonly skins: {
    list(): Promise<import('@kiki/protocol').ListSkinsResponse>;
    get(skinId: string): Promise<import('@kiki/protocol').GetSkinResponse>;
  };

  readonly workspaces: {
    list(): Promise<import('@kiki/protocol').ListWorkspacesResponse>;
    rename(workspaceId: string, name: string): Promise<import('@kiki/protocol').Workspace>;
    setPinned(workspaceId: string, pinned: boolean): Promise<import('@kiki/protocol').Workspace>;
    remove(workspaceId: string): Promise<{ readonly deleted: true }>;
    listSkills(workspaceId: string): Promise<ListSkillsResponse>;
  };

  readonly config: {
    get(): Promise<ConfigResponse>;
    patch(body: HttpRestConfigPatch): Promise<ConfigResponse>;
    previewModelGenerationMigration(): Promise<import('@kiki/protocol').ModelGenerationMigrationPreviewResponse>;
    applyModelGenerationMigration(revision: string): Promise<import('@kiki/protocol').ModelGenerationMigrationApplyResponse>;
    restoreModelGenerationMigration(backupKey: string, revision: string): Promise<import('@kiki/protocol').ModelGenerationMigrationRestoreResponse>;
  };

  readonly catalog: {
    provider(providerId: string): Promise<GetCatalogProviderResponse>;
  };

  readonly providers: {
    /** Test unsaved connection fields without writing configuration or discovery state. */
    probe(draft: ProbeProviderRequest, options?: HttpRestRequestOptions): Promise<ProbeProviderResponse>;
    /** One real inference request against a saved provider; the result is persisted without secrets. */
    test(providerId: string, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').ProviderConnectionTestResult>;
    health(): Promise<import('@kiki/protocol').ListProviderHealthResponse>;
  };

  readonly nbSearch: {
    capabilities(): Promise<import('@kiki/protocol').NbSearchCapabilities>;
    test(options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').NbSearchTestStatus>;
    readCredential(instanceId: string, reveal: boolean): Promise<import('@kiki/protocol').NbSearchManagedCredentialView>;
    writeCredential(instanceId: string, value: string | null, expectedVersion: string, expectedBinding: string): Promise<import('@kiki/protocol').NbSearchManagedCredentialView>;
  };

  readonly secrets: {
    /** Explicit, authenticated reveal of one secret value; bulk reads stay redacted. */
    reveal(ref: import('@kiki/protocol').SecretRef): Promise<import('@kiki/protocol').RevealedSecret>;
  };

  readonly executors: {
    list(): Promise<import('@kiki/protocol').ListExecutorsResponse>;
  };

  readonly agents: {
    list(query?: string | ListNamedAgentProfilesQuery): Promise<ListNamedAgentProfilesResponse>;
    previewExecutorPrompt(name: string, body?: import('@kiki/protocol').ExecutorPromptPreviewRequest): Promise<import('@kiki/protocol').ExecutorPromptPreviewResponse>;
    create(body: CreateNamedAgentProfileRequest): Promise<NamedAgentProfile>;
    update(name: string, body: UpdateNamedAgentProfileRequest): Promise<NamedAgentProfile>;
    /** Shipped (built-in) profile templates: management status and restore-original. */
    readonly shipped: {
      list(): Promise<ListShippedAgentProfilesResponse>;
      restore(id: string): Promise<ShippedAgentProfile>;
    };
  };

  readonly filesystem: {
    readHostFile(path: string): Promise<string>;
    previewHostFile(path: string, maxBytes: number): Promise<{ readonly text: string; readonly truncated: boolean }>;
    readHostFileBytes(path: string, options?: { readonly ifNoneMatch?: string }): Promise<HttpRestBinaryFile>;
    workspaceFsSearch(
      workspace: string,
      body: { readonly query: string; readonly limit?: number },
      options?: HttpRestRequestOptions,
    ): Promise<FsSearchResponse>;
  };

  readonly search: {
    messages(
      body: HttpRestSearchMessagesBody,
      options?: HttpRestRequestOptions,
    ): Promise<HttpRestSearchMessagesResponse>;
    retry(): Promise<{ retried: boolean }>;
  };

  /** Cross-workspace cron aggregate: `GET /api/cron` plus per-task actions. */
  readonly cron: {
    list(query?: HttpRestCronTaskQuery): Promise<{
      readonly items: readonly HttpRestCronTask[];
      readonly has_more?: boolean;
      readonly next_offset?: number;
    }>;
    pause(
      taskId: string,
      query?: HttpRestCronTaskQuery,
    ): Promise<{ readonly task: HttpRestCronTask }>;
    resume(
      taskId: string,
      query?: HttpRestCronTaskQuery,
    ): Promise<{ readonly task: HttpRestCronTask }>;
    /** Fire the task once right now; the schedule itself is untouched. */
    run(
      taskId: string,
      query?: HttpRestCronTaskQuery,
    ): Promise<{ readonly triggered: true }>;
    remove(
      taskId: string,
      query?: HttpRestCronTaskQuery,
    ): Promise<{ readonly deleted: true }>;
  };

  readonly runtime: {
    listTools(sessionId?: string): Promise<ListToolsResponse>;
    listMcpServers(): Promise<ListMcpServersResponse>;
    restartMcpServer(serverId: string): Promise<import('@kiki/protocol').RestartMcpServerResult>;
  };

  readonly plugins: {
    marketplace(): Promise<HttpRestPluginMarketplaceResponse>;
    preview(input: import('@kiki/protocol').PluginPreviewRequest): Promise<import('@kiki/protocol').PluginInstallPlan>;
    install(input: string | import('@kiki/protocol').PluginInstallRequest): Promise<PluginSummary>;
    info(id: string): Promise<PluginInfo>;
    settings(id: string): Promise<import('@kiki/protocol').PluginSettingsResponse>;
    setSettings(id: string, input: import('@kiki/protocol').PluginSettingsPatch): Promise<import('@kiki/protocol').PluginSettingsResponse>;
    setEnabled(id: string, enabled: boolean): Promise<{ readonly ok: true }>;
    remove(id: string, options?: { readonly deleteData?: boolean }): Promise<{ readonly ok: true }>;
    rollback(id: string): Promise<{ readonly ok: true }>;
    installPrerequisite(id: string, input: import('@kiki/protocol').PluginPrerequisiteInstall): Promise<{ readonly ok: true }>;
    panels(): Promise<{ readonly panels: readonly import('@kiki/protocol').PluginPanelSummary[] }>;
    panelDocument(id: string, panelId: string): Promise<import('@kiki/protocol').PluginPanelDocument>;
    panelBridge(id: string, panelId: string, input: import('@kiki/protocol').PluginPanelBridgeRequest): Promise<import('@kiki/protocol').PluginPanelBridgeResponse>;
    commands(): Promise<{ readonly commands: readonly { readonly pluginId: string; readonly name: string; readonly description: string; readonly prompt: string }[] }>;
    recommend(input: { readonly cwd?: string; readonly files?: readonly string[]; readonly commands?: readonly string[]; readonly dependencies?: readonly string[] }): Promise<{ readonly entries: readonly HttpRestPluginMarketplaceEntry[] }>;
    dismissRecommendation(id: string): Promise<{ readonly ok: true }>;
  };

  readonly auth: {
    summary(): Promise<AuthSummary>;
  };
}
