import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export const ISessionEphemeralMcpServers: ServiceIdentifier<
  Readonly<Record<string, McpServerConfig>>
> = createDecorator<Readonly<Record<string, McpServerConfig>>>('sessionEphemeralMcpServers');

export const ISessionEphemeralMcpInherit: ServiceIdentifier<
  ReadonlySet<string>
> = createDecorator<ReadonlySet<string>>('sessionEphemeralMcpInherit');

export interface SessionPluginMcpServers {
  readonly allNames: readonly string[];
  readonly enabled: Readonly<Record<string, McpServerConfig>>;
}

export const ISessionPluginMcpServers: ServiceIdentifier<SessionPluginMcpServers> =
  createDecorator<SessionPluginMcpServers>('sessionPluginMcpServers');

export function sessionEphemeralMcpServersSeed(
  servers: Readonly<Record<string, McpServerConfig>>,
  inheritNames?: ReadonlySet<string>,
): ScopeSeed {
  return [
    [ISessionEphemeralMcpServers as ServiceIdentifier<unknown>, servers],
    [ISessionEphemeralMcpInherit as ServiceIdentifier<unknown>, inheritNames ?? new Set<string>()],
  ];
}

export function sessionPluginMcpServersSeed(servers: SessionPluginMcpServers): ScopeSeed {
  return [[ISessionPluginMcpServers as ServiceIdentifier<unknown>, servers]];
}
