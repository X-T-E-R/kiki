import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { literalRulePattern } from '#/tool/rule-match';

const HOST_DESCRIPTION = 'SSH host name. Omit for the session workspace; use "local" for this machine when the workspace is remote. Paths are on the selected host.';

export function toolParametersWithHost(parameters: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const properties = parameters['properties'] as Record<string, unknown> | undefined;
  if (properties === undefined) throw new Error('Tool schema has no properties');
  const { host: _host, ...withoutHost } = properties;
  return {
    ...parameters,
    properties: enabled ? { ...withoutHost, host: { type: 'string', description: HOST_DESCRIPTION } } : withoutHost,
  };
}

export function resolveSshToolTarget(host: string | undefined, path?: string): { host?: string; path?: string } {
  if (path === undefined || !path.startsWith('ssh://')) return { host, path };
  const parsed = /^ssh:\/\/([A-Za-z0-9][A-Za-z0-9._@:-]{0,255})(\/[^?#]*)$/.exec(path);
  if (parsed === null) throw new Error('Invalid ssh://host/path address');
  if (host !== undefined && host !== parsed[1]) throw new Error('SSH host and path address disagree');
  return { host: parsed[1], path: parsed[2] };
}

export async function prepareToolRuntime(service: IAgentRuntimeService, host?: string): Promise<Runtime> {
  if (host === undefined && !service.inspect().identity.runtimeId.startsWith('ssh:')) return service.inspect();
  if (service.prepareFor === undefined) throw new Error('SSH runtime selection is not available');
  return service.prepareFor(host);
}

export function acquireToolRuntime(service: IAgentRuntimeService, host: string | undefined, required: readonly RuntimeCapability[]): RuntimeLease {
  if (host === undefined) return service.acquire(required);
  if (service.acquireFor === undefined) throw new Error('SSH runtime selection is not available');
  return service.acquireFor(host, required);
}

export function toolApprovalRule(name: string, subject: string, runtime: Runtime, host?: string): string {
  const id = host === 'local' ? 'local' : host === undefined ? runtime.identity.runtimeId : `ssh:${host}`;
  return literalRulePattern(id === 'local' && host === 'local' ? `${name}@local`
    : id.startsWith('ssh:') ? `${name}@${id.slice(4)}` : name, subject);
}

export function tagSshResult(result: ExecutableToolResult, runtime: Runtime | string): ExecutableToolResult {
  const id = typeof runtime === 'string' ? runtime === 'local' ? 'local' : `ssh:${runtime}` : runtime.identity.runtimeId;
  if (!id.startsWith('ssh:')) return result;
  return typeof result.output === 'string'
    ? { ...result, output: `host: ${id.slice(4)}\n${result.output}` }
    : { ...result, note: `${result.note ?? ''}<system>host: ${id.slice(4)}</system>` };
}
