import { join } from 'pathe';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { IRoomService } from '#/app/room/room';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentProfileService } from '#/agent/profile/profile';
import { readPersistedAgentProfileSnapshot, type AgentProfileSnapshotHost } from '#/session/agentProfileSnapshot';
import type { PersonaState } from '#/app/persona/personaStore';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IPersonaStore } from '#/app/persona/personaStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IThreadCommunicationService, type ThreadRef } from '#/app/threadCommunication/threadCommunication';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SEND_PEER_THREAD_MESSAGE, peerSendCapability } from '#/app/threadCommunication/peerThreadCapability';
import { Error2, ErrorCodes } from '#/errors';

import { BOT_SECTION, type BotConfig } from './configSection';
import {
  IBotService,
  type BotHandoffInput,
  type BotState,
  type BotSummary,
  type BotUpdateInput,
} from './bot';
import type { SendMessageReceipt } from './messageRouting';

interface HandoffRateDocument {
  readonly entries: readonly { readonly key: string; readonly at: number }[];
}

export class BotService extends Disposable implements IBotService {
  declare readonly _serviceBrand: undefined;

  private readonly homeFlights = new Map<string, Promise<BotSummary>>();
  private readonly snapshotHost: AgentProfileSnapshotHost;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPersonaStore private readonly personas: IPersonaStore,
    @ISessionManager private readonly sessions: ISessionManager,
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IThreadCommunicationService private readonly threads: IThreadCommunicationService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IFileSystemStorageService storage: IFileSystemStorageService,
    @IAppendLogStore appendLog: IAppendLogStore,
    @ICronTaskPersistence private readonly cron: ICronTaskPersistence,
    @IRoomService private readonly rooms: IRoomService,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
  ) {
    super();
    this.snapshotHost = { storage, appendLog };
    personas.setLifecycleHooks({
      beforeArchive: async (id, state, record) => {
        const tasks = await this.personaTasks(id);
        const pausedCronTasks = state.archived ? [...(state.pausedCronTasks ?? [])]
          : tasks.map(({ workspaceId, task }) => ({ workspaceId, taskId: task.id, wasPaused: task.paused === true }));
        await record({ pausedCronTasks });
        for (const { workspaceId, task } of tasks) await cron.save(workspaceId, { ...task, paused: true });
        return { pausedCronTasks };
      },
      beforeDelete: async (id) => {
        for (const { workspaceId, task } of await this.personaTasks(id)) await cron.delete(workspaceId, task.id);
        for (const room of await rooms.list()) {
          if (room.members.some((member) => member.kind === 'persona' && member.personaId === id)) {
            await rooms.removeMember(room.id, id);
          }
        }
      },
    });
    this._register(toDisposable(() => personas.setLifecycleHooks(undefined)));
  }

  async list(): Promise<readonly BotSummary[]> {
    const summaries = await this.personas.list({ includeArchived: false });
    const bots: BotSummary[] = [];
    for (const summary of summaries) {
      const bot = await this.personas.getState(summary.id);
      if (bot.homeSessionId === undefined) continue;
      bots.push({
        personaId: summary.id,
        name: summary.name,
        title: summary.title,
        homeSessionId: bot.homeSessionId,
        pinned: bot.pinned === true,
        hidden: bot.hidden === true,
      });
    }
    return bots;
  }

  async resolve(nameOrId: string): Promise<BotSummary | undefined> {
    const normalized = nameOrId.startsWith('@') ? nameOrId.slice(1) : nameOrId;
    const personas = await this.personas.list({ includeArchived: false });
    const exactId = personas.find((persona) => persona.id === normalized);
    const matches = exactId === undefined ? personas.filter((persona) => persona.name === normalized) : [exactId];
    if (matches.length > 1) throw new Error2(ErrorCodes.REQUEST_INVALID, `Persona name "${normalized}" is ambiguous.`);
    const match = matches[0];
    return match === undefined ? undefined : this.summary(match.id, match.name, match.title, await this.personas.getState(match.id));
  }

  async enable(personaId: string): Promise<BotSummary> {
    return this.ensureHomeSession(personaId);
  }

  async update(personaId: string, input: BotUpdateInput): Promise<BotState> {
    const patch: { pinned?: boolean; hidden?: boolean } = {};
    if (input.pinned !== undefined) patch.pinned = input.pinned;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    const next = await this.personas.updateState(personaId, patch);
    return {
      personaId,
      homeSessionId: next.homeSessionId,
      pinned: next.pinned === true,
      hidden: next.hidden === true,
    };
  }

  async ensureHomeSession(personaId: string): Promise<BotSummary> {
    const existing = this.homeFlights.get(personaId);
    if (existing !== undefined) return existing;
    const flight = this.createHomeSession(personaId).finally(() => {
      if (this.homeFlights.get(personaId) === flight) this.homeFlights.delete(personaId);
    });
    this.homeFlights.set(personaId, flight);
    return flight;
  }

  async sessionPersonaId(session: SessionSummary): Promise<string | undefined> {
    const main = this.sessions.get(session.id)?.accessor.get(IAgentLifecycleService).get('main');
    const bound = main?.accessor.get(IAgentProfileService).data().personaId ?? session.personaId;
    if (bound !== undefined) return bound;
    const persisted = main === undefined
      ? await readPersistedAgentProfileSnapshot(this.snapshotHost, session.workspaceId, session.id, 'main', undefined)
      : undefined;
    if (persisted?.personaId !== undefined) return persisted.personaId;
    const legacy = session.custom?.['bot_persona_id'] ?? session.custom?.['room_persona_id'];
    return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
  }

  async sessionBelongsToPersona(session: SessionSummary, personaId: string): Promise<boolean> {
    return await this.sessionPersonaId(session) === personaId;
  }

  async claimHomeSession(personaId: string, sessionId: string): Promise<PersonaState> {
    await this.validateHomeSession(personaId, sessionId);
    return this.personas.claimHomeSession(personaId, sessionId);
  }

  async setHomeSession(personaId: string, sessionId: string): Promise<PersonaState> {
    await this.homeFlights.get(personaId);
    return this.personas.updateState(personaId, { homeSessionId: sessionId }, async (state) => {
      if (state.archived) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Restore the archived persona before changing its daily chat.');
      await this.validateHomeSession(personaId, sessionId);
      const current = state.homeSessionId === undefined ? undefined : this.sessions.get(state.homeSessionId);
      if (current?.accessor.get(ISessionActivityView).state().busy) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Wait for the current daily chat to finish before changing it.');
    });
  }

  private async validateHomeSession(personaId: string, sessionId: string): Promise<void> {
    const session = await this.sessionIndex.get(sessionId);
    if (session === undefined || this.sessions.isEphemeral(sessionId)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Daily chat must be an existing persistent session.');
    if (session.archived || session.custom?.['room_member_of'] !== undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Daily chat cannot be an archived or room-member session.');
    if (!(await this.sessionBelongsToPersona(session, personaId))) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Daily chat must belong to this persona.');
    if (this.sessions.get(sessionId)?.accessor.get(ISessionActivityView).state().busy) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Wait for this conversation to finish before making it the daily chat.');
  }

  private async personaTasks(personaId: string): Promise<readonly { workspaceId: string; task: CronTask }[]> {
    const tasks: { workspaceId: string; task: CronTask }[] = [];
    for (const workspaceId of await this.cron.listWorkspaceIds()) {
      for (const task of await this.cron.list({ workspaceId })) {
        const sessionId = task.tags?.[CRON_SESSION_TAG];
        if (sessionId === undefined) continue;
        const session = await this.sessionIndex.get(sessionId);
        if (session !== undefined && await this.sessionBelongsToPersona(session, personaId)) tasks.push({ workspaceId, task });
      }
    }
    return tasks;
  }

  async sendHandoff(input: BotHandoffInput): Promise<SendMessageReceipt> {
    const resolved = await this.resolve(input.target);
    if (resolved === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Persona "${input.target}" was not found.`);
    const target = await this.ensureHomeSession(resolved.personaId);
    if (target.homeSessionId === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Persona daily chat could not be prepared.');
    const source = await this.sessionIndex.get(input.sourceSessionId);
    if (source === undefined) throw new Error2(ErrorCodes.THREAD_NOT_FOUND, `Source session "${input.sourceSessionId}" does not exist.`);
    if (target.homeSessionId === input.sourceSessionId) throw new Error2(ErrorCodes.THREAD_SELF_SEND, 'A Bot cannot send a handoff to itself.');
    await this.consumeHandoffBudget(input.sourcePersonaId ?? input.sourceSessionId, `${input.sourceSessionId}:${input.idempotencyKey}`);
    const sourceRef: ThreadRef = {
      hostId: this.threads.hostId,
      workspaceId: source.workspaceId,
      sessionId: input.sourceSessionId,
      personaId: input.sourcePersonaId,
      name: input.sourceName,
    };
    const targetSession = await this.sessionIndex.get(target.homeSessionId);
    if (targetSession === undefined) throw new Error2(ErrorCodes.THREAD_NOT_FOUND, `Bot session "${target.homeSessionId}" does not exist.`);
    if (targetSession.custom?.['bot_persona_id'] !== undefined && targetSession.custom?.['persona_home_managed'] !== true) this.assertEnabled();
    const targetRef: ThreadRef = {
      hostId: this.threads.hostId,
      workspaceId: targetSession.workspaceId,
      sessionId: target.homeSessionId,
      personaId: target.personaId,
      name: target.name,
    };
    const result = await peerSendCapability(this.threads)[SEND_PEER_THREAD_MESSAGE]({
      source: sourceRef,
      target: targetRef,
      content: input.attachments === undefined || input.attachments.length === 0 ? input.content
        : `${input.content}\n\nImmutable attachments from session ${input.sourceSessionId}:\n${JSON.stringify(input.attachments)}`,
      idempotencyKey: input.idempotencyKey,
      sender: {
        sessionId: input.sourceSessionId,
        personaId: input.sourcePersonaId,
        name: input.sourceName,
      },
      allowWhenDisabled: true,
    });
    return {
      messageId: result.messageId,
      deliveredTo: [target.name],
      attachments: input.attachments,
      sender: {
        sessionId: input.sourceSessionId,
        personaId: input.sourcePersonaId,
        name: input.sourceName,
      },
      handoff: {
        targetPersonaId: target.personaId,
        targetSessionId: target.homeSessionId,
        targetName: target.name,
        messageId: result.messageId,
      },
      deduplicated: result.deduplicated,
      delivery: result.delivery,
    };
  }

  private async createHomeSession(personaId: string): Promise<BotSummary> {
    const snapshot = await this.personas.get(personaId);
    if (snapshot === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Persona "${personaId}" does not exist.`);
    const prior = await this.personas.getState(personaId);
    if (prior.archived) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Restore the archived persona before opening its daily chat.');
    if (prior.homeSessionId !== undefined) {
      const session = await this.sessionIndex.get(prior.homeSessionId);
      if (session !== undefined) {
        if (!(await this.sessionBelongsToPersona(session, personaId)) || session.custom?.['room_member_of'] !== undefined) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'Daily chat pointer does not belong to this persona. Choose another conversation.');
        }
        return this.summary(personaId, snapshot.definition.name, snapshot.definition.title, prior);
      }
    }
    const definition = snapshot.definition;
    const configured = definition.homeWorkspace;
    const workDir = configured === undefined
      ? join(this.bootstrap.homeDir, 'bots', personaId)
      : (await this.workspaces.get(configured))?.root ?? configured;
    if (definition.homeWorkspace === undefined) await this.fs.mkdir(workDir, { recursive: true });
    const handle = await this.sessions.create({
      workDir,
      delivery: definition.delivery ?? 'reply',
      mainAgentBinding: { persona: personaId },
    });
    try {
      const metadata = handle.accessor.get(ISessionMetadata);
      await metadata.update({ custom: { ...(await metadata.read()).custom, bot_persona_id: personaId, persona_home_managed: true } }, { touchUpdatedAt: false });
      const next = await this.personas.claimHomeSession(personaId, handle.id, prior.homeSessionId);
      if (next.archived || next.homeSessionId === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Persona daily chat changed during preparation. Retry after restoring the persona.');
      if (next.homeSessionId !== handle.id) await this.sessions.delete(handle.id);
      return this.summary(personaId, definition.name, definition.title, next);
    } catch (error) {
      await this.sessions.delete(handle.id);
      throw error;
    }
  }

  private async consumeHandoffBudget(sender: string, idempotencyKey: string): Promise<void> {
    const config = this.config.get<BotConfig>(BOT_SECTION);
    const now = Date.now();
    const scope = this.bootstrap.scope('store');
    const key = `bot-handoffs/${encodeURIComponent(sender)}.json`;
    let exceeded = false;
    await this.documents.update<HandoffRateDocument>(scope, key, (current) => {
      const entries = (current?.entries ?? []).filter((entry) => entry.at > now - 60 * 60_000);
      if (entries.some((entry) => entry.key === idempotencyKey)) return { entries };
      if (entries.length >= config.maxHandoffsPerHour) {
        exceeded = true;
        return { entries };
      }
      return { entries: [...entries, { key: idempotencyKey, at: now }] };
    });
    if (exceeded) throw new Error2(ErrorCodes.REQUEST_INVALID, `Bot handoff limit (${config.maxHandoffsPerHour}/hour) exceeded.`);
  }

  private assertEnabled(): void {
    if (!this.config.get<BotConfig>(BOT_SECTION).enabled) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Bot mode is disabled. Enable [bot].enabled first.');
    }
  }

  private summary(personaId: string, name: string, title: string | undefined, state: { readonly homeSessionId?: string; readonly pinned?: boolean; readonly hidden?: boolean }): BotSummary {
    return {
      personaId,
      name,
      title,
      homeSessionId: state.homeSessionId,
      pinned: state.pinned === true,
      hidden: state.hidden === true,
    };
  }
}

registerScopedService(
  LifecycleScope.App,
  IBotService,
  BotService,
  ScopeActivation.OnScopeCreated,
  'bot',
);
