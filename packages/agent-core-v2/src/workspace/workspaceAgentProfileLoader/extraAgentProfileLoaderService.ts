/**
 * `workspaceAgentProfileLoader` domain — `IExtraAgentProfileLoader` implementation.
 *
 * Resolves the configured `extraAgentDirs` through `configService`,
 * `workspaceContext`, `bootstrap`, and `hostFs`, reporting skipped files
 * through `log`. Watches the resolved candidate roots through `hostFsWatch`,
 * rebuilding the watch set when `extraAgentDirs` changes and reloading
 * debounced on filesystem changes. Bound at Workspace scope.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
import { discoverAgentFiles } from '#/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import {
  configuredAgentRoots,
  configuredAgentRootWatchPlans,
} from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import {
  EXTRA_AGENT_DIRS_SECTION,
  type ExtraAgentDirsConfig,
} from '#/workspace/workspaceAgentProfileLoader/configSection';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';

import { IExtraAgentProfileLoader } from './extraAgentProfileLoader';

const WATCH_DEBOUNCE_MS = 200;

export class ExtraAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IExtraAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'extra';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.extra;

  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchResources = this._register(new DisposableStore());
  private activeWatchResources: DisposableStore | undefined;
  private watchSignature: string | undefined;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super(log);
    this._register(
      this.configService.onDidSectionChange((event) => {
        if (event.domain === EXTRA_AGENT_DIRS_SECTION) {
          void this.reload().catch((error) => {
            this.log.warn(`agent profile loader "extra" reload failed: ${String(error)}`);
          });
        }
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    await this.configService.ready;
    const dirs = this.configService.get<ExtraAgentDirsConfig>(EXTRA_AGENT_DIRS_SECTION) ?? [];
    await this.updateAgentRootWatches(dirs);
    return profilesFromDiscovery(
      await discoverAgentFiles(
        this.fs,
        await configuredAgentRoots(
          this.fs,
          dirs,
          this.workspace.cwd,
          this.bootstrap.osHomeDir,
          'extra',
          (message, error) => {
            this.log.warn(message, error);
          },
        ),
        (message) => this.log.warn(message),
        { includeRoutes: this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID) },
      ),
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
    );
  }

  private async updateAgentRootWatches(dirs: readonly string[]): Promise<void> {
    const plans = await configuredAgentRootWatchPlans(
      this.fs,
      dirs,
      this.workspace.cwd,
      this.bootstrap.osHomeDir,
      (message, error) => this.log.warn(message, error),
    );
    const signature = plans
      .flatMap(({ root, candidates }) => candidates.map((candidate) => `${root}\0${candidate}`))
      .toSorted()
      .join('\0');
    if (signature === this.watchSignature) return;

    const resources = this.watchResources.add(new DisposableStore());
    try {
      for (const { root, candidates } of plans) {
        const handle = resources.add(
          this.fsWatch.watch(root, {
            ignored: subtreeWatchFilter(root, candidates),
            signal: true,
          }),
        );
        resources.add(
          handle.onDidChange(() => {
            this.watchDebounce.cancelAndSet(() => {
              void this.reload().catch((error) => {
                this.log.warn(`agent profile loader "extra" reload failed: ${String(error)}`);
              });
            }, WATCH_DEBOUNCE_MS);
          }),
        );
      }
    } catch (error) {
      this.watchResources.delete(resources);
      throw error;
    }

    if (this.watchResources.isDisposed) return;
    const previous = this.activeWatchResources;
    this.activeWatchResources = resources;
    this.watchSignature = signature;
    if (previous !== undefined) this.watchResources.delete(previous);
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IExtraAgentProfileLoader,
  ExtraAgentProfileLoaderService,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileLoader',
);
