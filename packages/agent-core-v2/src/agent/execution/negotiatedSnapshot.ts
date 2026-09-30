import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import type { NegotiatedExecutorCapabilities } from '#/app/agentExecutor/capabilities';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

export async function recordNegotiatedSnapshot(context: AgentExecutorContext, negotiated: NegotiatedExecutorCapabilities): Promise<void> {
  const metadata = context.agent.accessor.get(ISessionMetadata);
  const current = (await metadata.read()).agents?.[context.agent.id];
  await metadata.registerAgent(context.agent.id, {
    ...current,
    executor: context.descriptor.id,
    executorProtocol: context.descriptor.protocol,
    allowKikiSubagents: context.binding.allowKikiSubagents,
    negotiated: structuredClone(negotiated),
  });
}
