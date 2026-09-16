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

/** `workspaceMcpConfig` domain — Workspace-scoped MCP server-config owner contract: the single source
 *  of truth for "which MCP servers should this workspace run". It resolves the config files (user
 *  `mcp.json`, project-root `.mcp.json`, `.kiki/mcp.json`) and the enabled plugins' contributions —
 *  the file config wins a name collision, and the project-level files are gated by `workspaceTrust`
 *  (an untrusted workspace gets the user file and plugin contributions only) — tracks both sources,
 *  and publishes the reconciled set as a snapshot plus already-diffed change events. Consumers never
 *  read config files, the plugin registry, or the `[mcp]` section themselves; the global timeout
 *  preferences surface here as `tunables()`. The domain holds no connection state and never talks to
 *  an MCP server; management writes land through the App-scope MCP config store, whose `onDidWrite`
 *  republishes them without waiting for the watch debounce. */
export interface IWorkspaceMcpConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  servers(): Readonly<Record<string, McpServerConfig>>;

  tunables(): McpTunables;

  readonly onDidChange: Event<McpServersChangeEvent>;
}

export const IWorkspaceMcpConfigService: ServiceIdentifier<IWorkspaceMcpConfigService> =
  createDecorator<IWorkspaceMcpConfigService>('workspaceMcpConfigService');
