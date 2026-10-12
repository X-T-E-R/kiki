import type { AcpOpenSessionOptions } from '@kiki/acp-client';

import { createDecorator } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import { toolGroupForName } from '#/agent/toolRegistry/toolGroups';
import type { ToolSource } from '#/tool/toolContract';

type HarnessCapabilityBinding = Pick<ProfileBindingSnapshot, 'execution' | 'kikiContext' | 'allowKikiSubagents'>;

export function harnessCapabilities(binding: HarnessCapabilityBinding) {
  return {
    context: binding.execution?.sources['kiki_context'] === 'harness-default' ? undefined
      : binding.execution?.effective.kiki_context ?? binding.kikiContext,
    delegation: binding.execution?.sources['allow_kiki_subagents'] === 'harness-default' ? undefined
      : binding.execution?.effective.allow_kiki_subagents ?? binding.allowKikiSubagents,
  };
}

export function nativeHarnessToolAllowed(
  binding: HarnessCapabilityBinding, parentAgentId: string | undefined, name: string, source: ToolSource,
): boolean {
  const child = parentAgentId !== undefined;
  const { context, delegation } = harnessCapabilities(binding);
  if (source === 'builtin') {
    const group = toolGroupForName(name);
    const contextGroup = group === 'thread' ? 'threads' : group;
    if (contextGroup !== undefined && ['memory', 'board', 'cron', 'threads', 'history'].includes(contextGroup)) {
      return context === undefined ? child : context.includes(contextGroup as NonNullable<typeof context>[number]);
    }
    if (name === 'AgentRun' || name === 'AgentList' || name === 'AgentSend') return delegation ?? child;
  }
  return child;
}

export type HarnessMcpServer = NonNullable<AcpOpenSessionOptions['mcpServers']>[number];

export interface HarnessMcpLease {
  readonly server: HarnessMcpServer;
  readonly processEnv?: Readonly<Record<string, string>>;
  readonly processArgs?: readonly string[];
  readonly sessionMeta?: Record<string, unknown>;
  readonly contextHook?: (event: 'Stop') => Promise<string>;
  dispose(): void;
}

export interface HarnessMcpRequest {
  readonly sessionId: string;
  readonly agentId: string;
  readonly workspacePath: string;
  readonly executorId?: string;
  readonly hooks?: boolean;
  readonly nativeTools?: boolean;
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
