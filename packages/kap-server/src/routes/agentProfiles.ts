import {
  AgentProfileSourceDiagnosticCodes,
  AgentProfileWriteErrors,
  BUILTIN_AGENT_PROFILE_SOURCE_ID,
  DEFAULT_AGENT_PROFILE_NAME,
  DISABLED_NAMED_PROFILES_SECTION,
  ErrorCodes,
  IAgentProfileRegistry,
  IAgentExecutorRegistry,
  IAgentExecutorPreflightService,
  IManagedAdapterService,
  ILocalSessionCatalog,
  IFlagService,
  LOCAL_SESSION_RESUME_FLAG,
  localSessionEngine,
  type LocalSessionSummary,
  MANAGED_ADAPTER_RELEASES,
  IBootstrapService,
  EXECUTOR_OVERRIDE_SOURCE_ID,
  executorCapabilities,
  expandExecutorText,
  IConfigService,
  IInstantiationService,
  ISessionAgentProfileCatalog,
  ISessionContext,
  ISessionManager,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  isError2,
  type AgentProfile,
  type AgentProfileCatalogSnapshot,
  type AgentExecutorDescriptor,
  type AgentProfileRegistration,
  type AgentProfileRouteDefinition,
  type DisabledNamedProfilesConfig,
  type Scope,
  type ScopedAgentProfileBinding,
} from '@kiki/agent-core-v2';
import {
  agentCapabilitiesQuerySchema,
  agentCapabilitiesResponseSchema,
  agentModelMenuPreviewRequestSchema,
  agentModelMenuPreviewResponseSchema,
  createNamedAgentProfileRequestSchema,
  listNamedAgentProfilesQuerySchema,
  listNamedAgentProfilesResponseSchema,
  listExecutorsResponseSchema,
  executorDetailResponseSchema,
  executorCheckResponseSchema,
  executorPromptPreviewRequestSchema,
  executorPromptPreviewResponseSchema,
  localSessionDirectorySchema,
  localSessionDetailSchema,
  resumeLocalSessionRequestSchema,
  resumeLocalSessionResponseSchema,
  namedAgentProfileNameParamsSchema,
  namedAgentProfileSchema,
  updateNamedAgentProfileRequestSchema,
  type NamedAgentProfile,
} from '@kiki/protocol';
import { z } from 'zod';
import { modelProfileToWire, modelProfileUpdateFromWire, subagentLeaseUpdateFromWire } from '@kiki/agent-core-v2/app/agentProfileCatalog/modelProfileOverlay';
import { createUnscopedAgentProfileCatalog } from '@kiki/agent-core-v2/workspace/workspaceAgentProfileLoader/unscopedAgentProfileCatalog';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { acquireDraftProfileCatalog, acquireDraftProfileListCatalog, acquireWorkspaceProfileCatalog, agentCapabilities } from './agentProfileCapabilities';
import { previewExecutorPrompt } from './executorPromptPreview';
import { applyAgentModelMenuDraft, projectAgentModelMenu } from './agentModelMenu';
import { resumeLocalSession } from './localSessionResume';
import { registerAntigravityRoutes } from './antigravity';

const unscopedCatalogs = new WeakMap<Scope, ReturnType<typeof createUnscopedAgentProfileCatalog>>();

async function unscopedProfileCatalog(core: Scope) {
  let preview = unscopedCatalogs.get(core);
  if (preview === undefined) {
    const instantiation = core.accessor.get(IInstantiationService);
    preview = createUnscopedAgentProfileCatalog(instantiation);
    unscopedCatalogs.set(core, preview);
    const owned = preview;
    instantiation.onWillDispose(() => {
      unscopedCatalogs.delete(core);
      owned.dispose();
    });
  }
  await preview.catalog.ready;
  return preview;
}

export interface AgentProfilesRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: { expand?: boolean; workspace_id?: string } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
const managedInstallSchema = z.object({ version: z.string(), integrity: z.string(), source: z.string(), install_id: z.string() });
const managedStatusSchema = z.object({
  id: z.string(),
  release: z.object({ package_name: z.string(), version: z.string(), integrity: z.string(),
    source: z.string(), entry: z.string() }),
  active: managedInstallSchema.optional(),
  previous: managedInstallSchema.optional(),
  phase: z.enum(['idle', 'downloading', 'verifying', 'installing', 'activating', 'failed']),
  error: z.string().optional(),
});

function projectManagedStatus(status: Awaited<ReturnType<IManagedAdapterService['status']>>) {
  const installation = (value: typeof status.active) => value === undefined ? undefined : {
    version: value.version, integrity: value.integrity, source: value.source, install_id: value.installId,
  };
  return {
    id: status.id,
    release: { package_name: status.release.packageName, version: status.release.version,
      integrity: status.release.integrity, source: status.release.source, entry: status.release.entry },
    active: installation(status.active), previous: installation(status.previous),
    phase: status.phase, error: status.error,
  };
}

function projectLocalSession(summary: LocalSessionSummary) {
  return { id: summary.id, engine: summary.engine, external_id: summary.externalId, source_path: summary.sourcePath,
    source_home: summary.sourceHome, resume: summary.resume,
    cwd: summary.cwd, title: summary.title, created_at: summary.createdAt, updated_at: summary.updatedAt,
    last_prompt: summary.lastPrompt, parent_id: summary.parentId, partial: summary.partial };
}

/** Registers the `/agents` routes — named agent-profile catalog and validated write-back. GET merges
 *  logical profiles across workspace registrations, exposes an expanded view, and projects builtin and
 *  named disable state; PATCH borrows the addressed workspace's validated common-field / raw-file
 *  writer and echoes the authoritative post-reload profile. */
export function registerAgentProfilesRoute(app: AgentProfilesRouteHost, core: Scope): void {
  registerAntigravityRoutes(app, core);
  const capabilitiesRoute = defineRoute({
    method: 'GET',
    path: '/agents/capabilities',
    querystring: agentCapabilitiesQuerySchema,
    success: { data: agentCapabilitiesResponseSchema },
    errors: { [ErrorCode.WORKSPACE_NOT_FOUND]: {}, [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {} },
    description: 'Inspect live caller dispatch targets or a workspace draft preview without launching agents',
    tags: ['agents'],
  }, async (req, reply) => {
    await withReplyCloseSignal(
      reply as unknown as Parameters<typeof withReplyCloseSignal>[0],
      async (signal) => {
        const result = await agentCapabilities(core, req.query, signal);
        if (result === 'workspace-not-found') {
          reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist', req.id));
        } else if (result === 'profile-not-found') {
          reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Main profile is unavailable', req.id));
        } else {
          reply.send(okEnvelope(result, req.id));
        }
      },
    );
  });
  app.get(capabilitiesRoute.path, capabilitiesRoute.options,
    capabilitiesRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const executorsRoute = defineRoute({
    method: 'GET',
    path: '/executors',
    success: { data: listExecutorsResponseSchema },
    description: 'List configured execution engines and local binary discovery status',
    tags: ['agents'],
  }, async (req, reply) => {
    const config = core.accessor.get(IConfigService);
    await config.ready;
    const registry = core.accessor.get(IAgentExecutorRegistry);
    const preflight = core.accessor.get(IAgentExecutorPreflightService);
    const items = await Promise.all(registry.list().map((descriptor) =>
      projectExecutor(descriptor, registry, preflight.lastCheck(descriptor.id), core.accessor.get(IBootstrapService))));

    reply.send(okEnvelope({ items }, req.id));
  });
  app.get(executorsRoute.path, executorsRoute.options,
    executorsRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const executorParams = z.object({ id: z.string().min(1) });
  const executorDetailRoute = defineRoute({
    method: 'GET', path: '/executors/{id}', params: executorParams,
    success: { data: executorDetailResponseSchema },
    errors: { [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {} },
    description: 'Inspect execution engine capability and connection settings', tags: ['agents'],
  }, async (req, reply) => {
    await core.accessor.get(IConfigService).ready;
    const registry = core.accessor.get(IAgentExecutorRegistry);
    const descriptor = registry.get(req.params.id);
    if (descriptor === undefined) {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Executor not found', req.id));
      return;
    }
    const check = core.accessor.get(IAgentExecutorPreflightService).lastCheck(descriptor.id);
    reply.send(okEnvelope(await projectExecutor(descriptor, registry, check, core.accessor.get(IBootstrapService)), req.id));
  });
  app.get(executorDetailRoute.path, executorDetailRoute.options,
    executorDetailRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const executorCheckRoute = defineRoute({
    method: 'POST', path: '/executors/{id}/check', params: executorParams,
    success: { data: executorCheckResponseSchema },
    errors: { [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {} },
    description: 'Check executable discovery and declared authentication hints', tags: ['agents'],
  }, async (req, reply) => {
    await core.accessor.get(IConfigService).ready;
    if (core.accessor.get(IAgentExecutorRegistry).get(req.params.id) === undefined) {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Executor not found', req.id));
      return;
    }
    const [result] = await core.accessor.get(IAgentExecutorPreflightService).run([req.params.id]);
    reply.send(okEnvelope({ id: result!.id, status: result!.status, version: result!.version,
      command: result!.command, selected_source: result!.selectedSource,
      resolved_args: result!.resolvedArgs, diagnostics: result!.diagnostics,
      login_status: result!.loginStatus,
      credential_source: result!.credentialSource,
      credential_detail: result!.credentialDetail,
      requirements: result!.requirements.map((requirement) => ({
        id: requirement.id, label: requirement.label, role: requirement.role, status: requirement.status,
        path: requirement.path, version: requirement.version, install_hint: requirement.installHint,
      })) }, req.id));
  });
  app.post(executorCheckRoute.path, executorCheckRoute.options,
    executorCheckRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const installationsRoute = defineRoute({
    method: 'GET', path: '/executors/installations',
    success: { data: z.object({ items: z.array(managedStatusSchema) }) },
    description: 'List pinned adapter releases, active versions and installation progress', tags: ['agents'],
  }, async (req, reply) => {
    const items = await core.accessor.get(IManagedAdapterService).list();
    reply.send(okEnvelope({ items: items.map(projectManagedStatus) }, req.id));
  });
  app.get(installationsRoute.path, installationsRoute.options,
    installationsRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const installRoute = defineRoute({
    method: 'POST', path: '/executors/{id}/install', params: executorParams,
    success: { data: managedStatusSchema },
    errors: { [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {} },
    description: 'Install the checksum-pinned adapter under the Kiki home', tags: ['agents'],
  }, async (req, reply) => {
    if (!Object.hasOwn(MANAGED_ADAPTER_RELEASES, req.params.id)) {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Managed adapter not found', req.id));
      return;
    }
    const status = await core.accessor.get(IManagedAdapterService).install(req.params.id);
    reply.send(okEnvelope(projectManagedStatus(status), req.id));
  });
  app.post(installRoute.path, installRoute.options,
    installRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const rollbackRoute = defineRoute({
    method: 'POST', path: '/executors/{id}/rollback', params: executorParams,
    success: { data: managedStatusSchema },
    errors: { [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {} },
    description: 'Atomically activate the previous managed adapter version', tags: ['agents'],
  }, async (req, reply) => {
    if (!Object.hasOwn(MANAGED_ADAPTER_RELEASES, req.params.id)) {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Managed adapter not found', req.id));
      return;
    }
    const status = await core.accessor.get(IManagedAdapterService).rollback(req.params.id);
    reply.send(okEnvelope(projectManagedStatus(status), req.id));
  });
  app.post(rollbackRoute.path, rollbackRoute.options,
    rollbackRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const localSessionsRoute = defineRoute({
    method: 'GET', path: '/executors/{id}/local-sessions', params: executorParams,
    querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
    success: { data: localSessionDirectorySchema },
    errors: { [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {} },
    description: 'Read the local Claude/Codex session directory without importing into Kiki', tags: ['agents'],
  }, async (req, reply) => {
    await core.accessor.get(IConfigService).ready;
    if (localSessionEngine(req.params.id) === undefined || core.accessor.get(IAgentExecutorRegistry).get(req.params.id) === undefined) {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Local session catalog is unavailable for this executor', req.id));
      return;
    }
    const directory = await core.accessor.get(ILocalSessionCatalog).list(req.params.id, req.query.limit);
    reply.send(okEnvelope({ root: directory.root, exists: directory.exists,
      items: directory.items.map(projectLocalSession), truncated: directory.truncated,
      unreadable_files: directory.unreadableFiles,
      resume_enabled: core.accessor.get(IFlagService).enabled(LOCAL_SESSION_RESUME_FLAG) }, req.id));
  });
  app.get(localSessionsRoute.path, localSessionsRoute.options,
    localSessionsRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const localSessionDetailRoute = defineRoute({
    method: 'GET', path: '/executors/{id}/local-sessions/{local_session_id}',
    params: executorParams.extend({ local_session_id: z.string().min(1) }),
    success: { data: localSessionDetailSchema },
    errors: { [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {}, [ErrorCode.SESSION_NOT_FOUND]: {} },
    description: 'Read a bounded vendor transcript preview; no Kiki session is created', tags: ['agents'],
  }, async (req, reply) => {
    await core.accessor.get(IConfigService).ready;
    if (localSessionEngine(req.params.id) === undefined || core.accessor.get(IAgentExecutorRegistry).get(req.params.id) === undefined) {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Local session catalog is unavailable for this executor', req.id));
      return;
    }
    const detail = await core.accessor.get(ILocalSessionCatalog).get(req.params.id, req.params.local_session_id);
    if (detail === undefined) {
      reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Local session was not found', req.id));
      return;
    }
    reply.send(okEnvelope({ summary: projectLocalSession(detail.summary), messages: detail.messages,
      warnings: detail.warnings }, req.id));
  });
  app.get(localSessionDetailRoute.path, localSessionDetailRoute.options,
    localSessionDetailRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const resumeLocalRoute = defineRoute({
    method: 'POST', path: '/executors/{id}/local-sessions/{local_session_id}/resume',
    params: executorParams.extend({ local_session_id: z.string().min(1) }),
    body: resumeLocalSessionRequestSchema,
    success: { data: resumeLocalSessionResponseSchema },
    errors: { [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {}, [ErrorCode.SESSION_NOT_FOUND]: {},
      [ErrorCode.CAPABILITY_UNSUPPORTED]: {}, [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      [ErrorCode.SESSION_LOCKED]: {} },
    description: 'Attach an external local session to Kiki; repeated attachment returns the existing Kiki session', tags: ['agents'],
  }, async (req, reply) => {
    await core.accessor.get(IConfigService).ready;
    if (localSessionEngine(req.params.id) === undefined) {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Local session catalog is unavailable for this executor', req.id));
      return;
    }
    try {
      const result = await resumeLocalSession(core, req.params.id, req.params.local_session_id, req.body);
      reply.send('error' in result ? errEnvelope(result.error, result.message, req.id) : okEnvelope(result, req.id));
    } catch (error) {
      if (isError2(error) && (error.code === ErrorCodes.CONFIG_INVALID || error.code === ErrorCodes.VALIDATION_FAILED)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
        return;
      }
      throw error;
    }
  });
  app.post(resumeLocalRoute.path, resumeLocalRoute.options,
    resumeLocalRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/agents',
      querystring: listNamedAgentProfilesQuerySchema,
      success: { data: listNamedAgentProfilesResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List loaded named agent profiles and route model pins',
      tags: ['agents'],
    },
    async (req, reply) => {
      const registry = core.accessor.get(IAgentProfileRegistry);
      const executors = core.accessor.get(IAgentExecutorRegistry);
      const config = core.accessor.get(IConfigService);
      await config.ready;
      const disabledNamed = new Set(
        config.get<DisabledNamedProfilesConfig>(DISABLED_NAMED_PROFILES_SECTION) ?? [],
      );
      const workspaceId = req.query.workspace_id;
      if (req.query.unscoped === true) {
        const { registry: previewRegistry, catalog } = await unscopedProfileCatalog(core);
        const items = projectEffectiveNamedAgentProfiles(core, previewRegistry.entries(), catalog, disabledNamed, executors)
          .map((item) => ({ ...item, workspace_id: undefined, workspace_ids: undefined }));
        reply.send(okEnvelope({ items, complete: catalog.complete }, req.id));
        return;
      }
      if (workspaceId === undefined && req.query.cwd === undefined) {
        const items = projectNamedAgentProfiles(
          core,
          registry.entries(),
          disabledNamed,
          req.query.expand === true,
          await sessionAgentProfileCatalogs(core),
          executors,
        );
        reply.send(okEnvelope({ items, complete: true }, req.id));
        return;
      }

      const workspaceCatalog = await acquireDraftProfileListCatalog(core, req.query);
      if (workspaceCatalog === undefined) {
        reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist', req.id));
        return;
      }
      try {
        const { catalog, workspaceId: resolvedWorkspaceId } = workspaceCatalog;
        const entries = ('registry' in workspaceCatalog ? workspaceCatalog.registry : registry).entries().filter((entry) =>
          entry.workspaceKey === undefined || entry.workspaceKey === resolvedWorkspaceId
        );
        const catalogs = new Map([[resolvedWorkspaceId, { catalog, snapshot: catalog.snapshot() }]]);
        const items = req.query.effective === true
          ? projectEffectiveNamedAgentProfiles(core, entries, catalog, disabledNamed, executors, resolvedWorkspaceId)
          : projectNamedAgentProfiles(core, entries, disabledNamed,
              req.query.expand === true, catalogs, executors);
        reply.send(okEnvelope({ items, complete: catalog.complete }, req.id));
      } finally {
        workspaceCatalog.dispose();
      }
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2],
  );

  const executorPromptPreviewRoute = defineRoute({
    method: 'POST',
    path: '/agents/{name}/executor-prompt:preview',
    params: namedAgentProfileNameParamsSchema.extend({ preview: z.literal(':preview') }),
    body: executorPromptPreviewRequestSchema,
    success: { data: executorPromptPreviewResponseSchema },
    errors: {
      [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {},
      [ErrorCode.VALIDATION_FAILED]: {},
    },
    description: 'Render the prompt blocks and actual delivery for an external executor',
    tags: ['agents'],
  }, async (req, reply) => {
    await core.accessor.get(IConfigService).ready;
    let workspaceId = req.body.workspace;
    if (workspaceId === undefined) {
      const keys = [...new Set(core.accessor.get(IAgentProfileRegistry).entries()
        .filter((entry) => entry.contribution.profiles.some((profile) => profile.name === req.params.name))
        .map((entry) => entry.workspaceKey).filter((key): key is string => key !== undefined))];
      if (keys.length === 1) workspaceId = keys[0];
      else {
        const workspaces = await core.accessor.get(IWorkspaceService).list();
        if (workspaces.length === 1) workspaceId = workspaces[0]!.id;
      }
    }
    if (workspaceId === undefined) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Specify workspace when multiple workspaces are available', req.id));
      return;
    }
    const workspace = await acquireWorkspaceProfileCatalog(core, { workspace_id: workspaceId });
    if (workspace === undefined) {
      reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist', req.id));
      return;
    }
    try {
      const profile = workspace.catalog.get(req.params.name);
      if (profile === undefined) {
        reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Agent profile not found', req.id));
        return;
      }
      const executorId = req.body.executor ?? profile.executor ?? 'native';
      const descriptor = core.accessor.get(IAgentExecutorRegistry).get(executorId);
      if (descriptor === undefined || descriptor.protocol === 'native') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Select an external executor for prompt preview', req.id));
        return;
      }
      reply.send(okEnvelope(await previewExecutorPrompt(core, workspace.instance, profile, executorId), req.id));
    } finally {
      workspace.dispose();
    }
  });
  app.post(executorPromptPreviewRoute.path, executorPromptPreviewRoute.options,
    executorPromptPreviewRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const modelMenuPreviewRoute = defineRoute({
    method: 'POST',
    path: '/agents/{name}/model-menu:preview',
    params: namedAgentProfileNameParamsSchema.extend({ preview: z.literal(':preview') }),
    body: agentModelMenuPreviewRequestSchema,
    success: { data: agentModelMenuPreviewResponseSchema },
    errors: {
      [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {},
    },
    description: 'Preview unsaved model-menu edits and canonical declaration changes without writing or binding',
    tags: ['agents'],
  }, async (req, reply) => {
    await core.accessor.get(IConfigService).ready;
    const workspace = await acquireWorkspaceProfileCatalog(core, { workspace_id: req.body.workspace_id });
    if (workspace === undefined) {
      reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist', req.id));
      return;
    }
    try {
      const profile = req.body.source_file === undefined ? workspace.catalog.get(req.params.name)
        : core.accessor.get(IAgentProfileRegistry).entries()
          .filter((entry) => entry.workspaceKey === undefined || entry.workspaceKey === workspace.workspaceId)
          .flatMap((entry) => entry.contribution.profiles)
          .find((candidate) => candidate.name === req.params.name && candidate.sourcePath === req.body.source_file);
      if (profile === undefined) {
        reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Agent profile not found', req.id));
        return;
      }
      const original = profileWithDefaultMain(profile);
      const before = projectAgentModelMenu(core, original, original.main === true ? 'main' : 'sub');
      const draft = profileWithDefaultMain(applyAgentModelMenuDraft(original, req.body.draft));
      const after = projectAgentModelMenu(core, draft, draft.main === true ? 'main' : 'sub');
      const oldIds = new Set(before.declared_model_menu.identities);
      const newIds = new Set(after.declared_model_menu.identities);
      reply.send(okEnvelope({
        ...after,
        added_model_identities: [...newIds].filter((id) => !oldIds.has(id)),
        removed_model_identities: [...oldIds].filter((id) => !newIds.has(id)),
      }, req.id));
    } finally {
      workspace.dispose();
    }
  });
  app.post(modelMenuPreviewRoute.path, modelMenuPreviewRoute.options,
    modelMenuPreviewRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const createRoute = defineRoute({
    method: 'POST',
    path: '/agent-profiles',
    body: createNamedAgentProfileRequestSchema,
    success: { data: namedAgentProfileSchema },
    errors: {
      [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
      [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      [ErrorCode.AGENT_PROFILE_ALREADY_EXISTS]: {},
    },
    description: 'Create a file-backed named agent profile in the user or project scope',
    tags: ['agents'],
  }, async (req, reply) => {
    const workspace = await core.accessor.get(IWorkspaceService).get(req.body.workspace_id);
    if (workspace === undefined) {
      reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${req.body.workspace_id} does not exist`, req.id));
      return;
    }
    const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire({ workspaceId: workspace.id });
    try {
      await lease.instance.program.ready;
      const created = await lease.instance.program.agentProfileWriter.create({
        name: req.body.name,
        scope: req.body.scope,
        template: req.body.template,
        main: req.body.main,
        description: req.body.description,
        whenToUse: req.body.when_to_use,
        modelAlias: req.body.pinned_model_alias,
        restrictModelsToMenu: req.body.restrict_models_to_menu,
        thinkingEffort: req.body.thinking_effort,
        tools: req.body.tools,
        prompt: req.body.prompt,
      });
      reply.send(okEnvelope(toNamedAgentProfile(core, {
        sourceId: created.sourceId,
        priority: 0,
        workspaceKey: created.workspaceKey,
        contribution: { profiles: [created.profile], routes: created.routes },
      }, created.profile, new Set(core.accessor.get(IConfigService).get<DisabledNamedProfilesConfig>(DISABLED_NAMED_PROFILES_SECTION) ?? [])), req.id));
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.VALIDATION_FAILED) {
        const issues = Array.isArray(error.details?.['issues'])
          ? error.details['issues']
          : [{ path: '', message: error.message }];
        reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id), details: issues });
        return;
      }
      if (isError2(error) && error.code === AgentProfileWriteErrors.codes.PROFILE_ALREADY_EXISTS) {
        reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_ALREADY_EXISTS, error.message, req.id));
        return;
      }
      throw error;
    } finally {
      lease.dispose();
    }
  });
  app.post(createRoute.path, createRoute.options,
    createRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const updateRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/agents/{name}',
      params: namedAgentProfileNameParamsSchema,
      body: updateNamedAgentProfileRequestSchema,
      success: { data: namedAgentProfileSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {},
        [ErrorCode.AGENT_PROFILE_READ_ONLY]: {},
      },
      description: 'Update editable fields in a file-backed named agent profile',
      tags: ['agents'],
    },
    async (req, reply) => {
      const workspace = await core.accessor.get(IWorkspaceService).get(req.body.workspace_id);
      if (workspace === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${req.body.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      const lease = await core.accessor
        .get(IWorkspaceInstanceManager)
        .acquire({ workspaceId: workspace.id });
      try {
        await lease.instance.program.ready;
        const updated = await lease.instance.program.agentProfileWriter.update({
          name: req.params.name,
          scope: req.body.scope,
          sourcePath: req.body.source_file,
          description: req.body.description,
          whenToUse: req.body.when_to_use,
          main: req.body.main,
          executor: req.body.executor,
          executorPrompt: req.body.executor_prompt,
          allowKikiSubagents: req.body.allow_kiki_subagents,
          kikiContext: req.body.kiki_context,
          modelAlias: req.body.pinned_model_alias,
          restrictModelsToMenu: req.body.restrict_models_to_menu,
          thinkingEffort: req.body.thinking_effort,
          preferredModels: req.body.preferred_models,
          discouragedModels: req.body.discouraged_models,
          preferredEfforts: req.body.preferred_efforts,
          allowedModels: req.body.allowed_models,
          denyModels: req.body.deny_models,
          allowedEfforts: req.body.allowed_efforts,
          allowedSubagents: req.body.allowed_subagents?.map((entry) => typeof entry === 'string' ? entry : subagentLeaseUpdateFromWire(entry)) ?? req.body.allowed_subagents,
          canSpawnSubagents: req.body.can_spawn_subagents,
          preferredSubagents: req.body.preferred_subagents,
          denySubagents: req.body.deny_subagents,
          spawnConstraints: req.body.spawn_constraints === null ? null : req.body.spawn_constraints === undefined
            ? undefined : {
                allowedModels: req.body.spawn_constraints.allowed_models,
                denyModels: req.body.spawn_constraints.deny_models,
                allowedEfforts: req.body.spawn_constraints.allowed_efforts,
                preferredModels: req.body.spawn_constraints.preferred_models,
                discouragedModels: req.body.spawn_constraints.discouraged_models,
                preferredEfforts: req.body.spawn_constraints.preferred_efforts,
                disallowedTools: req.body.spawn_constraints.disallowed_tools,
              },
          modelProfiles: req.body.model_profiles?.map(modelProfileUpdateFromWire) ?? req.body.model_profiles,
          promptOverrides: req.body.prompt_overrides,
          serviceTier: req.body.service_tier,
          autoCompact: req.body.auto_compact,
          tools: req.body.tools,
          disallowedTools: req.body.disallowed_tools,
          routes: req.body.routes?.map((route) => ({
            id: route.id,
            description: route.description,
            modelAlias: route.model_alias,
          })),
          prompt: req.body.prompt,
          rawText: req.body.raw_text,
        });
        reply.send(okEnvelope(toNamedAgentProfile(
          core,
          {
            sourceId: updated.sourceId,
            priority: 0,
            workspaceKey: updated.workspaceKey,
            contribution: { profiles: [updated.profile], routes: updated.routes },
          },
          profileWithDefaultMain(updated.profile),
          new Set(core.accessor.get(IConfigService).get<DisabledNamedProfilesConfig>(DISABLED_NAMED_PROFILES_SECTION) ?? []),
        ), req.id));
      } catch (error) {
        if (isError2(error) && error.code === ErrorCodes.VALIDATION_FAILED) {
          const issues = Array.isArray(error.details?.['issues'])
            ? error.details['issues']
            : [{ path: '', message: error.message }];
          reply.send({
            ...errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id),
            details: issues,
          });
          return;
        }
        if (isError2(error) && error.code === AgentProfileWriteErrors.codes.PROFILE_READ_ONLY) {
          reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_READ_ONLY, error.message, req.id));
          return;
        }
        if (isError2(error) && error.code === AgentProfileWriteErrors.codes.PROFILE_NOT_FOUND) {
          reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, error.message, req.id));
          return;
        }
        throw error;
      } finally {
        lease.dispose();
      }
    },
  );
  app.patch(
    updateRoute.path,
    updateRoute.options,
    updateRoute.handler as Parameters<AgentProfilesRouteHost['patch']>[2],
  );
}

function projectEffectiveNamedAgentProfiles(
  core: Scope,
  entries: readonly AgentProfileRegistration[],
  catalog: ISessionAgentProfileCatalog & { snapshot(): AgentProfileCatalogSnapshot },
  disabledNamed: ReadonlySet<string>,
  executors: IAgentExecutorRegistry,
  workspaceKey?: string,
): NamedAgentProfile[] {
  const snapshot = catalog.snapshot();
  const profiles = new Map(catalog.list().map((profile) => [profile.name, profile]));
  const defaultProfile = snapshot.defaultProfile;
  if (defaultProfile?.main === true) profiles.set(defaultProfile.name, defaultProfile);
  return [...profiles.values()].map((profile) => {
    const inspection = catalog.inspect(profile.name);
    const registration = entries.find((entry) =>
      (inspection === undefined || entry.sourceId === inspection.sourceId && entry.priority === inspection.priority)
      && entry.contribution.profiles.some((candidate) => sameProfileDefinition(candidate, profile))
    );
    const item = toNamedAgentProfile(core, registration ?? {
      sourceId: inspection?.sourceId ?? BUILTIN_AGENT_PROFILE_SOURCE_ID,
      priority: inspection?.priority ?? 0,
      workspaceKey,
      contribution: { profiles: [profile] },
    }, profile, disabledNamed, undefined, { catalog, snapshot }, executors);
    return profile === defaultProfile && profile.main === true ? { ...item, disabled: false } : item;
  }).toSorted(compareNamedAgentProfiles);
}

interface SessionAgentProfileCatalogProjection {
  readonly catalog: ISessionAgentProfileCatalog;
  readonly snapshot?: AgentProfileCatalogSnapshot;
}

async function sessionAgentProfileCatalogs(
  core: Scope,
  workspaceId?: string,
): Promise<ReadonlyMap<string, SessionAgentProfileCatalogProjection>> {
  const catalogs = new Map<string, SessionAgentProfileCatalogProjection>();
  await Promise.all(core.accessor.get(ISessionManager).list().map(async (session) => {
    const sessionWorkspaceId = session.accessor.get(ISessionContext).workspaceId;
    if (workspaceId !== undefined && sessionWorkspaceId !== workspaceId) return;
    const catalog = session.accessor.get(ISessionAgentProfileCatalog);
    await catalog.ready;
    if (!catalogs.has(sessionWorkspaceId)) {
      catalogs.set(sessionWorkspaceId, { catalog, snapshot: catalog.snapshot?.() });
    }
  }));
  return catalogs;
}

function projectNamedAgentProfiles(
  core: Scope,
  entries: readonly AgentProfileRegistration[],
  disabledNamed: ReadonlySet<string>,
  expand: boolean,
  catalogs: ReadonlyMap<string, SessionAgentProfileCatalogProjection> = new Map(),
  executors: IAgentExecutorRegistry,
): NamedAgentProfile[] {
  const registrations = entries.toSorted((a, b) =>
    b.priority - a.priority
    || a.sourceId.localeCompare(b.sourceId)
    || (a.workspaceKey ?? '').localeCompare(b.workspaceKey ?? '')
  ).map((entry) => ({ ...entry, contribution: {
    ...entry.contribution,
    profiles: entry.contribution.profiles
      .filter((profile) => profile.private !== true)
      .map((profile) => profileWithDefaultMain(profile)),
  } }));
  if (expand) {
    return registrations
      .flatMap((registration) =>
        registration.contribution.profiles.map((profile) =>
          toNamedAgentProfile(
            core,
            registration,
            profile,
            disabledNamed,
            undefined,
            catalogForProfile(registration, profile, catalogs),
            executors,
          ),
        ))
      .toSorted(compareNamedAgentProfiles);
  }

  const merged = new Map<
    string,
    {
      registration: AgentProfileRegistration;
      profile: AgentProfile;
      workspaceIds: Set<string>;
    }
  >();
  for (const registration of registrations) {
    for (const profile of registration.contribution.profiles) {
      const key = JSON.stringify([
        profile.name,
        registration.sourceId,
        profile.sourcePath ?? null,
      ]);
      const existing = merged.get(key);
      if (existing !== undefined) {
        if (registration.workspaceKey !== undefined) {
          existing.workspaceIds.add(registration.workspaceKey);
        }
        continue;
      }
      merged.set(key, {
        registration,
        profile,
        workspaceIds: new Set(
          registration.workspaceKey === undefined ? [] : [registration.workspaceKey],
        ),
      });
    }
  }

  return [...merged.values()]
    .map(({ registration, profile, workspaceIds }) =>
      toNamedAgentProfile(
        core,
        registration,
        profile,
        disabledNamed,
        workspaceIds.size === 0 ? undefined : [...workspaceIds].toSorted(),
        catalogForProfile(registration, profile, catalogs),
        executors,
      ))
    .toSorted(compareNamedAgentProfiles);
}

function catalogForProfile(
  registration: AgentProfileRegistration,
  profile: AgentProfile,
  catalogs: ReadonlyMap<string, SessionAgentProfileCatalogProjection>,
): SessionAgentProfileCatalogProjection | undefined {
  const candidates = registration.workspaceKey === undefined
    ? catalogs.values()
    : [catalogs.get(registration.workspaceKey)].values();
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const resolvedProfile =
      (candidate.snapshot?.resolvableProfiles ?? candidate.snapshot?.publicProfiles)?.get(profile.name)
      ?? candidate.catalog.get(profile.name);
    if (sameProfileDefinition(resolvedProfile, profile)) return candidate;
  }
  return undefined;
}

function profileWithDefaultMain(profile: AgentProfile): AgentProfile {
  return profile.main === undefined && profile.name === DEFAULT_AGENT_PROFILE_NAME
    ? { ...profile, main: true }
    : profile;
}

function sameProfileDefinition(left: AgentProfile | undefined, right: AgentProfile): boolean {
  if (left === right) return true;
  if (left?.definitionId !== undefined && right.definitionId !== undefined) {
    return left.definitionId === right.definitionId;
  }
  return left?.sourcePath !== undefined && left.name === right.name && left.sourcePath === right.sourcePath;
}

function compareNamedAgentProfiles(a: NamedAgentProfile, b: NamedAgentProfile): number {
  return a.name.localeCompare(b.name)
    || a.source.localeCompare(b.source)
    || (a.source_file ?? '').localeCompare(b.source_file ?? '')
    || (a.workspace_id ?? '').localeCompare(b.workspace_id ?? '');
}

function toNamedAgentProfile(
  core: Scope,
  registration: AgentProfileRegistration,
  profile: AgentProfile,
  disabledNamed: ReadonlySet<string> = new Set(),
  workspaceIds?: readonly string[],
  catalog?: SessionAgentProfileCatalogProjection,
  executors?: IAgentExecutorRegistry,
): NamedAgentProfile {
  const executorId = profile.executor ?? 'native';
  const executor = executors?.get(executorId);
  return {
    name: profile.name,
    description: profile.description,
    when_to_use: profile.whenToUse,
    source: registration.sourceId,
    workspace_id: registration.workspaceKey,
    workspace_ids: workspaceIds === undefined ? undefined : [...workspaceIds],
    source_file: profile.sourcePath,
    shadowed_files: profile.shadowedFiles === undefined ? undefined : [...profile.shadowedFiles],
    prompt: profile.fileDefinition?.prompt,
    main: profile.main === true,
    override: profile.override === true ? true : undefined,
    executor: executorId,
    executor_protocol: executor?.protocol ?? (executorId === 'native' ? 'native' : undefined),
    executor_options:
      profile.executorOptions === undefined
        ? undefined
        : { ...profile.executorOptions },
    executor_prompt: profile.executorPrompt,
    allow_kiki_subagents: profile.allowKikiSubagents,
    kiki_context: profile.kikiContext === undefined ? undefined : [...profile.kikiContext],
    pinned_model_alias: profile.modelAlias,
    ...projectAgentModelMenu(core, profile, profile.main === true ? 'main' : 'sub'),
    thinking_effort: profile.thinkingEffort,
    preferred_models: profile.preferredModels === undefined ? undefined : [...profile.preferredModels],
    discouraged_models: profile.discouragedModels === undefined ? undefined : [...profile.discouragedModels],
    preferred_efforts: profile.preferredEfforts === undefined ? undefined : [...profile.preferredEfforts],
    allowed_models: profile.allowedModels === undefined ? undefined : [...profile.allowedModels],
    deny_models: profile.denyModels === undefined ? undefined : [...profile.denyModels],
    allowed_efforts: profile.allowedEfforts === undefined ? undefined : [...profile.allowedEfforts],
    service_tier: profile.serviceTier,
    request_params: profile.requestParams === undefined ? undefined : { ...profile.requestParams },
    context_budget: profile.contextBudget,
    auto_compact: profile.autoCompact,
    max_completion_tokens: profile.maxCompletionTokens,
    tools: profile.tools === undefined ? undefined : [...profile.tools],
    disallowed_tools: profile.disallowedTools === undefined ? undefined : [...profile.disallowedTools],
    model_profiles: profile.modelProfiles?.map(toNamedAgentModelProfile),
    prompt_overrides: profile.promptOverrides as NamedAgentProfile['prompt_overrides'],
    spawn_constraints: profile.spawnConstraints === undefined
      ? undefined
      : {
          preferred_models: profile.spawnConstraints.preferredModels === undefined ? undefined : [...profile.spawnConstraints.preferredModels],
          discouraged_models: profile.spawnConstraints.discouragedModels === undefined ? undefined : [...profile.spawnConstraints.discouragedModels],
          preferred_efforts: profile.spawnConstraints.preferredEfforts === undefined ? undefined : [...profile.spawnConstraints.preferredEfforts],
          allowed_models: profile.spawnConstraints.allowedModels === undefined
            ? undefined
            : [...profile.spawnConstraints.allowedModels],
          deny_models: profile.spawnConstraints.denyModels === undefined
            ? undefined
            : [...profile.spawnConstraints.denyModels],
          allowed_efforts: profile.spawnConstraints.allowedEfforts === undefined
            ? undefined
            : [...profile.spawnConstraints.allowedEfforts],
          disallowed_tools: profile.spawnConstraints.disallowedTools === undefined
            ? undefined
            : [...profile.spawnConstraints.disallowedTools],
        },
    can_spawn_subagents: profile.canSpawnSubagents,
    preferred_subagents: profile.preferredSubagents === undefined ? undefined : [...profile.preferredSubagents],
    deny_subagents: profile.denySubagents === undefined ? undefined : [...profile.denySubagents],
    allowed_subagents: (profile.allowedSubagents ?? (Object.keys(profile.subagentLeases ?? {}).length === 0 ? undefined : ['*', ...Object.keys(profile.subagentLeases!)]))?.map((name) => {
      const lease = profile.subagentLeases?.[name];
      const binding = lease?.source === undefined
        ? undefined
        : scopedBindingFor(catalog, registration, profile, name);
      return lease === undefined ? name : toNamedAgentSubagentLease(lease, binding);
    }),
    disabled: disabledNamed.has(profile.name),
    executor_fields: executorFields(executorId, executor),
    routes: (registration.contribution.routes ?? [])
      .filter((candidate) => candidate.profile === profile.name)
      .map(toNamedAgentRoute)
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}

function executorFields(
  id: string,
  descriptor: AgentExecutorDescriptor | undefined,
): NamedAgentProfile['executor_fields'] {
  if (id === 'native') return undefined;
  const applied = { state: 'applied' as const };
  const ignored = (reason: string) => ({ state: 'ignored' as const, reason });
  const mapped = (reason: string) => ({ state: 'mapped' as const, reason });
  const modelMapped = descriptor?.protocol === 'codex-app-server'
    || descriptor?.modelBinding === 'argv' || descriptor?.modelBinding === 'session_config';
  const thoughtMapped = descriptor?.protocol === 'codex-app-server'
    || descriptor?.thoughtConfigId !== undefined || descriptor?.thoughtConfigCategory !== undefined;
  return {
    name: applied,
    description: applied,
    when_to_use: applied,
    main: applied,
    executor: applied,
    prompt: mapped(descriptor?.profileDelivery === 'system_prompt_override'
      ? 'Delivered as an executor system prompt override'
      : descriptor?.protocol === 'codex-app-server'
        ? 'Delivered as developer instructions'
        : 'Delivered in the first user message'),
    pinned_model_alias: modelMapped ? mapped('Uses the executor model identifier')
      : ignored('No executor model binding is declared'),
    allowed_models: applied,
    deny_models: applied,
    thinking_effort: thoughtMapped ? mapped('Uses the executor thinking setting')
      : ignored('No executor thinking setting is declared'),
    allowed_efforts: applied,
    service_tier: ignored('Provider service tiers apply only to native execution'),
    request_params: ignored('Provider request parameters apply only to native execution'),
    tools: ignored('Tools are controlled by the external executor'),
    disallowed_tools: ignored('Tools are controlled by the external executor'),
    context_budget: ignored('Context budgets are controlled by the external executor'),
    auto_compact: ignored('Compaction is controlled by the external executor'),
    max_completion_tokens: ignored('Output limits are controlled by the external executor'),
    can_spawn_subagents: applied,
    allowed_subagents: applied,
    preferred_subagents: applied,
    deny_subagents: applied,
    spawn_constraints: applied,
    routes: applied,
    model_profiles: applied,
  };
}

function scopedBindingFor(
  projection: SessionAgentProfileCatalogProjection | undefined,
  registration: AgentProfileRegistration,
  profile: AgentProfile,
  alias: string,
): ScopedAgentProfileBinding | undefined {
  if (projection !== undefined) {
    const parent = (projection.snapshot?.resolvableProfiles ?? projection.snapshot?.publicProfiles)
      ?.get(profile.name)
      ?? projection.catalog.get(profile.name);
    const parentDefinitionId = parent?.definitionId;
    const binding = parentDefinitionId === undefined
      ? undefined
      : projection.snapshot?.scopedBindings.get(parentDefinitionId)?.get(alias)
        ?? projection.catalog.getScopedBinding?.(parentDefinitionId, alias);
    if (binding !== undefined) return binding;
  }
  return profile.definitionId === undefined
    ? undefined
    : registration.contribution.scopedBindings?.get(profile.definitionId)?.get(alias);
}

function toNamedAgentModelProfile(
  modelProfile: NonNullable<AgentProfile['modelProfiles']>[number],
): NonNullable<NamedAgentProfile['model_profiles']>[number] {
  return modelProfileToWire(modelProfile);
}

function toNamedAgentSubagentLease(
  lease: NonNullable<AgentProfile['subagentLeases']>[string],
  binding?: ScopedAgentProfileBinding,
): Exclude<NonNullable<NamedAgentProfile['allowed_subagents']>[number], string> {
  const status = lease.source === undefined ? undefined : binding?.status ?? 'unavailable';
  return {
    name: lease.name,
    source: lease.source,
    scope: lease.source === undefined ? undefined : 'private',
    status,
    diagnostic: scopedBindingDiagnostic(binding, status),
    diagnostic_code: scopedBindingDiagnosticCode(binding, status),
    description: lease.description,
    when_to_use: lease.whenToUse,
    model_alias: lease.modelAlias,
    thinking_effort: lease.thinkingEffort,
    preferred_models: lease.preferredModels === undefined ? undefined : [...lease.preferredModels],
    discouraged_models: lease.discouragedModels === undefined ? undefined : [...lease.discouragedModels],
    preferred_efforts: lease.preferredEfforts === undefined ? undefined : [...lease.preferredEfforts],
    allowed_models: lease.allowedModels === undefined ? undefined : [...lease.allowedModels],
    deny_models: lease.denyModels === undefined ? undefined : [...lease.denyModels],
    allowed_efforts: lease.allowedEfforts === undefined ? undefined : [...lease.allowedEfforts],
    tools: lease.tools === undefined || lease.tools === null ? lease.tools : [...lease.tools],
    disallowed_tools: lease.disallowedTools === undefined
      ? undefined
      : [...lease.disallowedTools],
    can_spawn_subagents: lease.canSpawnSubagents,
    allowed_subagents: lease.allowedSubagents === undefined ? undefined : [...lease.allowedSubagents],
    preferred_subagents: lease.preferredSubagents === undefined ? undefined : [...lease.preferredSubagents],
    deny_subagents: lease.denySubagents === undefined ? undefined : [...lease.denySubagents],
    prompt_mode: lease.promptMode,
    prompt: lease.prompt,
    delegation_notice: lease.delegationNotice,
    service_tier: lease.serviceTier,
    request_params: lease.requestParams === undefined || lease.requestParams === null
      ? lease.requestParams
      : { ...lease.requestParams },
    model_profiles: lease.modelProfiles?.map(toNamedAgentModelProfile),
    model_prompts: lease.modelPrompts,
  };
}

function scopedBindingDiagnostic(
  binding: ScopedAgentProfileBinding | undefined,
  status: ScopedAgentProfileBinding['status'] | undefined,
): string | undefined {
  if (binding?.diagnostic === undefined) {
    return status === 'unavailable' ? 'Source profile is unavailable' : undefined;
  }
  switch (binding.diagnostic.code) {
    case AgentProfileSourceDiagnosticCodes.INVALID_PATH:
      return 'Source path is invalid';
    case AgentProfileSourceDiagnosticCodes.PATH_ESCAPE:
      return 'Source path escapes its contribution root';
    case AgentProfileSourceDiagnosticCodes.SYMLINK_ESCAPE:
      return 'Source path resolves outside its contribution root';
    case AgentProfileSourceDiagnosticCodes.NOT_PRIVATE:
      return 'Source profile is not private';
    case AgentProfileSourceDiagnosticCodes.UNAVAILABLE:
      return 'Source profile is unavailable';
    case AgentProfileSourceDiagnosticCodes.INVALID_PROFILE:
      return 'Source profile is invalid';
    case AgentProfileSourceDiagnosticCodes.CYCLE:
      return 'Source profile dependency cycle detected';
    case AgentProfileSourceDiagnosticCodes.DEPTH_EXCEEDED:
      return 'Source profile dependency depth exceeded';
    default:
      return 'Source profile is unavailable';
  }
}

function scopedBindingDiagnosticCode(
  binding: ScopedAgentProfileBinding | undefined,
  status: ScopedAgentProfileBinding['status'] | undefined,
): Exclude<NonNullable<NamedAgentProfile['allowed_subagents']>[number], string>['diagnostic_code'] {
  if (binding?.diagnostic === undefined) {
    return status === 'unavailable' ? AgentProfileSourceDiagnosticCodes.UNAVAILABLE : undefined;
  }
  switch (binding.diagnostic.code) {
    case AgentProfileSourceDiagnosticCodes.INVALID_PATH:
    case AgentProfileSourceDiagnosticCodes.PATH_ESCAPE:
    case AgentProfileSourceDiagnosticCodes.SYMLINK_ESCAPE:
    case AgentProfileSourceDiagnosticCodes.NOT_PRIVATE:
    case AgentProfileSourceDiagnosticCodes.UNAVAILABLE:
    case AgentProfileSourceDiagnosticCodes.INVALID_PROFILE:
    case AgentProfileSourceDiagnosticCodes.CYCLE:
    case AgentProfileSourceDiagnosticCodes.DEPTH_EXCEEDED:
      return binding.diagnostic.code;
    default:
      return AgentProfileSourceDiagnosticCodes.UNAVAILABLE;
  }
}

function executorOverrideProjection(descriptor: AgentExecutorDescriptor) {
  const explicit = descriptor.sources?.find((source) => source.id === EXECUTOR_OVERRIDE_SOURCE_ID);
  const binPath = explicit === undefined ? undefined
    : explicit.kind === 'node-script' || explicit.kind === 'explicit-path' ? explicit.path
      : explicit.kind === 'path-lookup' ? explicit.command
        : undefined;
  return {
    bin_path: binPath,
    home_dir: descriptor.homeDir,
    args: [...descriptor.extraArgs ?? []],
    env_keys: Object.keys(descriptor.env ?? {}),
  };
}

async function projectExecutor(descriptor: AgentExecutorDescriptor, registry: IAgentExecutorRegistry,
  check: ReturnType<IAgentExecutorPreflightService['lastCheck']>, bootstrap: IBootstrapService) {
  const probes = descriptor.id === 'native' ? [] : await registry.discover(descriptor.id).catch(() => undefined);
  const selected = probes?.find((probe) => probe.available);
  const capabilities = executorCapabilities(descriptor);
  return {
    id: descriptor.id,
    label: descriptor.label ?? (descriptor.id === 'native' ? 'Kiki' : descriptor.id),
    protocol: descriptor.protocol,
    status: descriptor.id === 'native' || selected !== undefined ? 'ready' as const
      : probes === undefined ? 'unknown' as const : 'unavailable' as const,
    version: selected?.version,
    model_binding: descriptor.protocol === 'native' || capabilities.modelBinding !== undefined
      ? 'mapped' as const : 'unavailable' as const,
    thinking_binding: descriptor.protocol === 'native' || capabilities.thinkingBinding
      ? 'mapped' as const : 'unavailable' as const,
    capabilities: {
      prompt_deliveries: capabilities.promptDeliveries,
      steer: capabilities.steer,
      permission: { via: capabilities.permission?.via,
        trust_engine_settings: capabilities.permission?.trustEngineSettings === true },
      model_binding: capabilities.modelBinding,
      thinking_binding: capabilities.thinkingBinding,
      negotiated: registry.negotiated?.(descriptor.id, selected?.version) === undefined ? undefined : (() => {
        const observed = registry.negotiated!(descriptor.id, selected?.version)!;
        return { models: observed.models, thinking_levels: observed.thinkingLevels,
          auth_methods: observed.authMethods, resume: observed.resume, load: observed.load,
          permission_modes: observed.permissionModes, agent_version: observed.agentVersion,
          image: observed.image, audio: observed.audio, fork: observed.fork,
          native_steering: observed.nativeSteering, question_form: observed.questionForm,
          plan_approval: observed.planApproval };
      })(),
    },
    connection: {
      command: selected?.launchArgs?.[0] ?? selected?.command ?? descriptor.command,
      source: selected?.id,
      install_hint: descriptor.installHint === undefined ? undefined : expandExecutorText(descriptor.installHint, bootstrap),
      login_command: descriptor.loginCommand,
      api_key_env: descriptor.apiKeyEnv,
      home_env: descriptor.homeEnv,
      override: executorOverrideProjection(descriptor),
      login_status: check?.loginStatus ?? 'unknown' as const,
      credential_source: check?.credentialSource,
      credential_detail: check?.credentialDetail,
      default_args: [...descriptor.args],
    },
    default_profile: descriptor.defaultProfile === true,
  };
}

function toNamedAgentRoute(route: AgentProfileRouteDefinition): NamedAgentProfile['routes'][number] {
  return {
    id: route.id,
    description: route.description,
    model_alias: route.modelAlias,
    source_file: route.path,
  };
}
