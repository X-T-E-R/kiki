import { INbSearchService, type Scope } from '@kiki/agent-core-v2';
import { nbSearchCapabilitiesSchema, nbSearchTestStatusSchema, nbSearchManagedCredentialReadSchema, nbSearchManagedCredentialWriteSchema, nbSearchManagedCredentialViewSchema } from '@kiki/protocol';
import { ManagedCredentialError } from '@kiki/agent-core-v2/app/nbSearch/managedCredentials';

import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
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
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string; body: unknown }, reply: { send(payload: unknown): void }) => Promise<void> | void,
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

  const readRoute = defineRoute({
    method: 'POST', path: '/nb-search/credentials/read', body: nbSearchManagedCredentialReadSchema,
    success: { data: nbSearchManagedCredentialViewSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Read Kiki-managed nb-search credential status; reveal returns only a Kiki-managed value on explicit request.',
    tags: ['nb-search'],
  }, async (req, reply) => {
    try {
      reply.send(okEnvelope(await core.accessor.get(INbSearchService).readManagedCredential(req.body.instance_id, req.body.reveal), req.id));
    } catch {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Managed nb-search credential is unavailable or its binding changed.', req.id));
    }
  });
  app.post(readRoute.path, readRoute.options, readRoute.handler as Parameters<NbSearchRouteHost['post']>[2]);

  const writeRoute = defineRoute({
    method: 'POST', path: '/nb-search/credentials/write', body: nbSearchManagedCredentialWriteSchema,
    success: { data: nbSearchManagedCredentialViewSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.CONFIG_REVISION_CONFLICT]: {} },
    description: 'Store, overwrite or clear a Kiki-managed nb-search credential with optimistic concurrency.',
    tags: ['nb-search'],
  }, async (req, reply) => {
    try {
      reply.send(okEnvelope(await core.accessor.get(INbSearchService).writeManagedCredential(req.body.instance_id, req.body.value, req.body.expected_version, req.body.expected_binding), req.id));
    } catch (error) {
      const changed = error instanceof ManagedCredentialError && error.reason === 'changed';
      reply.send(errEnvelope(changed ? ErrorCode.CONFIG_REVISION_CONFLICT : ErrorCode.VALIDATION_FAILED,
        changed ? 'Managed nb-search credential changed; reload before saving.' : 'Managed nb-search credential could not be saved; check the configured slot and storage.', req.id));
    }
  });
  app.post(writeRoute.path, writeRoute.options, writeRoute.handler as Parameters<NbSearchRouteHost['post']>[2]);
}
