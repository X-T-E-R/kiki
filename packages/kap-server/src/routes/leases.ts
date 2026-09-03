import { z } from 'zod';

import { defineRoute } from '../middleware/defineRoute';
import { okEnvelope } from '../protocol/envelope';
import type { LeaseRegistry } from '../services/leaseRegistry';

interface LeaseRouteHost {
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { readonly id: string; readonly body: z.infer<typeof leaseRequestSchema> },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const leaseRequestSchema = z.object({ lease_id: z.string().min(1).optional() }).strict();
const leaseResponseSchema = z.object({
  lease_id: z.string().min(1),
  expires_at: z.number().int().nonnegative(),
});

export function registerLeaseRoutes(app: LeaseRouteHost, registry: LeaseRegistry): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/leases',
      body: leaseRequestSchema,
      success: { data: leaseResponseSchema },
      description: 'Create or renew a server lease',
      tags: ['meta'],
    },
    async (req, reply) => {
      const lease = registry.renew(req.body.lease_id);
      reply.send(okEnvelope({ lease_id: lease.leaseId, expires_at: lease.expiresAt }, req.id));
    },
  );
  app.post(route.path, route.options, route.handler as Parameters<LeaseRouteHost['post']>[2]);
}
