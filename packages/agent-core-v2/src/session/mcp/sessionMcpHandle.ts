import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpConnectionView, McpServerEntry } from '#/mcpCore/connection-manager';
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
  /**
   * Record a disabled server on this session's own overlay. `config.enabled`
   * must be `false`. The entry stays disabled and is not connected. Resolves
   * to that recorded entry, or `undefined` when this call does not record one.
   */
  registerDisabledServer?(
    runtimeName: string,
    config: McpServerConfig,
    source?: 'global' | 'plugin' | 'caller',
  ): Promise<McpServerEntry | undefined>;
}

export const ISessionMcpHandle: ServiceIdentifier<ISessionMcpHandle> =
  createDecorator<ISessionMcpHandle>('sessionMcpHandle');

export function sessionMcpHandleSeed(handle: ISessionMcpHandle): ScopeSeed {
  return [[ISessionMcpHandle as ServiceIdentifier<unknown>, handle]];
}
