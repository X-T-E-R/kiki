/**
 * `/agents` REST routes — named agent-profile catalog and validated write-back.
 *
 * GET projects the live App registry. PATCH borrows the addressed workspace's
 * core writer, edits only file-backed descriptions and model pins, explicitly
 * reloads the owning source, and echoes the authoritative post-reload profile.
 */

import {
  AgentProfileWriteErrors,
  ErrorCodes,
  IAgentProfileRegistry,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  isError2,
  type AgentProfile,
  type AgentProfileRegistration,
  type AgentProfileRouteDefinition,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  listNamedAgentProfilesResponseSchema,
  namedAgentProfileNameParamsSchema,
  namedAgentProfileSchema,
  updateNamedAgentProfileRequestSchema,
  type NamedAgentProfile,
} from '../protocol/rest-agentProfile';

interface AgentProfilesRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
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
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/agents',
      success: { data: listNamedAgentProfilesResponseSchema },
      description: 'List loaded named agent profiles and route model pins',
      tags: ['agents'],
    },
    async (req, reply) => {
      const registry = core.accessor.get(IAgentProfileRegistry);
      const items = registry.entries().flatMap((registration) =>
        registration.contribution.profiles.map((profile) =>
          toNamedAgentProfile(registration, profile),
        ),
      ).toSorted((a, b) =>
        a.name.localeCompare(b.name)
        || a.source.localeCompare(b.source)
        || (a.workspace_id ?? '').localeCompare(b.workspace_id ?? '')
      );
      reply.send(okEnvelope({ items }, req.id));
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
          description: req.body.description,
          modelAlias: req.body.pinned_model_alias,
          routes: req.body.routes?.map((route) => ({
            id: route.id,
            description: route.description,
            modelAlias: route.model_alias,
          })),
        });
        reply.send(okEnvelope(toNamedAgentProfile(
          {
            sourceId: updated.sourceId,
            priority: 0,
            workspaceKey: updated.workspaceKey,
            contribution: { profiles: [updated.profile], routes: updated.routes },
          },
          updated.profile,
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
        if (isError2(error) && error.code === AgentProfileWriteErrors.codes.READ_ONLY) {
          reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_READ_ONLY, error.message, req.id));
          return;
        }
        if (isError2(error) && error.code === AgentProfileWriteErrors.codes.NOT_FOUND) {
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

function toNamedAgentProfile(
  registration: AgentProfileRegistration,
  profile: AgentProfile,
): NamedAgentProfile {
  return {
    name: profile.name,
    description: profile.description,
    source: registration.sourceId,
    workspace_id: registration.workspaceKey,
    source_file: profile.sourcePath,
    pinned_model_alias: profile.modelAlias,
    routes: (registration.contribution.routes ?? [])
      .filter((candidate) => candidate.profile === profile.name)
      .map(toNamedAgentRoute)
      .toSorted((a, b) => a.id.localeCompare(b.id)),
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
