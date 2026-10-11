import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpConnectionManager, McpConnectionView } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

export interface ISessionMcpOverlay {
  readonly handle: ISessionMcpHandle;
  update?(servers: Readonly<Record<string, McpServerConfig>>): Promise<void>;
  enableConfiguredServer?(
    runtimeName: string,
    config: McpServerConfig,
    source?: 'global' | 'plugin' | 'caller',
  ): Promise<void>;
  clearConfiguredServer?(runtimeName: string): Promise<void>;
  configuredServers?(): Readonly<Record<string, McpServerConfig>>;
  setCallerServers?(names: ReadonlySet<string>): void;
  shutdown(): Promise<void>;
}

export interface SessionMcpOverlayOptions {
  readonly stdioCwd?: string;
  readonly sessionId?: string;
}

export interface IWorkspaceMcpService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  connectionManager(): McpConnectionManager;

  sessionHandle(): ISessionMcpHandle;

  sessionOverlay(
    servers: Readonly<Record<string, McpServerConfig>>,
    opts?: SessionMcpOverlayOptions,
    baseView?: McpConnectionView,
  ): ISessionMcpOverlay;
}

export const IWorkspaceMcpService: ServiceIdentifier<IWorkspaceMcpService> =
  createDecorator<IWorkspaceMcpService>('workspaceMcpService');
