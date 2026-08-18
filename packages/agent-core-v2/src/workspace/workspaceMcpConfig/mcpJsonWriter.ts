/**
 * `workspaceMcpConfig` domain — validated MCP JSON write-back contract.
 *
 * A Workspace-scoped writer lists and mutates the editable user and project
 * `mcp.json` sources, reloads the workspace MCP configuration, and returns the
 * authoritative post-reload file entries.
 */

import type { McpServerConfig } from '#/mcpCore/config-schema';

export type McpJsonWriteScope = 'user' | 'project';

export interface McpJsonServerEntry {
  readonly name: string;
  readonly scope: McpJsonWriteScope;
  readonly config: McpServerConfig;
}

export interface McpJsonServerList {
  readonly entries: readonly McpJsonServerEntry[];
}

export interface McpJsonServerUpsertRequest {
  readonly name: string;
  readonly scope: McpJsonWriteScope;
  readonly config: McpServerConfig;
}

export interface McpJsonServerRemoveRequest {
  readonly name: string;
  readonly scope: McpJsonWriteScope;
}

export interface IMcpJsonWriter {
  readonly _serviceBrand: undefined;
  list(): Promise<McpJsonServerList>;
  upsert(request: McpJsonServerUpsertRequest): Promise<McpJsonServerList>;
  remove(request: McpJsonServerRemoveRequest): Promise<McpJsonServerList>;
}
