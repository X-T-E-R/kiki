/**
 * `workspaceMcpConfig` domain — Workspace-scoped MCP server-config owner
 * contract.
 *
 * Defines `IWorkspaceMcpConfigService`, the single source of truth for "which
 * MCP servers should this workspace run": it resolves the MCP config files
 * (user `mcp.json`, project-root `.mcp.json`, `.kiki/mcp.json`) and the
 * enabled plugins' contributions — on a name collision the file config wins —
 * with the two project-level files gated by `workspaceTrust` (an untrusted
 * workspace gets the user file and plugin contributions only), then tracks
 * both sources (fs watch on the config files,
 * `plugins.onDidReload`) and publishes the reconciled effective set as a
 * snapshot plus already-diffed change events. Consumers never read config
 * files, the plugin registry, or the `[mcp]` config section themselves: the
 * global timeout preferences are exposed here as {@link tunables} too, so the
 * connection side has exactly one configuration dependency. The domain holds
 * no connection state and never talks to an MCP server; management writes land
 * through the App-scope MCP config store, whose `onDidWrite` republishes them
 * without waiting for the watch debounce. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export interface McpServersChange {
  readonly upsert: Readonly<Record<string, McpServerConfig>>;
  readonly remove: readonly string[];
}

export type McpServersChangeEvent = McpServersChange & IWaitUntil;

export interface McpTunables {
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

export interface IWorkspaceMcpConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  servers(): Readonly<Record<string, McpServerConfig>>;

  tunables(): McpTunables;

  readonly onDidChange: Event<McpServersChangeEvent>;
}

export const IWorkspaceMcpConfigService: ServiceIdentifier<IWorkspaceMcpConfigService> =
  createDecorator<IWorkspaceMcpConfigService>('workspaceMcpConfigService');
