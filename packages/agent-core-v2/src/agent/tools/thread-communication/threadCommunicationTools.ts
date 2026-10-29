import { z } from 'zod';
import { bridgeReadSchema } from '@kiki/protocol';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';

import { createDecorator, IInstantiationService, type ServicesAccessor } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import THREAD_SEND_DESCRIPTION_SOURCE from './thread-send.md?raw';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  IThreadCommunicationService,
  type ThreadCaller,
  type ThreadRef,
} from '#/app/threadCommunication/threadCommunication';
import {
  SEND_PEER_THREAD_MESSAGE,
  peerSendCapability,
} from '#/app/threadCommunication/peerThreadCapability';
import { Error2, ErrorCodes } from '#/errors';
import { IRoomService, roomMemberId, type RoomDocument } from '#/app/room/room';

const ThreadRefSchema = z
  .object({
    host_id: z.string().max(256).optional().describe('Executing home host by default; a different space requires an approved bridge.'),
    bridge_id: z.string().uuid().optional(),
    connection_id: z.string().uuid().optional(),
    workspace_id: z.string().min(1).max(512),
    session_id: z.string().min(1).max(256),
  })
  .strict();

const ModelOutputOptions = {
  raw: z.boolean().optional().describe('Return the original receipt with all metadata instead of the compact model view. May be combined with cursor.'),
};

export const ListThreadsToolInputSchema = z
  .object({
    ...ModelOutputOptions,
    bridge_id: z.string().uuid().optional(),
    connection_id: z.string().uuid().optional(),
    workspace_id: z.string().min(1).max(512).optional(),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ReadThreadToolInputSchema = z
  .object({
    ...ModelOutputOptions,
    content_ref: bridgeReadSchema.shape.contentRef,
    thread: ThreadRefSchema,
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const SendMessageToThreadToolInputSchema = z.union([
  z.object({
    ...ModelOutputOptions,
    thread: ThreadRefSchema,
    content: z.string().min(1).max(100_000).describe('Input for the other thread. It arrives as a peer message from this thread.'),
    idempotency_key: z.string().min(1).max(256).describe('Retries this same content. A different message with a used key fails.'),
  }).strict(),
  z.object({
    ...ModelOutputOptions,
    room: z.string().min(1).max(128).describe('Id of a room this thread belongs to.'),
    content: z.string().min(1).max(20_000).describe('What this thread says in the room. Text written in this thread stays here.'),
    mentions: z.array(z.string().min(1).max(256)).max(6).optional().describe('Member ids to wake: a thread session id or a persona id. A member message wakes only these members. A user message with no mention goes to the room host.'),
    idempotency_key: z.string().min(1).max(256).optional().describe('Retries this same room message. Omit it to reuse the tool call id.'),
  }).strict(),
]);

export const WaitThreadsToolInputSchema = z
  .object({
    ...ModelOutputOptions,
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

export const RoomReadToolInputSchema = z.object({
  ...ModelOutputOptions,
  room: z.string().min(1).max(128),
  after_id: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const RoomAddToolInputSchema = z.object({
  room: z.string().min(1).max(128),
  session_id: z.string().min(1).max(256).describe('An existing unarchived top-level thread to add. No session or persona is created.'),
}).strict();

type RoomReadToolInput = z.infer<typeof RoomReadToolInputSchema>;
type RoomAddToolInput = z.infer<typeof RoomAddToolInputSchema>;

export interface IRoomReadTool extends AgentTool<RoomReadToolInput> {
  readonly _serviceBrand: undefined;
}

export interface IRoomAddTool extends AgentTool<RoomAddToolInput> {
  readonly _serviceBrand: undefined;
}

export const IRoomReadTool = createDecorator<IRoomReadTool>('roomReadTool');
export const IRoomAddTool = createDecorator<IRoomAddTool>('roomAddTool');

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
    private readonly instantiation?: IInstantiationService,
    private readonly knownAgentId?: string,
  ) {}

  protected callerRef(): ThreadRef {
    return {
      hostId: this.threads.hostId,
      workspaceId: this.session.workspaceId,
      sessionId: this.session.sessionId,
    };
  }

  protected admissionCaller(): ThreadCaller {
    return {
      ...this.callerRef(),
      agentId: this.knownAgentId ?? this.lookupAgentId(),
    };
  }

  private lookupAgentId(): string | undefined {
    if (this.instantiation === undefined) return undefined;
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(IAgentScopeContext))?.agentId;
    } catch {
      return undefined;
    }
  }

  protected async requireCallerEnabled(): Promise<void> {
    if (await this.threads.isWorkspaceEnabled(this.session.workspaceId, this.admissionCaller())) return;
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
    'List unarchived Kiki sessions (threads) in the executing home by default, or within an approved space using bridge_id/connection_id, that allow thread communication, newest first, with the thread reference (host_id, workspace_id, session_id) the other thread tools need and each thread\'s state (cold, idle, running). Use it to find an existing session; to delegate new work, use AgentRun. `limit` is 1-100 (default 50). Pass `cursor` from the previous result to get the next page, with the same `workspace_id` filter; a cursor from a different filter is rejected.';
  readonly parameters = toInputJsonSchema(ListThreadsToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(threads, session, instantiation);
  }

  resolveExecution(input: ListThreadsToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: ToolAccesses.none(),
      description: 'Listing local threads',
      execute: async (ctx) => {
        await this.requireCallerEnabled();
        const result = await this.threads.listThreads({
          signal: ctx.signal,
          bridgeId: input.bridge_id,
          connectionId: input.connection_id,
          caller: this.admissionCaller(),
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
    'Read a thread without resuming it. This home returns finished main-agent turns. Small local turns keep complete input and output; long values may be returned as previews with stable contentRefs. Pass content_ref to retrieve a bounded view.segment of up to 16,384 UTF-16 units and follow segment.next. An approved space returns bounded view.transcript with coverage and stable contentRefs; pass content_ref to retrieve its next segment in view.segment. Reading is a separate bridge permission, never implied by send or GUI access. Each turn has its input, output, and a `reason` of completed, cancelled, failed, or blocked; a turn still running is not included. Returns the newest `limit` turns (1-100, default 20) in chronological order. While the local history projection is preparing, it may return `turns: []`, `incomplete: "history_preparing"`, and an opaque `nextCursor`; this is not an empty thread. Continue with that `nextCursor` using the same thread and bridge scope; the original older-turn boundary is retained. After preparation completes, normal ended-turn pages use the same limit and order. Existing read cursors remain accepted, but a history rewrite or generation change can invalidate a cursor; restart from the first page when that happens.';
  readonly parameters = toInputJsonSchema(ReadThreadToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(threads, session, instantiation);
  }

  resolveExecution(input: ReadThreadToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: ToolAccesses.none(),
      description: 'Reading a local thread',
      execute: async (ctx) => {
        await this.requireCallerEnabled();
        const result = await this.threads.readThread({
          signal: ctx.signal,
          contentRef: input.content_ref,
          caller: this.admissionCaller(),
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
  readonly description = THREAD_SEND_DESCRIPTION_SOURCE.replace(/\r?\n$/, '');
  readonly parameters = toInputJsonSchema(SendMessageToThreadToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
    @IRoomService private readonly rooms: IRoomService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @IAgentContextMemoryService private readonly memory: IAgentContextMemoryService,
  ) {
    super(threads, session, undefined, agent.agentId);
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
        const origin = this.memory.get().findLast((message) => message.role === 'user' && ['user', 'peer_thread', 'bridged_peer'].includes(message.origin?.kind ?? 'user'))?.origin;
        const result = await peerSendCapability(this.threads)[SEND_PEER_THREAD_MESSAGE]({
          signal: ctx.signal,
          cause: origin?.kind === 'bridged_peer' ? { causeId: origin.causeId, hop: origin.hop } : undefined,
          source: this.callerRef(),
          executingAgentId: this.agent.agentId,
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
    'Wait for new activity on 1-8 distinct threads in the executing home or approved space bridges (requires wait authority): a turn ending (terminal), the thread waiting on an approval or question (attention), a lifecycle change such as close or archive, or an undeliverable message. Returns as soon as any listed thread has activity after its cursor, or with `timedOut: true` after `timeout_ms` (0-60000, default 30000; 0 checks once). Without a cursor, only activity after the call starts counts. Pass each thread\'s returned `cursor` into the next call so nothing is missed or repeated; if a cursor has expired, retry without it. Use ThreadRead to read the turn content.';
  readonly parameters = toInputJsonSchema(WaitThreadsToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(threads, session, instantiation);
  }

  resolveExecution(input: WaitThreadsToolInput): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: ToolAccesses.none(),
      description: 'Waiting for thread activity',
      execute: async (ctx) => {
        await this.requireCallerEnabled();
        const result = await this.threads.waitThreads({
          signal: ctx.signal,
          caller: this.admissionCaller(),
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

abstract class RoomToolBase extends ThreadToolBase {
  constructor(
    threads: IThreadCommunicationService,
    session: ISessionContext,
    protected readonly rooms: IRoomService,
    private readonly agent: IAgentScopeContext,
  ) {
    super(threads, session, undefined, agent.agentId);
  }

  protected async requireMember(roomId: string): Promise<RoomDocument> {
    if (this.agent.agentId !== 'main') throw new Error2(ErrorCodes.REQUEST_INVALID, 'Only main agents can read or manage rooms.');
    await this.requireCallerEnabled();
    const room = await this.rooms.get(roomId);
    if (room === undefined || !room.members.some((member) => member.sessionId === this.session.sessionId)) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'This thread is not a member of the room.');
    }
    return room;
  }

  protected roster(room: RoomDocument) {
    return { roomId: room.id, name: room.name, host: room.host, members: room.members.map((member) => ({ ...member, id: roomMemberId(member) })),
      paused: room.paused, pauseReason: room.pauseReason, archived: room.archived === true };
  }
}

export class RoomReadTool extends RoomToolBase implements IRoomReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'RoomRead';
  readonly description = 'Read the roster, host and saved messages of a room this main thread belongs to, without waking members. Member ids are the exact ids ThreadSend mentions. Returns at most 100 log entries (default 50); pass nextCursor as after_id to read the next page. Empty entries mean no new saved messages, not that members have exited. Does not mark notifications read or change room membership.';
  readonly parameters = toInputJsonSchema(RoomReadToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
    @IRoomService rooms: IRoomService,
    @IAgentScopeContext agent: IAgentScopeContext,
  ) {
    super(threads, session, rooms, agent);
  }

  resolveExecution(input: RoomReadToolInput): ToolExecution {
    return { approvalRule: this.name, description: 'Reading room members and messages', execute: async () => {
      const room = await this.requireMember(input.room);
      const log = await this.rooms.log(input.room, { afterId: input.after_id, limit: input.limit ?? 50 });
      return { output: JSON.stringify({ ...this.roster(room), ...log }, null, 2) };
    } };
  }
}

export class RoomAddTool extends RoomToolBase implements IRoomAddTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'RoomAdd';
  readonly description = 'Add an existing unarchived top-level thread to a room this main thread already belongs to, only when the user asks. Use ThreadList for the existing session_id. Keeps the host, existing member settings, workspace permissions and the room limit of six members. An already joined thread is returned unchanged. Does not create a room, persona or session, and does not send a message.';
  readonly parameters = toInputJsonSchema(RoomAddToolInputSchema);

  constructor(
    @IThreadCommunicationService threads: IThreadCommunicationService,
    @ISessionContext session: ISessionContext,
    @IRoomService rooms: IRoomService,
    @IAgentScopeContext agent: IAgentScopeContext,
  ) {
    super(threads, session, rooms, agent);
  }

  resolveExecution(input: RoomAddToolInput): ToolExecution {
    return { approvalRule: this.name, description: 'Adding an existing thread to a room', execute: async () => {
      const room = await this.requireMember(input.room);
      const duplicate = room.members.some((member) => member.sessionId === input.session_id);
      const updated = duplicate ? room : await this.rooms.addMember(input.room, { kind: 'thread', sessionId: input.session_id });
      return { output: JSON.stringify({ ...this.roster(updated), added: !duplicate }, null, 2) };
    } };
  }
}

function fromToolRef(ref: z.infer<typeof ThreadRefSchema>): ThreadRef {
  return { hostId: ref.host_id ?? 'local', workspaceId: ref.workspace_id, sessionId: ref.session_id, bridgeId: ref.bridge_id, connectionId: ref.connection_id };
}

function mainAgentOnly(accessor: ServicesAccessor): boolean {
  return accessor.get(IAgentScopeContext).agentId === 'main';
}

registerAgentToolService(IListThreadsTool, ListThreadsTool, {
  name: 'ThreadList',
  domain: 'threadCommunication',
});
registerAgentToolService(IReadThreadTool, ReadThreadTool, {
  name: 'ThreadRead',
  domain: 'threadCommunication',
});
registerAgentToolService(ISendMessageToThreadTool, SendMessageToThreadTool, {
  name: 'ThreadSend',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(IWaitThreadsTool, WaitThreadsTool, {
  name: 'ThreadWait',
  domain: 'threadCommunication',
});
registerAgentToolService(IRoomReadTool, RoomReadTool, {
  name: 'RoomRead',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
registerAgentToolService(IRoomAddTool, RoomAddTool, {
  name: 'RoomAdd',
  domain: 'threadCommunication',
  when: mainAgentOnly,
});
