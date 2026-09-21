import { toInputJsonSchema } from '#/tool/input-schema';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  AgentMessageMailboxFullError,
  IAgentCollaborationMessagingService,
} from '#/session/agentCollaboration/messageMailbox';
import {
  directChildAgents,
  findDirectChild,
} from '#/session/agentCollaboration/directChildren';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';

import {
  IAgentSendTool,
  AgentSendInputSchema,
  type AgentSendInput,
  type AgentSendResult,
} from './agent-send';
import AGENT_SEND_DESCRIPTION from './agent-send.md?raw';

export class AgentSendTool implements IAgentSendTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentSend' as const;
  readonly description = AGENT_SEND_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSendInputSchema);

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentCollaborationMessagingService private readonly messaging: IAgentCollaborationMessagingService,
  ) {}

  resolveExecution(args: AgentSendInput): ToolExecution {
    return {
      description: 'Queueing a message for a child agent',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async (context) => this.run(args, context),
    };
  }

  private async run(
    args: AgentSendInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const targetRef = args.target.trim();
      if (targetRef.length === 0) return failure('target must be nonblank.');
      if (args.message.trim().length === 0) return failure('message must be nonblank.');

      const callerAgentId = this.scope.agentId;
      const session = await this.metadata.read();
      const child = findDirectChild(directChildAgents(session.agents, callerAgentId), targetRef);
      if (child === undefined) {
        return failure(
          `No direct child agent matches "${targetRef}". Call AgentList to find a valid name or agent id.`,
        );
      }

      const targetTaskName = child.name ?? child.agentId;
      const acceptance = await this.messaging.send({
        sourceAgentId: callerAgentId,
        sourceTaskName: callerTaskName(session, callerAgentId),
        targetAgentId: child.agentId,
        targetTaskName,
        content: args.message,
        idempotencyKey: context.toolCallId,
        waitForRunningDelivery: true,
        idleWake: 'owned-child',
      });
      if (acceptance.payloadConflict) {
        return failure(
          `Message identity "${acceptance.message.messageId}" was already used with different content.`,
        );
      }
      return success({
        message_id: acceptance.message.messageId,
        status: acceptance.delivery,
        deduplicated: acceptance.deduplicated,
        resumed: acceptance.resumed,
        target: { task_name: targetTaskName, agent_id: child.agentId },
      });
    } catch (error) {
      if (error instanceof AgentMessageMailboxFullError) return failure(error.message);
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}

registerAgentToolService(IAgentSendTool, AgentSendTool, { name: 'AgentSend', domain: 'subagent' });

function callerTaskName(
  session: { readonly agents?: Readonly<Record<string, { readonly labels?: Readonly<Record<string, string>> }>> },
  callerAgentId: string,
): string {
  return (
    session.agents?.[callerAgentId]?.labels?.[COLLABORATION_TASK_NAME_LABEL] ??
    (callerAgentId === 'main' ? 'root' : callerAgentId)
  );
}

function success(value: AgentSendResult): ExecutableToolResult {
  return { output: JSON.stringify(value) };
}

function failure(message: string): ExecutableToolResult {
  return { output: message, isError: true };
}
