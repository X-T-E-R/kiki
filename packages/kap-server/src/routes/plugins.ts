import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  computeUpdateStatus,
  ErrorCodes as DomainErrorCodes,
  IPluginService,
  IPluginHostService,
  IPluginSettingsService,
  ISessionIndex,
  IAtomicDocumentStore,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  panelDocument,
  relevantPlugins,
  pluginRelevanceSignalsSchema,
  PluginErrors,
  isError2,
  nonemptyMarketplaceSource,
  parseManifest,
  parsePluginMarketplace,
  readPluginMarketplace,
  withLatestVersions,
  type MarketplaceLocation,
  type PluginMarketplace,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';
import {
  pluginSettingsResponseSchema, pluginSettingsPatchSchema, pluginPrerequisiteInstallSchema,
  pluginPanelSummarySchema, pluginPanelDocumentSchema, pluginPanelBridgeRequestSchema, pluginPanelBridgeResponseSchema,
} from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { authenticatedForwardHeaders } from '../middleware/auth';
import { ErrorCode } from '../protocol/error-codes';
import {
  installPluginRequestSchema,
  listPluginsResponseSchema,
  pluginInfoParamSchema,
  pluginInfoSchema,
  pluginMarketplaceResponseSchema,
  pluginMarketplaceEntrySchema,
  pluginInstallPlanSchema,
  pluginPreviewRequestSchema,
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
  inject(input: { method: 'POST'; url: string; headers: Record<string, string>; payload: unknown }): Promise<{ json(): unknown }>;
}

const PLUGIN_ACTIONS = ['enable', 'disable', 'remove', 'rollback', 'install-prerequisite', 'dismiss-recommendation'] as const;

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
  readonly serverToken: () => string;
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
      const localIcons = await localOfficialIcons(marketplace, read.location);
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
          icon: entry.icon ?? localIcons.get(entry.id),
          keywords: entry.keywords === undefined ? undefined : [...entry.keywords],
          relevance: entry.relevance,
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

  const recommendationsRoute = defineRoute(
    {
      method: 'POST', path: '/plugins/recommendations/match', body: pluginRelevanceSignalsSchema,
      success: { data: z.object({ entries: z.array(pluginMarketplaceEntrySchema) }) },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Match local task signals only against official and curated catalog entries', tags: ['plugins'],
    },
    async (req, reply) => {
      try {
        const source = nonemptyMarketplaceSource(opts.marketplaceUrl());
        if (source === undefined) { reply.send(okEnvelope({ entries: [] }, req.id)); return; }
        const { raw, location } = await readPluginMarketplace({ source, workDir: process.cwd(), fetchImpl: opts.fetchImpl ?? fetchWithTimeout });
        const catalog = parsePluginMarketplace(raw, location);
        const installed = new Set((await core.accessor.get(IPluginService).listPlugins()).map((item) => item.id));
        const dismissed = new Set((await core.accessor.get(IAtomicDocumentStore).get<readonly string[]>('plugin-relevance', 'dismissed')) ?? []);
        const entries = relevantPlugins(catalog.plugins, req.body, installed, dismissed).map((item) => ({
          id: item.id, tier: item.tier!, displayName: item.displayName, description: item.description,
          homepage: item.homepage, icon: item.icon, keywords: item.keywords === undefined ? undefined : [...item.keywords],
          relevance: item.relevance, version: item.version, source: item.source,
        }));
        reply.send(okEnvelope({ entries }, req.id));
      } catch (error) { reply.send(mapPluginError(error, req.id)); }
    },
  );
  app.post(recommendationsRoute.path, recommendationsRoute.options, recommendationsRoute.handler as Parameters<PluginsRouteHost['post']>[2]);

  const projectRecommendationsRoute = defineRoute(
    {
      method: 'GET', path: '/workspaces/{workspace_id}/plugin-recommendations',
      params: z.object({ workspace_id: z.string().min(1) }),
      success: { data: z.object({ trusted: z.boolean(), recommendations: z.array(z.object({ id: z.string(), source: z.string() })) }) },
      errors: { [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Read project plugin recommendations only after the workspace is trusted', tags: ['plugins'],
    },
    async (req, reply) => {
      const record = await core.accessor.get(IWorkspaceService).get(req.params.workspace_id);
      if (record === undefined) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Workspace does not exist', req.id));
        return;
      }
      try {
        const workspace = await core.accessor.get(IWorkspaceInstanceManager)
          .getOrCreate({ workspaceId: record.id, root: record.root });
        if (!await workspace.program.trust.get()) {
          reply.send(okEnvelope({ trusted: false, recommendations: [] }, req.id));
          return;
        }
        let content;
        try {
          content = await workspace.program.fs.read({ path: '.kiki/plugins.json', offset: 0, length: 32_768, encoding: 'utf-8' });
        } catch (error) {
          if (isError2(error) && error.code === DomainErrorCodes.FS_PATH_NOT_FOUND) {
            reply.send(okEnvelope({ trusted: true, recommendations: [] }, req.id));
            return;
          }
          throw error;
        }
        if (content.truncated || content.encoding !== 'utf-8') throw new Error('Project plugin recommendation file exceeds 32 KiB or is not UTF-8');
        const parsed = z.object({ recommendations: z.array(z.object({ id: z.string().min(1).max(64), source: z.string().min(1).max(2048) }).strict()).max(50) }).strict()
          .parse(JSON.parse(content.content));
        reply.send(okEnvelope({ trusted: true, recommendations: parsed.recommendations }, req.id));
      } catch (error) { reply.send(mapPluginError(error, req.id)); }
    },
  );
  app.get(projectRecommendationsRoute.path, projectRecommendationsRoute.options, projectRecommendationsRoute.handler as Parameters<PluginsRouteHost['get']>[2]);

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

  const panelListRoute = defineRoute(
    {
      method: 'GET', path: '/plugins/panels',
      success: { data: z.object({ panels: z.array(pluginPanelSummarySchema) }) },
      errors: {}, description: 'List enabled sandboxed plugin panels', tags: ['plugins'],
    },
    async (req, reply) => {
      const plugins = core.accessor.get(IPluginService);
      const installed = (await plugins.listPlugins()).filter((item) => item.enabled && item.state === 'ok');
      const panels = (await Promise.all(installed.map((item) => plugins.getPluginInfo({ id: item.id }))))
        .flatMap((info) => (info.manifest?.kiki?.panels ?? []).map((panel) => ({
          pluginId: info.id, id: panel.id, label: panel.label, slot: panel.slot,
        })));
      reply.send(okEnvelope({ panels }, req.id));
    },
  );
  app.get(panelListRoute.path, panelListRoute.options, panelListRoute.handler as Parameters<PluginsRouteHost['get']>[2]);

  const commandsRoute = defineRoute(
    {
      method: 'GET', path: '/plugins/commands',
      success: { data: z.object({ commands: z.array(z.object({ pluginId: z.string(), name: z.string(), description: z.string(), prompt: z.string() })) }) },
      errors: {}, description: 'List enabled plugin commands for the command palette', tags: ['plugins'],
    },
    async (req, reply) => {
      const commands = (await core.accessor.get(IPluginService).listPluginCommands()).map(({ pluginId, name, description, body }) => ({
        pluginId, name, description, prompt: body,
      }));
      reply.send(okEnvelope({ commands }, req.id));
    },
  );
  app.get(commandsRoute.path, commandsRoute.options, commandsRoute.handler as Parameters<PluginsRouteHost['get']>[2]);

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

  const panelParams = z.object({ plugin_id: z.string().min(1), panel_id: z.string().min(1) });
  const panelDocRoute = defineRoute(
    {
      method: 'GET', path: '/plugins/{plugin_id}/panels/{panel_id}/document', params: panelParams,
      success: { data: pluginPanelDocumentSchema }, errors: { [ErrorCode.PLUGIN_NOT_FOUND]: {} },
      description: 'Fetch CSP-restricted HTML for an opaque-origin sandbox iframe srcdoc', tags: ['plugins'],
    },
    async (req, reply) => {
      try {
        const info = await core.accessor.get(IPluginService).getPluginInfo({ id: req.params.plugin_id });
        const panel = info.manifest?.kiki?.panels?.find((item) => item.id === req.params.panel_id);
        if (!info.enabled || info.state !== 'ok' || panel === undefined) {
          reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, 'Panel is not enabled', req.id));
          return;
        }
        const html = await panelDocument(info.root, panel);
        reply.send(okEnvelope({ html, sandbox: 'allow-scripts' as const }, req.id));
      } catch (error) { reply.send(mapPluginError(error, req.id)); }
    },
  );
  app.get(panelDocRoute.path, panelDocRoute.options, panelDocRoute.handler as Parameters<PluginsRouteHost['get']>[2]);

  const panelBridgeRoute = defineRoute(
    {
      method: 'POST', path: '/plugins/{plugin_id}/panels/{panel_id}/bridge', params: panelParams,
      body: pluginPanelBridgeRequestSchema, success: { data: pluginPanelBridgeResponseSchema },
      errors: { [ErrorCode.PLUGIN_NOT_FOUND]: {}, [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
      description: 'Relay only a current-session summary, plain-text message, or this plugin backend action', tags: ['plugins'],
    },
    async (req, reply) => {
      try {
        const info = await core.accessor.get(IPluginService).getPluginInfo({ id: req.params.plugin_id });
        if (!info.enabled || info.state !== 'ok' || !info.manifest?.kiki?.panels?.some((item) => item.id === req.params.panel_id)) {
          reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, 'Panel is not enabled', req.id));
          return;
        }
        if (req.body.method === 'plugin.call') {
          const result = await core.accessor.get(IPluginHostService).requestPanel(info.id, req.params.panel_id, req.body.action, req.body.args);
          reply.send(okEnvelope({ result }, req.id));
          return;
        }
        const summary = await core.accessor.get(ISessionIndex).get(req.body.session_id);
        if (summary === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id));
          return;
        }
        if (req.body.method === 'session.summary') {
          reply.send(okEnvelope({ result: {
            id: summary.id, title: summary.title, lastPrompt: summary.lastPrompt?.slice(0, 500),
            createdAt: summary.createdAt, updatedAt: summary.updatedAt,
          } }, req.id));
          return;
        }
        if (req.body.method === 'session.sendMessage') {
          const response = await app.inject({
            method: 'POST', url: `/api/sessions/${encodeURIComponent(summary.id)}/prompts`,
            headers: {
              host: typeof req.headers['host'] === 'string' ? req.headers['host'] : '127.0.0.1',
              ...authenticatedForwardHeaders(req),
              'x-kiki-connection-grant': typeof req.headers['x-kiki-connection-grant'] === 'string' ? req.headers['x-kiki-connection-grant'] : '',
            },
            payload: { content: [{ type: 'text', text: req.body.text }] },
          });
          const result = response.json() as { code: number; data: unknown };
          if (result.code !== 0) { reply.send(result); return; }
          reply.send(okEnvelope({ result: result.data }, req.id));
          return;
        }
      } catch (error) { reply.send(mapPluginError(error, req.id)); }
    },
  );
  app.post(panelBridgeRoute.path, panelBridgeRoute.options, panelBridgeRoute.handler as Parameters<PluginsRouteHost['post']>[2]);

  const settingsGetRoute = defineRoute(
    {
      method: 'GET', path: '/plugins/{plugin_id}/settings', params: pluginInfoParamSchema,
      success: { data: pluginSettingsResponseSchema },
      errors: { [ErrorCode.PLUGIN_NOT_FOUND]: {} },
      description: 'Inspect own plugin settings without returning secret values',
      tags: ['plugins'], operationId: 'getPluginSettings',
    },
    async (req, reply) => {
      try {
        const view = await core.accessor.get(IPluginSettingsService).inspect(req.params.plugin_id);
        reply.send(okEnvelope(view, req.id));
      } catch (error) { reply.send(mapPluginError(error, req.id)); }
    },
  );
  app.get(settingsGetRoute.path, settingsGetRoute.options, settingsGetRoute.handler as Parameters<PluginsRouteHost['get']>[2]);

  const settingsPatchRoute = defineRoute(
    {
      method: 'POST', path: '/plugins/{plugin_id}/settings', params: pluginInfoParamSchema,
      body: pluginSettingsPatchSchema, success: { data: pluginSettingsResponseSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.PLUGIN_NOT_FOUND]: {} },
      description: 'Save plugin-owned settings; declared secret values stay in Kiki credentials',
      tags: ['plugins'], operationId: 'setPluginSettings',
    },
    async (req, reply) => {
      try {
        const view = await core.accessor.get(IPluginSettingsService).update({ pluginId: req.params.plugin_id, values: req.body.values });
        reply.send(okEnvelope(view, req.id));
      } catch (error) { reply.send(mapPluginError(error, req.id)); }
    },
  );
  app.post(settingsPatchRoute.path, settingsPatchRoute.options, settingsPatchRoute.handler as Parameters<PluginsRouteHost['post']>[2]);

  const previewRoute = defineRoute(
    {
      method: 'POST',
      path: '/plugins:preview',
      body: pluginPreviewRequestSchema,
      success: { data: pluginInstallPlanSchema },
      errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.FS_PATH_NOT_FOUND]: {} },
      description: 'Inspect contributions, permission changes, and content fingerprint before installation',
      tags: ['plugins'],
      operationId: 'previewPlugin',
    },
    async (req, reply) => {
      try {
        const plan = await core.accessor.get(IPluginService).previewPlugin(req.body);
        reply.send(okEnvelope(plan, req.id));
      } catch (error) {
        reply.send(mapPluginError(error, req.id));
      }
    },
  );
  app.post(previewRoute.path, previewRoute.options, previewRoute.handler as Parameters<PluginsRouteHost['post']>[2]);

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
      body: z.union([z.object({ deleteData: z.boolean().optional() }).strict(), pluginPrerequisiteInstallSchema]).optional(),
      success: { data: z.object({ ok: z.literal(true) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PLUGIN_NOT_FOUND]: {},
      },
      description: 'Enable, disable, remove, roll back, or consent to install a plugin prerequisite',
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
            await plugins.removePlugin({ id: parsed.id, deleteData: req.body && 'deleteData' in req.body ? req.body.deleteData : undefined });
            break;
          case 'rollback':
            await plugins.rollbackPlugin({ id: parsed.id });
            break;
          case 'install-prerequisite': {
            const consent = pluginPrerequisiteInstallSchema.safeParse(req.body);
            if (!consent.success) {
              reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, consent.error.message, req.id));
              return;
            }
            await core.accessor.get(IPluginHostService).installPrerequisite(parsed.id, consent.data.id, true);
            break;
          }
          case 'dismiss-recommendation':
            await core.accessor.get(IAtomicDocumentStore).update<readonly string[]>('plugin-relevance', 'dismissed',
              (current) => [...new Set([...(current ?? []), parsed.id])]);
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

async function localOfficialIcons(
  marketplace: PluginMarketplace,
  location: MarketplaceLocation,
): Promise<ReadonlyMap<string, string>> {
  const icons = new Map<string, string>();
  if (location.kind !== 'local') return icons;
  await Promise.all(marketplace.plugins.map(async (entry) => {
    if (entry.tier !== 'official' || entry.icon !== undefined) return;
    if (!isAbsolute(entry.source) || !(await isDirectory(entry.source))) return;
    const parsed = await parseManifest(entry.source).catch(() => undefined);
    const icon = parsed?.manifest?.icon;
    if (icon !== undefined) icons.set(entry.id, icon);
  }));
  return icons;
}

async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isDirectory() === true;
}
