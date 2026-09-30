import type { BotSummary, BotState, BotUpdateInput, RoomDocument, CreateRoomInput, UpdateRoomInput, RoomMessage, PostRoomMessageInput, RoomLogOptions, RoomLogResult, RoomUsage, RoomMemberInput, CreateThreadRoomInput, SearchRoomThreadsInput, SearchRoomThreadsResult } from '@kiki/protocol';
import type { Caller } from './global.js';

export interface GlobalBotsFacade {
  list(): Promise<readonly BotSummary[]>;
  enable(personaId: string): Promise<BotSummary>;
  ensureHomeSession(personaId: string): Promise<BotSummary>;
  update(personaId: string, input: BotUpdateInput): Promise<BotState>;
}
export interface GlobalRoomsFacade {
  list(): Promise<readonly RoomDocument[]>;
  get(roomId: string): Promise<RoomDocument | undefined>;
  create(input: CreateRoomInput): Promise<RoomDocument>;
  createFromThreads(input: CreateThreadRoomInput): Promise<RoomDocument>;
  searchThreads(input?: SearchRoomThreadsInput): Promise<SearchRoomThreadsResult>;
  addMember(roomId: string, member: RoomMemberInput): Promise<RoomDocument>;
  removeMember(roomId: string, memberId: string): Promise<RoomDocument>;
  update(roomId: string, input: UpdateRoomInput): Promise<RoomDocument>;
  delete(roomId: string): Promise<void>;
  postUserMessage(roomId: string, input: PostRoomMessageInput): Promise<RoomMessage>;
  pause(roomId: string): Promise<RoomDocument>;
  continue(roomId: string): Promise<RoomDocument>;
  stop(roomId: string): Promise<RoomDocument>;
  log(roomId: string, options?: RoomLogOptions): Promise<RoomLogResult>;
  usage(roomId: string): Promise<RoomUsage>;
}
export function createGlobalBots(call: Caller): GlobalBotsFacade {
  return {
    list: () => call('botService', 'list', []) as Promise<BotSummary[]>,
    enable: (id) => call('botService', 'enable', [id]) as Promise<BotSummary>,
    ensureHomeSession: (id) => call('botService', 'ensureHomeSession', [id]) as Promise<BotSummary>,
    update: (id, input) => call('botService', 'update', [id, input]) as Promise<BotState>,
  };
}
export function createGlobalRooms(call: Caller): GlobalRoomsFacade {
  return {
    list: () => call('roomService', 'list', []) as Promise<RoomDocument[]>,
    get: (id) => call('roomService', 'get', [id]) as Promise<RoomDocument | undefined>,
    create: (input) => call('roomService', 'create', [input]) as Promise<RoomDocument>,
    createFromThreads: (input) => call('roomService', 'createFromThreads', [input]) as Promise<RoomDocument>,
    searchThreads: (input) => call('roomService', 'searchThreads', [input]) as Promise<SearchRoomThreadsResult>,
    addMember: (id, member) => call('roomService', 'addMember', [id, member]) as Promise<RoomDocument>,
    removeMember: (id, memberId) => call('roomService', 'removeMember', [id, memberId]) as Promise<RoomDocument>,
    update: (id, input) => call('roomService', 'update', [id, input]) as Promise<RoomDocument>,
    delete: (id) => call('roomService', 'delete', [id]) as Promise<void>,
    postUserMessage: (id, input) => call('roomService', 'postUserMessage', [id, input]) as Promise<RoomMessage>,
    pause: (id) => call('roomService', 'pause', [id]) as Promise<RoomDocument>,
    continue: (id) => call('roomService', 'continue', [id]) as Promise<RoomDocument>,
    stop: (id) => call('roomService', 'stop', [id]) as Promise<RoomDocument>,
    log: (id, options) => call('roomService', 'log', options === undefined ? [id] : [id, options]) as Promise<RoomLogResult>,
    usage: (id) => call('roomService', 'usage', [id]) as Promise<RoomUsage>,
  };
}
