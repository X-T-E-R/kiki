import { z } from 'zod';
import type { IPluginExtensionPortRegistry } from '@kiki/agent-core-v2';
import { listPluginGuiSlotsResponseSchema } from '@kiki/protocol';

export { listPluginGuiSlotsResponseSchema };

/** Query parameters accepted by `GET /api/plugins/gui-slots`. */
export const pluginGuiSlotsQuerySchema = z
  .object({
    workspace_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
  })
  .strict()
  .refine((query) => query.workspace_id === undefined || query.session_id === undefined, {
    message: 'workspace_id and session_id are mutually exclusive',
  });

export type PluginGuiSlotsQuery = z.infer<typeof pluginGuiSlotsQuerySchema>;

/** Path parameters accepted by `/api/plugins/:pluginId/routes/*`. */
export const pluginBrokerRouteParamsSchema = z.object({
  pluginId: z.string().min(1),
  '*': z.string(),
});

export type PluginBrokerRouteParams = z.infer<typeof pluginBrokerRouteParamsSchema>;

/** Published WebSocket topic event payload emitted by `IPluginExtensionPortRegistry.onDidPublishWsTopicEvent`. */
export interface PluginPublishedWsTopicInput {
  readonly pluginId: string;
  readonly topic: string;
  readonly sessionId?: string;
  readonly spaceId?: string;
  readonly payload: unknown;
}

/** Host-side alias for the E12 port registry resolved by `kap-server`. */
export type PluginExtensionBrokerHostPort = IPluginExtensionPortRegistry;
