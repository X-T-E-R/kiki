import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { AgentMeta, ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  AGENT_MESSAGE_BACKLOG_LIMIT,
  AgentMessageMailboxFullError,
  type AgentMessageAcceptance,
  type IAgentCollaborationMessagingService,
} from '#/session/agentCollaboration/messageMailbox';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import { AgentSendInputSchema } from '#/agent/tools/agent-send/agent-send';
import { AgentSendTool } from '#/agent/tools/agent-send/agentSendTool';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const CALLER_ID = 'main';
const ANON_ID = 'agt_anon1';
const NAMED_ID = 'agt_named';
const NAMED_NAME = 'researcher';
const SWARM_ID = 'agt_swarm1';
const GRANDCHILD_ID = 'agt_grand1';
const DIRECT_CHILD_ID = 'agt_child1';
const TOOL_CALL_ID = 'toolu_send_1';

const signal = new AbortController().signal;

describe('AgentSend', () => {
  it('queues a message to an unnamed direct child addressed by agent id', async () => {
    const { tool, send } = createTool({
      agents: {
        [ANON_ID]: child(CALLER_ID),
      },
    });

    const result = await executeTool(
      tool,
      context({ target: ANON_ID, message: 'continue with the open files' }),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(outputString(result))).toEqual({
      message_id: 'msg-1',
      status: 'queued',
      deduplicated: false,
      target: { task_name: ANON_ID, agent_id: ANON_ID },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      sourceAgentId: CALLER_ID,
      sourceTaskName: 'root',
      targetAgentId: ANON_ID,
      targetTaskName: ANON_ID,
      content: 'continue with the open files',
      idempotencyKey: TOOL_CALL_ID,
      waitForRunningDelivery: true,
    });
  });

  it('queues a message to a named direct child addressed by name', async () => {
    const { tool, send } = createTool({
      agents: {
        [NAMED_ID]: child(CALLER_ID, { name: NAMED_NAME }),
        [ANON_ID]: child(CALLER_ID),
      },
    });

    const result = await executeTool(
      tool,
      context({ target: NAMED_NAME, message: 'switch to the failing test' }),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(outputString(result))).toEqual({
      message_id: 'msg-1',
      status: 'queued',
      deduplicated: false,
      target: { task_name: NAMED_NAME, agent_id: NAMED_ID },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskName: 'root',
        targetAgentId: NAMED_ID,
        targetTaskName: NAMED_NAME,
        content: 'switch to the failing test',
      }),
    );
  });

  it('queues a message to an AgentSwarm child addressed by agent id', async () => {
    const { tool, send } = createTool({
      agents: {
        [SWARM_ID]: child(CALLER_ID, { swarmItem: 'src/a.ts' }),
      },
    });

    const result = await executeTool(
      tool,
      context({ target: SWARM_ID, message: 'skip generated fixtures' }),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(outputString(result))).toEqual({
      message_id: 'msg-1',
      status: 'queued',
      deduplicated: false,
      target: { task_name: SWARM_ID, agent_id: SWARM_ID },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAgentId: SWARM_ID,
        targetTaskName: SWARM_ID,
      }),
    );
  });

  it('refuses to address a grandchild', async () => {
    const { tool, send } = createTool({
      agents: {
        [DIRECT_CHILD_ID]: child(CALLER_ID),
        [GRANDCHILD_ID]: child(DIRECT_CHILD_ID, { name: 'leaf' }),
      },
    });

    const byId = await executeTool(
      tool,
      context({ target: GRANDCHILD_ID, message: 'do not deliver' }),
    );
    const byName = await executeTool(tool, context({ target: 'leaf', message: 'do not deliver' }));

    expect(byId).toEqual({
      isError: true,
      output: `No direct child agent matches "${GRANDCHILD_ID}". Call AgentList to find a valid name or agent id.`,
    });
    expect(byName).toEqual({
      isError: true,
      output:
        'No direct child agent matches "leaf". Call AgentList to find a valid name or agent id.',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an unmatched reference and tells the model to call AgentList', async () => {
    const { tool, send } = createTool({
      agents: {
        [NAMED_ID]: child(CALLER_ID, { name: NAMED_NAME }),
      },
    });

    const result = await executeTool(
      tool,
      context({ target: 'missing_agent', message: 'hello' }),
    );

    expect(result).toEqual({
      isError: true,
      output:
        'No direct child agent matches "missing_agent". Call AgentList to find a valid name or agent id.',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a tool error when the child mailbox is full', async () => {
    const { tool } = createTool({
      agents: {
        [ANON_ID]: child(CALLER_ID),
      },
      send: vi.fn(async () => {
        throw new AgentMessageMailboxFullError();
      }),
    });

    const result = await executeTool(tool, context({ target: ANON_ID, message: 'hello' }));

    expect(result).toEqual({
      isError: true,
      output: `Named agent message backlog is full (${AGENT_MESSAGE_BACKLOG_LIMIT} queued messages).`,
    });
  });

  it('returns a tool error for a blank message', async () => {
    const { tool, send } = createTool({
      agents: {
        [ANON_ID]: child(CALLER_ID),
      },
    });

    const empty = await executeTool(tool, context({ target: ANON_ID, message: '' }));
    const whitespace = await executeTool(tool, context({ target: ANON_ID, message: '   ' }));

    expect(empty).toEqual({ isError: true, output: 'message must be nonblank.' });
    expect(whitespace).toEqual({ isError: true, output: 'message must be nonblank.' });
    expect(send).not.toHaveBeenCalled();
  });

  it('stamps the sender from the caller collaboration name when present', async () => {
    const { tool, send } = createTool({
      callerAgentId: 'agt_parent',
      agents: {
        agt_parent: {
          type: 'sub',
          labels: {
            parentAgentId: CALLER_ID,
            [COLLABORATION_TASK_NAME_LABEL]: 'orchestrator',
          },
        },
        [ANON_ID]: child('agt_parent'),
      },
    });

    await executeTool(tool, context({ target: ANON_ID, message: 'ping' }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgentId: 'agt_parent',
        sourceTaskName: 'orchestrator',
      }),
    );
  });

  it('rejects extra input keys at the schema layer', () => {
    expect(
      AgentSendInputSchema.safeParse({
        target: NAMED_NAME,
        message: 'hello',
        extra: true,
      }).success,
    ).toBe(false);
    expect(AgentSendInputSchema.safeParse({ target: NAMED_NAME, message: 'hello' }).success).toBe(
      true,
    );
  });
});

function child(
  parentAgentId: string,
  options: { readonly name?: string; readonly swarmItem?: string } = {},
): AgentMeta {
  const labels: Record<string, string> = { parentAgentId };
  if (options.name !== undefined) labels[COLLABORATION_TASK_NAME_LABEL] = options.name;
  if (options.swarmItem !== undefined) labels['swarmItem'] = options.swarmItem;
  return {
    type: 'sub',
    delegator: { kind: 'agent', agentId: parentAgentId },
    labels,
  };
}

function createTool(options: {
  readonly callerAgentId?: string;
  readonly agents?: Record<string, AgentMeta>;
  readonly send?: IAgentCollaborationMessagingService['send'];
}): {
  readonly tool: AgentSendTool;
  readonly send: ReturnType<typeof vi.fn<IAgentCollaborationMessagingService['send']>>;
} {
  const send =
    options.send === undefined
      ? vi.fn<IAgentCollaborationMessagingService['send']>(async (input) => queued(input))
      : vi.fn<IAgentCollaborationMessagingService['send']>(options.send);
  const tool = new AgentSendTool(
    { agentId: options.callerAgentId ?? CALLER_ID } as IAgentScopeContext,
    { read: async () => ({ agents: options.agents ?? {} }) } as ISessionMetadata,
    { send } as unknown as IAgentCollaborationMessagingService,
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

function context(args: { readonly target: string; readonly message: string }) {
  return { turnId: 0, toolCallId: TOOL_CALL_ID, args, signal };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  expect(typeof result.output).toBe('string');
  return result.output as string;
}
