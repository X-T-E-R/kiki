import { IBootstrapService, IPluginService, IPluginUsageService, ISessionPluginUsageService, ISessionIndex, IWorkspaceService, type Scope, type Workspace, type PluginUsageSnapshot } from '@kiki/agent-core-v2';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { pluginUsageTargetSchema, pluginUsageRequestSchema, pluginUsageResponseSchema, type PluginUsageTarget, type PluginUsageResponse, type PluginUsageOverride } from '@kiki/protocol';
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
function choice(value: boolean | undefined): PluginUsageOverride { return value === undefined ? 'inherit' : value ? 'on' : 'off'; }
export async function readPluginUsage(core: Scope, workspace: Workspace, sessionId?: string, applied?: PluginUsageSnapshot): Promise<PluginUsageResponse> {
  const usage = core.accessor.get(IPluginUsageService);
  const plugins = core.accessor.get(IPluginService);
  const bootstrap = core.accessor.get(IBootstrapService);
  const [snapshot, installed, session] = await Promise.all([usage.read(workspace.id), plugins.listPlugins(), sessionId === undefined ? undefined : usage.readSession(workspace.id, sessionId)]);
  const items = await Promise.all(installed.map(async (plugin) => {
    const selected = snapshot.overrides[plugin.id];
    const sessionSelected = session?.overrides[plugin.id];
    const global = plugin.globalEnabled;
    const desired = sessionSelected ?? selected ?? global;
    const info = await plugins.getPluginInfo({ id: plugin.id });
    return { id: plugin.id, displayName: plugin.displayName, version: plugin.version, icon: plugin.icon,
      home_enabled: plugin.enabled, global_enabled: global, state: plugin.state, override: choice(selected),
      session_override: sessionId === undefined ? undefined : choice(sessionSelected),
      effective: plugin.enabled && plugin.state === 'ok' && desired,
      reason: plugin.state !== 'ok' ? 'invalid_plugin' as const : !plugin.enabled ? 'home_disabled' as const : desired ? undefined : sessionSelected === false ? 'session_disabled' as const : selected === false ? 'workspace_disabled' as const : 'global_disabled' as const,
      app_service: info.manifest?.kiki?.activation === 'app',
      skillCount: plugin.skillCount, mcpServerCount: plugin.mcpServerCount };
  }));
  const status = applied ?? session ?? snapshot;
  return { home_id: bootstrap.spaceId ?? 'main', target: { workspace_id: workspace.id, name: workspace.name, root: workspace.root, session_id: sessionId },
    revision: status.revision, apply_state: status.applyState, errors: [...status.errors], plugins: items };
}
export function registerPluginUsageRoutes(app: Host, core: Scope): void {
  const errors = { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.PLUGIN_NOT_FOUND]: {}, [ErrorCode.CAPABILITY_UNSUPPORTED]: {} };
  const read = defineRoute({ method: 'GET', path: '/plugins/usage', querystring: pluginUsageTargetSchema, success: { data: pluginUsageResponseSchema }, errors,
    description: 'Read effective workspace or session plugin use without resuming sessions', tags: ['plugins'] }, async (req, reply) => {
    if (!core.accessor.get(IPluginUsageService).enabled()) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Workspace plugin selection is not enabled', req.id));
      return;
    }
    const workspace = await resolvePluginUsageWorkspace(core, req.query);
    if (workspace === undefined) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Workspace was not found', req.id)); return; }
    reply.send(okEnvelope(await readPluginUsage(core, workspace, 'session_id' in req.query ? req.query.session_id : undefined), req.id));
  });
  app.get(read.path, read.options, read.handler as never);
  const set = defineRoute({ method: 'POST', path: '/plugins/usage', body: pluginUsageRequestSchema, success: { data: pluginUsageResponseSchema }, errors,
    description: 'Choose or restore workspace defaults or explicit session activation', tags: ['plugins'] }, async (req, reply) => {
    const usage = core.accessor.get(IPluginUsageService);
    if (!usage.enabled()) { reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'Workspace plugin selection is not enabled', req.id)); return; }
    const workspace = await resolvePluginUsageWorkspace(core, req.body.target);
    if (workspace === undefined) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Workspace was not found', req.id)); return; }
    const plugin = (await core.accessor.get(IPluginService).listPlugins()).find((entry) => entry.id === req.body.plugin_id);
    if (plugin === undefined && req.body.override !== 'inherit') { reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, 'Install this plugin before enabling it', req.id)); return; }
    if (req.body.override === 'on' && (plugin?.enabled !== true || plugin.state !== 'ok')) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'This plugin is disabled globally or invalid', req.id)); return; }
    let applied: PluginUsageSnapshot;
    const sessionId = 'session_id' in req.body.target ? req.body.target.session_id : undefined;
    if (sessionId !== undefined) {
      const result = await withSessionOperation(core, sessionId, async session => session?.accessor.get(ISessionPluginUsageService).set(req.body.plugin_id, req.body.override));
      if (result === undefined) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Session was not found', req.id)); return; }
      applied = result;
    } else applied = await usage.set({ workspaceId: workspace.id, pluginId: req.body.plugin_id, override: req.body.override });
    reply.send(okEnvelope(await readPluginUsage(core, workspace, sessionId, applied), req.id));
  });
  app.post(set.path, set.options, set.handler as never);
}
