/**
 * `/agents` REST route — read-only named agent-profile catalog projection.
 *
 * Projects the live App-scope profile registry, including global built-ins and
 * every materialized workspace contribution. File-backed profiles expose their
 * source path; route sidecars stay nested under their base profile with their
 * pinned model alias and source path.
 */

import { IAgentProfileRegistry, type Scope } from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  listNamedAgentProfilesResponseSchema,
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
}

export function registerAgentProfilesRoute(app: AgentProfilesRouteHost, core: Scope): void {
  const route = defineRoute(
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
        registration.contribution.profiles.map((profile): NamedAgentProfile => ({
          name: profile.name,
          description: profile.description,
          source: registration.sourceId,
          workspace_id: registration.workspaceKey,
          source_file: profile.sourcePath,
          pinned_model_alias: profile.modelAlias,
          routes: (registration.contribution.routes ?? [])
            .filter((candidate) => candidate.profile === profile.name)
            .map((candidate) => ({
              id: candidate.id,
              model_alias: candidate.modelAlias,
              source_file: candidate.path,
            }))
            .toSorted((a, b) => a.id.localeCompare(b.id)),
        })),
      ).toSorted((a, b) =>
        a.name.localeCompare(b.name)
        || a.source.localeCompare(b.source)
        || (a.workspace_id ?? '').localeCompare(b.workspace_id ?? '')
      );
      reply.send(okEnvelope({ items }, req.id));
    },
  );

  app.get(
    route.path,
    route.options,
    route.handler as Parameters<AgentProfilesRouteHost['get']>[2],
  );
}
