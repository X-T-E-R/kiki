import { IHarnessMcpService, type HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { Error2, ErrorCodes } from '#/errors';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

export async function acquireHarnessMcp(context: AgentExecutorContext, cwd: string): Promise<HarnessMcpLease | undefined> {
  if (context.binding.allowKikiSubagents !== true && !context.binding.kikiContext?.length) return undefined;
  if (context.agent.id !== MAIN_AGENT_ID) throw new Error2(ErrorCodes.CONFIG_INVALID,
    'Kiki harness delegation is available only to a main profile');
  if (context.descriptor.supportsMcp === false ||
      (context.descriptor.mcpTransports !== undefined && !context.descriptor.mcpTransports.includes('stdio'))) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'This harness cannot receive the Kiki stdio MCP bridge');
  }
  const session = context.agent.accessor.get(ISessionContext);
  return context.agent.accessor.get(IHarnessMcpService).acquire({
    sessionId: session.sessionId,
    agentId: context.agent.id,
    workspacePath: cwd,
    executorId: context.descriptor.id,
    hooks: context.binding.kikiContext?.includes('hooks'),
  });
}

/**
 * Injects the Kiki MCP server into a Codex app-server launch. With
 * `approveKikiTools` the server's tools skip Codex's own approval prompt
 * (`default_tools_approval_mode = "approve"`); every other MCP server, command
 * and sandbox rule keeps the thread's policy, and Kiki still governs what the
 * delegated calls may do.
 */
export function codexHarnessMcpProcess(
  processes: import('@kiki/codex-client').HostProcessServiceLike,
  currentLease: () => HarnessMcpLease | undefined,
  approveKikiTools: () => boolean = () => false,
): import('@kiki/codex-client').HostProcessServiceLike {
  return {
    spawn: async (command, args, options) => {
      const server = currentLease()?.server;
      if (server === undefined) return processes.spawn(command, args, options);
      if (!('command' in server)) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Codex requires the Kiki stdio MCP bridge');
      const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
      const overrides = { command: server.command, args: server.args, env_vars: Object.keys(env), enabled: true, required: true,
        default_tools_approval_mode: approveKikiTools() ? 'approve' : undefined };
      const flags = Object.entries(overrides).flatMap(([key, value]) => value === undefined ? []
        : ['-c', `mcp_servers.${server.name}.${key}=${JSON.stringify(value)}`]);
      const lease = currentLease()!;
      return processes.spawn(command, [...args ?? [], ...flags, ...lease.processArgs ?? []], {
        ...options, env: { ...options?.env, ...env, ...lease.processEnv },
      });
    },
  };
}
