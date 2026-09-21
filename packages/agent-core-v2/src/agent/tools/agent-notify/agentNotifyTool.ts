import { toInputJsonSchema } from '#/tool/input-schema';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IConfigService } from '#/app/config/config';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentMessageMailboxFullError,
  IAgentCollaborationMessagingService,
} from '#/session/agentCollaboration/messageMailbox';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import {
  AGENTS_SECTION,
  isParentNotifyEnabled,
  type AgentsConfig,
} from '#/session/agentCollaboration/configSection';

import {
  IAgentNotifyTool,
  AgentNotifyInputSchema,
  isAgentNotifyAvailable,
  type AgentNotifyInput,
  type AgentNotifyResult,
} from './agent-notify';
import AGENT_NOTIFY_DESCRIPTION from './agent-notify.md?raw';

const PARENT_NOTIFY_DISABLED_MESSAGE =
  'AgentNotify is disabled by the [agents].notify_parent configuration.';

export class AgentNotifyTool implements IAgentNotifyTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentNotify' as const;
  readonly description = AGENT_NOTIFY_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentNotifyInputSchema);

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentCollaborationMessagingService private readonly messaging: IAgentCollaborationMessagingService,
    @IConfigService private readonly config: IConfigService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
  ) {}

  resolveExecution(args: AgentNotifyInput): ToolExecution {
    return {
      description: 'Notifying the parent agent',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async (context) => this.run(args, context),
    };
  }

  private async run(
    args: AgentNotifyInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const configEnabled = isParentNotifyEnabled(this.config.get<AgentsConfig>(AGENTS_SECTION));
    const parentAgentId = this.scope.parentAgentId;
    const allowParentNotify = this.profile.data().allowParentNotify;
    const toolPolicyEnabled = this.toolPolicy.isToolActive(this.name);
    if (parentAgentId === undefined) {
      return failure('AgentNotify is only available to subagents; the main agent has no parent.');
    }
    if (!isAgentNotifyAvailable({
      hasParent: true,
      allowParentNotify,
      configEnabled,
      toolPolicyEnabled,
    })) {
      if (!configEnabled) return failure(PARENT_NOTIFY_DISABLED_MESSAGE);
      if (allowParentNotify === false) {
        return failure('AgentNotify is disabled for this agent binding.');
      }
      return failure('AgentNotify is disabled by the active tool policy.');
    }
    if (args.message.trim().length === 0) return failure('message must be nonblank.');

    try {
      const session = await this.metadata.read();
      const targetTaskName =
        session.agents?.[parentAgentId]?.labels?.[COLLABORATION_TASK_NAME_LABEL] ??
        (parentAgentId === MAIN_AGENT_ID ? 'root' : parentAgentId);
      const sourceTaskName =
        session.agents?.[this.scope.agentId]?.labels?.[COLLABORATION_TASK_NAME_LABEL] ??
        this.scope.agentId;
      const acceptance = await this.messaging.send({
        sourceAgentId: this.scope.agentId,
        sourceTaskName,
        targetAgentId: parentAgentId,
        targetTaskName,
        content: args.message,
        idempotencyKey: context.toolCallId,
        idleWake: 'parent',
      });
      if (acceptance.payloadConflict) {
        return failure(
          `Message identity "${acceptance.message.messageId}" was already used with different content.`,
        );
      }
      return success({
        message_id: acceptance.message.messageId,
        status: acceptance.delivery,
        target: { task_name: targetTaskName, agent_id: parentAgentId },
      });
    } catch (error) {
      if (error instanceof AgentMessageMailboxFullError) return failure(error.message);
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}

function subagentWithNotifyEnabled(accessor: ServicesAccessor): boolean {
  const hasParent = accessor.get(IAgentScopeContext).parentAgentId !== undefined;
  if (!hasParent) return false;
  const allowParentNotify = accessor.get(IAgentProfileService).data().allowParentNotify;
  if (allowParentNotify === false) return false;
  const configEnabled = isParentNotifyEnabled(
    accessor.get(IConfigService).get<AgentsConfig>(AGENTS_SECTION),
  );
  if (!configEnabled) return false;
  return isAgentNotifyAvailable({
    hasParent,
    allowParentNotify,
    configEnabled,
    toolPolicyEnabled: accessor.get(IAgentToolPolicyService).isToolActive('AgentNotify'),
  });
}

registerAgentToolService(IAgentNotifyTool, AgentNotifyTool, {
  name: 'AgentNotify',
  domain: 'subagent',
  when: subagentWithNotifyEnabled,
});

function success(value: AgentNotifyResult): ExecutableToolResult {
  return { output: JSON.stringify(value) };
}

function failure(message: string): ExecutableToolResult {
  return { output: message, isError: true };
}
