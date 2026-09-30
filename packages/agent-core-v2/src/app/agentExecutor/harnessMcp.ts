import type { AcpOpenSessionOptions } from '@kiki/acp-client';

import { createDecorator } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';

export type HarnessMcpServer = NonNullable<AcpOpenSessionOptions['mcpServers']>[number];

export interface HarnessMcpLease {
  readonly server: HarnessMcpServer;
  dispose(): void;
}

export interface HarnessMcpRequest {
  readonly sessionId: string;
  readonly agentId: string;
  readonly workspacePath: string;
}

export type HarnessMcpProvider = (request: HarnessMcpRequest) => Promise<HarnessMcpLease>;

export interface IHarnessMcpService {
  readonly _serviceBrand: undefined;
  configure(provider: HarnessMcpProvider): { dispose(): void };
  acquire(request: HarnessMcpRequest): Promise<HarnessMcpLease>;
}

export const IHarnessMcpService = createDecorator<IHarnessMcpService>('harnessMcpService');

class HarnessMcpService implements IHarnessMcpService {
  declare readonly _serviceBrand: undefined;
  private provider: HarnessMcpProvider | undefined;

  configure(provider: HarnessMcpProvider): { dispose(): void } {
    if (this.provider !== undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Harness MCP provider is already configured');
    this.provider = provider;
    return { dispose: () => { if (this.provider === provider) this.provider = undefined; } };
  }

  acquire(request: HarnessMcpRequest): Promise<HarnessMcpLease> {
    if (this.provider === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID,
      'Kiki subagent delegation requires a host with the harness MCP bridge enabled');
    return this.provider(request);
  }
}

registerScopedService(LifecycleScope.App, IHarnessMcpService, HarnessMcpService, ScopeActivation.OnDemand, 'harnessMcp');
