import type { GlobalBotsFacade, GlobalRoomsFacade } from './botRooms.js';
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
  PersonaAvatarData,
  PersonaCardFormat,
  PersonaDeleteResponse,
  PersonaImportPreview,
  PersonaImportResponse,
  PersonaPutInput,
  PersonaSnapshot,
  PersonaSummary,
} from '@kiki/protocol';
import type { UsageResponse, UsagePricingResponse, UsagePricingUpdate } from '@kiki/protocol';

export interface NotificationGlobalSettings {
  enabled: boolean;
  suppress_viewing_session: boolean;
  min_work_ms: number;
  work_stable_ms: number;
  question_delay_ms: number;
  quiet_hours?: { start: string; end: string; time_zone: string };
}

export type NotificationHealth = 'ok' | 'connection_failed' | 'unauthorized' | 'unknown';
export type NotificationErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate_limited' | 'transient' | 'too_long' | 'bad_format' | 'dependency_missing' | 'configuration' | 'protocol' | 'unknown';

export interface NotificationInstance {
  provider_id: string;
  enabled: boolean;
  revision: string;
  options: Record<string, unknown>;
  label?: string;
  health?: NotificationHealth;
}

export interface NotificationChannel {
  provider_instance_id: string;
  enabled: boolean;
  revision: string;
  target: Record<string, unknown>;
  directions: ['send'];
  scenes: { work_complete: boolean; question_pending: boolean };
  label?: string;
  health?: NotificationHealth;
}

export interface NotificationCredentialSlot {
  provider_id: string;
  provider_instance_id: string;
  purpose: string;
  env: string;
  configured: boolean;
}

export interface NotificationSettings {
  global: NotificationGlobalSettings;
  provider_instances: Record<string, NotificationInstance>;
  channels: Record<string, NotificationChannel>;
  credential_slots: Record<string, NotificationCredentialSlot>;
}

export interface NotificationProviderDescriptor {
  id: string;
  can_send: boolean;
  can_receive: boolean;
  status: 'available' | 'unverified' | 'dependency_missing';
  status_reason?: string;
  instance_fields: readonly { key: string; label: string; kind: 'text' | 'select' | 'secret' | 'number' | 'json'; required: boolean; options?: readonly string[]; purpose?: string }[];
  target_fields: readonly { key: string; label: string; kind: 'text' | 'number'; required: boolean }[];
}

export interface NotificationDelivery {
  delivery_id: string;
  channel_id: string;
  status: 'queued' | 'sending' | 'accepted_by_provider' | 'suppressed' | 'failed' | 'expired' | 'unknown' | 'cancelled';
  attempt: number;
  created_at: string;
  expires_at: string;
  result: { status: 'accepted' | 'suppressed' | 'failed' | 'unknown'; message_ids: string[]; retryable: boolean; error_kind?: NotificationErrorKind; diagnostic_code?: string } | null;
}

export interface NotificationCredentialCheck {
  result: 'ok' | 'failed' | 'requires_test_send';
  health: NotificationHealth;
  error_kind?: NotificationErrorKind;
}

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

export interface HttpRestMediaOptions extends HttpRestRequestOptions {
  readonly ifNoneMatch?: string;
  readonly range?: string;
  readonly mediaType?: string;
}

export interface HttpRestMediaReceipt {
  readonly bytes: number;
  readonly mime: string;
  readonly name?: string;
  readonly etag?: string;
  readonly contentRange?: string;
  readonly totalBytes?: number;
  readonly notModified: boolean;
}

export type HttpRestMediaSink = (chunk: Uint8Array, progress: HttpRestMediaReceipt) => void | Promise<void>;

export interface HttpRestSessionArchive {
  readonly blob: Blob;
  readonly filename: string;
}

export interface HttpRestPersonaCardInput {
  readonly data: Uint8Array;
  readonly format?: PersonaCardFormat;
  readonly filename?: string;
}

export interface HttpRestPersonaImportInput extends HttpRestPersonaCardInput {
  readonly id?: string;
  readonly name?: string;
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
  readonly webAccess: import('./web-access.js').WebAccessFacade;
  readonly connections: import('./connections.js').ConnectionsFacade;
  readonly threadBridges: import('./thread-bridges.js').ThreadBridgesFacade;
  readonly usageExport: import('./usage-export.js').UsageExportFacade;
  healthz(baseUrlOverride?: string): Promise<boolean>;
  meta(): Promise<MetaResponse & { readonly experimental_flags?: Record<string, boolean> }>;
  renewLease(body: { readonly lease_id?: string }): Promise<{
    readonly lease_id: string;
    readonly expires_at: number;
  } | undefined>;
  usage(query: Record<string, string | number | boolean | undefined>): Promise<UsageResponse>;
  requestGovernance(): Promise<import('@kiki/protocol').RequestGovernanceSnapshot>;
  agentActivity(): Promise<import('@kiki/protocol').AgentActivitySnapshot>;
  readonly usageRescan: {
    status(): Promise<import('@kiki/protocol').UsageRescanStatus>;
    start(): Promise<import('@kiki/protocol').UsageRescanStatus>;
  };
  readonly usagePricing: {
    get(models?: readonly string[]): Promise<UsagePricingResponse>;
    set(update: UsagePricingUpdate): Promise<UsagePricingResponse>;
  };

  readonly shortcuts: {
    read(platform: import('@kiki/protocol').ShortcutPlatform): Promise<import('@kiki/protocol').ShortcutResponse>;
    write(platform: import('@kiki/protocol').ShortcutPlatform, preferences: import('@kiki/protocol').ShortcutPreferences): Promise<import('@kiki/protocol').ShortcutResponse>;
    reset(platform: import('@kiki/protocol').ShortcutPlatform, target?: { platform?: import('@kiki/protocol').ShortcutPlatform; action?: import('@kiki/protocol').ShortcutAction }): Promise<import('@kiki/protocol').ShortcutResponse>;
  };

  readonly browser: {
    list(): Promise<import('@kiki/protocol').BrowserControlList>;
    upsert(id: string, input: import('@kiki/protocol').BrowserConnectionInput): Promise<{ readonly connection: import('@kiki/protocol').BrowserConnection }>;
    remove(id: string): Promise<{ readonly removed: true }>;
    setDefault(browser?: string): Promise<{ readonly browser?: string }>;
    status(id: string): Promise<import('@kiki/protocol').BrowserStatus>;
    tabs(id: string): Promise<import('@kiki/protocol').BrowserTabsResponse>;
    catalog(id: string, options?: { includeSchema?: boolean }): Promise<import('@kiki/protocol').BrowserCatalogResponse>;
    check(id: string): Promise<import('@kiki/protocol').BrowserStatus>;
    connect(id: string): Promise<import('@kiki/protocol').BrowserStatus>;
    disconnect(id: string): Promise<import('@kiki/protocol').BrowserStatus>;
  };

  readonly ssh: {
    list(workspaceId?: string): Promise<{ readonly hosts: readonly import('@kiki/protocol').SshHost[] }>;
    discover(): Promise<{ readonly hosts: readonly import('@kiki/protocol').SshHost[] }>;
    upsert(id: string, host: import('@kiki/protocol').SshHostInput, workspaceId?: string): Promise<{ readonly host: import('@kiki/protocol').SshHost }>;
    remove(id: string, workspaceId?: string): Promise<{ readonly removed: true }>;
    configSync(): Promise<import('@kiki/protocol').SshConfigSyncSettings>;
    setConfigSync(enabled: boolean): Promise<import('@kiki/protocol').SshConfigSyncSettings>;
    hostKeys(id: string, workspaceId?: string): Promise<import('@kiki/protocol').SshHostKeys>;
    connectionApproval(): Promise<{ readonly enabled: boolean }>;
    setConnectionApproval(enabled: boolean): Promise<{ readonly enabled: boolean }>;
    writeBack(id: string, workspaceId?: string): Promise<{ readonly written: true }>;
    status(id: string, workspaceId?: string): Promise<import('@kiki/protocol').SshHostStatus>;
    disconnect(id: string, workspaceId?: string): Promise<{ readonly disconnected: true }>;
    sessionHosts(sessionId: string): Promise<import('@kiki/protocol').SshSessionHostsResponse>;
    addSessionHost(sessionId: string, hostId: string): Promise<{ readonly host: import('@kiki/protocol').SshHost }>;
    removeSessionHost(sessionId: string, hostId: string): Promise<{ readonly removed: true }>;
    submitApproval(sessionId: string, approvalId: string, body: import('@kiki/protocol').SshApprovalSubmit): Promise<{ readonly resolved: true }>;
    copySharedCredentialsToIsolated(body: import('@kiki/protocol').CopySharedSshCredentialsRequest): Promise<import('@kiki/protocol').CopySharedSshCredentialsResponse>;
  };

  readonly worktrees: {
    list(query?: { readonly workspace_id?: string; readonly state?: import('@kiki/protocol').WorktreeRecord['state'] }): Promise<{ readonly worktrees: readonly import('@kiki/protocol').WorktreeRecord[] }>;
    get(id: string): Promise<import('@kiki/protocol').WorktreeRecord>;
    inspect(id: string): Promise<import('@kiki/protocol').WorktreeInspection>;
    remove(id: string, body?: import('@kiki/protocol').WorktreeRemoveRequest): Promise<{ readonly outcome: import('@kiki/protocol').WorktreeRemovalOutcome }>;
    gc(dryRun: boolean): Promise<{ readonly candidates: readonly { readonly id: string; readonly outcome: import('@kiki/protocol').WorktreeRemovalOutcome }[] }>;
  };

  readonly sessions: {
    list(query?: HttpRestListSessionsQuery): Promise<import('@kiki/protocol').ListSessionsResponse>;
    listEphemeral(query?: Pick<HttpRestListSessionsQuery, 'before_id' | 'page_size' | 'workspace_id' | 'persona'>): Promise<import('@kiki/protocol').ListEphemeralSessionsResponse>;
    create(body: SessionCreate): Promise<Session>;
    saveEphemeral(sessionId: string): Promise<Session>;
    endEphemeral(sessionId: string, body?: { readonly worktree?: 'keep' | 'remove' }): Promise<import('@kiki/protocol').EndEphemeralSessionResponse>;
    compact(sessionId: string, body?: { readonly instruction?: string }): Promise<import('@kiki/protocol').CompactSessionResponse>;
    getAutoCompact(sessionId: string, agentId: string): Promise<import('@kiki/protocol').AutoCompactStatus>;
    setAutoCompact(sessionId: string, agentId: string, input: import('@kiki/protocol').AutoCompactWrite): Promise<import('@kiki/protocol').AutoCompactWriteResult>;
    inspectHooks(sessionId: string, agentId: string): Promise<import('@kiki/protocol').AgentHooksInspect>;
    undo(sessionId: string, body?: { readonly count?: number; readonly page_size?: number }): Promise<import('@kiki/protocol').UndoSessionResponse>;
    updateProfile(sessionId: string, body: UpdateSessionProfileRequest): Promise<Session>;
    getPersonaSettings(sessionId: string): Promise<import('@kiki/protocol').SessionPersonaSettings>;
    applyPersonaSettings(sessionId: string, input?: import('@kiki/protocol').ApplyPersonaSettingsRequest): Promise<import('@kiki/protocol').SessionPersonaSettings>;
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
    /** Read-only, incremental whole-session metadata. Drain next_page_token before interpreting coverage as complete. */
    listAgentTasks(sessionId: string, query?: import('../../contract/session/agent-tasks.js').ListAgentTasksQuery, options?: HttpRestRequestOptions): Promise<import('../../contract/session/agent-tasks.js').ListAgentTasksResponse>;
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
    media(sessionId: string, fileId: string, options?: HttpRestMediaOptions): Promise<HttpRestBinaryFile>;
    mediaPreview(sessionId: string, fileId: string, options?: HttpRestMediaOptions): Promise<HttpRestBinaryFile>;
    downloadMedia(sessionId: string, fileId: string, sink: HttpRestMediaSink, options?: HttpRestMediaOptions): Promise<HttpRestMediaReceipt>;
    export(sessionId: string): Promise<HttpRestSessionArchive>;
  };

  readonly bots: GlobalBotsFacade;
  readonly rooms: GlobalRoomsFacade;
  readonly personas: {
    list(options?: { readonly includeArchived?: boolean }): Promise<readonly PersonaSummary[]>;
    get(id: string): Promise<PersonaSnapshot>;
    ensureHome(id: string): Promise<{ readonly homeSessionId: string }>;
    setHome(id: string, sessionId: string): Promise<import('@kiki/protocol').PersonaState>;
    updateState(id: string, input: import('@kiki/protocol').PersonaStateUpdate): Promise<import('@kiki/protocol').PersonaState>;
    put(input: PersonaPutInput): Promise<PersonaSnapshot>;
    duplicate(id: string, options?: { readonly id?: string; readonly name?: string }): Promise<PersonaSnapshot>;
    archive(id: string, archived?: boolean): Promise<{ readonly version: 1; readonly archived: boolean }>;
    delete(id: string, options?: { readonly expectedRevision?: string }): Promise<PersonaDeleteResponse>;
    previewImport(input: HttpRestPersonaCardInput): Promise<PersonaImportPreview>;
    importCard(input: HttpRestPersonaImportInput): Promise<PersonaImportResponse>;
    exportCard(id: string, format: PersonaCardFormat, options?: HttpRestRequestOptions & { readonly includeMemory?: boolean }): Promise<HttpRestBinaryFile>;
    getAvatar(id: string, options?: HttpRestRequestOptions): Promise<HttpRestBinaryFile>;
    putAvatar(id: string, data: Uint8Array, mimeType?: string, shape?: import('@kiki/protocol').PersonaAvatarShape): Promise<import('@kiki/protocol').PersonaAvatarUploadResponse>;
    deleteAvatar(id: string): Promise<import('@kiki/protocol').PersonaAvatarDeleteResponse>;
    avatar(input: { readonly id: string; readonly name: string; readonly avatarMime?: string; readonly avatarShape?: import('@kiki/protocol').PersonaAvatarShape }): PersonaAvatarData;
  };

  readonly skills: {
    /** Read global skills, or a disposable directory snapshot for an absolute cwd, without registering a workspace or creating a session. */
    list(cwd?: string): Promise<ListSkillsResponse>;
    readBuiltinContent(name: string): Promise<import('@kiki/protocol').BuiltinSkillContentResponse>;
    previewHostInstall(host: 'claude' | 'codex' | 'grok' | 'agents'): Promise<{ readonly host: string; readonly directory: string; readonly path: string; readonly overwrites: boolean; readonly revision: string }>;
    installHost(host: 'claude' | 'codex' | 'grok' | 'agents', revision: string): Promise<{ readonly host: string; readonly directory: string; readonly path: string; readonly overwrites: boolean; readonly revision: string }>;
  };

  /** GUI skin files in the server's Kiki themes directory. Read-only by design. */
  readonly skins: {
    list(): Promise<import('@kiki/protocol').ListSkinsResponse>;
    get(skinId: string): Promise<import('@kiki/protocol').GetSkinResponse>;
  };

  readonly workspaces: {
    list(): Promise<import('@kiki/protocol').ListWorkspacesResponse>;
    inspect(root: string): Promise<import('@kiki/protocol').InspectWorkspaceResponse>;
    rename(workspaceId: string, name: string): Promise<import('@kiki/protocol').Workspace>;
    setPinned(workspaceId: string, pinned: boolean): Promise<import('@kiki/protocol').Workspace>;
    remove(workspaceId: string): Promise<{ readonly deleted: true }>;
    listSkills(workspaceId: string): Promise<ListSkillsResponse>;
    getTrust(workspaceId: string): Promise<import('@kiki/protocol').WorkspaceTrustResponse>;
    trust(workspaceId: string): Promise<import('@kiki/protocol').WorkspaceTrustResponse>;
    untrust(workspaceId: string): Promise<import('@kiki/protocol').WorkspaceTrustResponse>;
  };

  readonly homes: {
    presets(): Promise<import('@kiki/protocol').SpacePresetsResponse>;
    list(): Promise<import('@kiki/protocol').ListSpacesResponse>;
    detail(id: string): Promise<import('@kiki/protocol').SpaceDetail>;
    preview(id: string, body: import('@kiki/protocol').SpacePlanRequest): Promise<import('@kiki/protocol').SpacePreview>;
    apply(id: string, body: import('@kiki/protocol').SpaceApplyRequest): Promise<import('@kiki/protocol').SpaceMutationResponse>;
    undo(id: string, undoId: string): Promise<import('@kiki/protocol').SpaceMutationResponse>;
    importPreferences(id: string, body: import('@kiki/protocol').SpacePreferenceImport): Promise<import('@kiki/protocol').SpacePreferenceImportResponse>;
    create(body: import('@kiki/protocol').CreateSpaceRequest): Promise<import('@kiki/protocol').SpaceRecord>;
    attach(body: import('@kiki/protocol').AttachSpaceRequest): Promise<import('@kiki/protocol').SpaceRecord>;
    sshCopyCandidates(id: string): Promise<import('@kiki/protocol').SshCopyCandidatesResponse>;
    update(id: string, body: import('@kiki/protocol').UpdateSpaceRequest): Promise<import('@kiki/protocol').UpdateSpaceResponse>;
    remove(id: string): Promise<import('@kiki/protocol').ListSpacesResponse>;
    erase(id: string, body: import('@kiki/protocol').DeleteSpaceRequest): Promise<import('@kiki/protocol').ListSpacesResponse>;
  };

  readonly config: {
    get(): Promise<ConfigResponse>;
    patch(body: HttpRestConfigPatch): Promise<ConfigResponse>;
    removeOverride(body: import('@kiki/protocol').RemoveSpaceConfigOverrideRequest): Promise<ConfigResponse>;
    previewModelGenerationMigration(): Promise<import('@kiki/protocol').ModelGenerationMigrationPreviewResponse>;
    applyModelGenerationMigration(revision: string): Promise<import('@kiki/protocol').ModelGenerationMigrationApplyResponse>;
    restoreModelGenerationMigration(backupKey: string, revision: string): Promise<import('@kiki/protocol').ModelGenerationMigrationRestoreResponse>;
  };

  readonly catalog: {
    list(options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').ListCatalogProvidersResponse>;
    provider(providerId: string): Promise<GetCatalogProviderResponse>;
    importProvider(input: { catalog_id: string; id?: string; api_key?: string; base_url?: string }, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').ImportCatalogProviderResponse>;
    importRegistry(input: { url: string; api_key?: string }, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').ImportCustomRegistryResponse>;
  };

  readonly oauth: {
    usage(provider?: string, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').ManagedUsageResult>;
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
    /** User-requested only; cold/expired caches may make remote usage calls. Never needed to save settings. */
    keyUsage(instanceId: string, refresh?: boolean, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').NbSearchKeyUsageView>;
    readCredential(instanceId: string, reveal: boolean): Promise<import('@kiki/protocol').NbSearchManagedCredentialView>;
    writeCredential(instanceId: string, value: string | null, expectedVersion: string, expectedBinding: string): Promise<import('@kiki/protocol').NbSearchManagedCredentialView>;
  };

  /** `/request-identity/*`: identity profiles, client release tracks, usage and recent requests. Mutations return the full catalog. */
  readonly requestIdentity: {
    get(): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    preview(body: import('@kiki/protocol').RequestIdentityPreviewRequest): Promise<import('@kiki/protocol').RequestIdentityPreview>;
    duplicateProfile(from: string, label?: string): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    updateProfile(id: string, draft: import('@kiki/protocol').RequestIdentityProfileDraft): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    deleteProfile(id: string): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    checkTrack(track: import('@kiki/protocol').RequestIdentityTrackId, source: import('@kiki/protocol').RequestIdentityUpdateSource): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    applyTrack(track: import('@kiki/protocol').RequestIdentityTrackId, version: string): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    trackAction(track: import('@kiki/protocol').RequestIdentityTrackId, action: 'dismiss' | 'rollback' | 'reset'): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    pinTrack(track: import('@kiki/protocol').RequestIdentityTrackId, pinned: boolean): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
    setManifestUrl(url: string | null): Promise<import('@kiki/protocol').RequestIdentityCatalog>;
  };

  readonly notifications: {
    getSettings(): Promise<NotificationSettings>;
    updateSettings(settings: NotificationGlobalSettings): Promise<NotificationSettings>;
    listProviders(): Promise<readonly NotificationProviderDescriptor[]>;
    upsertInstance(id: string, instance: NotificationInstance, slots: Record<string, Omit<NotificationCredentialSlot, 'configured'>>): Promise<NotificationSettings>;
    deleteInstance(id: string): Promise<NotificationSettings>;
    upsertChannel(id: string, channel: NotificationChannel): Promise<NotificationSettings>;
    deleteChannel(id: string): Promise<NotificationSettings>;
    setCredential(slotId: string, value: string | null): Promise<{ configured: boolean }>;
    checkCredential(instanceId: string): Promise<NotificationCredentialCheck>;
    sendTest(channelId: string): Promise<NotificationDelivery>;
    listDeliveries(channelId?: string): Promise<readonly NotificationDelivery[]>;
  };

  readonly secrets: {
    /** Explicit, authenticated reveal of one secret value; bulk reads stay redacted. */
    reveal(ref: import('@kiki/protocol').SecretRef): Promise<import('@kiki/protocol').RevealedSecret>;
  };

  readonly executors: {
    list(): Promise<import('@kiki/protocol').ListExecutorsResponse>;
    listLocalSessions(executorId: string, query?: { readonly limit?: number }, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').LocalSessionDirectory>;
    getLocalSession(executorId: string, localSessionId: string, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').LocalSessionDetail>;
    /** Attaches without sending a prompt; duplicate calls return the existing Kiki session. */
    resumeLocalSession(executorId: string, localSessionId: string, body: import('@kiki/protocol').ResumeLocalSessionRequest, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').ResumeLocalSessionResponse>;
  };

  readonly agents: {
    list(query?: string | ListNamedAgentProfilesQuery): Promise<ListNamedAgentProfilesResponse>;
    previewExecutorPrompt(name: string, body?: import('@kiki/protocol').ExecutorPromptPreviewRequest): Promise<import('@kiki/protocol').ExecutorPromptPreviewResponse>;
    previewModelMenu(name: string, body: import('@kiki/protocol').AgentModelMenuPreviewRequest, options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').AgentModelMenuPreviewResponse>;
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
    readHostFileBytes(path: string, options?: HttpRestMediaOptions): Promise<HttpRestBinaryFile>;
    readHostMediaPreview(path: string, options?: HttpRestMediaOptions): Promise<HttpRestBinaryFile>;
    downloadHostFile(path: string, sink: HttpRestMediaSink, options?: HttpRestMediaOptions): Promise<HttpRestMediaReceipt>;
    workspaceFsSearch(
      workspace: string,
      body: { readonly query: string; readonly limit?: number },
      options?: HttpRestRequestOptions,
    ): Promise<FsSearchResponse>;
  };

  readonly threads: {
    messages(query?: import('@kiki/protocol').ListThreadMessagesQuery,
      options?: HttpRestRequestOptions): Promise<import('@kiki/protocol').ListThreadMessagesResponse>;
  };

  readonly search: {
    messages(
      body: HttpRestSearchMessagesBody,
      options?: HttpRestRequestOptions,
    ): Promise<HttpRestSearchMessagesResponse>;
    retry(): Promise<{ retried: boolean }>;
    status(): Promise<{ index_state: HttpRestSearchMessagesResponse['index_state'] & {
      readonly retry_after_ms?: number;
      readonly writer?: boolean;
    } }>;
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
    navigation(): Promise<import('@kiki/protocol').PluginNavigation>;
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
