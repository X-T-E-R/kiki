import { randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { abortable } from '#/_base/utils/abort';
import { Emitter, type Event } from '#/_base/event';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { BOT_SECTION } from '#/app/bot/configSection';
import { Error2, ErrorCodes } from '#/errors';
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
import type { CreateSessionOptions } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { escapeXml } from '#/_base/utils/xml-escape';

import {
  IRoomService,
  ROOM_DEFAULT_BUDGET,
  ROOM_MAX_MEMBERS,
  ROOM_MIN_MEMBERS,
  type CreateRoomInput,
  type PostBotMessageInput,
  type PostUserMessageInput,
  type RoomAttachment,
  type RoomBudget,
  type RoomChangeEvent,
  type RoomDocument,
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
}

interface RoomLogRecord {
  readonly seq: number;
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
    return rooms.filter((room): room is RoomDocument => room !== undefined);
  }

  async get(roomId: string): Promise<RoomDocument | undefined> {
    validateRoomId(roomId);
    return this.documents.get<RoomDocument>(roomScope(roomId), 'room.json');
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
      for (const member of room.members) await this.sessions.archive(member.sessionId);
      await this.appendLogs.rewrite(roomScope(roomId), ROOM_LOG_KEY, []);
      await this.documents.delete(roomScope(roomId), 'room.json');
      await this.updateIndex((current) => ({ ...current, rooms: current.rooms.filter((entry) => entry.id !== roomId) }));
      this.runtimes.delete(roomId);
    });
  }

  async create(input: CreateRoomInput): Promise<RoomDocument> {
    this.ensureBotEnabled();
    const id = input.id ?? `room_${randomUUID().replaceAll('-', '')}`;
    validateRoomId(id);
    const name = requiredText(input.name, 'Room name');
    const members = validateMemberInputs(input.members);
    const host = input.host ?? members[0]!.personaId;
    if (!members.some((member) => member.personaId === host)) invalid('Room host must be a member.');
    const mode = input.mode ?? 'mention';
    if (mode !== 'mention') invalid(`Unsupported room mode '${mode}'.`);
    const budget = normalizeBudget(input.budget, this.defaultRoomBudget());
    const workspace = requiredText(input.workspace, 'Room workspace');

    return this.withRoomLock(id, async () => {
      if (await this.get(id) !== undefined) invalid(`Room '${id}' already exists.`);
      const cards = await this.loadPersonaCards(members);
      const prompt = renderRoomPrompt({
        name,
        members,
        host,
        cards,
      });
      const created: Array<{ readonly member: RoomMember; readonly session: ISessionScopeHandle }> = [];
      try {
        for (const member of members) {
          const session = await this.createMemberSession(id, member, workspace, prompt);
          const roomMember = { personaId: member.personaId, sessionId: session.id, muted: member.muted === true } satisfies RoomMember;
          created.push({ member: roomMember, session });
        }
      } catch (error) {
        await Promise.all(created.map(({ session }) => this.sessions.delete(session.id).catch(() => undefined)));
        throw error;
      }
      const now = new Date().toISOString();
      const room: RoomDocument = {
        version: 1,
        id,
        name,
        members: created.map(({ member }) => member),
        host,
        mode,
        budget,
        workspace,
        createdAt: now,
        generation: 0,
        paused: false,
        budgetUsed: 0,
        userMessageCount: 0,
        cursors: Object.fromEntries(created.map(({ member }) => [member.sessionId, undefined])),
        pendingWakes: [],
      };
      await this.documents.set(roomScope(id), 'room.json', room);
      await this.documents.set(roomScope(id), ROOM_LOG_STATE_KEY, emptyRoomLogState());
      await this.updateIndex((current) => ({
        version: 1,
        rooms: [...current.rooms, { id: room.id, name: room.name, createdAt: room.createdAt }],
      }));
      await this.appendGreetings(room, room.members);
      this.runtime(id).generation = room.generation;
      this.fire({ roomId: id, room });
      return room;
    });
  }

  async update(roomId: string, input: UpdateRoomInput): Promise<RoomDocument> {
    validateRoomId(roomId);
    return this.withRoomLock(roomId, async () => {
      const current = await this.requireRoom(roomId);
      const nextName = input.name === undefined ? current.name : requiredText(input.name, 'Room name');
      const nextMode = input.mode ?? current.mode;
      if (nextMode !== 'mention') invalid(`Unsupported room mode '${nextMode}'.`);
      const nextWorkspace = input.workspace === undefined ? current.workspace : requiredText(input.workspace, 'Room workspace');
      const nextBudget = input.budget === undefined ? current.budget : normalizeBudget({ ...current.budget, ...input.budget });
      const requestedMembers = input.members === undefined
        ? current.members.map((member) => ({ personaId: member.personaId, muted: member.muted }))
        : validateMemberInputs(input.members);
      const nextHost = input.host ?? current.host;
      if (!requestedMembers.some((member) => member.personaId === nextHost)) invalid('Room host must be a member.');
      const cards = await this.loadPersonaCards(requestedMembers);
      const workspaceChanged = nextWorkspace !== current.workspace;
      const rosterChanged = requestedMembers.length !== current.members.length
        || requestedMembers.some((member) => !current.members.some((existing) => existing.personaId === member.personaId));
      const runtime = this.runtime(roomId);
      if ((workspaceChanged || rosterChanged) && (runtime.active !== undefined || runtime.activeQuestionSessionId !== undefined)) {
        invalid('Stop the active room turn before changing its members or workspace.');
      }
      const existingByPersona = new Map((workspaceChanged ? [] : current.members).map((member) => [member.personaId, member]));
      const prompt = renderRoomPrompt({
        name: nextName,
        members: requestedMembers,
        host: nextHost,
        cards,
      });
      const added: Array<{ readonly member: RoomMember; readonly session: ISessionScopeHandle }> = [];
      try {
        for (const member of requestedMembers) {
          if (existingByPersona.has(member.personaId)) continue;
          const session = await this.createMemberSession(roomId, member, nextWorkspace, prompt);
          added.push({
            member: { personaId: member.personaId, sessionId: session.id, muted: member.muted === true },
            session,
          });
        }
      } catch (error) {
        await Promise.all(added.map(({ session }) => this.sessions.delete(session.id).catch(() => undefined)));
        throw error;
      }
      const nextMembers = requestedMembers.map((member) => {
        const existing = existingByPersona.get(member.personaId);
        const addedMember = added.find((item) => item.member.personaId === member.personaId)?.member;
        return existing === undefined
          ? addedMember!
          : { ...existing, muted: member.muted === true };
      });
      const nextCursors: Record<string, string | undefined> = {};
      for (const member of nextMembers) nextCursors[member.sessionId] = current.cursors[member.sessionId];
      const next: RoomDocument = {
        ...current,
        name: nextName,
        members: nextMembers,
        host: nextHost,
        mode: nextMode,
        budget: nextBudget,
        workspace: nextWorkspace,
        cursors: nextCursors,
        generation: workspaceChanged || rosterChanged ? current.generation + 1 : current.generation,
        pendingWakes: workspaceChanged || rosterChanged ? [] : current.pendingWakes,
      };
      if (workspaceChanged || rosterChanged) {
        this.cancelPending(runtime);
        runtime.generation = next.generation;
        await this.cancelRoomDeliveries(roomId, current.generation);
      }
      await this.documents.set(roomScope(roomId), 'room.json', next);
      await this.updateIndex((index) => ({
        version: 1,
        rooms: index.rooms.map((entry) => entry.id === roomId ? { ...entry, name: next.name } : entry),
      }));
      await this.appendGreetings(next, added.map((item) => item.member));
      const removed = current.members.filter((member) => !next.members.some((candidate) => candidate.sessionId === member.sessionId));
      await Promise.all(removed.map((member) => this.sessions.archive(member.sessionId)));
      if (workspaceChanged) await this.appendSystem(roomId, 'workspace_changed', 'Room workspace changed; member sessions were rebuilt.', { workspace: nextWorkspace });
      if (current.name !== next.name) await this.appendSystem(roomId, 'room_renamed', `Room renamed to ${next.name}.`, { name: next.name });
      if (current.host !== next.host) await this.appendSystem(roomId, 'host_changed', `Room host changed to ${next.host}.`, { host: next.host });
      if (!sameMemberRoster(current.members, next.members)) await this.appendSystem(roomId, 'roster_changed', 'Room roster updated.', { members: next.members.map((member) => member.personaId) });
      this.fire({ roomId, room: next });
      return next;
    });
  }

  async postUserMessage(roomId: string, input: PostUserMessageInput): Promise<RoomMessage> {
    this.ensureBotEnabled();
    validateRoomId(roomId);
    const text = requiredMessageText(input.text);
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
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
      const generation = room.generation + 1;
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
      this.cancelPending(runtime);
      await this.clearPendingWakes(roomId);
      await this.cancelRoomDeliveries(roomId, room.generation);
      if (runtime.active !== undefined) void this.steerActive(room, runtime.active, entry, generation).catch(() => undefined);
      if (!next.paused) {
        const activeSessionId = runtime.active?.member.sessionId;
        const targets = resolveUserTargets(next, mentions);
        for (const member of targets) {
          if (member.sessionId !== activeSessionId) await this.enqueueWake(roomId, member, generation, entry.id);
        }
      }
      this.fire({ roomId, room: next, entry });
      return entry;
    });
  }

  async postBotMessage(roomId: string, input: PostBotMessageInput): Promise<RoomMessage | undefined> {
    this.ensureBotEnabled();
    validateRoomId(roomId);
    const text = requiredMessageText(input.text);
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
      const member = room.members.find((candidate) => candidate.sessionId === input.sessionId);
      if (member === undefined) invalid(`Session '${input.sessionId}' is not a member of room '${roomId}'.`);
      const existing = await this.findMessage(roomId, `bot:${input.sessionId}:${input.toolCallId}`);
      if (existing !== undefined) return existing;
      if ((room.paused && room.pauseReason !== 'manual') || room.budgetUsed >= room.budget.botMessagesPerUserMessage) return undefined;
      const cards = await this.loadPersonaCards(room.members);
      const mentions = resolveMentions([input.to, text].filter(Boolean).join(' '), cards);
      const idempotencyKey = `bot:${input.sessionId}:${input.toolCallId}`;
      const entry: RoomMessage = {
        id: messageId(),
        at: new Date().toISOString(),
        kind: 'message',
        from: member.personaId,
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
    this.ensureBotEnabled();
    return this.withRoomLock(roomId, async () => {
      const room = await this.requireRoom(roomId);
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
    return {
      entries: page,
      nextCursor: entries.length > limit ? page.at(-1)?.id : undefined,
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
      return { sessionId: member.sessionId, personaId: member.personaId, usage };
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
      await queue;
      if (runtime.queue === queue) return;
    }
  }

  private async deliverWake(work: WakeWork): Promise<void> {
    const room = await this.requireRoom(work.roomId);
    if (work.cancelled || room.paused || room.generation !== work.generation) return;
    const entries = await this.readIndexedLog(work.roomId, room.cursors[work.member.sessionId]);
    const catchup = renderCatchup(entries, room, work.member, work.sourceMessageId);
    const target = await this.threadRef(room, work.member);
    const receipt = await this.threadCommunication.sendRoomMessage({
      target,
      roomId: work.roomId,
      content: catchup.content,
      idempotencyKey: `room:${work.roomId}:${work.generation}:${work.member.personaId}:${work.sourceMessageId}`,
      targeted: true,
      generation: work.generation,
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
      idempotencyKey: `room-steer:${room.id}:${generation}:${active.member.personaId}:${entry.id}`,
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
    if (active === undefined) return;
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
    const work: WakeWork = { roomId, member, generation, sourceMessageId, cancelled: false };
    runtime.pending.add(work);
    await this.updatePendingWakes(roomId, (pending) => [
      ...pending,
      { sessionId: member.sessionId, sourceMessageId, generation },
    ]);
    runtime.queue = runtime.queue.then(async () => {
      await this.withRoomLock(roomId, async () => {
        runtime.pending.delete(work);
        if (!work.cancelled) runtime.active = work;
      });
      if (work.cancelled) return;
      try {
        await this.deliverWake(work);
      } catch (error) {
        await this.withRoomLock(roomId, async () => {
          if (work.cancelled || this.runtimes.get(roomId) !== runtime) return;
          await this.appendSystem(work.roomId, 'wake_failed', `Unable to wake ${work.member.personaId}; the wake remains retryable.`, {
            sessionId: work.member.sessionId,
            sourceMessageId: work.sourceMessageId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }).catch(() => undefined);
      } finally {
        runtime.pending.delete(work);
        if (runtime.active === work) runtime.active = undefined;
      }
    }, async () => undefined);
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
      runtime = { queue: Promise.resolve(), questionTail: Promise.resolve(), questionsQueued: 0, generation: 0, pending: new Set() };
      this.runtimes.set(roomId, runtime);
    }
    return runtime;
  }

  private async createMemberSession(roomId: string, member: RoomMemberInput, workspace: string, roomPrompt: string): Promise<ISessionScopeHandle> {
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
      const snapshot = await this.personas.get(member.personaId);
      const greeting = snapshot?.definition.greeting;
      if (greeting === undefined || greeting.trim().length === 0) continue;
      const idempotencyKey = `greeting:${member.sessionId}`;
      const entry: RoomMessage = {
        id: messageId(),
        at: new Date().toISOString(),
        kind: 'message',
        from: member.personaId,
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
      const record = { seq, entry } satisfies RoomLogRecord;
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
    const segmentKey = roomLogSegmentKey(seq);
    await this.documents.update<RoomLogSegment>(roomScope(roomId), segmentKey, (current) => ({
      entries: [...(current?.entries ?? []), { seq, entry }],
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

function emptyRoomLogState(): RoomLogState {
  return { version: 1, nextSeq: 1, userMessages: 0, botMessages: 0 };
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
  readonly members: readonly { readonly personaId: string }[];
  readonly host: string;
  readonly cards?: ReadonlyMap<string, RoomPersonaCard>;
}): string {
  const cards = room.cards ?? new Map<string, PersonaCard>();
  const host = cards.get(room.host);
  const roster = room.members.map((member) => {
    const card = cards.get(member.personaId);
    const suffix = card?.job === undefined ? '' : ` (${escapeXml(card.job)})`;
    return `${escapeXml(card?.name ?? member.personaId)}${suffix}`;
  }).join('; ');
  return `<room name="${escapeXml(room.name)}">Your host is ${escapeXml(host?.name ?? room.host)}; members: ${roster}; the user is User. Only speak when mentioned by the user or assigned by the host; a room message is visible in the next wake. Do not repeat your own SendMessage output.</room>`;
}

function renderCatchup(entries: readonly RoomLogEntry[], room: RoomDocument, member: RoomMember, sourceMessageId: string): RoomCatchup {
  const cursor = room.cursors[member.sessionId];
  const after = cursor === undefined ? entries : entries.slice(Math.max(0, entries.findIndex((entry) => entry.id === cursor) + 1));
  const visible = after.filter((entry) => !(entry.kind === 'message' && entry.from === member.personaId));
  const rows = visible.map((entry) => {
    if (entry.kind === 'system') return `[system ${entry.event}] ${entry.text}`;
    const author = entry.from === 'user' ? entry.username ?? 'User' : entry.from;
    const mentions = entry.mentions.length === 0 ? '' : ` @${entry.mentions.join(' @')}`;
    const attachments = entry.attachments?.length ? `\nImmutable attachments: ${JSON.stringify(entry.attachments)}` : '';
    return `[${entry.id} ${author}]${mentions} ${entry.text}${attachments}`;
  }).join('\n');
  return {
    content: `<room-messages since="${escapeXml(cursor ?? '')}">${rows}\n</room-messages>\nYou were selected for room message ${escapeXml(sourceMessageId)}.`,
    cursor: after.at(-1)?.id,
  };
}

function resolveUserTargets(room: RoomDocument, mentions: readonly string[]): readonly RoomMember[] {
  if (mentions.length > 0) return room.members.filter((member) => mentions.includes(member.personaId));
  const host = room.members.find((member) => member.personaId === room.host);
  return host === undefined || host.muted ? [] : [host];
}

function resolveBotTargets(room: RoomDocument, sender: RoomMember, mentions: readonly string[]): readonly RoomMember[] {
  return room.members.filter((member) => member.personaId !== sender.personaId && mentions.includes(member.personaId) && !member.muted);
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

function validateMemberInputs(members: readonly RoomMemberInput[]): readonly RoomMemberInput[] {
  if (members.length < ROOM_MIN_MEMBERS || members.length > ROOM_MAX_MEMBERS) invalid(`A room needs ${ROOM_MIN_MEMBERS}–${ROOM_MAX_MEMBERS} persona members.`);
  const seen = new Set<string>();
  for (const member of members) {
    requiredText(member.personaId, 'Persona id');
    if (!ROOM_ID_PATTERN.test(member.personaId)) invalid(`Invalid persona id '${member.personaId}'.`);
    if (seen.has(member.personaId)) invalid(`Persona '${member.personaId}' is listed more than once.`);
    seen.add(member.personaId);
  }
  return members.map((member) => ({ personaId: member.personaId, muted: member.muted === true }));
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
    mode: 'mention',
    generation: room.generation ?? 0,
    paused: room.paused === true,
    budgetUsed: room.budgetUsed ?? 0,
    userMessageCount: room.userMessageCount ?? 0,
    cursors: room.cursors ?? Object.fromEntries(room.members.map((member) => [member.sessionId, undefined])),
    pendingWakes: room.pendingWakes ?? [],
  };
}

function sameMemberRoster(a: readonly RoomMember[], b: readonly RoomMember[]): boolean {
  return a.length === b.length && a.every((member, index) => member.personaId === b[index]?.personaId && member.muted === b[index]?.muted);
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
