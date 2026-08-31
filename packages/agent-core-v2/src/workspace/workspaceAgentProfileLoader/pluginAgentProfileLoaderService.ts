import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';

import { discoverAgentFiles } from './internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from './internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';
import { IPluginAgentProfileLoader } from './pluginAgentProfileLoader';

export class PluginAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IPluginAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'plugin';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.plugin;

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IFlagService private readonly flags: IFlagService,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this._register(
      this.plugins.onDidReload(() => {
        void this.reload().catch((error) => {
          this.log.warn(`agent profile loader "plugin" reload failed: ${String(error)}`);
        });
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    const roots = await this.plugins.pluginAgentRoots();
    return profilesFromDiscovery(
      await discoverAgentFiles(
        this.fs,
        roots,
        (message) => {
          this.log.warn(message);
        },
        { includeRoutes: this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID) },
      ),
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
      (context) => this.user.getBuiltinDefault().renderSystemPrompt(context),
      {
        registry: this.executors,
        allowExternal: false,
        reason: 'Plugin profiles cannot select external executors until a plugin trust gate is available',
      },
    );
  }
}
