import {
  computeUpdateStatus,
  ErrorCodes as DomainErrorCodes,
  IPluginService,
  PluginErrors,
  isError2,
  nonemptyMarketplaceSource,
  parsePluginMarketplace,
  readPluginMarketplace,
  withLatestVersions,
  type MarketplaceLocation,
  type PluginMarketplace,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  installPluginRequestSchema,
  listPluginsResponseSchema,
  pluginInfoParamSchema,
  pluginInfoSchema,
  pluginMarketplaceResponseSchema,
  pluginIdParamSchema,
  pluginSummarySchema,
  type PluginMarketplaceEntryWire,
} from '../protocol/rest-plugin';
import { parseActionSuffix } from './action-suffix';

interface PluginsRouteHost {
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
}

const PLUGIN_ACTIONS = ['enable', 'disable', 'remove'] as const;

const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(...args: Parameters<typeof fetch>): Promise<Response> {
  const [input, init] = args;
  return fetch(input, { ...init, signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS) });
}

export interface PluginsRouteOptions {
  /**
   * Catalog URL resolver, invoked per request so a config.toml or env change is
   * reflected without a restart. `undefined` means no marketplace is configured
   * and the route returns `{ configured: false }` without fetching.
   */
  readonly marketplaceUrl: () => string | undefined;
  readonly fetchImpl?: typeof fetch;
}

export function registerPluginsRoutes(
  app: PluginsRouteHost,
  core: Scope,
  opts: PluginsRouteOptions,
): void {
  const marketplaceRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins/marketplace',
      success: { data: pluginMarketplaceResponseSchema },
      errors: {},
      description: 'List the plugin marketplace catalog merged with live install state',
      tags: ['plugins'],
      operationId: 'listPluginMarketplace',
    },
    async (req, reply) => {
      const source = nonemptyMarketplaceSource(opts.marketplaceUrl());
      if (source === undefined) {
        reply.send(okEnvelope({ configured: false, entries: [] }, req.id));
        return;
      }
      const fetchImpl = opts.fetchImpl ?? fetchWithTimeout;
      let read: { raw: string; location: MarketplaceLocation };
      try {
        read = await readPluginMarketplace({
          source,
          workDir: process.cwd(),
          fetchImpl,
        });
      } catch (error) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            `Plugin marketplace is unreachable: ${error instanceof Error ? error.message : String(error)}`,
            req.id,
          ),
        );
        return;
      }
      let marketplace: PluginMarketplace;
      try {
        marketplace = parsePluginMarketplace(read.raw, read.location);
      } catch (error) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            `Plugin marketplace returned an invalid catalog: ${error instanceof Error ? error.message : String(error)}`,
            req.id,
          ),
        );
        return;
      }
      marketplace = await withLatestVersions(marketplace, fetchImpl);
      const installed = await core.accessor.get(IPluginService).listPlugins();
      const byId = new Map(installed.map((p) => [p.id, p]));
      const entries: PluginMarketplaceEntryWire[] = [];
      for (const entry of marketplace.plugins) {
        const record = byId.get(entry.id);
        const installedInfo =
          record === undefined
            ? undefined
            : { enabled: record.enabled, version: record.version };
        const updateAvailable =
          computeUpdateStatus(entry.version, record?.version, record !== undefined).kind ===
          'update';
        entries.push({
          id: entry.id,
          tier: entry.tier ?? 'third-party',
          displayName: entry.displayName,
          description: entry.description,
          homepage: entry.homepage,
          keywords: entry.keywords === undefined ? undefined : [...entry.keywords],
          version: entry.version,
          source: entry.source,
          installed: installedInfo,
          updateAvailable: updateAvailable ? true : undefined,
        });
      }
      reply.send(okEnvelope({ configured: true, source: read.location.resolved, entries }, req.id));
    },
  );
  app.get(
    marketplaceRoute.path,
    marketplaceRoute.options,
    marketplaceRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins',
      success: { data: listPluginsResponseSchema },
      errors: {},
      description: 'List installed plugins',
      tags: ['plugins'],
      operationId: 'listPlugins',
    },
    async (req, reply) => {
      const plugins = await core.accessor.get(IPluginService).listPlugins();
      reply.send(okEnvelope({ plugins }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  const infoRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins/{plugin_id}',
      params: pluginInfoParamSchema,
      success: { data: pluginInfoSchema },
      errors: {
        [ErrorCode.PLUGIN_NOT_FOUND]: {},
      },
      description: 'Get one installed plugin including its manifest and MCP servers',
      tags: ['plugins'],
      operationId: 'getPlugin',
    },
    async (req, reply) => {
      try {
        const plugin = await core.accessor
          .get(IPluginService)
          .getPluginInfo({ id: req.params.plugin_id });
        reply.send(okEnvelope(plugin, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.get(
    infoRoute.path,
    infoRoute.options,
    infoRoute.handler as Parameters<PluginsRouteHost['get']>[2],
  );

  const installRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins',
      body: installPluginRequestSchema,
      success: { data: pluginSummarySchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: 'Install a plugin from a local path, zip URL, or GitHub repo',
      tags: ['plugins'],
      operationId: 'installPlugin',
    },
    async (req, reply) => {
      try {
        const plugin = await core.accessor.get(IPluginService).installPlugin(req.body);
        reply.send(okEnvelope(plugin, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(
    installRoute.path,
    installRoute.options,
    installRoute.handler as Parameters<PluginsRouteHost['post']>[2],
  );

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins/{tail}',
      params: pluginIdParamSchema,
      success: { data: z.object({ ok: z.literal(true) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PLUGIN_NOT_FOUND]: {},
      },
      description: 'Enable, disable, or remove an installed plugin',
      tags: ['plugins'],
      operationId: 'pluginAction',
    },
    async (req, reply) => {
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: PLUGIN_ACTIONS,
        resourceLabel: 'plugin',
      });
      if (parsed.kind !== 'action') {
        const message =
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.tail}`;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      const plugins = core.accessor.get(IPluginService);
      try {
        switch (parsed.action) {
          case 'enable':
            await plugins.setPluginEnabled({ id: parsed.id, enabled: true });
            break;
          case 'disable':
            await plugins.setPluginEnabled({ id: parsed.id, enabled: false });
            break;
          case 'remove':
            await plugins.removePlugin({ id: parsed.id });
            break;
        }
        reply.send(okEnvelope({ ok: true as const }, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(
    actionRoute.path,
    actionRoute.options,
    actionRoute.handler as Parameters<PluginsRouteHost['post']>[2],
  );
}

const PLUGIN_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  [PluginErrors.codes.PLUGIN_NOT_FOUND]: ErrorCode.PLUGIN_NOT_FOUND,
  [PluginErrors.codes.PLUGIN_LOAD_FAILED]: ErrorCode.VALIDATION_FAILED,
  [DomainErrorCodes.VALIDATION_FAILED]: ErrorCode.VALIDATION_FAILED,
  [DomainErrorCodes.FS_PATH_NOT_FOUND]: ErrorCode.FS_PATH_NOT_FOUND,
};

function mapPluginError(error: unknown, requestId: string) {
  const mapped = isError2(error) ? PLUGIN_ERROR_MAP[error.code] : undefined;
  if (mapped !== undefined && isError2(error)) {
    return errEnvelope(mapped, error.message, requestId, error.stack);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
    requestId,
    error instanceof Error ? error.stack : undefined,
  );
}
