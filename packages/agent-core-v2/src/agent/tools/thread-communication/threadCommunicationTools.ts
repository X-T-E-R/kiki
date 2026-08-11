/**
 * `tools` domain — main-agent peer-thread tools.
 *
 * Exposes bounded list, read, send, and wait operations through the App-scope
 * `threadCommunication` service while deriving the sending Thread from the
 * current Session. Registered for the main Agent only. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  IThreadCommunicationService,
  type ThreadRef,
} from '#/app/threadCommunication/threadCommunication';
import {
  SEND_PEER_THREAD_MESSAGE,
  peerSendCapability,
} from '#/app/threadCommunication/peerThreadCapability';
import { Error2, ErrorCodes } from '#/errors';

const ThreadRefSchema = z
  .object({
    host_id: z.string().min(1).max(256),
    workspace_id: z.string().min(1).max(512),
    session_id: z.string().min(1).max(256),
  })
  .strict();

export const ListThreadsToolInputSchema = z
  .object({
    workspace_id: z.string().min(1).max(512).optional(),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ReadThreadToolInputSchema = z
  .object({
    thread: ThreadRefSchema,
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const SendMessageToThreadToolInputSchema = z
  .object({
    thread: ThreadRefSchema,
    content: z.string().min(1).max(100_000),
    idempotency_key: z.string().min(1).max(256),
  })
  .strict();

export const WaitThreadsToolInputSchema = z
  .object({
    threads: z
      .array(
        z
          .object({
            thread: ThreadRefSchema,
            cursor: z.string().min(1).max(4096).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    timeout_ms: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();

type ListThreadsToolInput = z.infer<typeof ListThreadsToolInputSchema>;
type ReadThreadToolInput = z.infer<typeof ReadThreadToolInputSchema>;
type SendMessageToThreadToolInput = z.infer<typeof SendMessageToThreadToolInputSchema>;
type WaitThreadsToolInput = z.infer<typeof WaitThreadsToolInputSchema>;

export interface IListThreadsTool extends AgentTool<ListThreadsToolInput> {
  readonly _serviceBrand: undefined;
}

export interface IReadThreadTool extends AgentTool<ReadThreadToolInput> {
  readonly _serviceBrand: undefined;
}

export interface ISendMessageToThreadTool extends AgentTool<SendMessageToThreadToolInput> {
  readonly _serviceBrand: undefined;
}

export interface IWaitThreadsTool extends AgentTool<WaitThreadsToolInput> {
  readonly _serviceBrand: undefined;
}

export const IListThreadsTool = createDecorator<IListThreadsTool>('listThreadsTool');
export const IReadThreadTool = createDecorator<IReadThreadTool>('readThreadTool');
export const ISendMessageToThreadTool =
  createDecorator<ISendMessageToThreadTool>('sendMessageToThreadTool');
export const IWaitThreadsTool = createDecorator<IWaitThreadsTool>('waitThreadsTool');

abstract class ThreadToolBase {
  constructor(
    protected readonly threads: IThreadCommunicationService,
    protected readonly session: ISessionContext,
  ) {}

  protected callerRef(): ThreadRef {
    return {
      hostId: this.threads.hostId,
      workspaceId: this.session.workspaceId,
      sessionId: this.session.sessionId,
    };
  }

  protected async requireCallerEnabled(): Promise<void> {
    if (await this.threads.isWorkspaceEnabled(this.session.workspaceId)) return;
    throw new Error2(
      ErrorCodes.THREAD_DISABLED,
      `Thread communication is disabled for workspace "${this.session.workspaceId}".`,
    );
  }
}

export class ListThreadsTool extends ThreadToolBase implements IListThreadsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_threads';
  readonly description =
    'List enabled local threads. Results are newest first and can be continued with the returned cursor.';
  readonly parameters = toInputJsonSchema(ListThreadsToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
  ) {
    super(threads, session);
  }

  resolveExecution(input: ListThreadsToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing local threads',
      execute: async () => {
        await this.requireCallerEnabled();
        const result = await this.threads.listThreads({
          workspaceId: input.workspace_id,
          cursor: input.cursor,
          limit: input.limit,
        });
        return { output: JSON.stringify(result, null, 2) };
      },
    };
  }
}

export class ReadThreadTool extends ThreadToolBase implements IReadThreadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'read_thread';
  readonly description =
    'Read completed main-agent turns from a local thread without resuming a cold thread.';
  readonly parameters = toInputJsonSchema(ReadThreadToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
  ) {
    super(threads, session);
  }

  resolveExecution(input: ReadThreadToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Reading a local thread',
      execute: async () => {
        await this.requireCallerEnabled();
        const result = await this.threads.readThread({
          thread: fromToolRef(input.thread),
          cursor: input.cursor,
          limit: input.limit,
        });
        return { output: JSON.stringify(result, null, 2) };
      },
    };
  }
}

export class SendMessageToThreadTool
  extends ThreadToolBase
  implements ISendMessageToThreadTool
{
  declare readonly _serviceBrand: undefined;
  readonly name = 'send_message_to_thread';
  readonly description =
    'Persist and queue a user-role peer message for another enabled local thread. Reuse the same idempotency key only for the same message.';
  readonly parameters = toInputJsonSchema(SendMessageToThreadToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
  ) {
    super(threads, session);
  }

  resolveExecution(input: SendMessageToThreadToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Sending a peer-thread message',
      execute: async () => {
        await this.requireCallerEnabled();
        const result = await peerSendCapability(this.threads)[SEND_PEER_THREAD_MESSAGE]({
          source: this.callerRef(),
          target: fromToolRef(input.thread),
          content: input.content,
          idempotencyKey: input.idempotency_key,
        });
        return { output: JSON.stringify(result, null, 2) };
      },
    };
  }
}

export class WaitThreadsTool extends ThreadToolBase implements IWaitThreadsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'wait_threads';
  readonly description =
    'Wait for terminal, attention, lifecycle, or undeliverable-message activity from up to eight local threads.';
  readonly parameters = toInputJsonSchema(WaitThreadsToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
  ) {
    super(threads, session);
  }

  resolveExecution(input: WaitThreadsToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Waiting for thread activity',
      execute: async () => {
        await this.requireCallerEnabled();
        const result = await this.threads.waitThreads({
          threads: input.threads.map((item) => ({
            thread: fromToolRef(item.thread),
            cursor: item.cursor,
          })),
          timeoutMs: input.timeout_ms,
        });
        return { output: JSON.stringify(result, null, 2) };
      },
    };
  }
}

function fromToolRef(ref: z.infer<typeof ThreadRefSchema>): ThreadRef {
  return { hostId: ref.host_id, workspaceId: ref.workspace_id, sessionId: ref.session_id };
}

function mainAgentOnly(accessor: ServicesAccessor): boolean {
  return accessor.get(IAgentScopeContext).agentId === 'main';
}

registerAgentToolService(IListThreadsTool, ListThreadsTool, {
  name: 'list_threads',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(IReadThreadTool, ReadThreadTool, {
  name: 'read_thread',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(ISendMessageToThreadTool, SendMessageToThreadTool, {
  name: 'send_message_to_thread',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(IWaitThreadsTool, WaitThreadsTool, {
  name: 'wait_threads',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
