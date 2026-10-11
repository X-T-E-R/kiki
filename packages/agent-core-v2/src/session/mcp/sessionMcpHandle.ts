import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionView } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export interface SessionMcpSelection {
  readonly overrides: Map<string, 'on' | 'off'>;
  loaded?: Promise<void>;
}

export interface ISessionMcpHandle {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly connectionManager: McpConnectionView;
  readonly selection?: SessionMcpSelection;
  isBaselineServer(name: string): boolean;
  admitCurrentServers?(): ReadonlySet<string>;
  setServerEnabled?(runtimeName: string, enabled: boolean): boolean;
  clearServerEnabledOverride?(runtimeName: string): boolean | Promise<boolean>;
  enableConfiguredServer?(
    runtimeName: string,
    config: McpServerConfig,
    source?: 'global' | 'plugin' | 'caller',
  ): Promise<void>;
}

export const ISessionMcpHandle: ServiceIdentifier<ISessionMcpHandle> =
  createDecorator<ISessionMcpHandle>('sessionMcpHandle');

export function sessionMcpHandleSeed(handle: ISessionMcpHandle): ScopeSeed {
  return [[ISessionMcpHandle as ServiceIdentifier<unknown>, handle]];
}
