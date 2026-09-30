import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type RoomMode = 'mention';
export type RoomPauseReason = 'budget' | 'manual';

export interface RoomBudget {
  readonly botMessagesPerUserMessage: number;
}

export type RoomMember =
  | { readonly kind: 'persona'; readonly personaId: string; readonly sessionId: string; readonly muted: boolean }
  | { readonly kind: 'thread'; readonly sessionId: string; readonly muted: boolean; readonly joinedAt: string; readonly queueWhenBusy: boolean };

export function roomMemberId(member: RoomMember | RoomMemberInput): string {
  return member.kind === 'thread' ? member.sessionId : member.personaId;
}

export interface RoomQuestionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly status: 'queued' | 'active';
  readonly enqueuedAt: number;
}

export interface RoomDocument {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly members: readonly RoomMember[];
  readonly host: string;
  readonly mode: RoomMode;
  readonly budget: RoomBudget;
  readonly workspace: string;
  readonly createdAt: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly generation: number;
  readonly paused: boolean;
  readonly pauseReason?: RoomPauseReason;
  readonly budgetUsed: number;
  readonly userMessageCount: number;
  readonly cursors: Readonly<Record<string, string | undefined>>;
  readonly pendingWakes?: readonly {
    readonly sessionId: string;
    readonly sourceMessageId: string;
    readonly generation: number;
  }[];
  readonly questionQueue?: readonly RoomQuestionRecord[];
}

export type RoomMemberInput =
  | { readonly kind?: 'persona'; readonly personaId: string; readonly muted?: boolean }
  | { readonly kind: 'thread'; readonly sessionId: string; readonly muted?: boolean; readonly queueWhenBusy?: boolean };

export interface CreateThreadRoomInput extends Omit<CreateRoomInput, 'members'> {
  readonly sessionIds: readonly string[];
}

export interface SearchRoomThreadsInput {
  readonly query?: string;
  readonly workspaceId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SearchRoomThreadsResult {
  readonly threads: readonly import('#/app/threadCommunication/threadCommunication').ThreadSummary[];
  readonly nextCursor?: string;
  readonly incomplete?: 'scan_budget';
}

export interface CreateRoomInput {
  readonly id?: string;
  readonly name: string;
  readonly members: readonly RoomMemberInput[];
  readonly host?: string;
  readonly mode?: RoomMode;
  readonly budget?: Partial<RoomBudget>;
  readonly workspace: string;
}

export interface UpdateRoomInput {
  readonly name?: string;
  readonly members?: readonly RoomMemberInput[];
  readonly host?: string;
  readonly mode?: RoomMode;
  readonly budget?: Partial<RoomBudget>;
  readonly workspace?: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

export interface RoomListItem {
  readonly kind: 'room';
  readonly id: string;
  readonly title: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeq: number;
  readonly memberCount: number;
  readonly busy: boolean;
  readonly needsYou: boolean;
  readonly pendingInteraction: 'approval' | 'question' | 'none';
  readonly failed: boolean;
  readonly pinned: boolean;
  readonly archived: boolean;
}

export interface RoomAttachment {
  readonly blobId: string;
  readonly path: string;
  readonly title?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export interface RoomMessage {
  readonly id: string;
  readonly at: string;
  readonly kind: 'message';
  readonly from: 'user' | string;
  readonly username?: string;
  readonly text: string;
  readonly idempotencyKey?: string;
  readonly replyTo?: string;
  readonly mentions: readonly string[];
  readonly attachments?: readonly RoomAttachment[];
}

export interface RoomSystemLog {
  readonly id: string;
  readonly at: string;
  readonly kind: 'system';
  readonly from: 'system';
  readonly event: string;
  readonly text: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type RoomLogEntry = RoomMessage | RoomSystemLog;

export interface PostUserMessageInput {
  readonly text: string;
  readonly username?: string;
  readonly idempotencyKey?: string;
  readonly replyTo?: string;
  readonly attachments?: readonly RoomAttachment[];
}

export interface PostBotMessageInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly text: string;
  readonly to?: string;
  readonly mentions?: readonly string[];
  readonly replyTo?: string;
  readonly attachments?: readonly RoomAttachment[];
}

export interface RoomLogOptions {
  readonly afterId?: string;
  readonly limit?: number;
}

export interface RoomLogResult {
  readonly entries: readonly RoomLogEntry[];
  readonly nextCursor?: string;
  readonly lastSeq?: number;
}

export interface RoomMemberUsage {
  readonly sessionId: string;
  readonly personaId?: string;
  readonly usage?: unknown;
}

export interface RoomUsage {
  readonly userMessages: number;
  readonly botMessages: number;
  readonly budgetUsed: number;
  readonly budgetLimit: number;
  readonly paused: boolean;
  readonly members: readonly RoomMemberUsage[];
  readonly questions?: { readonly activeSessionId?: string; readonly queued: number };
}

export interface RoomChangeEvent {
  readonly roomId: string;
  readonly room: RoomDocument;
  readonly entry?: RoomLogEntry;
  readonly deleted?: boolean;
}

export interface IRoomService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<RoomChangeEvent>;
  list(): Promise<readonly RoomDocument[]>;
  listItems(): Promise<readonly RoomListItem[]>;
  get(roomId: string): Promise<RoomDocument | undefined>;
  create(input: CreateRoomInput): Promise<RoomDocument>;
  createFromThreads(input: CreateThreadRoomInput): Promise<RoomDocument>;
  searchThreads(input?: SearchRoomThreadsInput): Promise<SearchRoomThreadsResult>;
  addMember(roomId: string, member: RoomMemberInput): Promise<RoomDocument>;
  removeMember(roomId: string, memberId: string): Promise<RoomDocument>;
  update(roomId: string, input: UpdateRoomInput): Promise<RoomDocument>;
  delete(roomId: string): Promise<void>;
  postUserMessage(roomId: string, input: PostUserMessageInput): Promise<RoomMessage>;
  postBotMessage(roomId: string, input: PostBotMessageInput): Promise<RoomMessage | undefined>;
  pause(roomId: string): Promise<RoomDocument>;
  continue(roomId: string): Promise<RoomDocument>;
  stop(roomId: string): Promise<RoomDocument>;
  log(roomId: string, options?: RoomLogOptions): Promise<RoomLogResult>;
  usage(roomId: string): Promise<RoomUsage>;
  drain(roomId: string): Promise<void>;
  runQuestion<T>(roomId: string, sessionId: string, request: () => Promise<T>, signal: AbortSignal): Promise<T>;
}

export const IRoomService: ServiceIdentifier<IRoomService> = createDecorator<IRoomService>('roomService');

export const ROOM_DEFAULT_BUDGET = 12;
export const ROOM_MIN_MEMBERS = 2;
export const ROOM_MAX_MEMBERS = 6;
