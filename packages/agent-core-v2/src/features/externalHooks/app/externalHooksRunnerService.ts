import { Disposable } from '#/_base/di/lifecycle';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { Emitter, type Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginHookLoadFailure } from '#/app/plugin/types';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { HOOKS_SECTION, legacyHooks, type HooksConfig } from '../configSection';
import {
  IExternalHooksRunnerService,
  type ExternalHooksRunnerFailureMode,
  type ExternalHooksRunnerTriggerArgs,
} from './externalHooksRunner';
import { blockDecision, indexHooks, runMatchedHooks } from '../internal/matchHooks';
import type { HookRunCallbacks, IndexedHookDef } from '../internal/matchHooks';
import type { HookBlockDecision, HookResult } from '../internal/types';

export class ExternalHooksRunnerService extends Disposable implements IExternalHooksRunnerService {
  declare readonly _serviceBrand: undefined;

  private byEvent = new Map<string, IndexedHookDef[]>();
  private manifestHookFailures: readonly PluginHookLoadFailure[] = [];
  private matcherHookFailures: readonly PluginHookLoadFailure[] = [];
  private hasSuccessfulSnapshot = false;
  private loadFailure: unknown;
  readonly ready: Promise<void>;

  private readonly _onDidReload = this._register(new Emitter<void>());
  readonly onDidReload: Event<void> = this._onDidReload.event;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IPluginService private readonly plugins: IPluginService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    @IPluginUsageService private readonly usage?: IPluginUsageService,
    @ISessionIndex private readonly sessions?: ISessionIndex,
    private readonly callbacks: HookRunCallbacks = {},
  ) {
    super();
    this.ready = this.loadSafe();
    this._register(
      this.plugins.onDidReload(() => {
        void this.reloadSafe();
      }),
    );
  }

  get summary(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [event, hooks] of this.byEvent.entries()) {
      result[event] = hooks.length;
    }
    return result;
  }

  async trigger(
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
    failureMode: ExternalHooksRunnerFailureMode = 'empty',
  ): Promise<HookResult[]> {
    try {
      return await this.triggerInner(event, args);
    } catch (error) {
      return failureMode === 'block'
        ? [{ action: 'block', reason: `Failed to evaluate ${event} hooks: ${toErrorMessage(error)}` }]
        : [];
    }
  }

  async triggerBlock(
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
  ): Promise<HookBlockDecision | undefined> {
    return blockDecision(event, await this.trigger(event, args, 'block'));
  }

  fireAndForgetTrigger(
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
  ): Promise<HookResult[]> {
    try {
      return this.trigger(event, args).catch((): HookResult[] => []);
    } catch {
      return Promise.resolve([]);
    }
  }

  hasHooksFor(event: string): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0;
  }

  private async triggerInner(
    event: string,
    args: ExternalHooksRunnerTriggerArgs,
  ): Promise<HookResult[]> {
    await this.ready;
    if (!this.hasSuccessfulSnapshot) throw this.loadFailure;
    let workspaceResolved = false;
    let workspaceId: string | undefined;
    const resolveWorkspaceId = async (): Promise<string | undefined> => {
      if (!workspaceResolved) {
        workspaceResolved = true;
        if (args.sessionId !== undefined && this.sessions !== undefined) {
          workspaceId = (await this.sessions.get(args.sessionId))?.workspaceId;
        }
      }
      return workspaceId;
    };
    const broken = await this.findApplicableHookFailure(resolveWorkspaceId, args.sessionId);
    if (broken !== undefined) {
      throw new Error(`Plugin "${broken.pluginId}" failed to load its hooks: ${broken.message}`);
    }
    let byEvent = this.byEvent;
    if (this.usage?.enabled() && (byEvent.get(event) ?? []).some((entry) => entry.hook.pluginId !== undefined)) {
      const resolvedWorkspaceId = await resolveWorkspaceId();
      if (args.sessionId !== undefined && this.sessions !== undefined && resolvedWorkspaceId === undefined) {
        const hooks = (byEvent.get(event) ?? []).filter((indexed) => indexed.hook.pluginId === undefined);
        byEvent = new Map([[event, hooks]]);
      } else {
        const hooks = await Promise.all((byEvent.get(event) ?? []).map(async (indexed) =>
          indexed.hook.pluginId === undefined || await this.usage!.allows(
            resolvedWorkspaceId,
            indexed.hook.pluginId,
            args.sessionId,
          ) ? indexed : undefined));
        byEvent = new Map([[event, hooks.filter((indexed) => indexed !== undefined)]]);
      }
    }
    if (args.additionalHooks !== undefined) {
      const additional = indexHooks(await args.additionalHooks());
      byEvent = new Map([[event, [...byEvent.get(event) ?? [], ...additional.get(event) ?? []]]]);
    }
    return runMatchedHooks(
      this.hostProcess,
      byEvent,
      event,
      {
        cwd: args.cwd ?? this.bootstrap.cwd,
        ...args,
        inputData: {
          clientType: this.bootstrap.clientIdentity.platform,
          ...args.inputData,
        },
      },
      this.callbacks,
    );
  }

  private async findApplicableHookFailure(
    resolveWorkspaceId: () => Promise<string | undefined>,
    sessionId: string | undefined,
  ): Promise<PluginHookLoadFailure | undefined> {
    if (this.manifestHookFailures.length === 0 && this.matcherHookFailures.length === 0) {
      return undefined;
    }
    const workspaceId = await resolveWorkspaceId();
    if (this.manifestHookFailures.length > 0) {
      if (this.plugins.inspectHooks !== undefined) {
        const scoped = await this.plugins.inspectHooks(workspaceId, sessionId);
        if (scoped.failures.length > 0) return scoped.failures[0];
      } else {
        for (const failure of this.manifestHookFailures) {
          if (await this.isFailureApplicable(failure, workspaceId, sessionId)) return failure;
        }
      }
    }
    for (const failure of this.matcherHookFailures) {
      if (await this.isFailureApplicable(failure, workspaceId, sessionId)) return failure;
    }
    return undefined;
  }

  private async isFailureApplicable(
    failure: PluginHookLoadFailure,
    workspaceId: string | undefined,
    sessionId: string | undefined,
  ): Promise<boolean> {
    if (this.usage === undefined || !this.usage.enabled()) {
      return failure.defaultEnabled;
    }
    return this.usage.allows(workspaceId, failure.pluginId, sessionId);
  }

  private async loadSafe(): Promise<void> {
    try {
      await this.load();
    } catch (error) {
      this.loadFailure = error;
    }
  }

  private async reloadSafe(): Promise<void> {
    try {
      await this.load();
    } catch (error) {
      this.loadFailure = error;
    }
  }

  private async load(): Promise<void> {
    await this.config.ready;
    const configured = this.config.get<HooksConfig>(HOOKS_SECTION);
    const merged = indexHooks(legacyHooks(configured));
    const snapshot = this.plugins.inspectHooks !== undefined
      ? await this.plugins.inspectHooks('*')
      : { hooks: await this.plugins.enabledHooks('*'), failures: [] };
    const matcherFailures: PluginHookLoadFailure[] = [];
    const failedIds = new Set(snapshot.failures.map((item) => item.pluginId));
    for (const hook of snapshot.hooks) {
      try {
        const indexed = indexHooks([hook]);
        for (const [event, items] of indexed.entries()) {
          const target = merged.get(event) ?? [];
          target.push(...items);
          merged.set(event, target);
        }
      } catch (error) {
        if (hook.pluginId === undefined) throw error;
        if (!failedIds.has(hook.pluginId)) {
          failedIds.add(hook.pluginId);
          matcherFailures.push({
            pluginId: hook.pluginId,
            defaultEnabled: true,
            message: toErrorMessage(error),
          });
        }
      }
    }
    this.byEvent = merged;
    this.manifestHookFailures = snapshot.failures;
    this.matcherHookFailures = matcherFailures;
    this.hasSuccessfulSnapshot = true;
    this.loadFailure = undefined;
    this._onDidReload.fire();
  }
}
