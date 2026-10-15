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

export interface KikiMcpSupport {
  readonly state: 'supported' | 'unsupported' | 'undeclared';
  readonly fact: string;
}

export interface KikiMcpSupportDescriptor {
  readonly id: string;
  readonly protocol: string;
  readonly supportsMcp?: boolean;
  readonly mcpTransports?: readonly string[];
  readonly diagnostics?: readonly { readonly kind: string; readonly message?: string }[];
}

export const KIKI_MCP_INJECTION_APPLIES = 'next_binding' as const;
export const KIKI_MCP_INJECTION_PRECEDENCE = ['session', 'profile', 'harness-settings', 'harness-default'] as const;

/**
 * Whether this descriptor can receive the Kiki stdio bridge.
 * `supported` is an explicit `supports_mcp` that includes stdio, or the Codex
 * app-server process-flag adapter. A refusal or a transport list without stdio
 * is `unsupported`. A descriptor that does not say is `undeclared`.
 */
export function kikiMcpSupport(descriptor: KikiMcpSupportDescriptor): KikiMcpSupport {
  const transports = descriptor.mcpTransports;
  if (transports !== undefined && !transports.includes('stdio')) {
    return { state: 'unsupported', fact: `${descriptor.id} mcp_transports is ${transports.join(', ')}; the Kiki bridge needs stdio.` };
  }
  const stated = descriptor.diagnostics?.find((rule) => rule.kind === 'message' && rule.message !== undefined && /mcp/i.test(rule.message))?.message;
  if (descriptor.supportsMcp === false) {
    return { state: 'unsupported', fact: stated ?? `${descriptor.id} supports_mcp is false.` };
  }
  if (descriptor.supportsMcp === true) {
    const transportFact = transports === undefined ? 'stdio is the bridge transport' : `mcp_transports is ${transports.join(', ')}`;
    return { state: 'supported', fact: `${descriptor.id} supports_mcp is true; ${transportFact}.` };
  }
  if (descriptor.protocol === 'codex-app-server') {
    return { state: 'supported', fact: `${descriptor.id} injects the Kiki bridge as mcp_servers.<name>.* -c process flags. supports_mcp is not set.` };
  }
  return { state: 'undeclared', fact: stated === undefined
    ? `${descriptor.id} does not set supports_mcp.`
    : `${descriptor.id} does not set supports_mcp. ${stated}` };
}

/**
 * Defaults-layer view for the connection-settings switch.
 * `effective` null keeps the current lease decision. Profile and session
 * choices win in `precedence` order and are copied onto the next execution
 * binding. Changing this view leaves a binding that is already running as it is.
 */
export function kikiMcpDefaultView(saved: boolean | undefined, descriptor: KikiMcpSupportDescriptor) {
  return {
    effective: saved === undefined ? null : saved,
    source: saved === undefined ? 'harness-default' as const : 'harness-settings' as const,
    applies: KIKI_MCP_INJECTION_APPLIES,
    precedence: KIKI_MCP_INJECTION_PRECEDENCE,
    support: kikiMcpSupport(descriptor),
  };
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
