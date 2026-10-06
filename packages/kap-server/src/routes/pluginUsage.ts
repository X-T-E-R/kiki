import { IBootstrapService, IPluginService, IPluginUsageService, ISessionIndex, IWorkspaceService, type Scope, type Workspace } from '@kiki/agent-core-v2';
import { pluginUsageTargetSchema, pluginUsageRequestSchema, pluginUsageResponseSchema, type PluginUsageTarget, type PluginUsageResponse } from '@kiki/protocol';
import { defineRoute } from '../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';

interface Host {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
}
export async function resolvePluginUsageWorkspace(core: Scope, target: PluginUsageTarget): Promise<Workspace | undefined> {
  const workspaceId = 'workspace_id' in target ? target.workspace_id : (await core.accessor.get(ISessionIndex).get(target.session_id))?.workspaceId;
  return workspaceId === undefined ? undefined : core.accessor.get(IWorkspaceService).get(workspaceId);
}
export async function readPluginUsage(core: Scope, workspace: Workspace): Promise<PluginUsageResponse> {
  const usage = core.accessor.get(IPluginUsageService);
  const plugins = core.accessor.get(IPluginService);
  const bootstrap = core.accessor.get(IBootstrapService);
  const [snapshot, installed] = await Promise.all([usage.read(workspace.id), plugins.listPlugins()]);
  const items = await Promise.all(installed.map(async (plugin) => {
    const selected = snapshot.overrides[plugin.id];
    const info = await plugins.getPluginInfo({ id: plugin.id });
    const extension = info.manifest?.kiki;
    return { id: plugin.id, displayName: plugin.displayName, version: plugin.version, icon: plugin.icon,
      home_enabled: plugin.enabled, state: plugin.state, override: selected === undefined ? 'inherit' as const : selected ? 'on' as const : 'off' as const,
      effective: plugin.enabled && plugin.state === 'ok' && selected !== false,
      reason: plugin.state !== 'ok' ? 'invalid_plugin' as const : !plugin.enabled ? 'home_disabled' as const : selected === false ? 'workspace_disabled' as const : undefined,
      app_service: extension !== undefined && 'activation' in extension && extension.activation === 'app',
      skillCount: plugin.skillCount, mcpServerCount: plugin.mcpServerCount };
  }));
  return { home_id: bootstrap.spaceId ?? 'main', target: { workspace_id: workspace.id, name: workspace.name, root: workspace.root },
    revision: snapshot.revision, apply_state: snapshot.applyState, errors: [...snapshot.errors], plugins: items };
}
export function registerPluginUsageRoutes(app: Host, core: Scope): void {
  const errors = {
    [ErrorCode.VALIDATION_FAILED]: {},
    [ErrorCode.PLUGIN_NOT_FOUND]: {},
    [ErrorCode.CAPABILITY_UNSUPPORTED]: {},
  };
  const read = defineRoute({ method: 'GET', path: '/plugins/usage', querystring: pluginUsageTargetSchema, success: { data: pluginUsageResponseSchema }, errors,
    description: 'Read plugin use in a workspace without resuming its sessions', tags: ['plugins'] }, async (req, reply) => {
    if (!core.accessor.get(IPluginUsageService).enabled()) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Workspace plugin selection is not enabled', req.id));
      return;
    }
    const workspace = await resolvePluginUsageWorkspace(core, req.query);
    if (workspace === undefined) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Workspace was not found', req.id));
      return;
    }
    reply.send(okEnvelope(await readPluginUsage(core, workspace), req.id));
  });
  app.get(read.path, read.options, read.handler as never);
  const set = defineRoute({ method: 'POST', path: '/plugins/usage', body: pluginUsageRequestSchema, success: { data: pluginUsageResponseSchema }, errors,
    description: 'Choose or restore plugin use in this workspace without changing the home lifecycle', tags: ['plugins'] }, async (req, reply) => {
    const usage = core.accessor.get(IPluginUsageService);
    if (!usage.enabled()) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Workspace plugin selection is not enabled', req.id));
      return;
    }
    const workspace = await resolvePluginUsageWorkspace(core, req.body.target);
    if (workspace === undefined) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Workspace was not found', req.id));
      return;
    }
    const plugin = (await core.accessor.get(IPluginService).listPlugins()).find((entry) => entry.id === req.body.plugin_id);
    if (plugin === undefined && req.body.override !== 'inherit') {
      reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, 'Install this plugin before adding it to the workspace', req.id));
      return;
    }
    await usage.set({ workspaceId: workspace.id, pluginId: req.body.plugin_id, override: req.body.override });
    reply.send(okEnvelope(await readPluginUsage(core, workspace), req.id));
  });
  app.post(set.path, set.options, set.handler as never);
}
