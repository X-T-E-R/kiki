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
import { IRoomService } from '#/app/room/room';

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

export const SendMessageToThreadToolInputSchema = z.union([
  z.object({ thread: ThreadRefSchema, content: z.string().min(1).max(100_000), idempotency_key: z.string().min(1).max(256) }).strict(),
  z.object({ room: z.string().min(1).max(128), content: z.string().min(1).max(20_000), mentions: z.array(z.string().min(1).max(256)).max(6).optional(), idempotency_key: z.string().min(1).max(256).optional() }).strict(),
]);

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
    if (await this.threads.isWorkspaceEnabled(this.session.workspaceId, this.callerRef())) return;
    throw new Error2(
      ErrorCodes.THREAD_DISABLED,
      `Thread communication is disabled for workspace "${this.session.workspaceId}".`,
    );
  }
}

export class ListThreadsTool extends ThreadToolBase implements IListThreadsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ThreadList';
  readonly description =
    'List unarchived Kiki sessions (threads) on this host, including this one, that allow thread communication, newest first, with the thread reference (host_id, workspace_id, session_id) the other thread tools need and each thread\'s state (cold, idle, running). Use it to find an existing session; to delegate new work, use AgentRun. `limit` is 1-100 (default 50). Pass `cursor` from the previous result to get the next page, with the same `workspace_id` filter; a cursor from a different filter is rejected.';
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
          caller: this.callerRef(),
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
  readonly name = 'ThreadRead';
  readonly description =
    'Read the finished main-agent turns of a local thread without resuming it. Each turn has its input, output, and a `reason` of completed, cancelled, failed, or blocked; a turn still running is not included. Returns the newest `limit` turns (1-100, default 20) in chronological order. Pass the returned `cursor` with the same thread to page to older turns; a cursor from another thread is rejected.';
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
          caller: this.callerRef(),
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
  readonly name = 'ThreadSend';
  readonly description =
    'Send a message to another local thread; it arrives there as a user message attributed to this thread. The message is stored durably, then delivered right away when possible: it starts a turn or joins the running one (`delivery: delivered`), otherwise waits in that thread\'s queue (`pending`); `undeliverable` means it was rejected. Sending can resume a cold thread and use model quota. You cannot send to your own thread. Reuse an `idempotency_key` only to retry the same content; a different message with a used key fails. Use ThreadWait to watch for the reply. Alternatively pass room instead of thread to post to a room you belong to: {room, content, mentions?}; mentions are member ids (thread sessionId or personaId). Only explicit room sends appear in the room, never ordinary assistant text. Room sends use the tool call id for retries when idempotency_key is omitted; room delivery means logged, not that every member has replied. Only mentioned members are woken; thread members queue while busy by default.';
  readonly parameters = toInputJsonSchema(SendMessageToThreadToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
    @IRoomService private readonly rooms: IRoomService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
  ) {
    super(threads, session);
  }

  resolveExecution(input: SendMessageToThreadToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'room' in input ? 'Posting a room message' : 'Sending a peer-thread message',
      execute: async (ctx) => {
        await this.requireCallerEnabled();
        if ('room' in input) {
          if (this.agent.agentId !== 'main') throw new Error2(ErrorCodes.REQUEST_INVALID, 'Subagents cannot speak in rooms.');
          const message = await this.rooms.postBotMessage(input.room, {
            sessionId: this.session.sessionId, toolCallId: input.idempotency_key ?? ctx.toolCallId,
            text: input.content, mentions: input.mentions,
          });
          return { output: JSON.stringify({ roomId: input.room, messageId: message?.id, delivery: message === undefined ? 'undeliverable' : 'delivered' }) };
        }
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
  readonly name = 'ThreadWait';
  readonly description =
    'Wait for new activity on 1-8 distinct local threads: a turn ending (terminal), the thread waiting on an approval or question (attention), a lifecycle change such as close or archive, or an undeliverable message. Returns as soon as any listed thread has activity after its cursor, or with `timedOut: true` after `timeout_ms` (0-60000, default 30000; 0 checks once). Without a cursor, only activity after the call starts counts. Pass each thread\'s returned `cursor` into the next call so nothing is missed or repeated; if a cursor has expired, retry without it. Use ThreadRead to read the turn content.';
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
          caller: this.callerRef(),
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
  name: 'ThreadList',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(IReadThreadTool, ReadThreadTool, {
  name: 'ThreadRead',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(ISendMessageToThreadTool, SendMessageToThreadTool, {
  name: 'ThreadSend',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(IWaitThreadsTool, WaitThreadsTool, {
  name: 'ThreadWait',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
