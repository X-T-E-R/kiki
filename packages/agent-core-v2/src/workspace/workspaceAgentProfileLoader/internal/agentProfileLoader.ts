import { MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import type { ILogService } from '#/_base/log/log';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';

export abstract class AgentProfileLoaderBase extends Service {
  protected abstract readonly sourceId: string;
  protected abstract readonly priority: number;
  protected readonly fatal: boolean = false;

  private readyPromise: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private lastGoodContribution: AgentProfileContribution | undefined;
  private readonly contributionHandle = this._register(new MutableDisposable<IDisposable>());
  private readonly readinessHandle = this._register(new MutableDisposable<IDisposable>());

  constructor(
    protected readonly log: ILogService,
    private readonly registry?: IAgentProfileRegistry,
  ) {
    super();
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  protected start(): void {
    this.readyPromise = this.enqueue();
    this.readinessHandle.value = this.registry?.registerSourceReadiness(
      this.sourceId,
      this.workspaceKey,
      this.readyPromise,
    );
    void this.readyPromise.catch(() => undefined);
  }

  async reload(): Promise<void> {
    this.readyPromise = this.enqueue();
    void this.readyPromise.catch(() => undefined);
    await this.readyPromise;
  }

  protected abstract load(): Promise<AgentProfileContribution>;

  protected get workspaceKey(): string | undefined {
    return undefined;
  }

  private enqueue(): Promise<void> {
    const current = this.tail.catch(() => undefined).then(() => this.loadAndContribute());
    this.tail = current;
    return current;
  }

  private async loadAndContribute(): Promise<void> {
    try {
      const contribution = this.withLastGoodEntries(await this.load());
      const registration = {
        sourceId: this.sourceId,
        priority: this.priority,
        workspaceKey: this.workspaceKey,
        contribution,
      };
      if (this.registry !== undefined) {
        this.contributionHandle.value = this.registry.register(registration);
      } else {
        const handle = this.provide(AgentProfileContribution, registration);
        this.contributionHandle.value = { dispose: () => void handle.dispose() };
      }
      this.lastGoodContribution = contribution;
    } catch (error) {
      if (this.fatal) throw error;
      this.log.warn(`agent profile loader "${this.sourceId}" load failed: ${String(error)}`);
    }
  }

  private withLastGoodEntries(contribution: AgentProfileContribution): AgentProfileContribution {
    const previous = this.lastGoodContribution;
    if (previous === undefined || contribution.skipped === undefined) return contribution;
    const invalidProfilePaths = new Set(
      contribution.skipped
        .filter((entry) => entry.code?.startsWith('agent_profile_route.') !== true)
        .map((entry) => this.pathKey(entry.path)),
    );
    const invalidRoutePaths = new Set(
      contribution.skipped
        .filter((entry) => entry.code?.startsWith('agent_profile_route.') === true)
        .map((entry) => this.pathKey(entry.path)),
    );
    const currentProfileNames = new Set(contribution.profiles.map((profile) => profile.name));
    const retainedProfiles = previous.profiles.filter(
      (profile) =>
        profile.sourcePath !== undefined &&
        this.matchesFailedPath(profile.sourcePath, invalidProfilePaths) &&
        !currentProfileNames.has(profile.name),
    );
    const currentRouteIds = new Set((contribution.routes ?? []).map((route) => route.id));
    const retainedRoutes = (previous.routes ?? []).filter(
      (route) =>
        (this.matchesFailedPath(route.path, invalidRoutePaths) ||
          this.matchesFailedPath(route.path, invalidProfilePaths)) &&
        !currentRouteIds.has(route.id),
    );
    for (const profile of retainedProfiles) {
      this.log.warn(
        `agent profile loader "${this.sourceId}" is keeping the last good profile "${profile.name}" after a reload error`,
      );
    }
    for (const route of retainedRoutes) {
      this.log.warn(
        `agent profile loader "${this.sourceId}" is keeping the last good route "${route.id}" after a reload error`,
      );
    }
    if (retainedProfiles.length === 0 && retainedRoutes.length === 0) return contribution;
    return {
      ...contribution,
      profiles: [...contribution.profiles, ...retainedProfiles],
      routes: [...(contribution.routes ?? []), ...retainedRoutes],
      scopedBindings:
        retainedProfiles.length === 0
          ? contribution.scopedBindings
          : new Map([
              ...(previous.scopedBindings ?? []),
              ...(contribution.scopedBindings ?? []),
            ]),
      sourceDefinitions:
        retainedProfiles.length === 0
          ? contribution.sourceDefinitions
          : new Map([
              ...(previous.sourceDefinitions ?? []),
              ...(contribution.sourceDefinitions ?? []),
            ]),
      dependencyIndex:
        retainedProfiles.length === 0
          ? contribution.dependencyIndex
          : new Map([
              ...(previous.dependencyIndex ?? []),
              ...(contribution.dependencyIndex ?? []),
            ]),
    };
  }

  private matchesFailedPath(path: string, failedPaths: ReadonlySet<string>): boolean {
    const candidate = this.pathKey(path);
    for (const failed of failedPaths) {
      if (candidate === failed || candidate.startsWith(`${failed}/`)) return true;
    }
    return false;
  }

  private pathKey(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    return process.platform === 'win32' || /^[a-zA-Z]:\//u.test(normalized)
      ? normalized.toLowerCase()
      : normalized;
  }
}
