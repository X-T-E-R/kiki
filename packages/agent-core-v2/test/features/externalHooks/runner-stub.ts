import { Event } from '#/_base/event';
import { ExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunnerService';
import { HOOKS_SECTION, type HooksV2Config } from '#/features/externalHooks/configSection';
import type { HookDef } from '#/features/externalHooks/internal/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
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
    usage?: IPluginUsageService;
    sessions?: ISessionIndex;
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
    { onTriggered: options.onTriggered, onResolved: options.onResolved },
  );
}
