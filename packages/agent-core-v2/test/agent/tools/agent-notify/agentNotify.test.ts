import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IConfigService } from '#/app/config/config';
import type { AgentMeta, ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  AGENT_MESSAGE_BACKLOG_LIMIT,
  AgentMessageMailboxFullError,
  type AgentMessageAcceptance,
  type IAgentCollaborationMessagingService,
} from '#/session/agentCollaboration/messageMailbox';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import { AgentNotifyInputSchema } from '#/agent/tools/agent-notify/agent-notify';
import { AgentNotifyTool } from '#/agent/tools/agent-notify/agentNotifyTool';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const MAIN_ID = 'main';
const CHILD_ID = 'agt_child1';
const TOOL_CALL_ID = 'toolu_notify_1';

const signal = new AbortController().signal;

describe('AgentNotify', () => {
  it('queues a message to the main parent addressed as root', async () => {
    const { tool, send } = createTool({
      agents: {
        [CHILD_ID]: child(MAIN_ID, { name: 'researcher' }),
      },
    });

    const result = await executeTool(tool, context({ message: 'indexing done' }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(outputString(result))).toEqual({
      message_id: 'msg-1',
      status: 'queued',
      target: { task_name: 'root', agent_id: MAIN_ID },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      sourceAgentId: CHILD_ID,
      sourceTaskName: 'researcher',
      targetAgentId: MAIN_ID,
      targetTaskName: 'root',
      content: 'indexing done',
      idempotencyKey: TOOL_CALL_ID,
    });
  });

  it('queues a message to a named non-main parent by its collaboration name', async () => {
    const { tool, send } = createTool({
      parentAgentId: 'agt_parent',
      agents: {
        agt_parent: {
          type: 'sub',
          labels: { parentAgentId: MAIN_ID, [COLLABORATION_TASK_NAME_LABEL]: 'orchestrator' },
        },
        [CHILD_ID]: child('agt_parent'),
      },
    });

    const result = await executeTool(tool, context({ message: 'blocked on approval' }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(outputString(result))).toEqual({
      message_id: 'msg-1',
      status: 'queued',
      target: { task_name: 'orchestrator', agent_id: 'agt_parent' },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgentId: CHILD_ID,
        sourceTaskName: CHILD_ID,
        targetAgentId: 'agt_parent',
        targetTaskName: 'orchestrator',
      }),
    );
  });

  it('returns the delivered status when the parent mailbox accepts immediately', async () => {
    const { tool } = createTool({
      send: vi.fn(async (input) => ({ ...queued(input), delivery: 'delivered' as const })),
    });

    const result = await executeTool(tool, context({ message: 'ping' }));

    expect(JSON.parse(outputString(result))).toEqual({
      message_id: 'msg-1',
      status: 'delivered',
      target: { task_name: 'root', agent_id: MAIN_ID },
    });
  });

  it('fails when the caller is the main agent', async () => {
    const { tool, send } = createTool({ parentAgentId: undefined });

    const result = await executeTool(tool, context({ message: 'hello' }));

    expect(result).toEqual({
      isError: true,
      output: 'AgentNotify is only available to subagents; the main agent has no parent.',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails while the notify switch is off without touching the mailbox', async () => {
    const { tool, send } = createTool({ notifyParent: false });

    const result = await executeTool(tool, context({ message: 'hello' }));

    expect(result).toEqual({
      isError: true,
      output: 'AgentNotify is disabled by the [agents].notify_parent configuration.',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a tool error for a blank message', async () => {
    const { tool, send } = createTool();

    const empty = await executeTool(tool, context({ message: '' }));
    const whitespace = await executeTool(tool, context({ message: '   ' }));

    expect(empty).toEqual({ isError: true, output: 'message must be nonblank.' });
    expect(whitespace).toEqual({ isError: true, output: 'message must be nonblank.' });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a tool error when the parent mailbox is full', async () => {
    const { tool } = createTool({
      send: vi.fn(async () => {
        throw new AgentMessageMailboxFullError();
      }),
    });

    const result = await executeTool(tool, context({ message: 'hello' }));

    expect(result).toEqual({
      isError: true,
      output: `Named agent message backlog is full (${AGENT_MESSAGE_BACKLOG_LIMIT} queued messages).`,
    });
  });

  it('rejects extra input keys at the schema layer', () => {
    expect(AgentNotifyInputSchema.safeParse({ message: 'hello', extra: true }).success).toBe(false);
    expect(AgentNotifyInputSchema.safeParse({ message: 'hello' }).success).toBe(true);
  });
});

function child(
  parentAgentId: string,
  options: { readonly name?: string } = {},
): AgentMeta {
  const labels: Record<string, string> = { parentAgentId };
  if (options.name !== undefined) labels[COLLABORATION_TASK_NAME_LABEL] = options.name;
  return {
    type: 'sub',
    delegator: { kind: 'agent', agentId: parentAgentId },
    labels,
  };
}

function createTool(options: {
  readonly parentAgentId?: string;
  readonly notifyParent?: boolean;
  readonly agents?: Record<string, AgentMeta>;
  readonly send?: IAgentCollaborationMessagingService['send'];
} = {}): {
  readonly tool: AgentNotifyTool;
  readonly send: ReturnType<typeof vi.fn<IAgentCollaborationMessagingService['send']>>;
} {
  const send =
    options.send === undefined
      ? vi.fn<IAgentCollaborationMessagingService['send']>(async (input) => queued(input))
      : vi.fn<IAgentCollaborationMessagingService['send']>(options.send);
  const parentAgentId = 'parentAgentId' in options ? options.parentAgentId : MAIN_ID;
  const scope: IAgentScopeContext = {
    _serviceBrand: undefined,
    agentId: CHILD_ID,
    parentAgentId,
    scope: () => `agents/${CHILD_ID}`,
  };
  const tool = new AgentNotifyTool(
    scope,
    { read: async () => ({ agents: options.agents ?? {} }) } as ISessionMetadata,
    { send } as unknown as IAgentCollaborationMessagingService,
    {
      get: () => ({ notify_parent: options.notifyParent ?? true }),
    } as unknown as IConfigService,
  );
  return { tool, send };
}

function queued(
  input: Parameters<IAgentCollaborationMessagingService['send']>[0],
): AgentMessageAcceptance {
  return {
    message: {
      messageId: 'msg-1',
      sessionId: 'session-1',
      sourceAgentId: input.sourceAgentId,
      sourceTaskName: input.sourceTaskName,
      targetAgentId: input.targetAgentId,
      targetTaskName: input.targetTaskName,
      content: input.content,
      acceptedAt: 1,
      targetSeq: 1,
    },
    deduplicated: false,
    delivery: 'queued',
    payloadConflict: false,
  };
}

function context(args: { readonly message: string }) {
  return { turnId: 0, toolCallId: TOOL_CALL_ID, args, signal };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  expect(typeof result.output).toBe('string');
  return result.output as string;
}
