import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import type { NegotiatedExecutorCapabilities } from '#/app/agentExecutor/capabilities';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

export interface ExtendedNegotiatedExecutorCapabilities extends NegotiatedExecutorCapabilities {
  readonly pdf?: boolean;
  readonly textAttachment?: boolean;
  readonly embeddedContext?: boolean;
  readonly logout?: boolean;
  readonly slashCommands?: readonly string[];
  readonly modelThinkingLevels?: Readonly<Record<string, readonly string[]>>;
}

export async function recordNegotiatedSnapshot(
  context: AgentExecutorContext,
  negotiated: ExtendedNegotiatedExecutorCapabilities,
): Promise<void> {
  const metadata = context.agent.accessor.get(ISessionMetadata);
  await metadata.updateAgent(context.agent.id, (current) => ({
    ...current,
    executor: context.descriptor.id,
    executorProtocol: context.descriptor.protocol,
    allowKikiSubagents: context.binding.allowKikiSubagents,
    negotiated: structuredClone(negotiated),
  }));
}
