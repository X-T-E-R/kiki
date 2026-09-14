/**
 * `/agents` REST routes — named agent-profile catalog and validated write-back.
 *
 * GET merges logical profiles across workspace registrations, exposes an
 * expanded view, and projects builtin and named disable state. PATCH borrows
 * the addressed workspace's validated common-field / raw-file
 * writer and echoes the authoritative post-reload profile.
 */

import {
  AgentProfileSourceDiagnosticCodes,
  AgentProfileWriteErrors,
  BUILTIN_AGENT_PROFILE_SOURCE_ID,
  DISABLED_BUILTIN_PROFILES_SECTION,
  DISABLED_NAMED_PROFILES_SECTION,
  ErrorCodes,
  IAgentProfileRegistry,
  IAgentExecutorRegistry,
  IConfigService,
  ISessionAgentProfileCatalog,
  ISessionContext,
  ISessionManager,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  isError2,
  type AgentProfile,
  type AgentProfileCatalogSnapshot,
  type AgentProfileRegistration,
  type AgentProfileRouteDefinition,
  type DisabledBuiltinProfilesConfig,
  type DisabledNamedProfilesConfig,
  type Scope,
  type ScopedAgentProfileBinding,
} from '@kiki/agent-core-v2';
import {
  agentCapabilitiesQuerySchema,
  agentCapabilitiesResponseSchema,
  listNamedAgentProfilesQuerySchema,
  listNamedAgentProfilesResponseSchema,
  namedAgentProfileNameParamsSchema,
  namedAgentProfileSchema,
  updateNamedAgentProfileRequestSchema,
  type NamedAgentProfile,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { acquireWorkspaceProfileCatalog, agentCapabilities } from './agentProfileCapabilities';

interface AgentProfilesRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: { expand?: boolean; workspace_id?: string } },
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

export function registerAgentProfilesRoute(app: AgentProfilesRouteHost, core: Scope): void {
  const capabilitiesRoute = defineRoute({
    method: 'GET',
    path: '/agents/capabilities',
    querystring: agentCapabilitiesQuerySchema,
    success: { data: agentCapabilitiesResponseSchema },
    errors: { [ErrorCode.WORKSPACE_NOT_FOUND]: {}, [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {} },
    description: 'Inspect live caller dispatch targets or a workspace draft preview without launching agents',
    tags: ['agents'],
  }, async (req, reply) => {
    const result = await agentCapabilities(core, req.query);
    if (result === 'workspace-not-found') {
      reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist', req.id));
    } else if (result === 'profile-not-found') {
      reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_NOT_FOUND, 'Main profile is unavailable', req.id));
    } else {
      reply.send(okEnvelope(result, req.id));
    }
  });
  app.get(capabilitiesRoute.path, capabilitiesRoute.options,
    capabilitiesRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

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
      const disabledBuiltins = new Set(
        config.get<DisabledBuiltinProfilesConfig>(DISABLED_BUILTIN_PROFILES_SECTION) ?? [],
      );
      const disabledNamed = new Set(
        config.get<DisabledNamedProfilesConfig>(DISABLED_NAMED_PROFILES_SECTION) ?? [],
      );
      const workspaceId = req.query.workspace_id;
      if (workspaceId === undefined && req.query.cwd === undefined) {
        const items = projectNamedAgentProfiles(
          registry.entries(),
          disabledBuiltins,
          disabledNamed,
          req.query.expand === true,
          await sessionAgentProfileCatalogs(core),
          executors,
        );
        reply.send(okEnvelope({ items, complete: true }, req.id));
        return;
      }

      const workspaceCatalog = await acquireWorkspaceProfileCatalog(core, req.query);
      if (workspaceCatalog === undefined) {
        reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace does not exist', req.id));
        return;
      }
      try {
        const { catalog, workspaceId: resolvedWorkspaceId } = workspaceCatalog;
        const entries = registry.entries().filter((entry) =>
          entry.workspaceKey === undefined || entry.workspaceKey === resolvedWorkspaceId
        );
        const catalogs = new Map([[resolvedWorkspaceId, { catalog, snapshot: catalog.snapshot() }]]);
        const effectiveProfiles = new Map(catalog.list().map((profile) => [profile.name, profile]));
        const defaultProfile = catalog.snapshot().defaultProfile;
        if (defaultProfile?.main === true) effectiveProfiles.set(defaultProfile.name, defaultProfile);
        const items = req.query.effective === true
          ? [...effectiveProfiles.values()].map((profile) => {
              const inspection = catalog.inspect(profile.name);
              const registration = entries.find((entry) =>
                (inspection === undefined || entry.sourceId === inspection.sourceId && entry.priority === inspection.priority)
                && entry.contribution.profiles.some((candidate) => sameProfileDefinition(candidate, profile))
              );
              const item = toNamedAgentProfile(registration ?? {
                sourceId: inspection?.sourceId ?? BUILTIN_AGENT_PROFILE_SOURCE_ID,
                priority: inspection?.priority ?? 0,
                workspaceKey: resolvedWorkspaceId,
                contribution: { profiles: [profile] },
              }, profile, disabledBuiltins, disabledNamed, undefined,
              { catalog, snapshot: catalog.snapshot() }, executors);
              return profile === defaultProfile && profile.main === true ? { ...item, disabled: false } : item;
            }).toSorted(compareNamedAgentProfiles)
          : projectNamedAgentProfiles(entries, disabledBuiltins, disabledNamed,
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
          modelAlias: req.body.pinned_model_alias,
          thinkingEffort: req.body.thinking_effort,
          serviceTier: req.body.service_tier,
          tools: req.body.tools,
          disallowedTools: req.body.disallowed_tools,
          routes: req.body.routes?.map((route) => ({
            id: route.id,
            description: route.description,
            modelAlias: route.model_alias,
          })),
          rawText: req.body.raw_text,
        });
        reply.send(okEnvelope(toNamedAgentProfile(
          {
            sourceId: updated.sourceId,
            priority: 0,
            workspaceKey: updated.workspaceKey,
            contribution: { profiles: [updated.profile], routes: updated.routes },
          },
          profileWithBuiltinMain(updated.profile, core.accessor.get(IAgentProfileRegistry).entries()),
          new Set(core.accessor.get(IConfigService).get<DisabledBuiltinProfilesConfig>(DISABLED_BUILTIN_PROFILES_SECTION) ?? []),
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
  entries: readonly AgentProfileRegistration[],
  disabledBuiltins: ReadonlySet<string>,
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
      .map((profile) => profileWithBuiltinMain(profile, entries)),
  } }));
  if (expand) {
    return registrations
      .flatMap((registration) =>
        registration.contribution.profiles.map((profile) =>
          toNamedAgentProfile(
            registration,
            profile,
            disabledBuiltins,
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
        registration,
        profile,
        disabledBuiltins,
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
    const publicProfile = candidate.snapshot?.publicProfiles.get(profile.name)
      ?? candidate.catalog.get(profile.name);
    if (sameProfileDefinition(publicProfile, profile)) return candidate;
  }
  return undefined;
}

function profileWithBuiltinMain(profile: AgentProfile, entries: readonly AgentProfileRegistration[]): AgentProfile {
  const builtin = entries.find((entry) => entry.sourceId === BUILTIN_AGENT_PROFILE_SOURCE_ID)
    ?.contribution.profiles.find((candidate) => candidate.name === profile.name);
  return profile.main === undefined && builtin?.main !== undefined
    ? { ...profile, main: builtin.main }
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
  registration: AgentProfileRegistration,
  profile: AgentProfile,
  disabledBuiltins: ReadonlySet<string> = new Set(),
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
    main: profile.main === true,
    override: profile.override === true ? true : undefined,
    executor: executorId,
    executor_protocol: executor?.protocol ?? (executorId === 'native' ? 'native' : undefined),
    executor_options:
      profile.executorOptions === undefined
        ? undefined
        : { ...profile.executorOptions },
    pinned_model_alias: profile.modelAlias,
    thinking_effort: profile.thinkingEffort,
    service_tier: profile.serviceTier,
    request_params: profile.requestParams === undefined ? undefined : { ...profile.requestParams },
    context_budget: profile.contextBudget,
    max_completion_tokens: profile.maxCompletionTokens,
    tools: profile.tools === undefined ? undefined : [...profile.tools],
    disallowed_tools: profile.disallowedTools === undefined ? undefined : [...profile.disallowedTools],
    model_profiles: profile.modelProfiles?.map(toNamedAgentModelProfile),
    spawn_constraints: profile.spawnConstraints === undefined
      ? undefined
      : {
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
    subagents: profile.subagents?.map((name) => {
      const lease = profile.subagentLeases?.[name];
      const binding = lease?.source === undefined
        ? undefined
        : scopedBindingFor(catalog, registration, profile, name);
      return lease === undefined ? name : toNamedAgentSubagentLease(lease, binding);
    }),
    disabled: registration.sourceId === BUILTIN_AGENT_PROFILE_SOURCE_ID
      ? disabledBuiltins.has(profile.name)
      : disabledNamed.has(profile.name),
    routes: (registration.contribution.routes ?? [])
      .filter((candidate) => candidate.profile === profile.name)
      .map(toNamedAgentRoute)
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  };
}

function scopedBindingFor(
  projection: SessionAgentProfileCatalogProjection | undefined,
  registration: AgentProfileRegistration,
  profile: AgentProfile,
  alias: string,
): ScopedAgentProfileBinding | undefined {
  if (projection !== undefined) {
    const parent = projection.snapshot?.publicProfiles.get(profile.name)
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
  return {
    alias: modelProfile.alias,
    when: modelProfile.when,
    context_budget: modelProfile.contextBudget,
    max_completion_tokens: modelProfile.maxCompletionTokens,
    service_tier: modelProfile.serviceTier,
    request_params: modelProfile.requestParams === undefined ? undefined : { ...modelProfile.requestParams },
    thinking_effort: modelProfile.thinkingEffort,
    allowed_efforts: modelProfile.allowedEfforts === undefined
      ? undefined
      : [...modelProfile.allowedEfforts],
    prompt_mode: modelProfile.promptMode,
    prompt: modelProfile.prompt,
  };
}

function toNamedAgentSubagentLease(
  lease: NonNullable<AgentProfile['subagentLeases']>[string],
  binding?: ScopedAgentProfileBinding,
): Exclude<NonNullable<NamedAgentProfile['subagents']>[number], string> {
  const status = lease.source === undefined ? undefined : binding?.status ?? 'unavailable';
  return {
    name: lease.name,
    source: lease.source,
    scope: lease.source === undefined ? undefined : 'private',
    status,
    diagnostic: scopedBindingDiagnostic(binding, status),
    description: lease.description,
    when_to_use: lease.whenToUse,
    model_alias: lease.modelAlias,
    thinking_effort: lease.thinkingEffort,
    allowed_models: lease.allowedModels === undefined ? undefined : [...lease.allowedModels],
    deny_models: lease.denyModels === undefined ? undefined : [...lease.denyModels],
    allowed_efforts: lease.allowedEfforts === undefined ? undefined : [...lease.allowedEfforts],
    tools: lease.tools === undefined || lease.tools === null ? lease.tools : [...lease.tools],
    disallowed_tools: lease.disallowedTools === undefined
      ? undefined
      : [...lease.disallowedTools],
    subagents: lease.subagents === undefined || lease.subagents === null
      ? lease.subagents
      : [...lease.subagents],
    prompt_mode: lease.promptMode,
    prompt: lease.prompt,
    delegation_notice: lease.delegationNotice,
    service_tier: lease.serviceTier,
    request_params: lease.requestParams === undefined || lease.requestParams === null
      ? lease.requestParams
      : { ...lease.requestParams },
    model_profiles: lease.modelProfiles?.map(toNamedAgentModelProfile),
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

function toNamedAgentRoute(route: AgentProfileRouteDefinition): NamedAgentProfile['routes'][number] {
  return {
    id: route.id,
    description: route.description,
    model_alias: route.modelAlias,
    source_file: route.path,
  };
}
