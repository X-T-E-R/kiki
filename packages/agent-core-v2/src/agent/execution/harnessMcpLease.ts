import { IHarnessMcpService, type HarnessMcpLease } from '#/app/agentExecutor/harnessMcp';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { Error2, ErrorCodes } from '#/errors';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

export async function acquireHarnessMcp(context: AgentExecutorContext, cwd: string): Promise<HarnessMcpLease | undefined> {
  if (context.binding.allowKikiSubagents !== true) return undefined;
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
  });
}
