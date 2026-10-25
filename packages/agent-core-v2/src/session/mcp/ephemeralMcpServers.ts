import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export const ISessionEphemeralMcpServers: ServiceIdentifier<
  Readonly<Record<string, McpServerConfig>>
> = createDecorator<Readonly<Record<string, McpServerConfig>>>('sessionEphemeralMcpServers');

export interface SessionPluginMcpServers {
  readonly allNames: readonly string[];
  readonly enabled: Readonly<Record<string, McpServerConfig>>;
}

export const ISessionPluginMcpServers: ServiceIdentifier<SessionPluginMcpServers> =
  createDecorator<SessionPluginMcpServers>('sessionPluginMcpServers');

export function sessionEphemeralMcpServersSeed(
  servers: Readonly<Record<string, McpServerConfig>>,
): ScopeSeed {
  return [[ISessionEphemeralMcpServers as ServiceIdentifier<unknown>, servers]];
}

export function sessionPluginMcpServersSeed(servers: SessionPluginMcpServers): ScopeSeed {
  return [[ISessionPluginMcpServers as ServiceIdentifier<unknown>, servers]];
}
