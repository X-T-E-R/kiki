import { join } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IPersonaStore } from '#/app/persona/personaStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
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

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPersonaStore private readonly personas: IPersonaStore,
    @ISessionManager private readonly sessions: ISessionManager,
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IThreadCommunicationService private readonly threads: IThreadCommunicationService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {
    super();
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
    const bots = await this.list();
    const exactId = bots.find((bot) => bot.personaId === normalized);
    if (exactId !== undefined) return exactId;
    const matches = bots.filter((bot) => bot.name === normalized);
    if (matches.length > 1) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Bot name "${normalized}" is ambiguous.`);
    }
    return matches[0];
  }

  async enable(personaId: string): Promise<BotSummary> {
    const state = await this.personas.getState(personaId);
    if (state.archived) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Restore the archived persona before enabling its Bot.');
    await this.config.set(BOT_SECTION, { enabled: true });
    return this.ensureHomeSession(personaId);
  }

  async update(personaId: string, input: BotUpdateInput): Promise<BotState> {
    const next = await this.personas.updateState(personaId, {
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
    });
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

  async sendHandoff(input: BotHandoffInput): Promise<SendMessageReceipt> {
    this.assertEnabled();
    const target = await this.resolve(input.target);
    if (target === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Bot "${input.target}" was not found.`);
    if (target.homeSessionId === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Bot "${input.target}" is not enabled.`);
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
    this.assertEnabled();
    const snapshot = await this.personas.get(personaId);
    if (snapshot === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Persona "${personaId}" does not exist.`);
    const prior = await this.personas.getState(personaId);
    if (prior.archived) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Restore the archived persona before enabling its Bot.');
    if (prior.homeSessionId !== undefined) {
      const session = await this.sessions.resume(prior.homeSessionId);
      if (session !== undefined && (await session.accessor.get(ISessionMetadata).read()).custom?.['bot_persona_id'] === personaId) {
        return this.summary(personaId, snapshot.definition.name, snapshot.definition.title, prior);
      }
    }
    const definition = snapshot.definition;
    const workDir = definition.homeWorkspace ?? join(this.bootstrap.homeDir, 'bots', personaId);
    if (definition.homeWorkspace === undefined) await this.fs.mkdir(workDir, { recursive: true });
    const handle = await this.sessions.create({
      workDir,
      delivery: 'message',
      mainAgentBinding: {
        persona: personaId,
        profile: definition.profile,
        model: definition.modelAlias,
        thinking: definition.thinkingEffort,
        strictThinking: definition.thinkingEffort !== undefined,
      },
    });
    try {
      const metadata = handle.accessor.get(ISessionMetadata);
      await metadata.update({ custom: { ...(await metadata.read()).custom, bot_persona_id: personaId } }, { touchUpdatedAt: false });
      const next = await this.personas.updateState(personaId, { homeSessionId: handle.id });
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
