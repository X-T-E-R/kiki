import {
  IConfigService,
  IKosongConfigService,
  IModelCatalog,
  IModelCatalogMutationService,
  IOAuthService,
  IProviderDiscoveryService,
  IModelsDevImportService,
  isError2,
  ModelsDevImportErrors,
  type ProviderEntity,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  createModelRequestSchema,
  createModelResponseSchema,
  createProviderRequestSchema,
  createProviderResponseSchema,
  getCatalogProviderResponseSchema,
  getModelResponseSchema,
  getProviderResponseSchema,
  importCatalogProviderResponseSchema,
  importCustomRegistryResponseSchema,
  listCatalogProvidersResponseSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
  patchModelRequestSchema,
  patchProviderRequestSchema,
  patchProviderResponseSchema,
  providerCollectionActionBodySchema,
  refreshProviderModelsResponseSchema,
  revisionConflictDetailsSchema,
  setDefaultModelResponseSchema,
  type ProviderCollectionActionBody,
} from '../protocol/rest-modelCatalog';
import { parseActionSuffix } from './action-suffix';

interface ModelCatalogRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
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
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

interface StatusReply {
  code(status: number): StatusReply;
  send(payload?: unknown): unknown;
}

const providerIdParamSchema = z.object({
  provider_id: z.string().min(1),
});

const modelIdParamSchema = z.object({
  model_id: z.string().min(1),
});

const modelActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const providerActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const providerCollectionActionParamSchema = z.object({
  action: z.string().min(1),
});

const catalogIdParamSchema = z.object({
  catalog_id: z.string().min(1),
});

const revisionConflictErrors = {
  [ErrorCode.CONFIG_REVISION_CONFLICT]: { detailsSchema: revisionConflictDetailsSchema },
} as const;

async function loadCatalog(core: Scope): Promise<IModelCatalog> {
  await core.accessor.get(IConfigService).ready;
  await core.accessor.get(IKosongConfigService).ready;
  return core.accessor.get(IModelCatalog);
}

async function loadMutation(core: Scope): Promise<IModelCatalogMutationService> {
  await core.accessor.get(IConfigService).ready;
  await core.accessor.get(IKosongConfigService).ready;
  return core.accessor.get(IModelCatalogMutationService);
}

async function loadConfig(core: Scope): Promise<IConfigService> {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  await core.accessor.get(IKosongConfigService).ready;
  return config;
}

async function loadDiscovery(core: Scope): Promise<IProviderDiscoveryService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IProviderDiscoveryService);
}

async function loadOAuth(core: Scope): Promise<IOAuthService> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IOAuthService);
}

export function registerModelCatalogRoutes(app: ModelCatalogRouteHost, core: Scope): void {
  const listModelsRoute = defineRoute(
    {
      method: 'GET',
      path: '/models',
      success: { data: listModelsResponseSchema },
      description:
        'List configured models. `id` is the local alias, `remote_id` the exact model name sent upstream and `provider_id` the routed connection; the list is a read projection, never an edit carrier.',
      tags: ['models'],
    },
    async (req, reply) => {
      const items = await (await loadCatalog(core)).listModels();
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listModelsRoute.path,
    listModelsRoute.options,
    listModelsRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const getModelRoute = defineRoute(
    {
      method: 'GET',
      path: '/models/{model_id}',
      params: modelIdParamSchema,
      success: { data: getModelResponseSchema },
      errors: {
        [ErrorCode.MODEL_NOT_FOUND]: {},
      },
      description:
        'Get one configured model by its local alias: identity (local id, resolved provider, exact remote id), stored metadata and parameters, `revision` for the next PATCH, and any `issues` preventing it from running.',
      tags: ['models'],
      operationId: 'getModel',
    },
    async (req, reply) => {
      try {
        const model = await (await loadMutation(core)).readModel(req.params.model_id);
        reply.send(okEnvelope(model, req.id));
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    getModelRoute.path,
    getModelRoute.options,
    getModelRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const createModelRoute = defineRoute(
    {
      method: 'POST',
      path: '/models',
      body: createModelRequestSchema,
      success: { data: createModelResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
        [ErrorCode.MODEL_ALREADY_EXISTS]: {},
      },
      description:
        'Create one local model bound to a provider. `id` is the local alias and defaults to the `provider_id/remote_id` naming suggestion; `remote_id` is the exact upstream model name. Creating never overwrites an existing model. Answers 201 with the new entity.',
      tags: ['models'],
      operationId: 'createModel',
    },
    async (req, reply) => {
      await enqueueWrite(async () => {
        try {
          const model = await (await loadMutation(core)).createModel(req.body);
          (reply as unknown as StatusReply).code(201).send(okEnvelope(model, req.id));
        } catch (err) {
          if (sendMappedError(reply, req.id, err)) return;
          throw err;
        }
      });
    },
  );
  app.post(
    createModelRoute.path,
    createModelRoute.options,
    createModelRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const patchModelRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/models/{model_id}',
      params: modelIdParamSchema,
      body: patchModelRequestSchema,
      success: { data: getModelResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.MODEL_NOT_FOUND]: {},
        ...revisionConflictErrors,
      },
      description:
        'Partially update one model: only the listed fields change, every other stored field (including ones this client does not know) is preserved. `null` clears a field. Send `base_revision` from a previous read to get a structured 40941 conflict instead of overwriting a concurrent edit.',
      tags: ['models'],
      operationId: 'patchModel',
    },
    async (req, reply) => {
      await enqueueWrite(async () => {
        try {
          const model = await (await loadMutation(core)).updateModel(
            req.params.model_id,
            req.body,
          );
          reply.send(okEnvelope(model, req.id));
        } catch (err) {
          if (sendMappedError(reply, req.id, err)) return;
          throw err;
        }
      });
    },
  );
  app.patch(
    patchModelRoute.path,
    patchModelRoute.options,
    patchModelRoute.handler as Parameters<ModelCatalogRouteHost['patch']>[2],
  );

  const deleteModelRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/models/{model_id}',
      params: modelIdParamSchema,
      errors: {
        [ErrorCode.MODEL_NOT_FOUND]: {},
        ...revisionConflictErrors,
      },
      rawResponse: {
        204: { description: 'Model deleted.' },
      },
      description:
        'Delete one local model alias (204, no body). Other aliases — including other aliases of the same remote model — and the global pointers are left untouched.',
      tags: ['models'],
      operationId: 'deleteModel',
    },
    async (req, reply) => {
      await enqueueWrite(async () => {
        try {
          await (await loadMutation(core)).deleteModel(req.params.model_id);
          (reply as unknown as StatusReply).code(204).send();
        } catch (err) {
          if (sendMappedError(reply, req.id, err)) return;
          throw err;
        }
      });
    },
  );
  app.delete(
    deleteModelRoute.path,
    deleteModelRoute.options,
    deleteModelRoute.handler as Parameters<ModelCatalogRouteHost['delete']>[2],
  );

  const setDefaultModelRoute = defineRoute(
    {
      method: 'POST',
      path: '/models/{tail}',
      params: modelActionTailParamSchema,
      success: { data: setDefaultModelResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.MODEL_NOT_FOUND]: {},
      },
      description: 'Set the global default model alias',
      tags: ['models'],
      operationId: 'setDefaultModel',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['set_default'] as const,
          resourceLabel: 'model',
        });
        if (parsed.kind !== 'action') {
          const message =
            parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await (await loadCatalog(core)).setDefaultModel(parsed.id);
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.post(
    setDefaultModelRoute.path,
    setDefaultModelRoute.options,
    setDefaultModelRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const listProvidersRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers',
      success: { data: listProvidersResponseSchema },
      description:
        'List configured providers. No route on this surface ever returns a stored secret: authentication state is reported as `has_api_key`/`status`.',
      tags: ['providers'],
    },
    async (req, reply) => {
      const items = await (await loadCatalog(core)).listProviders();
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listProvidersRoute.path,
    listProvidersRoute.options,
    listProvidersRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const createProviderRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers',
      body: createProviderRequestSchema,
      success: { data: createProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_ALREADY_EXISTS]: {},
      },
      description:
        'Create a provider (type + credentials + optional initial models). A connection may be saved with zero models. `default_model` is the model half of this provider\'s default (stored as the `id/default_model` alias). When no global default_model is configured (fresh setup), it is seeded with the new provider default (or first) model; an existing default is never modified.',
      tags: ['providers'],
      operationId: 'createProvider',
    },
    async (req, reply) => {
      await enqueueWrite(async () => {
        try {
          const provider = await (await loadMutation(core)).createProvider(req.body);
          (reply as unknown as StatusReply).code(201).send(okEnvelope(provider, req.id));
        } catch (err) {
          if (sendMappedError(reply, req.id, err)) return;
          throw err;
        }
      });
    },
  );
  app.post(
    createProviderRoute.path,
    createProviderRoute.options,
    createProviderRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const patchProviderRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      body: patchProviderRequestSchema,
      success: { data: patchProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
        ...revisionConflictErrors,
      },
      description:
        'Partially update one provider connection. The body never carries a model list: models are their own entities, so saving a connection field can no longer rebuild or drop them. `base_url`/`default_model`/`request_identity` accept `null` to clear; `api_key` is tri-state (omitted keeps the stored key, "" clears it, any other value replaces it) and is never echoed back. The path id is the identity — connections are not renamed in place. OAuth-managed providers may update base_url/default_model/request_identity only; type and credential changes are rejected. Answers 200 with `{provider, revision}`.',
      tags: ['providers'],
      operationId: 'patchProvider',
    },
    async (req, reply) => {
      await enqueueWrite(async () => {
        try {
          const provider = await (await loadMutation(core)).updateProvider(
            req.params.provider_id,
            req.body,
          );
          reply.send(
            okEnvelope({ provider: stripRevision(provider), revision: provider.revision }, req.id),
          );
        } catch (err) {
          if (sendMappedError(reply, req.id, err)) return;
          throw err;
        }
      });
    },
  );
  app.patch(
    patchProviderRoute.path,
    patchProviderRoute.options,
    patchProviderRoute.handler as Parameters<ModelCatalogRouteHost['patch']>[2],
  );

  const refreshProvidersRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers:action',
      params: providerCollectionActionParamSchema,
      body: providerCollectionActionBodySchema.optional(),
      success: {
        data: z.union([
          refreshProviderModelsResponseSchema,
          importCatalogProviderResponseSchema,
          importCustomRegistryResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.CATALOG_IMPORT_INVALID]: {},
        [ErrorCode.REGISTRY_IMPORT_INVALID]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.CATALOG_ENTRY_NOT_FOUND]: {},
        [ErrorCode.CATALOG_UNAVAILABLE]: {},
      },
      description:
        'Provider collection actions. Use `:refresh` for all providers or `:refresh_oauth` for OAuth-backed providers only. Use `:import_catalog` to import a models.dev directory entry as a configured provider (201): the wire protocol and endpoint come from the catalog resolution (`base_url` overrides it; required when the entry resolves to needs-base-url), all catalogued models are written as aliases, and importing an id that already exists is a refresh — the provider entry and its aliases are rewritten from the catalog (OAuth-managed providers are rejected instead). `id` overrides the catalog id as the local provider id. Use `:import_registry` to import a models.dev-shaped private registry (api.json `url` + optional Bearer `api_key`, 201): every listed provider is written with a `source` blob so scheduled refreshes rediscover it, and re-importing the same URL removes providers that disappeared upstream (the URL is the stable registry identity). For both imports the global default_provider/default_model pointers are never modified — except that a default_model is seeded from the first imported model when none is configured at all (fresh setup).',
      tags: ['providers'],
      operationId: 'providerCollectionAction',
    },
    async (req, reply) => {
      const raw = req.params.action;
      const action = raw.startsWith(':') ? raw.slice(1) : raw;
      if (action === 'refresh_oauth') {
        const result = await (await loadOAuth(core)).refreshOAuthProviderModels();
        reply.send(okEnvelope(result, req.id));
        return;
      }
      if (action === 'refresh') {
        const result = await (await loadDiscovery(core)).refreshProviderModels({ scope: 'all' });
        reply.send(okEnvelope(result, req.id));
        return;
      }
      if (action === 'import_catalog') {
        await enqueueWrite(() => handleImportCatalog(req, reply, core));
        return;
      }
      if (action === 'import_registry') {
        await enqueueWrite(() => handleImportRegistry(req, reply, core));
        return;
      }
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${raw}`, req.id));
    },
  );
  app.post(
    refreshProvidersRoute.path,
    refreshProvidersRoute.options,
    refreshProvidersRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const refreshProviderRoute = defineRoute(
    {
      method: 'POST',
      path: '/providers/{tail}',
      params: providerActionTailParamSchema,
      success: { data: refreshProviderModelsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description: 'Refresh model metadata for a single provider',
      tags: ['providers'],
      operationId: 'refreshProvider',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['refresh'] as const,
          resourceLabel: 'provider',
        });
        if (parsed.kind !== 'action') {
          const message =
            parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const result = await (await loadDiscovery(core)).refreshProviderModels({
          providerId: parsed.id,
        });
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.post(
    refreshProviderRoute.path,
    refreshProviderRoute.options,
    refreshProviderRoute.handler as Parameters<ModelCatalogRouteHost['post']>[2],
  );

  const getProviderRoute = defineRoute(
    {
      method: 'GET',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      success: { data: getProviderResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      description:
        'Get one configured provider with the `revision` its next PATCH must carry. The stored `api_key` is never returned.',
      tags: ['providers'],
      operationId: 'getProvider',
    },
    async (req, reply) => {
      try {
        const { provider_id } = req.params;
        const provider = await (await loadMutation(core)).readProvider(provider_id);
        reply.send(okEnvelope(provider, req.id));
      } catch (err) {
        if (sendMappedError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    getProviderRoute.path,
    getProviderRoute.options,
    getProviderRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const deleteProviderRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/providers/{provider_id}',
      params: providerIdParamSchema,
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PROVIDER_OAUTH_MANAGED]: {},
        [ErrorCode.PROVIDER_NOT_FOUND]: {},
      },
      rawResponse: {
        204: { description: 'Provider deleted.' },
      },
      description:
        'Delete a provider and all of its model aliases (204, no body). The global default_provider/default_model pointers are left untouched — they are the user\'s settings, not this endpoint\'s to garbage-collect. OAuth-managed providers are rejected: log out via /oauth/logout instead.',
      tags: ['providers'],
      operationId: 'deleteProvider',
    },
    async (req, reply) => {
      await enqueueWrite(async () => {
        try {
          await (await loadMutation(core)).deleteProvider(req.params.provider_id);
          (reply as unknown as StatusReply).code(204).send();
        } catch (err) {
          if (sendMappedError(reply, req.id, err)) return;
          throw err;
        }
      });
    },
  );
  app.delete(
    deleteProviderRoute.path,
    deleteProviderRoute.options,
    deleteProviderRoute.handler as Parameters<ModelCatalogRouteHost['delete']>[2],
  );

  const listCatalogProvidersRoute = defineRoute(
    {
      method: 'GET',
      path: '/catalog/providers',
      success: { data: listCatalogProvidersResponseSchema },
      errors: { [ErrorCode.CATALOG_UNAVAILABLE]: {} },
      description:
        'Browse the models.dev directory (server-proxied, 10-minute in-memory cache, built-in snapshot fallback). Entries the server cannot import carry `rejected: true` with a machine-readable `reject_reason`; entries with `needs_base_url: true` require a base URL at import time. Items keep the upstream directory order.',
      tags: ['providers'],
      operationId: 'listCatalogProviders',
    },
    async (req, reply) => {
      try {
        const items = await core.accessor.get(IModelsDevImportService).listModelsDevProviders();
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        if (sendModelsDevImportError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    listCatalogProvidersRoute.path,
    listCatalogProvidersRoute.options,
    listCatalogProvidersRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );

  const getCatalogProviderRoute = defineRoute(
    {
      method: 'GET',
      path: '/catalog/providers/{catalog_id}',
      params: catalogIdParamSchema,
      success: { data: getCatalogProviderResponseSchema },
      errors: {
        [ErrorCode.CATALOG_ENTRY_NOT_FOUND]: {},
        [ErrorCode.CATALOG_UNAVAILABLE]: {},
      },
      description: 'Get one models.dev directory entry by catalog id.',
      tags: ['providers'],
      operationId: 'getCatalogProvider',
    },
    async (req, reply) => {
      try {
        const { catalog_id } = req.params;
        const item = await core.accessor.get(IModelsDevImportService).getModelsDevProvider(catalog_id);
        reply.send(okEnvelope(item, req.id));
      } catch (err) {
        if (sendModelsDevImportError(reply, req.id, err)) return;
        throw err;
      }
    },
  );
  app.get(
    getCatalogProviderRoute.path,
    getCatalogProviderRoute.options,
    getCatalogProviderRoute.handler as Parameters<ModelCatalogRouteHost['get']>[2],
  );
}

function stripRevision(provider: ProviderEntity): Record<string, unknown> {
  const { revision: _revision, ...rest } = provider;
  return rest;
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): boolean {
  if (!isError2(err)) return false;
  const mapped = ENGINE_ERROR_CODES[err.code];
  if (mapped === undefined) return false;
  reply.send({
    code: mapped,
    msg: err.message,
    data: null,
    request_id: requestId,
    details: err.details,
    stack: err.stack,
  });
  return true;
}

const ENGINE_ERROR_CODES: Readonly<Record<string, number>> = {
  'provider.not_found': ErrorCode.PROVIDER_NOT_FOUND,
  'model.not_found': ErrorCode.MODEL_NOT_FOUND,
  'provider.already_exists': ErrorCode.PROVIDER_ALREADY_EXISTS,
  'model.already_exists': ErrorCode.MODEL_ALREADY_EXISTS,
  'model_catalog.revision_conflict': ErrorCode.CONFIG_REVISION_CONFLICT,
  'provider.oauth_managed': ErrorCode.PROVIDER_OAUTH_MANAGED,
  'config.invalid': ErrorCode.VALIDATION_FAILED,
};

const MODELS_DEV_IMPORT_ERROR_CODES: Record<string, number> = {
  [ModelsDevImportErrors.codes.CATALOG_UNAVAILABLE]: ErrorCode.CATALOG_UNAVAILABLE,
  [ModelsDevImportErrors.codes.CATALOG_ENTRY_NOT_FOUND]: ErrorCode.CATALOG_ENTRY_NOT_FOUND,
  [ModelsDevImportErrors.codes.CATALOG_IMPORT_INVALID]: ErrorCode.CATALOG_IMPORT_INVALID,
  [ModelsDevImportErrors.codes.REGISTRY_IMPORT_INVALID]: ErrorCode.REGISTRY_IMPORT_INVALID,
  [ModelsDevImportErrors.codes.PROVIDER_OAUTH_MANAGED]: ErrorCode.PROVIDER_OAUTH_MANAGED,
};

function sendModelsDevImportError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): boolean {
  if (!isError2(err)) return false;
  const numeric = MODELS_DEV_IMPORT_ERROR_CODES[err.code];
  if (numeric === undefined) return false;
  reply.send(errEnvelope(numeric, err.message, requestId, err.stack));
  return true;
}

async function handleImportCatalog(
  req: { id: string; body: ProviderCollectionActionBody | undefined },
  reply: { send(payload: unknown): unknown },
  core: Scope,
): Promise<void> {
  try {
    const body = req.body;
    if (body?.catalog_id === undefined) {
      reply.send(
        errEnvelope(
          ErrorCode.VALIDATION_FAILED,
          'catalog_id is required for :import_catalog',
          req.id,
        ),
      );
      return;
    }

    const result = await core.accessor.get(IModelsDevImportService).importModelsDevProvider({
      catalogId: body.catalog_id,
      id: body.id,
      apiKey: body.api_key,
      baseUrl: body.base_url,
    });
    (reply as unknown as StatusReply)
      .code(201)
      .send(
        okEnvelope(
          { provider: result.provider, models_imported: result.modelsImported },
          req.id,
        ),
      );
  } catch (err) {
    if (sendModelsDevImportError(reply, req.id, err)) return;
    throw err;
  }
}

async function handleImportRegistry(
  req: { id: string; body: ProviderCollectionActionBody | undefined },
  reply: { send(payload: unknown): unknown },
  core: Scope,
): Promise<void> {
  try {
    const body = req.body;
    if (body?.url === undefined) {
      reply.send(
        errEnvelope(ErrorCode.VALIDATION_FAILED, 'url is required for :import_registry', req.id),
      );
      return;
    }
    const result = await core.accessor.get(IModelsDevImportService).importCustomRegistry({
      url: body.url,
      apiKey: body.api_key,
    });
    (reply as unknown as StatusReply)
      .code(201)
      .send(
        okEnvelope(
          { providers: result.providers, models_imported: result.modelsImported },
          req.id,
        ),
      );
  } catch (err) {
    if (sendModelsDevImportError(reply, req.id, err)) return;
    throw err;
  }
}

let writeChain: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
