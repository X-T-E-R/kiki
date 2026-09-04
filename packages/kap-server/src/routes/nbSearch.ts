import { INbSearchService, type Scope } from '@moonshot-ai/agent-core-v2';
import { nbSearchCapabilitiesSchema, nbSearchTestStatusSchema } from '@moonshot-ai/protocol';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface NbSearchRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerNbSearchRoutes(app: NbSearchRouteHost, core: Scope): void {
  const capabilitiesRoute = defineRoute(
    {
      method: 'GET',
      path: '/nb-search/capabilities',
      success: { data: nbSearchCapabilitiesSchema },
      description: 'Get secret-free nb-search runtime capabilities',
      tags: ['nb-search'],
    },
    async (req, reply) => {
      const capabilities = await core.accessor.get(INbSearchService).capabilities();
      reply.send(okEnvelope(capabilities, req.id));
    },
  );
  app.get(
    capabilitiesRoute.path,
    capabilitiesRoute.options,
    capabilitiesRoute.handler as Parameters<NbSearchRouteHost['get']>[2],
  );

  const testRoute = defineRoute(
    {
      method: 'GET',
      path: '/nb-search/test',
      success: { data: nbSearchTestStatusSchema },
      description: 'Get local nb-search default readiness status',
      tags: ['nb-search'],
    },
    async (req, reply) => {
      const status = await core.accessor.get(INbSearchService).test();
      reply.send(okEnvelope(status, req.id));
    },
  );
  app.get(
    testRoute.path,
    testRoute.options,
    testRoute.handler as Parameters<NbSearchRouteHost['get']>[2],
  );
}
