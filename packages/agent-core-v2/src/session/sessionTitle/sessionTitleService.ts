import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { ILogService } from '#/_base/log/log';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { PromptSubmitted } from '#/agent/prompt/promptService';
import { ContextApplyCompaction, type ContextApplyCompactionPayload } from '#/agent/contextMemory/contextEvents';
import { TurnPrompt, TurnEnded, turnKey } from '#/agent/loop/turnOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { SessionErrors } from '#/session/errors';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { resolveSessionTitleModelAlias, resolveSessionTitleTriggers, type SessionTitleTrigger } from './configSection';
import { AUTO_SESSION_TITLE_FLAG_ID } from './flag';
import { ISessionTitleService, type SessionTitleSource } from './sessionTitle';

const MAX_GENERATED_TITLE_LENGTH = 200;
const MAX_TITLE_INPUT_LENGTH = 1000;
const MAX_TITLE_PROMPTS = 3;
const MAX_TITLE_USER_SEGMENT = 300;
const MAX_TITLE_FIRST_TURN_ASSISTANT = 600;
const MAX_TITLE_DIGEST_ASSISTANT = 400;

const TITLE_SYSTEM_PROMPT =
  'You name conversations. Answer with the title only: one line, at most 8 words, ' +
  'no quotes, no trailing punctuation, in the language of the conversation.';

export class SessionTitleService extends Disposable implements ISessionTitleService {
  declare readonly _serviceBrand: undefined;

  private _shared: Promise<string | undefined> | undefined;
  private automatic = Promise.resolve();
  private readonly mainSubscriptions = this._register(new DisposableStore());

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly eventService: IEventService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
  ) {
    super();
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main !== undefined) this.attachMain(main);
    this._register(this.agentLifecycle.onDidCreate((handle) => {
      if (handle.id === MAIN_AGENT_ID) this.attachMain(handle);
    }));
    this._register(this.agentLifecycle.onDidDispose((id) => {
      if (id !== MAIN_AGENT_ID) return;
      const result = this.mainSubscriptions.clear();
      if (isPromiseLike(result)) result.catch(onUnexpectedError);
    }));
  }

  private attachMain(handle: IAgentScopeHandle): void {
    const previous = this.mainSubscriptions.clear();
    if (isPromiseLike(previous)) previous.catch(onUnexpectedError);
    const bus = handle.accessor.get(IEventBus);
    const queue = handle.accessor.get(IAgentPromptService).list();
    let firstUserSeen = handle.accessor.get(IAgentStateService).get(turnKey).nextTurnId > 0 ||
      queue.active !== undefined || queue.pending.length > 0 || queue.launching !== undefined;
    let openingPromptId: string | undefined;
    let openingTurnId: number | undefined;
    this.mainSubscriptions.add(bus.subscribe(PromptSubmitted, (event) => {
      if (firstUserSeen) return;
      firstUserSeen = true;
      openingPromptId = event.promptId;
      this.trigger('first_user_message', 'user_prompts');
    }));
    this.mainSubscriptions.add(bus.subscribe(TurnPrompt, (event) => {
      if (event.origin.kind !== 'user') return;
      if (!firstUserSeen) {
        firstUserSeen = true;
        openingTurnId = event.turnId;
        this.trigger('first_user_message', 'user_prompts');
      } else if (openingPromptId !== undefined && event.promptId === openingPromptId) {
        openingTurnId = event.turnId;
        openingPromptId = undefined;
      }
    }));
    this.mainSubscriptions.add(bus.subscribe(TurnEnded, (event) => {
      if (event.turnId !== openingTurnId) return;
      openingTurnId = undefined;
      if (event.reason === 'completed') this.trigger('first_turn_completed', 'first_turn');
    }));
    this.mainSubscriptions.add(bus.subscribe(ContextApplyCompaction, (event) => {
      const payload = event as unknown as ContextApplyCompactionPayload;
      const summary = 'contextSummary' in payload ? payload.contextSummary ?? payload.summary : payload.summary;
      const text = typeof summary === 'string' ? summary : summary?.content
        .filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      this.trigger('context_compacted', 'digest', text);
    }));
  }

  private trigger(trigger: SessionTitleTrigger, source: SessionTitleSource, summary?: string): void {
    if (!resolveSessionTitleTriggers(this.config).includes(trigger)) return;
    if (!this.flags.enabled(AUTO_SESSION_TITLE_FLAG_ID) || resolveSessionTitleModelAlias(this.config) === undefined) return;
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) return;
    const input = composeTitleInput(main.accessor.get(IAgentTitlePromptSource), source)
      .then((value) => value ?? (summary === undefined ? undefined : `summary: ${summary.slice(0, MAX_TITLE_INPUT_LENGTH)}`));
    this.automatic = this.automatic.then(async () => {
      if (!resolveSessionTitleTriggers(this.config).includes(trigger)) return;
      const text = await input;
      if (text !== undefined) await this.generateAndApply(text, false);
    }).catch((error) => {
      this.log.warn(`automatic session title generation failed: ${errorMessage(error)}`);
    });
  }

  async generateTitle(opts?: { force?: boolean; source?: SessionTitleSource }): Promise<string | undefined> {
    const force = opts?.force === true;
    const source = opts?.source ?? 'user_prompts';
    if (force) return this.generateTitleOnce(true, source);
    if (this._shared !== undefined) return this._shared;
    const tracked = this.generateTitleOnce(false, source).finally(() => {
      if (this._shared === tracked) this._shared = undefined;
    });
    this._shared = tracked;
    return tracked;
  }

  private async generateTitleOnce(force: boolean, source: SessionTitleSource): Promise<string | undefined> {
    if (!this.flags.enabled(AUTO_SESSION_TITLE_FLAG_ID) || resolveSessionTitleModelAlias(this.config) === undefined) return undefined;
    const current = await this.metadata.read();
    if (!force && (current.titleKind === 'custom' || current.titleKind === 'generated')) return undefined;
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) return undefined;
    const input = await composeTitleInput(main.accessor.get(IAgentTitlePromptSource), source);
    if (input === undefined) return undefined;
    return this.generateAndApply(input, force);
  }

  private async generateAndApply(chatContent: string, force: boolean): Promise<string | undefined> {
    if (!this.flags.enabled(AUTO_SESSION_TITLE_FLAG_ID)) return undefined;
    const alias = resolveSessionTitleModelAlias(this.config);
    if (alias === undefined) return undefined;
    const current = await this.metadata.read();
    if (!force && current.titleKind === 'custom') return undefined;
    const title = await this.requestModelTitle(chatContent, alias);
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(title, { force });
    if (!applied) return undefined;
    this.eventService.publish(new SessionMetaUpdated({
      payload: {
        agentId: MAIN_AGENT_ID,
        sessionId: this.ctx.sessionId,
        title,
        patch: { title, isCustomTitle: false },
      },
    }));
    return title;
  }

  private async requestModelTitle(chatContent: string, alias: string): Promise<string> {
    const collected: string[] = [];
    let finishReason: string | undefined;
    try {
      const requester = this.modelCatalog.getRequester(alias);
      for await (const event of requester.request({
        systemPrompt: TITLE_SYSTEM_PROMPT,
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: chatContent }], toolCalls: [] }],
      }, undefined, { attribution: {
        logicalRequestId: crypto.randomUUID(), sessionId: this.ctx.sessionId,
        agentId: MAIN_AGENT_ID, purpose: 'session_title', waitBudget: { waitedMs: 0 },
      } })) {
        if (event.type !== 'finish') continue;
        finishReason = event.rawFinishReason ?? event.providerFinishReason;
        for (const part of event.message.content) {
          if (part.type === 'text') collected.push(part.text);
        }
      }
    } catch (error) {
      throw new Error2(SessionErrors.codes.SESSION_TITLE_GENERATION_FAILED,
        `Title model request failed: ${errorMessage(error)}`, { cause: error, details: { model: alias } });
    }
    const title = normalizeGeneratedTitle(collected.join(''));
    if (title.length === 0) {
      throw new Error2(SessionErrors.codes.SESSION_TITLE_GENERATION_FAILED,
        'The title model returned no title text.', { details: { model: alias, finishReason } });
    }
    return title;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeGeneratedTitle(raw: string): string {
  const collapsed = raw.replaceAll(/\s+/g, ' ').trim();
  const unquoted = /^(["'“”‘’])([\s\S]*)\1$/.test(collapsed)
    ? collapsed.slice(1, -1).trim()
    : collapsed;
  return unquoted.slice(0, MAX_GENERATED_TITLE_LENGTH);
}

function titleInputFromPrompts(prompts: readonly string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  return prompts
    .map((prompt) => `user: ${prompt}`)
    .join('\n')
    .slice(0, MAX_TITLE_INPUT_LENGTH);
}

async function composeTitleInput(
  promptSource: IAgentTitlePromptSource,
  source: SessionTitleSource,
): Promise<string | undefined> {
  if (source === 'first_turn') {
    const excerpt = await promptSource.firstTurnExcerpt();
    if (excerpt.user === undefined || excerpt.assistant === undefined) return undefined;
    return [
      `user: ${excerpt.user.slice(0, MAX_TITLE_USER_SEGMENT)}`,
      `assistant: ${excerpt.assistant.slice(0, MAX_TITLE_FIRST_TURN_ASSISTANT)}`,
    ].join('\n');
  }
  if (source === 'digest') {
    const excerpt = await promptSource.digestExcerpt();
    const lines: string[] = [];
    if (excerpt.firstUser !== undefined) {
      lines.push(`user: ${excerpt.firstUser.slice(0, MAX_TITLE_USER_SEGMENT)}`);
    }
    if (excerpt.lastUser !== undefined) {
      lines.push(`user: ${excerpt.lastUser.slice(0, MAX_TITLE_USER_SEGMENT)}`);
    }
    if (excerpt.assistant !== undefined) {
      lines.push(`assistant: ${excerpt.assistant.slice(0, MAX_TITLE_DIGEST_ASSISTANT)}`);
    }
    return lines.length === 0 ? undefined : lines.join('\n');
  }
  return titleInputFromPrompts(await promptSource.firstUserPrompts(MAX_TITLE_PROMPTS));
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTitleService,
  SessionTitleService,
  ScopeActivation.OnScopeCreated,
  'sessionTitle',
);
