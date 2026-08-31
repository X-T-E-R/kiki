import { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { discoverAgentFiles } from '#/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { projectAgentRootCandidates, projectAgentRoots } from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import { IWorkspaceAgentProfileLoader } from './workspaceAgentProfileLoader';

const WATCH_DEBOUNCE_MS = 200;

export class WorkspaceAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IWorkspaceAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'workspace';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.workspace;

  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
    @IWorkspaceTrust private readonly trust: IWorkspaceTrust,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this.watchReady = this.watchProjectAgentRoots();
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    await Promise.all([this.watchReady, this.trust.ready]);
    const trusted = this.trust.isTrusted();
    const roots = await projectAgentRoots(this.fs, this.workspace.cwd, (message, error) => {
      this.log.warn(message, error);
    });
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message), {
        includeRoutes: this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID),
      }),
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
      (context) => this.user.getBuiltinDefault().renderSystemPrompt(context),
      {
        registry: this.executors,
        allowExternal: trusted,
        reason: 'External executors require a trusted workspace profile source',
      },
    );
  }

  private async watchProjectAgentRoots(): Promise<void> {
    const { projectRoot, candidates } = await projectAgentRootCandidates(
      this.fs,
      this.workspace.cwd,
      (message) => this.log.warn(message),
    );
    const handle = this.fsWatch.watch(projectRoot, {
      ignored: subtreeWatchFilter(projectRoot, candidates),
    });
    this._register(handle);
    this._register(
      handle.onDidChange(() => {
        this.watchDebounce.cancelAndSet(() => {
          void this.reload().catch((error) => {
            this.log.warn(`agent profile loader "workspace" reload failed: ${String(error)}`);
          });
        }, WATCH_DEBOUNCE_MS);
      }),
    );
  }
}
