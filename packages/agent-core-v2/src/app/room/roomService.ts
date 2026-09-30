import { randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { abortable } from '#/_base/utils/abort';
import { Emitter, type Event } from '#/_base/event';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { BOT_SECTION } from '#/app/bot/configSection';
import { Error2, ErrorCodes, toErrorPayload } from '#/errors';
import { IPersonaStore } from '#/app/persona/personaStore';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IThreadCommunicationService } from '#/app/threadCommunication/threadCommunication';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import type { CreateSessionOptions } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { escapeXml } from '#/_base/utils/xml-escape';

import {
  IRoomService,
  ROOM_DEFAULT_BUDGET,
  ROOM_MAX_MEMBERS,
  ROOM_MIN_MEMBERS,
  roomMemberId,
  type CreateRoomInput,
  type CreateThreadRoomInput,
  type SearchRoomThreadsInput,
  type SearchRoomThreadsResult,
  type PostBotMessageInput,
  type PostUserMessageInput,
  type RoomAttachment,
  type RoomBudget,
  type RoomChangeEvent,
  type RoomDocument,
  type RoomListItem,
  type RoomLogEntry,
  type RoomLogOptions,
  type RoomLogResult,
  type RoomMember,
  type RoomMemberInput,
  type RoomMessage,
  type RoomQuestionRecord,
  type RoomSystemLog,
  type RoomUsage,
  type UpdateRoomInput,
} from './room';

interface RoomIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

interface RoomIndex {
  readonly version: 1;
  readonly rooms: readonly RoomIndexEntry[];
}

interface RoomRuntime {
  queue: Promise<void>;
  questionTail: Promise<void>;
  questionsQueued: number;
  activeQuestionSessionId?: string;
  generation: number;
  readonly pending: Set<WakeWork>;
  readonly lanes: Map<string, Promise<void>>;
  active?: WakeWork;
}

interface RoomWakeRecord {
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly generation: number;
}

interface WakeWork {
  readonly roomId: string;
  readonly member: RoomMember;
  readonly generation: number;
  readonly sourceMessageId: string;
  cancelled: boolean;
}

interface RoomCatchup {
  readonly content: string;
  readonly cursor?: string;
}

export interface RoomPersonaCard {
  readonly name: string;
  readonly job?: string;
}

type PersonaCard = RoomPersonaCard;

interface RoomBotConfig {
  readonly enabled?: boolean;
  readonly roomBudget?: number;
}

interface RoomLogState {
  version: 1;
  nextSeq: number;
  userMessages: number;
  botMessages: number;
  activitySeq?: number;
  updatedAt?: string;
  failed?: boolean;
}

interface RoomLogRecord {
  readonly seq: number;
  readonly activitySeq?: number;
  readonly entry: RoomLogEntry;
}

interface RoomLogSegment {
  readonly entries: readonly RoomLogRecord[];
}

interface RoomLogPointer {
  readonly seq: number;
}

const ROOM_INDEX_SCOPE = '';
const ROOM_INDEX_KEY = 'rooms/index.json';
const ROOM_LOG_KEY = 'log.jsonl';
const ROOM_LOG_STATE_KEY = 'log-state.json';
const ROOM_LOG_SEGMENT_PREFIX = 'log-segments/';
const ROOM_LOG_POINTER_PREFIX = 'log-pointers/';
const ROOM_LOG_SEGMENT_SIZE = 64;
const MAX_LOG_LIMIT = 500;
const ROOM_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export class RoomService extends Disposable implements IRoomService {
  declare readonly _serviceBrand: undefined;

  private readonly changeEmitter = new Emitter<RoomChangeEvent>();
  readonly onDidChange: Event<RoomChangeEvent> = this.changeEmitter.event;
  private readonly runtimes = new Map<string, RoomRuntime>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly logStateFlights = new Map<string, Promise<RoomLogState>>();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IAppendLogStore private readonly appendLogs: IAppendLogStore,
    @IPersonaStore private readonly personas: IPersonaStore,
    @ISessionManager private readonly sessions: ISessionManager,
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IThreadCommunicationService private readonly threadCommunication: IThreadCommunicationService,
  ) {
    super();
    this._register(this.changeEmitter);
  }

  async list(): Promise<readonly RoomDocument[]> {
    const index = await this.documents.get<RoomIndex>(ROOM_INDEX_SCOPE, ROOM_INDEX_KEY);
    if (index === undefined) return [];
    const rooms = await Promise.all(index.rooms.map(async (entry) => this.documents.get<RoomDocument>(roomScope(entry.id), 'room.json')));
    return rooms.filter((room): room is RoomDocument => room !== undefined).map(normalizeRoom);
  }

  async listItems(): Promise<readonly RoomListItem[]> {
    const items: RoomListItem[] = [];
    for (const listed of await this.list()) {
      const item = await this.withRoomLock(listed.id, async (): Promise<RoomListItem | undefined> => {
        const room = await this.get(listed.id);
        if (room === undefined) return undefined;
        const state = await this.ensureLogState(room.id);
        const last = state.updatedAt === undefined ? await this.readIndexedRecord(room.id, state.nextSeq - 1) : undefined;
        const activities = room.members.flatMap((member) => {
          const session = this.sessions.get(member.sessionId);
          return session === undefined ? [] : [session.accessor.get(ISessionActivityView).state()];
        });
        const pendingInteraction = activities.some((activity) => activity.pendingInteraction === 'approval') ? 'approval'
          : activities.some((activity) => activity.pendingInteraction === 'question') || room.questionQueue?.some((question) => question.status === 'active') ? 'question' : 'none';
        const runtime = this.runtimes.get(room.id);
        return {
          kind: 'room', id: room.id, title: room.name, workspace: room.workspace, createdAt: room.createdAt,
          updatedAt: state.updatedAt ?? (state.activitySeq === undefined ? last?.entry.at : undefined) ?? room.createdAt, lastSeq: state.activitySeq ?? state.nextSeq - 1,
          memberCount: room.members.length, pinned: room.pinned === true, archived: room.archived === true,
          busy: activities.some((activity) => activity.busy) || (runtime?.pending.size ?? 0) > 0 || runtime?.active !== undefined,
          needsYou: pendingInteraction !== 'none' || room.pauseReason === 'budget', pendingInteraction,
          failed: state.failed ?? (last?.entry.kind === 'system' && last.entry.event === 'wake_failed'),
        };
      });
      if (item !== undefined) items.push(item);
    }
    return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  }

  async get(roomId: string): Promise<RoomDocument | undefined> {
    validateRoomId(roomId);
    const room = await this.documents.get<RoomDocument>(roomScope(roomId), 'room.json');
    return room === undefined ? undefined : normalizeRoom(room);
  }

  async delete(roomId: string): Promise<void> {
    validateRoomId(roomId);
    await this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      const runtime = this.runtime(roomId);
      this.cancelPending(runtime);
      if (runtime.active !== undefined) runtime.active.cancelled = true;
      await this.cancelRoomDeliveries(roomId, room.generation);
      await this.stopActive(roomId);
      for (const member of room.members) await this.leaveMember(room, member);
      await this.appendLogs.rewrite(roomScope(roomId), ROOM_LOG_KEY, []);
      for (const prefix of [ROOM_LOG_SEGMENT_PREFIX, ROOM_LOG_POINTER_PREFIX]) {
        const keys = new Set([
          ...await this.documents.list(roomScope(roomId), prefix),
          ...(await this.documents.list(`${roomScope(roomId)}/${prefix.slice(0, -1)}`)).map((key) => `${prefix}${key}`),
        ]);
        for (const key of keys) await this.documents.delete(roomScope(roomId), key);
      }
      await this.documents.delete(roomScope(roomId), ROOM_LOG_STATE_KEY);
      await this.documents.delete(roomScope(roomId), 'room.json');
      await this.updateIndex((current) => ({ ...current, rooms: current.rooms.filter((entry) => entry.id !== roomId) }));
      this.runtimes.delete(roomId);
      this.fire({ roomId, room, deleted: true });
    });
  }

  async create(input: CreateRoomInput): Promise<RoomDocument> {
    const id = input.id ?? `room_${randomUUID().replaceAll('-', '')}`;
    validateRoomId(id);
    const name = requiredText(input.name, 'Room name');
    const members = validateMemberInputs(input.members);
    await this.validateMembers(members);
    const host = input.host ?? roomMemberId(members[0]!);
    if (!members.some((member) => roomMemberId(member) === host)) invalid('Room host must be a member.');
    const mode = input.mode ?? 'mention';
    if (mode !== 'mention') invalid(`Unsupported room mode '${mode}'.`);
    const budget = normalizeBudget(input.budget, this.defaultRoomBudget());
    const workspace = requiredText(input.workspace, 'Room workspace');
    return this.withRoomLock(id, async () => {
      if (await this.get(id) !== undefined) invalid(`Room '${id}' already exists.`);
      const cards = await this.loadPersonaCards(members);
      const prompt = renderRoomPrompt({ name, members, host, cards });
      const created = await this.materializeMembers(id, members, workspace, prompt);
      const room: RoomDocument = {
        version: 1, id, name, members: created, host, mode, budget, workspace,
        createdAt: new Date().toISOString(), generation: 0, paused: false,
        budgetUsed: 0, userMessageCount: 0,
        cursors: Object.fromEntries(created.map((member) => [member.sessionId, undefined])),
        pendingWakes: [],
      };
      await this.documents.set(roomScope(id), 'room.json', room);
      await this.documents.set(roomScope(id), ROOM_LOG_STATE_KEY, emptyRoomLogState());
      await this.updateIndex((current) => ({ version: 1, rooms: [...current.rooms, { id, name, createdAt: room.createdAt }] }));
      await this.appendGreetings(room, room.members);
      await this.announceJoined(room, room.members);
      this.runtime(id).generation = room.generation;
      this.fire({ roomId: id, room });
      return room;
    });
  }

  createFromThreads(input: CreateThreadRoomInput): Promise<RoomDocument> {
    const { sessionIds, ...rest } = input;
    return this.create({ ...rest, members: sessionIds.map((sessionId) => ({ kind: 'thread', sessionId })) });
  }

  async searchThreads(input: SearchRoomThreadsInput = {}): Promise<SearchRoomThreadsResult> {
    const conditions = JSON.stringify([input.query ?? '', input.workspaceId ?? null]);
    let before: string | undefined;
    if (input.cursor !== undefined) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (cursor['v'] !== 1 || cursor['conditions'] !== conditions || typeof cursor['before'] !== 'string') throw new Error('invalid');
        before = cursor['before'];
      } catch { invalid('Room thread search cursor does not match the filters.'); }
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const threads: SearchRoomThreadsResult['threads'][number][] = [];
    const query = (input.query ?? '').toLocaleLowerCase();
    let scanned = 0;
    let hasMore = false;
    while (threads.length < limit && scanned < 500) {
      const page = await this.sessionIndex.listRecent({ workspaceIds: input.workspaceId === undefined ? undefined : [input.workspaceId], includeArchived: false, before, limit: Math.min(100, 500 - scanned) });
      hasMore = page.nextCursor !== undefined;
      if (page.items.length === 0) break;
      for (const [index, summary] of page.items.entries()) {
        before = summary.id;
        scanned++;
        if (isChildSession(summary.custom) || !`${summary.id} ${summary.title ?? ''}`.toLocaleLowerCase().includes(query)) continue;
        if (!(await this.threadCommunication.isWorkspaceEnabled(summary.workspaceId))) continue;
        const session = this.sessions.get(summary.id);
        threads.push({ ref: { hostId: this.threadCommunication.hostId, workspaceId: summary.workspaceId, sessionId: summary.id }, title: summary.title, updatedAt: summary.updatedAt, createdAt: summary.createdAt,
          state: session === undefined ? 'cold' : session.accessor.get(ISessionActivityView).state().busy ? 'running' : 'idle' });
        if (threads.length === limit) { hasMore = index < page.items.length - 1 || hasMore; break; }
      }
      if (!hasMore) break;
    }
    return { threads, incomplete: hasMore && scanned >= 500 ? 'scan_budget' : undefined,
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, conditions, before })).toString('base64url') : undefined };
  }

  addMember(roomId: string, member: RoomMemberInput): Promise<RoomDocument> {
    validateRoomId(roomId);
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      return this.updateLocked(roomId, { members: [...room.members, member] });
    });
  }

  removeMember(roomId: string, memberId: string): Promise<RoomDocument> {
    validateRoomId(roomId);
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      if (!room.members.some((member) => roomMemberId(member) === memberId)) invalid('Room member not found.');
      const members = room.members.filter((member) => roomMemberId(member) !== memberId);
      return this.updateLocked(roomId, { members, host: room.host === memberId && members.length > 0 ? roomMemberId(members[0]!) : room.host });
    });
  }

  update(roomId: string, input: UpdateRoomInput): Promise<RoomDocument> {
    validateRoomId(roomId);
    return this.withRoomLock(roomId, () => this.updateLocked(roomId, input));
  }

  private async updateLocked(roomId: string, input: UpdateRoomInput): Promise<RoomDocument> {
    const current = await this.requireRoom(roomId);
    const name = input.name === undefined ? current.name : requiredText(input.name, 'Room name');
    const mode = input.mode ?? current.mode;
    if (mode !== 'mention') invalid(`Unsupported room mode '${mode}'.`);
    const workspace = input.workspace === undefined ? current.workspace : requiredText(input.workspace, 'Room workspace');
    const budget = input.budget === undefined ? current.budget : normalizeBudget({ ...current.budget, ...input.budget });
    const requested = input.members === undefined ? current.members : validateMemberInputs(input.members, 0);
    const addedInputs = requested.filter((member) => !current.members.some((existing) => existing.kind === (member.kind ?? 'persona') && roomMemberId(existing) === roomMemberId(member)));
    await this.validateMembers(addedInputs);
    const host = input.host ?? current.host;
    if (requested.length > 0 && !requested.some((member) => roomMemberId(member) === host)) invalid('Room host must be a member.');
    const cards = await this.loadPersonaCards(requested);
    const added = await this.materializeMembers(roomId, addedInputs, workspace, renderRoomPrompt({ name, members: requested, host, cards }));
    const members = requested.map((member): RoomMember => {
      const existing = current.members.find((candidate) => candidate.kind === (member.kind ?? 'persona') && roomMemberId(candidate) === roomMemberId(member));
      if (existing === undefined) return added.find((candidate) => roomMemberId(candidate) === roomMemberId(member))!;
      return existing.kind === 'thread' && member.kind === 'thread'
        ? { ...existing, muted: member.muted === true, queueWhenBusy: member.queueWhenBusy !== false }
        : { ...existing, muted: member.muted === true };
    });
    const personaIds = (list: readonly RoomMember[]) => list.flatMap((member) => member.kind === 'persona' ? [member.personaId] : []).toSorted().join(',');
    const rosterChanged = personaIds(current.members) !== personaIds(members);
    const next: RoomDocument = { ...current, name, mode, workspace, budget, host, members,
      pinned: input.pinned ?? current.pinned ?? false, archived: input.archived ?? current.archived ?? false,
      cursors: Object.fromEntries(members.map((member) => [member.sessionId, current.cursors[member.sessionId]])),
      generation: rosterChanged || (input.archived === true && !current.archived) ? current.generation + 1 : current.generation,
      pendingWakes: rosterChanged || input.archived === true ? [] : (current.pendingWakes ?? []).filter((wake) => members.some((member) => member.sessionId === wake.sessionId)) };
    if (rosterChanged || (input.archived === true && !current.archived)) {
      const runtime = this.runtime(roomId);
      this.cancelPending(runtime);
      if (runtime.active !== undefined) runtime.active.cancelled = true;
      runtime.generation = next.generation;
      await this.cancelRoomDeliveries(roomId, current.generation);
      if (input.archived === true) await this.stopActive(roomId);
    }
    await this.documents.set(roomScope(roomId), 'room.json', next);
    await this.updateIndex((index) => ({ version: 1, rooms: index.rooms.map((entry) => entry.id === roomId ? { ...entry, name } : entry) }));
    await this.appendGreetings(next, added);
    const removed = current.members.filter((member) => !members.some((candidate) => candidate.sessionId === member.sessionId));
    if (!rosterChanged) {
      const runtime = this.runtime(roomId);
      for (const work of runtime.pending) {
        if (removed.some((member) => member.sessionId === work.member.sessionId)) { work.cancelled = true; runtime.pending.delete(work); }
      }
    }
    for (const member of removed) {
      await this.leaveMember(current, member);
      if (member.kind === 'thread') await this.appendSystem(roomId, 'member_left', `${member.sessionId} left the room.`, { memberId: member.sessionId, kind: 'thread' });
    }
    await this.announceJoined(next, added);
    if (workspace !== current.workspace) await this.appendSystem(roomId, 'workspace_changed', 'Room classification workspace changed; member permissions are unchanged.', { workspace });
    if (name !== current.name) await this.appendSystem(roomId, 'room_renamed', `Room renamed to ${name}.`, { name });
    if (host !== current.host) await this.appendSystem(roomId, 'host_changed', `Room host changed to ${host}.`, { host });
    if (rosterChanged) await this.appendSystem(roomId, 'roster_changed', 'Room roster updated.', { members: members.map(roomMemberId) });
    this.fire({ roomId, room: next });
    return next;
  }

  private async validateMembers(members: readonly RoomMemberInput[]): Promise<void> {
    if (members.some((member) => member.kind !== 'thread')) this.ensureBotEnabled();
    for (const member of members) {
      if (member.kind !== 'thread') continue;
      const summary = await this.sessionIndex.get(member.sessionId);
      if (summary === undefined || summary.archived) invalid('Only existing unarchived threads can join a room.');
      if (isChildSession(summary.custom)) invalid('Subagents cannot join rooms; communicate through their parent thread.');
      if (!(await this.threadCommunication.isWorkspaceEnabled(summary.workspaceId))) {
        throw new Error2(ErrorCodes.THREAD_DISABLED, 'Thread communication is disabled for this thread.');
      }
    }
  }

  private async materializeMembers(roomId: string, inputs: readonly RoomMemberInput[], workspace: string, prompt: string): Promise<RoomMember[]> {
    const members: RoomMember[] = [];
    try {
      for (const input of inputs) {
        if (input.kind === 'thread') {
          members.push({ kind: 'thread', sessionId: input.sessionId, muted: input.muted === true, joinedAt: new Date().toISOString(), queueWhenBusy: input.queueWhenBusy !== false });
        } else {
          const session = await this.createMemberSession(roomId, input, workspace, prompt);
          members.push({ kind: 'persona', personaId: input.personaId, sessionId: session.id, muted: input.muted === true });
        }
      }
    } catch (error) {
      await Promise.all(members.filter((member) => member.kind === 'persona').map((member) => this.sessions.delete(member.sessionId).catch(() => undefined)));
      throw error;
    }
    return members;
  }

  private async leaveMember(room: RoomDocument, member: RoomMember): Promise<void> {
    if (member.kind === 'persona') { await this.sessions.archive(member.sessionId); return; }
    await this.remindThread(member.sessionId, `Left room "${room.name}" (${room.id}). Its discussion log remains in the room; room messages no longer reach this thread.`, 'room_left');
  }

  private async announceJoined(room: RoomDocument, members: readonly RoomMember[]): Promise<void> {
    for (const member of members) {
      if (member.kind !== 'thread') continue;
      await this.appendSystem(room.id, 'member_joined', `${member.sessionId} joined the room.`, { memberId: member.sessionId, kind: 'thread' });
      await this.remindThread(member.sessionId, `Joined room "${room.name}" (${room.id}). You are woken when mentioned, and a message that mentions no one goes to the room host. To speak there, use ThreadSend({room: "${room.id}", content, mentions?}). Your workspace and permissions are unchanged.`, 'room_joined');
    }
  }

  private async remindThread(sessionId: string, text: string, variant: string): Promise<void> {
    try {
      const session = await this.sessions.resume(sessionId);
      if (session === undefined) return;
      const main = await ensureMainAgent(session);
      main.accessor.get(IAgentSystemReminderService).appendSystemReminder(text, { kind: 'injection', variant });
    } catch {}
  }

  async postUserMessage(roomId: string, input: PostUserMessageInput): Promise<RoomMessage> {
    validateRoomId(roomId);
    const text = requiredMessageText(input.text);
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      if (room.members.some((member) => member.kind === 'persona')) this.ensureBotEnabled();
      const existing = input.idempotencyKey === undefined ? undefined : await this.findMessage(roomId, `user:${input.idempotencyKey}`);
      if (existing !== undefined) return existing;
      const cards = await this.loadPersonaCards(room.members);
      const mentions = resolveMentions(text, cards);
      const idempotencyKey = `user:${input.idempotencyKey ?? messageId()}`;
      const entry: RoomMessage = {
        id: messageId(),
        at: new Date().toISOString(),
        kind: 'message',
        from: 'user',
        username: optionalDisplayName(input.username),
        text,
        idempotencyKey,
        replyTo: input.replyTo,
        mentions,
        attachments: normalizeAttachments(input.attachments),
      };
      const interruptPersonas = room.members.every((member) => member.kind === 'persona');
      const generation = room.generation + (interruptPersonas ? 1 : 0);
      const next: RoomDocument = {
        ...room,
        generation,
        paused: room.paused && room.pauseReason === 'manual',
        pauseReason: room.paused && room.pauseReason === 'manual' ? 'manual' : undefined,
        budgetUsed: 0,
        userMessageCount: room.userMessageCount + 1,
      };
      await this.appendMessage(roomId, entry);
      await this.documents.set(roomScope(roomId), 'room.json', next);
      const runtime = this.runtime(roomId);
      runtime.generation = generation;
      const active = runtime.active;
      if (interruptPersonas) {
        this.cancelPending(runtime);
        await this.clearPendingWakes(roomId);
        await this.cancelRoomDeliveries(roomId, room.generation);
        if (active !== undefined) void this.steerActive(room, active, entry, generation).catch(() => undefined);
      }
      if (!next.paused) {
        const targets = resolveUserTargets(next, mentions);
        for (const member of targets) {
          if (interruptPersonas && active?.member.sessionId === member.sessionId) continue;
          await this.enqueueWake(roomId, member, generation, entry.id);
        }
      }
      this.fire({ roomId, room: next, entry });
      return entry;
    });
  }

  async postBotMessage(roomId: string, input: PostBotMessageInput): Promise<RoomMessage | undefined> {
    validateRoomId(roomId);
    const text = requiredMessageText(input.text);
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      const member = room.members.find((candidate) => candidate.sessionId === input.sessionId);
      if (member === undefined) invalid(`Session '${input.sessionId}' is not a member of room '${roomId}'.`);
      await this.validateMembers([member]);
      const existing = await this.findMessage(roomId, `bot:${input.sessionId}:${input.toolCallId}`);
      if (existing !== undefined) {
        if (existing.text !== text) throw new Error2(ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT, 'Room send key was already used for different content.');
        return existing;
      }
      if ((room.paused && room.pauseReason !== 'manual') || room.budgetUsed >= room.budget.botMessagesPerUserMessage) return undefined;
      const cards = await this.loadPersonaCards(room.members);
      if (input.mentions?.some((id) => !cards.has(id))) invalid('A mentioned room member was not found.');
      const mentions = [...new Set([...resolveMentions([input.to, text].filter(Boolean).join(' '), cards), ...(input.mentions ?? [])])];
      const idempotencyKey = `bot:${input.sessionId}:${input.toolCallId}`;
      const entry: RoomMessage = {
        id: messageId(),
        at: new Date().toISOString(),
        kind: 'message',
        from: roomMemberId(member),
        text,
        idempotencyKey,
        replyTo: input.replyTo,
        mentions,
        attachments: normalizeAttachments(input.attachments),
      };
      const next: RoomDocument = { ...room, budgetUsed: room.budgetUsed + 1 };
      await this.appendMessage(roomId, entry);
      await this.documents.set(roomScope(roomId), 'room.json', next);
      this.fire({ roomId, room: next, entry });
      if (next.budgetUsed >= next.budget.botMessagesPerUserMessage) {
        const paused: RoomDocument = { ...next, paused: true, pauseReason: 'budget' };
        await this.documents.set(roomScope(roomId), 'room.json', paused);
        await this.appendSystem(roomId, 'budget_exhausted', `Discussion paused after ${paused.budget.botMessagesPerUserMessage} bot messages.`, {
          budget: paused.budget.botMessagesPerUserMessage,
        });
        const runtime = this.runtime(roomId);
        this.cancelPending(runtime);
        await this.cancelRoomDeliveries(roomId, paused.generation);
        this.fire({ roomId, room: paused });
        return entry;
      }
      const targets = resolveBotTargets(room, member, mentions);
      if (!room.paused) {
        for (const target of targets) await this.enqueueWake(roomId, target, room.generation, entry.id);
      }
      return entry;
    });
  }

  async pause(roomId: string): Promise<RoomDocument> {
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      if (room.paused && room.pauseReason === 'manual') return room;
      const next: RoomDocument = { ...room, paused: true, pauseReason: 'manual' };
      await this.documents.set(roomScope(roomId), 'room.json', next);
      const runtime = this.runtime(roomId);
      this.cancelPending(runtime);
      await this.clearPendingWakes(roomId);
      await this.cancelRoomDeliveries(roomId, room.generation);
      await this.appendSystem(roomId, 'paused', 'Discussion paused.', undefined);
      this.fire({ roomId, room: next });
      return next;
    });
  }

  async continue(roomId: string): Promise<RoomDocument> {
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      if (room.members.some((member) => member.kind === 'persona')) this.ensureBotEnabled();
      if (!room.paused) return room;
      const pending = room.pauseReason === 'budget' ? [...(room.pendingWakes ?? [])] : [];
      const next: RoomDocument = {
        ...room,
        paused: false,
        pauseReason: undefined,
        budgetUsed: 0,
        pendingWakes: [],
      };
      await this.documents.set(roomScope(roomId), 'room.json', next);
      await this.appendSystem(roomId, 'continued', 'Discussion continued.', { budget: next.budget.botMessagesPerUserMessage });
      const runtime = this.runtime(roomId);
      runtime.generation = next.generation;
      for (const wake of pending) {
        const member = next.members.find((candidate) => candidate.sessionId === wake.sessionId);
        const active = runtime.active;
        if (active?.member.sessionId === wake.sessionId && active.sourceMessageId === wake.sourceMessageId) continue;
        if (member !== undefined && wake.generation === next.generation) {
          await this.enqueueWake(roomId, member, wake.generation, wake.sourceMessageId);
        }
      }
      const resumed = await this.requireRoom(roomId);
      this.fire({ roomId, room: resumed });
      return resumed;
    });
  }

  async stop(roomId: string): Promise<RoomDocument> {
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      const next: RoomDocument = { ...room, paused: false, pauseReason: undefined };
      await this.documents.set(roomScope(roomId), 'room.json', next);
      this.cancelPending(this.runtime(roomId));
      await this.clearPendingWakes(roomId);
      await this.cancelRoomDeliveries(roomId, room.generation);
      await this.stopActive(roomId);
      await this.appendSystem(roomId, 'stopped', 'All active discussion turns stopped.', undefined);
      this.fire({ roomId, room: next });
      return next;
    });
  }

  async log(roomId: string, options: RoomLogOptions = {}): Promise<RoomLogResult> {
    await this.requireRoom(roomId);
    const limit = Math.min(Math.max(options.limit ?? MAX_LOG_LIMIT, 1), MAX_LOG_LIMIT);
    const entries = await this.readIndexedLog(roomId, options.afterId, limit + 1);
    const page = entries.slice(0, limit);
    const lastId = page.at(-1)?.id ?? options.afterId;
    const pointer = lastId === undefined ? undefined : await this.documents.get<RoomLogPointer>(roomScope(roomId), roomLogPointerKey(lastId));
    const record = pointer === undefined ? undefined : await this.readIndexedRecord(roomId, pointer.seq);
    return {
      entries: page,
      nextCursor: entries.length > limit ? page.at(-1)?.id : undefined,
      lastSeq: record?.activitySeq ?? record?.seq ?? 0,
    };
  }

  async usage(roomId: string): Promise<RoomUsage> {
    const room = await this.requireRoom(roomId);
    const state = await this.ensureLogState(roomId);
    const members = await Promise.all(room.members.map(async (member) => {
      const session = this.sessions.get(member.sessionId);
      let usage: unknown;
      if (session !== undefined) {
        try {
          usage = session.accessor.get(ISessionMetadata).usage();
        } catch {
          usage = undefined;
        }
      }
      if (usage === undefined) usage = (await this.sessionIndex.get(member.sessionId))?.usage;
      return { sessionId: member.sessionId, personaId: member.kind === 'persona' ? member.personaId : undefined, usage };
    }));
    return {
      userMessages: state.userMessages,
      botMessages: state.botMessages,
      budgetUsed: room.budgetUsed,
      budgetLimit: room.budget.botMessagesPerUserMessage,
      paused: room.paused,
      members,
      questions: {
        activeSessionId: this.runtime(roomId).activeQuestionSessionId ?? room.questionQueue?.find((question) => question.status === 'active')?.sessionId,
        queued: Math.max(
          room.questionQueue?.filter((question) => question.status === 'queued').length ?? 0,
          this.runtime(roomId).questionsQueued,
        ),
      },
    };
  }

  async runQuestion<T>(roomId: string, sessionId: string, request: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const room = await this.requireRoom(roomId);
    if (!room.members.some((member) => member.sessionId === sessionId)) invalid('Only a room member may ask a room question.');
    signal.throwIfAborted();
    const runtime = this.runtime(roomId);
    runtime.questionsQueued++;
    const question: RoomQuestionRecord = {
      id: `question_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`,
      sessionId,
      status: 'queued',
      enqueuedAt: Date.now(),
    };
    await this.withRoomLock(roomId, async () => {
      const current = await this.requireRoom(roomId);
      await this.documents.set(roomScope(roomId), 'room.json', {
        ...current,
        questionQueue: [...(current.questionQueue ?? []), question],
      });
    });
    const previous = runtime.questionTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runtime.questionTail = previous.then(() => gate);
    let active = false;
    try {
      await abortable(previous, signal);
      await this.waitForQuestionTurn(roomId, question.id, signal);
      signal.throwIfAborted();
      runtime.questionsQueued--;
      runtime.activeQuestionSessionId = sessionId;
      active = true;
      await this.setQuestionStatus(roomId, question.id, 'active');
      return await request();
    } finally {
      if (active) runtime.activeQuestionSessionId = undefined;
      else runtime.questionsQueued--;
      release();
      await this.removeQuestion(roomId, question.id);
    }
  }

  private async waitForQuestionTurn(roomId: string, questionId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const room = await this.requireRoom(roomId);
      const head = room.questionQueue?.[0];
      if (head?.status === 'active' && this.runtime(roomId).activeQuestionSessionId === undefined) {
        await this.removeQuestion(roomId, head.id);
        continue;
      }
      if (head?.id === questionId) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        const abort = (): void => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        timer.unref?.();
      });
    }
  }

  private async setQuestionStatus(roomId: string, questionId: string, status: RoomQuestionRecord['status']): Promise<void> {
    await this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      const questionQueue = (room.questionQueue ?? []).map((question) =>
        question.id === questionId ? { ...question, status } : question,
      );
      await this.documents.set(roomScope(roomId), 'room.json', { ...room, questionQueue });
    });
  }

  private async removeQuestion(roomId: string, questionId: string): Promise<void> {
    await this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      const questionQueue = (room.questionQueue ?? []).filter((question) => question.id !== questionId);
      if (questionQueue.length === (room.questionQueue ?? []).length) return;
      await this.documents.set(roomScope(roomId), 'room.json', {
        ...room,
        questionQueue: questionQueue.length === 0 ? undefined : questionQueue,
      });
    });
  }

  async drain(roomId: string): Promise<void> {
    validateRoomId(roomId);
    const runtime = this.runtime(roomId);
    for (;;) {
      const queue = runtime.queue;
      const lanes = [...runtime.lanes.values()];
      await Promise.all([queue, ...lanes]);
      if (runtime.queue === queue && [...runtime.lanes.values()].every((lane) => lanes.includes(lane))) return;
    }
  }

  private async deliverWake(work: WakeWork): Promise<void> {
    const room = await this.requireRoom(work.roomId);
    if (work.cancelled || room.paused || room.generation !== work.generation) return;
    if (!room.members.some((member) => member.sessionId === work.member.sessionId)) return;
    const entries = await this.readIndexedLog(work.roomId, room.cursors[work.member.sessionId]);
    const catchup = renderCatchup(entries, room, work.member, work.sourceMessageId, await this.loadPersonaCards(room.members).catch(() => new Map<string, PersonaCard>()));
    const target = await this.threadRef(room, work.member);
    const receipt = await this.threadCommunication.sendRoomMessage({
      target,
      roomId: work.roomId,
      content: catchup.content,
      idempotencyKey: `room:${work.roomId}:${work.generation}:${roomMemberId(work.member)}:${work.sourceMessageId}`,
      targeted: true,
      generation: work.generation,
      queueWhenBusy: work.member.kind === 'thread' ? work.member.queueWhenBusy : undefined,
      requireCommunication: work.member.kind === 'thread' ? true : undefined,
    });
    await this.threadCommunication.waitRoomDelivery({ target, messageId: receipt.messageId });
    if (work.cancelled) return;
    await this.withRoomLock(work.roomId, async () => {
      const latest = await this.requireRoom(work.roomId);
      if (latest.generation !== work.generation) return;
      const currentCursor = latest.cursors[work.member.sessionId];
      const nextCursor = catchup.cursor ?? currentCursor;
      const pendingWakes = latest.pendingWakes ?? [];
      const nextPendingWakes = pendingWakes.filter((pending) =>
        !(pending.sessionId === work.member.sessionId && pending.sourceMessageId === work.sourceMessageId && pending.generation === work.generation));
      const updated: RoomDocument = {
        ...latest,
        cursors: { ...latest.cursors, [work.member.sessionId]: nextCursor },
        pendingWakes: nextPendingWakes,
      };
      if (currentCursor === nextCursor && nextPendingWakes.length === pendingWakes.length) return;
      await this.documents.set(roomScope(work.roomId), 'room.json', updated);
      this.fire({ roomId: work.roomId, room: updated });
    });
  }

  private async steerActive(room: RoomDocument, active: WakeWork, entry: RoomMessage, generation: number): Promise<void> {
    const entries = await this.readIndexedLog(room.id, room.cursors[active.member.sessionId]);
    const catchup = renderCatchup(entries, { ...room, generation }, active.member, entry.id);
    const target = await this.threadRef(room, active.member);
    const receipt = await this.threadCommunication.sendRoomMessage({
      target,
      roomId: room.id,
      content: catchup.content,
      idempotencyKey: `room-steer:${room.id}:${generation}:${roomMemberId(active.member)}:${entry.id}`,
      targeted: true,
      generation,
    });
    await this.threadCommunication.waitRoomDelivery({ target, messageId: receipt.messageId });
    if (catchup.cursor !== undefined) {
      await this.withRoomLock(room.id, async () => {
        const latest = await this.requireRoom(room.id);
        const updated: RoomDocument = {
          ...latest,
          cursors: { ...latest.cursors, [active.member.sessionId]: catchup.cursor },
        };
        await this.documents.set(roomScope(room.id), 'room.json', updated);
      });
    }
  }

  private async threadRef(room: RoomDocument, member: RoomMember): Promise<ThreadRef> {
    const session = this.sessions.get(member.sessionId);
    try {
      const workspaceId = session?.accessor.get(ISessionContext).workspaceId;
      if (workspaceId !== undefined) {
        return {
          hostId: this.threadCommunication.hostId,
          workspaceId,
          sessionId: member.sessionId,
        };
      }
    } catch {}
    const persisted = await this.sessionIndex.get(member.sessionId);
    return {
      hostId: this.threadCommunication.hostId,
      workspaceId: persisted?.workspaceId ?? room.workspace,
      sessionId: member.sessionId,
    };
  }

  private async stopActive(roomId: string): Promise<void> {
    const runtime = this.runtime(roomId);
    const active = runtime.active;
    if (active === undefined || active.member.kind === 'thread') return;
    const session = this.sessions.get(active.member.sessionId);
    if (session === undefined) return;
    const agents = session.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      const prompt = agent.accessor.get(IAgentPromptService);
      const activePrompt = prompt.list().active;
      if (activePrompt !== undefined) prompt.abort(activePrompt.id, new Error2(ErrorCodes.REQUEST_INVALID, 'Room discussion stopped.'));
    }
  }

  private async enqueueWake(roomId: string, member: RoomMember, generation: number, sourceMessageId: string): Promise<void> {
    const runtime = this.runtime(roomId);
    if (member.kind === 'thread' && member.queueWhenBusy && this.isSessionBusy(member.sessionId)) {
      await this.appendSystem(roomId, 'member_busy', `${member.sessionId} is busy and will receive this message after its current turn.`, { sessionId: member.sessionId, sourceMessageId });
    }
    const work: WakeWork = { roomId, member, generation, sourceMessageId, cancelled: false };
    runtime.pending.add(work);
    await this.updatePendingWakes(roomId, (pending) => [
      ...pending,
      { sessionId: member.sessionId, sourceMessageId, generation },
    ]);
    const run = async (): Promise<void> => {
      await this.withRoomLock(roomId, async () => {
        runtime.pending.delete(work);
        if (!work.cancelled && member.kind === 'persona') runtime.active = work;
      });
      if (work.cancelled) return;
      try {
        await this.deliverWake(work);
      } catch (error) {
        await this.withRoomLock(roomId, async () => {
          if (work.cancelled || this.runtimes.get(roomId) !== runtime) return;
          const failure = toErrorPayload(error);
          await this.appendSystem(work.roomId, 'wake_failed', `Unable to wake ${roomMemberId(work.member)}: ${failure.message}`, {
            memberId: roomMemberId(work.member),
            sessionId: work.member.sessionId,
            sourceMessageId: work.sourceMessageId,
            reason_code: failure.code,
            reason: failure.message,
            retryable: failure.retryable,
            provider: failure.details?.['provider'],
          });
        }).catch(() => undefined);
      } finally {
        runtime.pending.delete(work);
        if (runtime.active === work) runtime.active = undefined;
      }
    };
    if (member.kind === 'persona') {
      runtime.queue = runtime.queue.then(run, async () => undefined);
      return;
    }
    const lane = (runtime.lanes.get(member.sessionId) ?? Promise.resolve()).then(run, async () => undefined);
    runtime.lanes.set(member.sessionId, lane);
    void lane.then(() => { if (runtime.lanes.get(member.sessionId) === lane) runtime.lanes.delete(member.sessionId); });
  }

  private isSessionBusy(sessionId: string): boolean {
    try {
      return this.sessions.get(sessionId)?.accessor.get(ISessionActivityView).state().busy === true;
    } catch {
      return false;
    }
  }

  private cancelPending(runtime: RoomRuntime): void {
    for (const work of runtime.pending) work.cancelled = true;
    runtime.pending.clear();
  }

  private async clearPendingWakes(roomId: string): Promise<void> {
    await this.updatePendingWakes(roomId, () => []);
  }

  private async updatePendingWakes(roomId: string, updater: (pending: readonly RoomWakeRecord[]) => readonly RoomWakeRecord[]): Promise<void> {
    await this.documents.update<RoomDocument>(roomScope(roomId), 'room.json', (current) => {
      if (current === undefined) return current;
      return { ...current, pendingWakes: updater(current.pendingWakes ?? []) };
    });
  }

  private runtime(roomId: string): RoomRuntime {
    let runtime = this.runtimes.get(roomId);
    if (runtime === undefined) {
      runtime = { queue: Promise.resolve(), questionTail: Promise.resolve(), questionsQueued: 0, generation: 0, pending: new Set(), lanes: new Map() };
      this.runtimes.set(roomId, runtime);
    }
    return runtime;
  }

  private async createMemberSession(roomId: string, member: Exclude<RoomMemberInput, { kind: 'thread' }>, workspace: string, roomPrompt: string): Promise<ISessionScopeHandle> {
    const sessionId = `room_${roomId}_${member.personaId}_${randomUUID().slice(0, 8)}`;
    const binding: NonNullable<CreateSessionOptions['mainAgentBinding']> = {
      persona: member.personaId,
      roomPrompt,
    };
    const options: CreateSessionOptions = {
      sessionId,
      workDir: workspace,
      mainAgentBinding: binding,
      delivery: 'message',
    };
    const session = await this.sessions.create(options);
    try {
      const metadata = session.accessor.get(ISessionMetadata);
      const current = await metadata.read();
      await metadata.update({ custom: { ...current.custom, room_member_of: roomId, room_persona_id: member.personaId } });
    } catch {
      await this.sessions.delete(session.id).catch(() => undefined);
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Unable to persist room member metadata for session '${session.id}'.`);
    }
    return session;
  }

  private async appendGreetings(room: RoomDocument, members: readonly RoomMember[]): Promise<void> {
    if (members.length === 0) return;
    const cards = await this.loadPersonaCards(members);
    for (const member of members) {
      if (member.kind === 'thread') continue;
      const snapshot = await this.personas.get(member.personaId);
      const greeting = snapshot?.definition.greeting;
      if (greeting === undefined || greeting.trim().length === 0) continue;
      const idempotencyKey = `greeting:${member.sessionId}`;
      const entry: RoomMessage = {
        id: messageId(),
        at: new Date().toISOString(),
        kind: 'message',
        from: roomMemberId(member),
        text: greeting,
        idempotencyKey,
        mentions: resolveMentions(greeting, cards),
      };
      const existing = await this.findMessage(room.id, idempotencyKey);
      if (existing !== undefined) continue;
      await this.appendMessage(room.id, entry);
      this.fire({ roomId: room.id, room, entry });
    }
  }

  private async loadPersonaCards(members: readonly (RoomMember | RoomMemberInput)[]): Promise<ReadonlyMap<string, PersonaCard>> {
    const cards = new Map<string, PersonaCard>();
    for (const member of members) {
      if (member.kind === 'thread') {
        const summary = await this.sessionIndex.get(member.sessionId);
        cards.set(member.sessionId, { name: summary?.title ?? member.sessionId });
        continue;
      }
      const snapshot = await this.personas.get(member.personaId);
      if (snapshot === undefined) invalid(`Persona '${member.personaId}' was not found.`);
      cards.set(member.personaId, { name: snapshot.definition.name, job: snapshot.definition.job });
    }
    return cards;
  }

  private async requireRoom(roomId: string): Promise<RoomDocument> {
    const room = await this.get(roomId);
    if (room === undefined) invalid(`Room '${roomId}' was not found.`);
    return normalizeRoom(room);
  }

  private async findMessage(roomId: string, key: string): Promise<RoomMessage | undefined> {
    const pointer = await this.documents.get<RoomLogPointer>(roomScope(roomId), roomLogPointerKey(key));
    if (pointer === undefined) return undefined;
    const record = await this.readIndexedRecord(roomId, pointer.seq);
    return record?.entry.kind === 'message' ? record.entry : undefined;
  }

  private async readIndexedLog(
    roomId: string,
    afterId?: string,
    limit = Number.MAX_SAFE_INTEGER,
  ): Promise<readonly RoomLogEntry[]> {
    const state = await this.ensureLogState(roomId);
    let firstSeq = 1;
    if (afterId !== undefined) {
      const pointer = await this.documents.get<RoomLogPointer>(roomScope(roomId), roomLogPointerKey(afterId));
      if (pointer !== undefined) firstSeq = pointer.seq + 1;
    }
    const entries: RoomLogEntry[] = [];
    for (let seq = firstSeq; seq < state.nextSeq && entries.length < limit;) {
      const segment = await this.documents.get<RoomLogSegment>(
        roomScope(roomId),
        roomLogSegmentKey(seq),
      );
      if (segment === undefined) break;
      for (const record of segment.entries) {
        if (record.seq < firstSeq) continue;
        entries.push(record.entry);
        if (entries.length >= limit) break;
      }
      const last = segment.entries.at(-1)?.seq;
      if (last === undefined || last < seq) break;
      seq = last + 1;
    }
    return entries;
  }

  private async readIndexedRecord(roomId: string, seq: number): Promise<RoomLogRecord | undefined> {
    const segment = await this.documents.get<RoomLogSegment>(roomScope(roomId), roomLogSegmentKey(seq));
    return segment?.entries.find((record) => record.seq === seq);
  }

  private async ensureLogState(roomId: string): Promise<RoomLogState> {
    const existing = await this.documents.get<RoomLogState>(roomScope(roomId), ROOM_LOG_STATE_KEY);
    if (existing !== undefined) return existing;
    const flight = this.logStateFlights.get(roomId);
    if (flight !== undefined) return flight;
    const migration = this.migrateLegacyLog(roomId).finally(() => {
      if (this.logStateFlights.get(roomId) === migration) this.logStateFlights.delete(roomId);
    });
    this.logStateFlights.set(roomId, migration);
    return migration;
  }

  private async migrateLegacyLog(roomId: string): Promise<RoomLogState> {
    const current = await this.documents.get<RoomLogState>(roomScope(roomId), ROOM_LOG_STATE_KEY);
    if (current !== undefined) return current;
    const state = emptyRoomLogState();
    const segments = new Map<number, RoomLogRecord[]>();
    for await (const entry of this.appendLogs.read<RoomLogEntry>(roomScope(roomId), ROOM_LOG_KEY)) {
      const seq = state.nextSeq;
      if (roomEntryIsActivity(entry)) {
        state.activitySeq = (state.activitySeq ?? 0) + 1;
        state.updatedAt = entry.at;
        state.failed = entry.kind === 'system' && entry.event === 'wake_failed';
      }
      const record = { seq, entry, activitySeq: state.activitySeq } satisfies RoomLogRecord;
      const segmentNumber = roomLogSegmentNumber(seq);
      const segment = segments.get(segmentNumber) ?? [];
      segment.push(record);
      segments.set(segmentNumber, segment);
      await this.documents.set(roomScope(roomId), roomLogPointerKey(entry.id), { seq });
      if (entry.kind === 'message' && entry.idempotencyKey !== undefined) {
        await this.documents.set(roomScope(roomId), roomLogPointerKey(entry.idempotencyKey), { seq });
      }
      state.nextSeq++;
      if (entry.kind === 'message') {
        if (entry.from === 'user') state.userMessages++;
        else state.botMessages++;
      }
    }
    for (const [segmentNumber, entries] of segments) {
      await this.documents.set(roomScope(roomId), roomLogSegmentKeyFromNumber(segmentNumber), { entries });
    }
    await this.documents.set(roomScope(roomId), ROOM_LOG_STATE_KEY, state);
    return state;
  }

  private async appendMessage(roomId: string, entry: RoomMessage): Promise<void> {
    const existing = entry.idempotencyKey === undefined ? undefined : await this.findMessage(roomId, entry.idempotencyKey);
    if (existing !== undefined) return;
    await this.appendIndexedEntry(roomId, entry);
  }

  private async appendSystem(roomId: string, event: string, text: string, data: Readonly<Record<string, unknown>> | undefined): Promise<RoomSystemLog> {
    const entry: RoomSystemLog = { id: messageId(), at: new Date().toISOString(), kind: 'system', from: 'system', event, text, data };
    await this.appendIndexedEntry(roomId, entry);
    const room = await this.requireRoom(roomId);
    this.fire({ roomId, room, entry });
    return entry;
  }

  private async appendIndexedEntry(roomId: string, entry: RoomLogEntry): Promise<void> {
    const state = await this.ensureLogState(roomId);
    const seq = state.nextSeq;
    const previous = state.updatedAt === undefined ? await this.readIndexedRecord(roomId, seq - 1) : undefined;
    const activity = roomEntryIsActivity(entry);
    const activitySeq = (state.activitySeq ?? seq - 1) + Number(activity);
    const segmentKey = roomLogSegmentKey(seq);
    await this.documents.update<RoomLogSegment>(roomScope(roomId), segmentKey, (current) => ({
      entries: [...(current?.entries ?? []), { seq, entry, activitySeq }],
    }));
    await this.documents.set(roomScope(roomId), roomLogPointerKey(entry.id), { seq });
    if (entry.kind === 'message' && entry.idempotencyKey !== undefined) {
      await this.documents.set(roomScope(roomId), roomLogPointerKey(entry.idempotencyKey), { seq });
    }
    await this.documents.set(roomScope(roomId), ROOM_LOG_STATE_KEY, {
      version: 1,
      nextSeq: seq + 1,
      userMessages: state.userMessages + (entry.kind === 'message' && entry.from === 'user' ? 1 : 0),
      botMessages: state.botMessages + (entry.kind === 'message' && entry.from !== 'user' ? 1 : 0),
      activitySeq,
      updatedAt: activity ? entry.at : state.updatedAt ?? (state.activitySeq === undefined ? previous?.entry.at : undefined),
      failed: activity ? entry.kind === 'system' && entry.event === 'wake_failed' : state.failed ?? (previous?.entry.kind === 'system' && previous.entry.event === 'wake_failed'),
    } satisfies RoomLogState);
    this.appendLogs.append(roomScope(roomId), ROOM_LOG_KEY, entry);
    await this.appendLogs.flush(roomScope(roomId), ROOM_LOG_KEY);
  }

  private async updateIndex(updater: (current: RoomIndex) => RoomIndex): Promise<void> {
    await this.documents.update<RoomIndex>(ROOM_INDEX_SCOPE, ROOM_INDEX_KEY, (current) => updater(current ?? { version: 1, rooms: [] }));
  }

  private async cancelRoomDeliveries(roomId: string, generation: number): Promise<void> {
    await this.threadCommunication.cancelRoomDeliveries({ roomId, generation }).catch(() => undefined);
  }

  private async withRoomLock<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(roomId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.then(() => undefined, () => undefined);
    this.locks.set(roomId, tail);
    try {
      return await current;
    } finally {
      if (this.locks.get(roomId) === tail) this.locks.delete(roomId);
    }
  }

  private botConfig(): RoomBotConfig {
    return this.config.get<RoomBotConfig | undefined>(BOT_SECTION) ?? {};
  }

  private ensureBotEnabled(): void {
    if (this.botConfig().enabled !== true) invalid('Bot mode is disabled. Enable the bot configuration before using rooms.');
  }

  private defaultRoomBudget(): number {
    const config = this.botConfig();
    return config.roomBudget ?? ROOM_DEFAULT_BUDGET;
  }

  private fire(event: RoomChangeEvent): void {
    this.changeEmitter.fire(event);
  }
}

function roomEntryIsActivity(entry: RoomLogEntry): boolean {
  return entry.kind === 'message' || entry.event === 'wake_failed' || entry.event === 'budget_exhausted';
}

function emptyRoomLogState(): RoomLogState {
  return { version: 1, nextSeq: 1, userMessages: 0, botMessages: 0, activitySeq: 0, failed: false };
}

function roomLogSegmentNumber(seq: number): number {
  return Math.floor((seq - 1) / ROOM_LOG_SEGMENT_SIZE);
}

function roomLogSegmentKey(seq: number): string {
  return roomLogSegmentKeyFromNumber(roomLogSegmentNumber(seq));
}

function roomLogSegmentKeyFromNumber(segment: number): string {
  return `${ROOM_LOG_SEGMENT_PREFIX}${segment.toString().padStart(8, '0')}.json`;
}

function roomLogPointerKey(id: string): string {
  return `${ROOM_LOG_POINTER_PREFIX}${encodeURIComponent(id)}.json`;
}

export function renderRoomPrompt(room: {
  readonly name: string;
  readonly members: readonly RoomMemberInput[];
  readonly host: string;
  readonly cards?: ReadonlyMap<string, RoomPersonaCard>;
}): string {
  const cards = room.cards ?? new Map<string, PersonaCard>();
  const host = cards.get(room.host);
  const roster = room.members.map((member) => {
    const id = roomMemberId(member);
    const card = cards.get(id);
    const suffix = card?.job === undefined ? '' : ` (${escapeXml(card.job)})`;
    return `${escapeXml(card?.name ?? id)}${suffix}`;
  }).join('; ');
  return `<room name="${escapeXml(room.name)}">Your host is ${escapeXml(host?.name ?? room.host)}; members: ${roster}; the user is User. Only speak when mentioned by the user or assigned by the host; a room message is visible in the next wake. Do not repeat your own SendMessage output.</room>`;
}

function renderCatchup(entries: readonly RoomLogEntry[], room: RoomDocument, member: RoomMember, sourceMessageId: string, cards: ReadonlyMap<string, PersonaCard> = new Map()): RoomCatchup {
  const label = (id: string): string => {
    const name = cards.get(id)?.name;
    return name === undefined || name === id ? id : `${name} (${id})`;
  };
  const cursor = room.cursors[member.sessionId];
  const after = cursor === undefined ? entries : entries.slice(Math.max(0, entries.findIndex((entry) => entry.id === cursor) + 1));
  const visible = after.filter((entry) => !(entry.kind === 'message' && entry.from === roomMemberId(member)));
  const rows = visible.map((entry) => {
    if (entry.kind === 'system') return `[system ${entry.event}] ${entry.text}`;
    const author = entry.from === 'user' ? entry.username ?? 'User' : label(entry.from);
    const mentions = entry.mentions.length === 0 ? '' : ` @${entry.mentions.join(' @')}`;
    const attachments = entry.attachments?.length ? `\nImmutable attachments: ${JSON.stringify(entry.attachments)}` : '';
    return `[${entry.id} ${author}]${mentions} ${entry.text}${attachments}`;
  }).join('\n');
  return {
    content: `<room-messages room="${escapeXml(room.id)}" since="${escapeXml(cursor ?? '')}">${rows}\n</room-messages>\nYou were selected for room message ${escapeXml(sourceMessageId)}. ${member.kind === 'thread' ? `Ordinary assistant text is NOT posted to this room. To speak in the room, use ThreadSend({room: "${escapeXml(room.id)}", content, mentions?}); mentions use member ids: ${escapeXml(room.members.filter((candidate) => candidate.sessionId !== member.sessionId).map((candidate) => label(roomMemberId(candidate))).join('; '))}. A message that mentions no one goes to the room host. Your existing workspace and permissions are unchanged.` : 'Only SendMessage posts your speech to this room.'}`,
    cursor: after.at(-1)?.id,
  };
}

function resolveUserTargets(room: RoomDocument, mentions: readonly string[]): readonly RoomMember[] {
  if (mentions.length > 0) return room.members.filter((member) => mentions.includes(roomMemberId(member)));
  const host = room.members.find((member) => roomMemberId(member) === room.host);
  return host === undefined || host.muted ? [] : [host];
}

function resolveBotTargets(room: RoomDocument, sender: RoomMember, mentions: readonly string[]): readonly RoomMember[] {
  return room.members.filter((member) => roomMemberId(member) !== roomMemberId(sender) && mentions.includes(roomMemberId(member)) && !member.muted);
}

const MENTION_END = '[\\s\\])}.,!?;:，。！？、：；）]';

function resolveMentions(text: string, cards: ReadonlyMap<string, PersonaCard>): readonly string[] {
  const lower = text.toLocaleLowerCase();
  const everyone = new RegExp(`(^|[\\s([{:;,])@(所有人|everyone|all)(?=$|${MENTION_END})`, 'iu').test(text);
  const matches: string[] = [];
  for (const [personaId, card] of cards) {
    const aliases = [personaId, card.name];
    if (everyone || aliases.some((alias) => mentionMatches(text, alias))) matches.push(personaId);
  }
  void lower;
  return matches;
}

function mentionMatches(text: string, alias: string): boolean {
  const escaped = alias.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s([{:;,])@${escaped}(?=$|${MENTION_END})`, 'iu').test(text);
}

function validateMemberInputs(members: readonly RoomMemberInput[], minimum = ROOM_MIN_MEMBERS): readonly RoomMemberInput[] {
  if (members.length < minimum || members.length > ROOM_MAX_MEMBERS) invalid(`A room needs ${minimum}–${ROOM_MAX_MEMBERS} members.`);
  const seen = new Set<string>();
  for (const member of members) {
    const id = roomMemberId(member);
    requiredText(id, 'Member id');
    if (member.kind !== 'thread' && !ROOM_ID_PATTERN.test(id)) invalid(`Invalid persona id '${id}'.`);
    if (seen.has(id)) invalid(`Member '${id}' is listed more than once.`);
    seen.add(id);
  }
  return members.map((member) => member.kind === 'thread'
    ? { kind: 'thread', sessionId: member.sessionId, muted: member.muted === true, queueWhenBusy: member.queueWhenBusy !== false }
    : { kind: 'persona', personaId: member.personaId, muted: member.muted === true });
}

function isChildSession(custom: Record<string, unknown> | undefined): boolean {
  return custom?.['child_session_kind'] === 'child' || typeof custom?.['parent_session_id'] === 'string';
}

function normalizeBudget(input: Partial<RoomBudget> | undefined, fallback = ROOM_DEFAULT_BUDGET): RoomBudget {
  const value = input?.botMessagesPerUserMessage ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) invalid('Room bot message budget must be an integer between 1 and 1000.');
  return { botMessagesPerUserMessage: value };
}

function normalizeRoom(room: RoomDocument): RoomDocument {
  return {
    ...room,
    version: 1,
    members: room.members.map((member) => member.kind === 'thread' ? { ...member, queueWhenBusy: member.queueWhenBusy !== false } : { ...member, kind: 'persona' }),
    mode: 'mention',
    generation: room.generation ?? 0,
    paused: room.paused === true,
    budgetUsed: room.budgetUsed ?? 0,
    userMessageCount: room.userMessageCount ?? 0,
    cursors: room.cursors ?? Object.fromEntries(room.members.map((member) => [member.sessionId, undefined])),
    pendingWakes: room.pendingWakes ?? [],
  };
}

function roomScope(roomId: string): string {
  return `rooms/${roomId}`;
}

function validateRoomId(roomId: string): void {
  if (!ROOM_ID_PATTERN.test(roomId)) invalid(`Invalid room id '${roomId}'.`);
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (text.length === 0) invalid(`${label} is required.`);
  return text;
}

function requiredMessageText(value: string): string {
  const text = value.trim();
  if (text.length === 0 || text.length > 20_000) invalid('Room message must contain 1–20000 characters.');
  return text;
}

function invalid(message: string): never {
  throw new Error2(ErrorCodes.REQUEST_INVALID, message);
}

function optionalDisplayName(value: string | undefined): string {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? 'User' : text.slice(0, 200);
}

function normalizeAttachments(attachments: readonly RoomAttachment[] | undefined): readonly RoomAttachment[] | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  return attachments.map((attachment) => {
    if (attachment.blobId.trim().length === 0 || attachment.path.trim().length === 0) invalid('Room attachments require an immutable blob reference.');
    return {
      blobId: attachment.blobId,
      path: attachment.path,
      title: attachment.title,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
  });
}

function messageId(): string {
  return `m_${Date.now().toString(36)}_${randomUUID().slice(0, 12)}`;
}

registerScopedService(LifecycleScope.App, IRoomService, RoomService, ScopeActivation.OnDemand, 'room');
