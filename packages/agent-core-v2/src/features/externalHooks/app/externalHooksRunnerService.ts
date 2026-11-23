import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
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
import {
  blockDecision,
  indexHooks,
  isEffectiveHookBlock,
  runMatchedHooks,
} from '../internal/matchHooks';
import type { HookRunCallbacks, IndexedHookDef } from '../internal/matchHooks';
import type { HookBlockDecision, HookDef, HookResult } from '../internal/types';

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
    @ref(ILogService) private readonly logRef?: LiveRef<ILogService>,
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

  get hookLoadFailures(): readonly PluginHookLoadFailure[] {
    return [...this.manifestHookFailures, ...this.matcherHookFailures];
  }

  async trigger(
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
    failureMode: ExternalHooksRunnerFailureMode = 'empty',
  ): Promise<HookResult[]> {
    let hasFailClosed = false;
    try {
      const { results, hasFailClosed: evaluatedFailClosed } = await this.triggerInner(event, args, (flag) => {
        hasFailClosed = flag;
      });
      hasFailClosed = evaluatedFailClosed;
      if (args.signal?.aborted !== true) {
        this.warnFailOpenResults(event, results);
      }
      return results;
    } catch (error) {
      const message = toErrorMessage(error);
      if (failureMode === 'block' && hasFailClosed) {
        return [{ action: 'block', failClosed: true, reason: `Failed to evaluate ${event} hooks: ${message}` }];
      }
      if (args.signal?.aborted !== true) {
        this.logRef?.current?.warn(`${event} hook evaluation failed; failing open`, {
          event,
          error: message,
        });
      }
      return [];
    }
  }

  async triggerBlock(
    event: string,
    args: ExternalHooksRunnerTriggerArgs = {},
  ): Promise<HookBlockDecision | undefined> {
    const results = await this.trigger(event, args, 'block');
    return blockDecision(event, results);
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

  private warnFailOpenResults(event: string, results: readonly HookResult[]): void {
    for (const result of results) {
      if (result.action === 'block' && !isEffectiveHookBlock(result)) {
        this.logRef?.current?.warn(`${event} hook failed; failing open`, {
          event,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          reason: result.reason,
        });
      } else if (result.cleanupError !== undefined) {
        this.logRef?.current?.warn(`${event} hook cleanup failed`, {
          event,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          reason: result.cleanupError,
        });
      }
    }
  }

  private async triggerInner(
    event: string,
    args: ExternalHooksRunnerTriggerArgs,
    reportFailClosed: (value: boolean) => void,
  ): Promise<{ readonly results: HookResult[]; readonly hasFailClosed: boolean }> {
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
    let byEvent = this.byEvent;
    reportFailClosed((byEvent.get(event) ?? []).some((entry) => entry.hook.failClosed === true));
    if (args.additionalHooks !== undefined) {
      const extra = await args.additionalHooks();
      if (extra.length > 0) {
        const additional = indexHooks(extra, ({ hook, message }) => {
          this.logRef?.current?.warn('Skipping hook with invalid matcher', {
            pluginId: hook.pluginId,
            event: hook.event,
            matcher: hook.matcher,
            error: message,
          });
        });
        byEvent = new Map([[event, [...byEvent.get(event) ?? [], ...additional.get(event) ?? []]]]);
        reportFailClosed((byEvent.get(event) ?? []).some((entry) => entry.hook.failClosed === true));
      }
    }
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
      reportFailClosed((byEvent.get(event) ?? []).some((entry) => entry.hook.failClosed === true));
    }
    const hasFailClosed = (byEvent.get(event) ?? []).some((entry) => entry.hook.failClosed === true);
    const results = await runMatchedHooks(
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
    return { results, hasFailClosed };
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
    const merged = indexHooks(legacyHooks(configured), ({ hook, message }) => {
      this.logRef?.current?.warn('Skipping hook with invalid matcher', {
        event: hook.event,
        matcher: hook.matcher,
        error: message,
      });
    });
    let snapshot: { readonly hooks: readonly HookDef[]; readonly failures: readonly PluginHookLoadFailure[] };
    try {
      snapshot = this.plugins.inspectHooks !== undefined
        ? await this.plugins.inspectHooks('*')
        : { hooks: await this.plugins.enabledHooks('*'), failures: [] };
    } catch (error) {
      const message = toErrorMessage(error);
      this.logRef?.current?.warn('Failed to load plugin hooks; continuing with configured hooks', {
        error: message,
      });
      snapshot = {
        hooks: [],
        failures: [{ pluginId: '*', defaultEnabled: true, message }],
      };
    }
    const matcherFailures: PluginHookLoadFailure[] = [];
    const failedIds = new Set(snapshot.failures.map((item) => item.pluginId));
    const pluginIndexed = indexHooks(snapshot.hooks, ({ hook, message }) => {
      this.logRef?.current?.warn('Skipping plugin hook with invalid matcher', {
        pluginId: hook.pluginId,
        event: hook.event,
        matcher: hook.matcher,
        error: message,
      });
      if (hook.pluginId !== undefined && !failedIds.has(hook.pluginId)) {
        failedIds.add(hook.pluginId);
        matcherFailures.push({
          pluginId: hook.pluginId,
          defaultEnabled: true,
          message,
        });
      }
    });
    for (const [event, items] of pluginIndexed.entries()) {
      const target = merged.get(event) ?? [];
      target.push(...items);
      merged.set(event, target);
    }
    for (const failure of snapshot.failures) {
      this.logRef?.current?.warn('Plugin failed to load one or more hooks; skipping failed hooks', {
        pluginId: failure.pluginId,
        error: failure.message,
      });
    }
    this.byEvent = merged;
    this.manifestHookFailures = snapshot.failures;
    this.matcherHookFailures = matcherFailures;
    this.hasSuccessfulSnapshot = true;
    this.loadFailure = undefined;
    this._onDidReload.fire();
  }
}
