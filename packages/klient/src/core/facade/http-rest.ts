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
  ListMcpServersResponse,
  ListNamedAgentProfilesQuery,
  ListNamedAgentProfilesResponse,
  ListSkillsResponse,
  ListTasksResponse,
  ListToolsResponse,
  ListSessionsQuery,
  Message,
  MetaResponse,
  NamedAgentProfile,
  PageResponse,
  PatchConfigRequest,
  PromptListResponse,
  RestoreSessionResponse,
  Session,
  SessionCreate,
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
    readonly state: 'building' | 'ready' | 'readonly';
    readonly indexed_sessions: number;
    readonly total_sessions: number;
    readonly documents: number;
    readonly stale?: boolean;
    readonly degraded?: string;
  };
  readonly source: 'live' | 'index';
}

export interface HttpRestPluginMarketplaceEntry {
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

export interface HttpRestPluginMarketplaceResponse {
  readonly configured: boolean;
  readonly source?: string;
  readonly entries: readonly HttpRestPluginMarketplaceEntry[];
}

export interface HttpRestBinaryFile {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly name?: string;
}

export interface HttpRestSessionArchive {
  readonly blob: Blob;
  readonly filename: string;
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

  readonly sessions: {
    list(query?: HttpRestListSessionsQuery): Promise<PageResponse<Session>>;
    create(body: SessionCreate): Promise<Session>;
    compact(sessionId: string, body?: { readonly instruction?: string }): Promise<import('@kiki/protocol').CompactSessionResponse>;
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
    listTasks(sessionId: string): Promise<ListTasksResponse>;
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
    media(sessionId: string, fileId: string): Promise<HttpRestBinaryFile>;
    export(sessionId: string): Promise<HttpRestSessionArchive>;
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
  };

  readonly nbSearch: {
    capabilities(): Promise<import('@kiki/protocol').NbSearchCapabilities>;
    test(options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').NbSearchTestStatus>;
  };

  readonly agents: {
    list(query?: string | ListNamedAgentProfilesQuery): Promise<ListNamedAgentProfilesResponse>;
    update(name: string, body: UpdateNamedAgentProfileRequest): Promise<NamedAgentProfile>;
  };

  readonly filesystem: {
    readHostFile(path: string): Promise<string>;
    readHostFileBytes(path: string): Promise<HttpRestBinaryFile>;
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
  };

  readonly runtime: {
    listTools(sessionId?: string): Promise<ListToolsResponse>;
    listMcpServers(): Promise<ListMcpServersResponse>;
    restartMcpServer(serverId: string): Promise<import('@kiki/protocol').RestartMcpServerResult>;
  };

  readonly plugins: {
    marketplace(): Promise<HttpRestPluginMarketplaceResponse>;
    install(source: string): Promise<PluginSummary>;
    info(id: string): Promise<PluginInfo>;
    setEnabled(id: string, enabled: boolean): Promise<{ readonly ok: true }>;
    remove(id: string): Promise<{ readonly ok: true }>;
  };

  readonly auth: {
    summary(): Promise<AuthSummary>;
  };
}
