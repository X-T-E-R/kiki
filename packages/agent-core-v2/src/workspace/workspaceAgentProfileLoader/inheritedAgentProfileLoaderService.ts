import { ILogService } from '#/_base/log/log';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { TimeoutTimer } from '#/_base/utils/timer';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { resolveSpaceInheritance } from '#/app/bootstrap/spaceInheritance';
import { IFlagService } from '#/app/flag/flag';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { discoverAgentFiles } from './internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from './internal/agentProfileLoader';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import {
  inheritedAgentRoots,
  inheritedAgentRootWatchPlans,
} from './internal/agentRoots';
import { loadSystemMdProfile } from './internal/systemFile';
import { IInheritedAgentProfileLoader } from './inheritedAgentProfileLoader';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';

const WATCH_DEBOUNCE_MS = 200;

/** `IInheritedAgentProfileLoader` implementation (Workspace scope): the base (main) home's `agents/`
 *  directory plus its `SYSTEM.md` registered as the `inherited` source, so a space keeps its own
 *  same-name profiles while a profile only present in the base home stays visible. */
export class InheritedAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IInheritedAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'inherited';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.inherited;

  private lastGoodSystemMd: AgentProfile | undefined;
  private duplicateWarnings = new Set<string>();
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
    @IAgentProfileRegistry registry: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this.watchReady = this.watchInheritedRoots();
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    await this.watchReady;
    const inheritance = resolveSpaceInheritance(this.bootstrap);
    const baseHomeDir = inheritance.agents ? inheritance.baseHomeDir : undefined;
    if (baseHomeDir === undefined) {
      return { profiles: [], routes: [], skipped: [], scannedRoots: [] };
    }
    const roots = await inheritedAgentRoots(this.fs, baseHomeDir, (message, error) => {
      this.log.warn(message, error);
    });
    const systemFailures: NonNullable<AgentProfileContribution['skipped']>[number][] = [];
    const loadedSystemMd = await loadSystemMdProfile(
      this.fs,
      baseHomeDir,
      this.user.getBuiltinDefault(),
      (message) => { this.log.warn(message); },
      (failure) => systemFailures.push(failure),
    );
    const systemMd = systemFailures.length > 0 ? this.lastGoodSystemMd : loadedSystemMd;
    if (systemFailures.length > 0 && systemMd !== undefined) {
      this.log.warn(`agent profile loader "inherited" is keeping the last good SYSTEM.md profile at ${systemMd.sourcePath}`);
    }
    const currentDuplicates = new Set<string>();
    const discovery = await discoverAgentFiles(this.fs, roots, (message) => {
      if (message.startsWith('Duplicate agent profile ')) {
        currentDuplicates.add(message);
        if (this.duplicateWarnings.has(message)) return;
      }
      this.log.warn(message);
    }, {
      includeRoutes: this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID),
    });
    this.duplicateWarnings = currentDuplicates;
    this.lastGoodSystemMd = systemMd;
    const contribution = profilesFromDiscovery(
      discovery,
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
      (context) => this.user.getBuiltinDefault().renderSystemPrompt(context),
      { registry: this.executors, allowExternal: true },
    );
    return {
      ...contribution,
      profiles: systemMd === undefined ? contribution.profiles : [...contribution.profiles, systemMd],
      skipped: [...(contribution.skipped ?? []), ...systemFailures],
    };
  }

  private async watchInheritedRoots(): Promise<void> {
    const inheritance = resolveSpaceInheritance(this.bootstrap);
    const baseHomeDir = inheritance.agents ? inheritance.baseHomeDir : undefined;
    if (baseHomeDir === undefined) return;
    for (const { root, candidates } of inheritedAgentRootWatchPlans(baseHomeDir)) {
      try {
        const handle = this.fsWatch.watch(root, {
          ignored: subtreeWatchFilter(root, candidates),
          signal: true,
        });
        this._register(handle);
        this._register(
          handle.onDidChange(() => {
            this.watchDebounce.cancelAndSet(() => {
              void this.reload().catch((error) => {
                this.log.warn(`agent profile loader "inherited" reload failed: ${String(error)}`);
              });
            }, WATCH_DEBOUNCE_MS);
          }),
        );
      } catch (error) {
        this.log.warn(`cannot watch inherited agent root ${root}: ${String(error)}`);
      }
    }
  }
}
