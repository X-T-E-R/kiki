/**
 * Bot and room operations for the GUI, over klient's `rest.bots` /
 * `rest.rooms` (kap-server `routes/botRooms.ts`, frozen `@kiki/protocol`
 * shapes). Screens consume `BotRoomApi` only, so tests and the fixture
 * server stand in behind the same interface.
 */

import { useMemo } from 'react';

import type {
  BotState,
  BotSummary,
  BotUpdateInput,
  CreateRoomInput,
  CreateThreadRoomInput,
  PostRoomMessageInput,
  RoomDocument,
  RoomLogOptions,
  RoomLogResult,
  RoomMemberInput,
  RoomMessage,
  RoomUsage,
  SearchRoomThreadsInput,
  SearchRoomThreadsResult,
  UpdateRoomInput,
} from '@kiki/protocol';

import { useConnection } from '../state/connection';
import type { KikiClient } from './client';

export interface BotRoomApi {
  listBots(): Promise<readonly BotSummary[]>;
  /** Turns a persona into a Bot (creates its home session on first use). */
  enableBot(personaId: string): Promise<BotSummary>;
  /** The Bot's home session, created again if it was removed. */
  ensureBotHome(personaId: string): Promise<BotSummary>;
  updateBot(personaId: string, input: BotUpdateInput): Promise<BotState>;
  listRooms(): Promise<readonly RoomDocument[]>;
  getRoom(roomId: string): Promise<RoomDocument | undefined>;
  createRoom(input: CreateRoomInput): Promise<RoomDocument>;
  /** A room whose members are existing threads; no member session is created. */
  createRoomFromThreads(input: CreateThreadRoomInput): Promise<RoomDocument>;
  /** Threads that may join a room (top-level, unarchived, communication on). */
  searchRoomThreads(input?: SearchRoomThreadsInput): Promise<SearchRoomThreadsResult>;
  addRoomMember(roomId: string, member: RoomMemberInput): Promise<RoomDocument>;
  /** `memberId` is a thread's session id or a persona id. */
  removeRoomMember(roomId: string, memberId: string): Promise<RoomDocument>;
  /** Members, mute, host and budget all change through this one patch. */
  updateRoom(roomId: string, input: UpdateRoomInput): Promise<RoomDocument>;
  deleteRoom(roomId: string): Promise<void>;
  /** Also the interjection path: the server cancels queued wakes and steers running members. */
  postRoomMessage(roomId: string, input: PostRoomMessageInput): Promise<RoomMessage>;
  pauseRoom(roomId: string): Promise<RoomDocument>;
  continueRoom(roomId: string): Promise<RoomDocument>;
  stopRoom(roomId: string): Promise<RoomDocument>;
  roomLog(roomId: string, options?: RoomLogOptions): Promise<RoomLogResult>;
  roomUsage(roomId: string): Promise<RoomUsage>;
}

export function createBotRoomApi(client: KikiClient): BotRoomApi {
  const rest = () => {
    const facade = client.klient.rest;
    if (facade === undefined) throw new Error('Bot and room APIs are unavailable on this transport');
    return facade;
  };
  return {
    listBots: () => rest().bots.list(),
    enableBot: (id) => rest().bots.enable(id),
    ensureBotHome: (id) => rest().bots.ensureHomeSession(id),
    updateBot: (id, input) => rest().bots.update(id, input),
    listRooms: () => rest().rooms.list(),
    getRoom: (id) => rest().rooms.get(id),
    createRoom: (input) => rest().rooms.create(input),
    createRoomFromThreads: (input) => rest().rooms.createFromThreads(input),
    searchRoomThreads: (input) => rest().rooms.searchThreads(input),
    addRoomMember: (id, member) => rest().rooms.addMember(id, member),
    removeRoomMember: (id, memberId) => rest().rooms.removeMember(id, memberId),
    updateRoom: (id, input) => rest().rooms.update(id, input),
    deleteRoom: (id) => rest().rooms.delete(id),
    postRoomMessage: (id, input) => rest().rooms.postUserMessage(id, input),
    pauseRoom: (id) => rest().rooms.pause(id),
    continueRoom: (id) => rest().rooms.continue(id),
    stopRoom: (id) => rest().rooms.stop(id),
    roomLog: (id, options) => rest().rooms.log(id, options),
    roomUsage: (id) => rest().rooms.usage(id),
  };
}

export function useBotRoomApi(): BotRoomApi {
  const { client } = useConnection();
  return useMemo(() => createBotRoomApi(client), [client]);
}

export const BOTS_QUERY_KEY = ['bots'] as const;
export const ROOMS_QUERY_KEY = ['rooms'] as const;
export const roomQueryKey = (id: string) => ['rooms', id] as const;
export const roomLogQueryKey = (id: string) => ['rooms', id, 'log'] as const;
export const roomUsageQueryKey = (id: string) => ['rooms', id, 'usage'] as const;
