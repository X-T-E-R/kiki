import { Event } from '#/_base/event';
import type { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';

export function stubPluginUsageService(): IPluginUsageService {
  let stateReader: Parameters<IPluginUsageService['registerPluginStateReader']>[0] | undefined;
  return {
    _serviceBrand: undefined,
    enabled: () => false,
    read: async (workspaceId) => ({ workspaceId, revision: 0, overrides: {}, applyState: 'applied', errors: [] }),
    allows: async (_workspaceId, pluginId) => {
      const state = stateReader?.(pluginId);
      return state?.allowed !== false && (state?.globalEnabled ?? true);
    },
    registerPluginStateReader: (reader) => {
      stateReader = reader;
      return { dispose: () => { if (stateReader === reader) stateReader = undefined; } };
    },
    readSession: async (workspaceId, sessionId) => ({ workspaceId, sessionId, revision: 0, overrides: {}, applyState: 'applied', errors: [] }),
    applySession: async (snapshot) => snapshot,
    set: async () => { throw new Error('Plugin usage overrides are not exercised by this fixture'); },
    onDidChange: Event.None,
    onDidApply: Event.None,
  };
}
