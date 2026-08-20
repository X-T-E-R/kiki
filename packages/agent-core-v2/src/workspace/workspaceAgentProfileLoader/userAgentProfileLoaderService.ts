/**
 * `workspaceAgentProfileLoader` domain — `IUserAgentProfileLoader` implementation.
 *
 * Discovers user agent profiles through `bootstrap` home paths and `hostFs`,
 * reports skipped files through `log`, and appends the `<home>/SYSTEM.md`
 * prompt-override profile (synthesized against the builtin default from the
 * App builtin loader) after the scanned profiles so it wins same-name
 * collisions within this contribution. Watches user agent-root candidates and
 * `SYSTEM.md` through `hostFsWatch`, reloading debounced on changes. The user
 * roots are global os directories, but per-workspace contribution keeps every
 * record flowing through the same workspace-tagged lane. Bound at Workspace
 * scope.
 */


import { ILogService } from '#/_base/log/log';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';

import { discoverAgentFiles } from './internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from './internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { userAgentRoots, userAgentRootWatchPlans } from './internal/agentRoots';
import { loadSystemMdProfile } from './internal/systemFile';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';

const WATCH_DEBOUNCE_MS = 200;

export class UserAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IUserAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'user';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.user;

  private defaultProfile: AgentProfile;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IBuiltinAgentProfileLoader private readonly builtin: IBuiltinAgentProfileLoader,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @IFlagService private readonly flags: IFlagService,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this.defaultProfile = builtin.getDefault();
    this.watchReady = this.watchUserAgentRoots();
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  getDefaultProfile(): AgentProfile {
    return this.defaultProfile;
  }

  getBuiltinDefault(): AgentProfile {
    return this.builtin.getDefault();
  }

  protected async load(): Promise<AgentProfileContribution> {
    await this.watchReady;
    const roots = await userAgentRoots(
      this.fs,
      this.bootstrap.userAgentProfileHomeDir,
      this.bootstrap.osHomeDir,
      (message, error) => {
        this.log.warn(message, error);
      },
    );
    const systemMd = await loadSystemMdProfile(
      this.fs,
      this.bootstrap.userAgentProfileHomeDir,
      this.builtin.getDefault(),
      (message) => this.log.warn(message),
    );
    this.defaultProfile = systemMd ?? this.builtin.getDefault();
    const contribution = profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message), {
        includeRoutes: this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID),
      }),
      (context) => this.defaultProfile.renderSystemPrompt(context),
      (context) => this.builtin.getDefault().renderSystemPrompt(context),
    );
    if (systemMd === undefined) return contribution;
    return { ...contribution, profiles: [...contribution.profiles, systemMd] };
  }

  private async watchUserAgentRoots(): Promise<void> {
    for (const { root, candidates } of userAgentRootWatchPlans(
      this.bootstrap.userAgentProfileHomeDir,
      this.bootstrap.osHomeDir,
    )) {
      const handle = this.fsWatch.watch(root, {
        ignored: subtreeWatchFilter(root, candidates),
        signal: true,
      });
      this._register(handle);
      this._register(
        handle.onDidChange(() => {
          this.watchDebounce.cancelAndSet(() => {
            void this.reload().catch((error) => {
              this.log.warn(`agent profile loader "user" reload failed: ${String(error)}`);
            });
          }, WATCH_DEBOUNCE_MS);
        }),
      );
    }
  }
}
