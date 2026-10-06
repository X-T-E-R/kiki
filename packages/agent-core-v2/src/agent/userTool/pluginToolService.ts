import { mediaGenerateInputSchema, mediaRequestSchema, type MediaRequest } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { IAgentPluginMediaService, mediaInputRefs } from '#/agent/pluginMedia/pluginMedia';
import { dispose, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import type { PluginTool } from '#/app/plugin/contributions';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { isWithinDirectory, resolveRealPathAccess, resolveRealPathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import type { ExecutableTool, ToolAccesses, ToolExecution } from '#/tool/toolContract';

export interface IAgentPluginToolService {
  readonly _serviceBrand: undefined;
  ready(): Promise<void>;
}
export const IAgentPluginToolService = createDecorator<IAgentPluginToolService>('agentPluginToolService');

export class AgentPluginToolService extends Service implements IAgentPluginToolService {
  declare readonly _serviceBrand: undefined;
  private readonly registrations = new Map<string, IDisposable>();
  private refreshQueue: Promise<void> = Promise.resolve();

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IPluginHostService private readonly hosts: IPluginHostService,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentPluginMediaService private readonly media?: IAgentPluginMediaService,
  ) {
    super();
    this._register(this.plugins.onDidReload((event) => {
      event.waitUntil(this.queueRefresh());
    }));
    void this.queueRefresh();
  }

  ready(): Promise<void> { return this.refreshQueue; }

  private queueRefresh(): Promise<void> {
    this.refreshQueue = this.refreshQueue.catch(() => undefined).then(() => this.refresh());
    return this.refreshQueue;
  }

  private async refresh(): Promise<void> {
    const definitions = await this.hosts.list();
    await dispose(this.registrations.values());
    this.registrations.clear();
    for (const { pluginId, definition } of definitions) {
      const name = `plugin__${pluginId.replaceAll('-', '_')}__${definition.name}`;
      if (this.registry.resolve(name) !== undefined) continue;
      const tool: ExecutableTool = {
        name,
        description: definition.description,
        parameters: definition.parameters ?? { type: 'object', properties: {} },
        resolveExecution: (args) => this.resolveExecution(name, pluginId, definition, args),
      };
      this.registrations.set(name, this._register(this.registry.register(tool, { source: 'plugin', disclosure: definition.disclosure })));
    }
  }

  private async resolveExecution(name: string, pluginId: string, definition: PluginTool, args: unknown): Promise<ToolExecution> {
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: this.workspaceCtx.additionalDirs,
    });
    const workspace: WorkspaceConfig = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
    const env = { _serviceBrand: undefined, ...inspected.environment, ready: Promise.resolve() };
    const fileTargets: { field?: string; inputIndex?: number; raw: string; path: string; operation: 'read' | 'write' }[] = [];
    let request: MediaRequest | undefined;
    if (definition.mediaInputs === true) {
      if (this.media === undefined) return { isError: true, output: 'Media host is unavailable' };
      request = mediaRequestSchema.parse((args as { request?: unknown })?.request);
    }
    const accesses: ToolAccesses[number][] = [];
    const lease = this.runtime.acquire(['fs']);
    try {
      if (lease.runtime.identity.generation !== inspected.identity.generation) {
        return { isError: true, output: 'Runtime changed before plugin file admission. Retry the tool call.' };
      }
      for (const access of definition.accesses) {
        if (access.kind === 'all') { accesses.push(access); continue; }
        const field = /^\$\.([A-Za-z][A-Za-z0-9_]*)$/.exec(access.path);
        if (field === null) return { isError: true, output: `Unsupported plugin file target: ${access.path}` };
        const raw = typeof args === 'object' && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)[field[1]!] : undefined;
        if (typeof raw !== 'string' || raw.length === 0) {
          return { isError: true, output: `Plugin file target $.${field[1]} must be a path string.` };
        }
        const operation = access.operation === 'read' || access.operation === 'search' ? 'read' as const : 'write' as const;
        const admitted = await resolveRealPathAccess(raw, { env, workspace, operation }, lease.runtime.fs!);
        fileTargets.push({ field: field[1]!, raw, path: admitted.path, operation });
        accesses.push({ ...access, path: admitted.path, implicitExternal: admitted.implicitExternal });
      }
      if (request !== undefined) {
        for (const [inputIndex, ref] of mediaInputRefs(request).entries()) {
          if (!('path' in ref)) continue;
          const admitted = await resolveRealPathAccess(ref.path, { env, workspace, operation: 'read' }, lease.runtime.fs!);
          fileTargets.push({ inputIndex, raw: ref.path, path: admitted.path, operation: 'read' });
          accesses.push({ kind: 'file', operation: 'read', path: admitted.path, implicitExternal: admitted.implicitExternal });
        }
      }
    } finally { lease.dispose(); }
    const path = fileTargets[0]?.path;
    const pathOptions = { cwd: workspace.workspaceDir, pathClass: env.pathClass, homeDir: env.homeDir };
    return {
      accesses,
      approvalRule: path === undefined ? definition.approvalRule ?? name : literalRulePattern(name, path),
      matchesRule: path === undefined ? undefined : (ruleArgs) => matchesPathRuleSubject(ruleArgs, path, pathOptions),
      execute: async (context) => {
        const current = this.runtime.acquire(['fs']);
        try {
          if (current.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed after plugin file admission. Retry the tool call.' };
          }
          for (const target of fileTargets) {
            const actual = await resolveRealPathAccessPath(target.raw, { env, workspace, operation: target.operation }, current.runtime.fs!);
            if ((env.pathClass === 'win32' ? actual.toLowerCase() : actual) !==
              (env.pathClass === 'win32' ? target.path.toLowerCase() : target.path)) {
              return { isError: true, output: `Plugin file target changed after path admission: admitted "${target.path}", actual "${actual}". Use the actual absolute path or resolve a changed link first.` };
            }
          }
          const resolvedArgs = { ...(args as Record<string, unknown>) };
          const admittedRequest = request === undefined ? undefined : structuredClone(request);
          const refs = admittedRequest === undefined ? [] : mediaInputRefs(admittedRequest);
          const approvedPaths: string[] = [];
          for (const target of fileTargets) {
            if (target.field !== undefined) resolvedArgs[target.field] = target.path;
            else if (target.inputIndex !== undefined) Object.assign(refs[target.inputIndex]!, { path: target.path });
            if (isWithinDirectory(target.path, view.workDir, env.pathClass)) continue;
            const missingCreate = definition.name === 'office_create' &&
              await current.runtime.fs!.stat(target.path).then(() => false, () => true);
            approvedPaths.push(missingCreate ? current.runtime.path.dirname(target.path) : target.path);
          }
          const requestId = refs.length === 0 ? context.toolCallId : mediaGenerateInputSchema.shape.request_id.parse(resolvedArgs['request_id']) ?? context.toolCallId;
          for (const [index, ref] of refs.entries()) {
            const snapshot = await this.media!.snapshotInput(ref, `${requestId}/${index}`, current.runtime.fs!, context.signal);
            if (snapshot !== ref) {
              for (const key of Object.keys(ref)) Reflect.deleteProperty(ref, key);
              Object.assign(ref, snapshot);
            }
          }
          if (admittedRequest !== undefined) resolvedArgs['request'] = admittedRequest;
          return await this.hosts.execute(pluginId, definition.name, resolvedArgs, context.signal, context.onUpdate, {
            workspaceRoot: view.workDir,
            approvedPaths,
            imageIn: this.profile.getModelCapabilities().image_in,
            media: this.media?.api(context.toolCallId, admittedRequest),
          }, definition);
        } finally { current.dispose(); }
      },
    };
  }

  override async dispose(): Promise<void> {
    await dispose(this.registrations.values());
    this.registrations.clear();
    await super.dispose();
  }
}

registerScopedService(LifecycleScope.Agent, IAgentPluginToolService, AgentPluginToolService, ScopeActivation.OnScopeCreated, 'plugin');
