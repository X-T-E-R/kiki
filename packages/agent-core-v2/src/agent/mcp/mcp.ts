import type { Tool as KosongTool } from '#/kosong/contract/tool';

import { createDecorator } from "#/_base/di/instantiation";
import { type IDisposable } from "#/_base/di/lifecycle";
import type { McpServerEntry } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type {
  McpServerAuthState,
  McpServerLocator,
} from '#/app/mcpManagement/mcpManagement';
import type { McpServerConfigView } from '#/mcpCore/configView';
import type { McpServerSource } from '#/app/mcpRegistry/mcpRegistry';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';

export interface McpResolvedServer {
  readonly client: MCPClient;
  readonly tools: readonly KosongTool[];
  readonly rawTools: readonly MCPToolDefinition[];
  readonly enabledNames: ReadonlySet<string>;
  readonly admitCall?: () => Promise<{ release(): void } | undefined>;
}

export type McpSessionOverrideValue = 'on' | 'off' | 'inherit';

export interface McpSessionOverride {
  readonly locator: McpServerLocator;
  readonly override: McpSessionOverrideValue;
}

export interface McpSessionCapability {
  readonly locator: McpServerLocator;
  readonly runtimeName: string;
  readonly origin: McpServerSource;
  readonly config: McpServerConfigView;
  readonly authStatus: McpServerAuthState;
  readonly connection: 'enabled' | 'disabled' | 'connecting' | 'connected' | 'failed' | 'unavailable';
  readonly override: McpSessionOverrideValue;
  readonly error?: string;
}

export interface IAgentMcpService {
  readonly _serviceBrand: undefined;

  readonly oauthService: McpOAuthService | undefined;
  waitForInitialLoad(signal?: AbortSignal): Promise<void>;
  initialLoadDurationMs(): number;
  list(): readonly McpServerEntry[];
  resolved(name: string): McpResolvedServer | undefined;
  getRemoteServerUrl(name: string): string | undefined;
  reconnect(name: string, signal?: AbortSignal): Promise<void>;
  connect(name: string, config: McpServerConfig): Promise<void>;
  /** Redacted registry and known local connection/auth state only; never probes or starts a server. */
  listMcpSessionCapabilities(): Promise<readonly McpSessionCapability[]>;
  /** Persists session-only locator intent. On reuses a live connection or admits that server in the session overlay; off withdraws only this session's contribution; inherit restores the current source baseline. */
  setMcpSessionOverride(input: McpSessionOverride): Promise<McpSessionCapability>;
  /** Refreshes effective contributions and tools/list on existing enabled clients without reconnecting them. Explicit off and plugin admission rules remain in force. */
  refreshCapabilities(): Promise<void>;
  onStatusChange(listener: (entry: McpServerEntry) => void): IDisposable;
}

export const IAgentMcpService = createDecorator<IAgentMcpService>('agentMcpService');
