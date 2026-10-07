import { Event, type Emitter } from '#/_base/event';
import type { IPluginService } from '#/app/plugin/plugin';
import type {
  EnabledPluginSessionStart,
  PluginMutationSummary,
  PluginReloadEvent,
  ReloadSummary,
} from '#/app/plugin/types';

interface StubPluginServiceOptions {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly reloadEmitter?: Emitter<PluginReloadEvent>;
  readonly mutateEmitter?: Emitter<PluginMutationSummary>;
}

export function stubPluginService(options: StubPluginServiceOptions): IPluginService {
  return {
    _serviceBrand: undefined,
    onWillChange: Event.None as IPluginService['onWillChange'],
    onDidReload: options.reloadEmitter?.event ?? (Event.None as IPluginService['onDidReload']),
    onDidMutate: options.mutateEmitter?.event ?? (Event.None as IPluginService['onDidMutate']),
    listPlugins: async () => [],
    previewPlugin: async () => { throw new Error('unused'); },
    installPlugin: async () => ({ id: '' }) as never,
    rollbackPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async (): Promise<ReloadSummary> => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async ({ id }) => ({
      id,
      enabled: true,
      globalEnabled: true,
      state: 'ok' as const,
      manifest: undefined,
    }) as never,
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    pluginSkillOwner: async () => undefined,
    pluginAgentRoots: async () => [],
    enabledSessionStarts: async () => options.sessionStarts,
    enabledSystemPrompts: async () => [],
    enabledMcpServers: async () => ({}),
    mcpServerEntries: async () => [],
    enabledHooks: async () => [],
    enabledHookRules: async () => [],
    hasLoadedSnapshot: () => true,
  };
}
