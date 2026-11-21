import { Event } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { ExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunnerService';
import { HOOKS_SECTION, type HooksV2Config } from '#/features/externalHooks/configSection';
import type { HookDef } from '#/features/externalHooks/internal/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginHookLoadFailure } from '#/app/plugin/types';
import type { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

export function nodeCommand(source: string): string {
  const compact = source
    .replaceAll(/\s*\n\s*/g, ' ')
    .replaceAll('\\n', '" + String.fromCharCode(10) + "');
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(compact)}`;
}

export function makeHookRunner(
  hooks: readonly HookDef[] | HooksV2Config,
  options: {
    cwd?: string;
    loadError?: Error;
    pluginHooks?: readonly HookDef[];
    pluginHookFailures?: readonly PluginHookLoadFailure[];
    inspectHooks?: IPluginService['inspectHooks'];
    usage?: IPluginUsageService;
    sessions?: ISessionIndex;
    log?: ILogService;
    onTriggered?: (event: string, target: string, count: number) => void;
    onResolved?: (
      event: string,
      target: string,
      action: string,
      reason: string | undefined,
      durationMs: number,
    ) => void;
  } = {},
): ExternalHooksRunnerService {
  return new ExternalHooksRunnerService(
    {
      _serviceBrand: undefined,
      ready:
        options.loadError === undefined
          ? Promise.resolve()
          : Promise.reject(options.loadError),
      get: (section: string) => (section === HOOKS_SECTION ? hooks : undefined),
    } as unknown as IConfigService,
    {
      _serviceBrand: undefined,
      enabledHooks: async () => options.pluginHooks ?? [],
      inspectHooks: options.inspectHooks ?? (options.pluginHookFailures === undefined
        ? undefined
        : async (workspaceId?: string, sessionId?: string) => {
          const allHooks = options.pluginHooks ?? [];
          const allFailures = options.pluginHookFailures ?? [];
          if (workspaceId === '*') return { hooks: allHooks, failures: allFailures };
          if (options.usage === undefined || !options.usage.enabled()) {
            return {
              hooks: allHooks,
              failures: allFailures.filter((item) => item.defaultEnabled),
            };
          }
          const allowedFailures = await Promise.all(
            allFailures.map(async (item) =>
              await options.usage!.allows(workspaceId, item.pluginId, sessionId) ? item : undefined),
          );
          return {
            hooks: allHooks,
            failures: allowedFailures.filter((item): item is PluginHookLoadFailure => item !== undefined),
          };
        }),
      onDidReload: Event.None as IPluginService['onDidReload'],
    } as unknown as IPluginService,
    {
      _serviceBrand: undefined,
      cwd: options.cwd ?? '',
      clientIdentity: { productName: 'test', version: '0.0.0-test', platform: 'test_platform' },
    } as unknown as IBootstrapService,
    new HostProcessService(),
    options.usage,
    options.sessions,
    options.log === undefined ? undefined : { current: options.log, onDidChange: Event.None as Event<void> },
    { onTriggered: options.onTriggered, onResolved: options.onResolved },
  );
}
