import {
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  fetchChatTitle,
  kimiCodeToolsUrl,
  parseKimiCodeCustomHeaders,
  resolveKimiCodeRuntimeAuth,
} from '@kiki/oauth';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import { IProviderService } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { resolveSessionTitleModelAlias } from './configSection';
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

export class SessionTitleService implements ISessionTitleService {
  declare readonly _serviceBrand: undefined;

  private _shared: Promise<string | undefined> | undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly eventService: IEventService,
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
  ) {}

  async generateTitle(opts?: {
    force?: boolean;
    source?: SessionTitleSource;
  }): Promise<string | undefined> {
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

  private async generateTitleOnce(
    force: boolean,
    source: SessionTitleSource,
  ): Promise<string | undefined> {
    if (!this.flags.enabled(AUTO_SESSION_TITLE_FLAG_ID)) return undefined;
    const current = await this.metadata.read();
    if (!force) {
      if (current.titleKind === 'custom') return undefined;
      if (current.titleKind === 'generated') return undefined;
    }
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) return undefined;
    const promptSource = main.accessor.get(IAgentTitlePromptSource);
    const input = await composeTitleInput(promptSource, source);
    if (input === undefined) return undefined;
    return this.generateAndApply(input, force);
  }

  private async generateAndApply(
    chatContent: string,
    force: boolean,
  ): Promise<string | undefined> {
    const current = await this.metadata.read();
    if (!force && current.titleKind === 'custom') return undefined;
    const alias = resolveSessionTitleModelAlias(this.config);
    const title =
      alias === undefined
        ? await this.requestManagedTitle(chatContent)
        : await this.requestModelTitle(chatContent, alias);
    if (title === undefined) return undefined;
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(title, { force });
    if (!applied) return undefined;
    this.eventService.publish(
      new SessionMetaUpdated({
        payload: {
          agentId: 'main',
          sessionId: this.ctx.sessionId,
          title,
          patch: { title, isCustomTitle: false },
        },
      }),
    );
    return title;
  }

  private async requestModelTitle(
    chatContent: string,
    alias: string,
  ): Promise<string | undefined> {
    let requester: ModelRequester;
    try {
      requester = this.modelCatalog.getRequester(alias);
    } catch (error) {
      this.log.debug(`session title model unavailable: ${errorMessage(error)}`);
      return undefined;
    }
    const collected: string[] = [];
    try {
      for await (const event of requester.request(
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          tools: [],
          messages: [
            { role: 'user', content: [{ type: 'text', text: chatContent }], toolCalls: [] },
          ],
        },
        undefined,
        { maxCompletionTokens: MAX_GENERATED_TITLE_LENGTH },
      )) {
        if (event.type !== 'finish') continue;
        for (const part of event.message.content) {
          if (part.type === 'text') collected.push(part.text);
        }
      }
    } catch (error) {
      this.log.debug(`session title generation failed: ${errorMessage(error)}`);
      return undefined;
    }
    const title = normalizeGeneratedTitle(collected.join(''));
    return title.length > 0 ? title : undefined;
  }

  private async requestManagedTitle(chatContent: string): Promise<string | undefined> {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (
      provider === undefined ||
      !isOAuthCatalogVendor(provider.type) ||
      provider.oauth === undefined
    ) {
      return undefined;
    }
    const runtimeAuth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider.baseUrl,
      configuredOAuthRef: provider.oauth,
    });
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      runtimeAuth.oauthRef,
    );
    if (tokenProvider === undefined) return undefined;
    let token: string;
    try {
      token = await tokenProvider.getAccessToken();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      this.log.debug(`chat_title request unavailable: ${error.message}`);
      return undefined;
    }
    const requestTitle = (accessToken: string) =>
      fetchChatTitle(kimiCodeToolsUrl(runtimeAuth.baseUrl), accessToken, chatContent, {
        headers: {
          ...parseKimiCodeCustomHeaders(),
          ...this.hostHeaders.headers,
          ...provider.customHeaders,
        },
      });
    let result = await requestTitle(token);
    if (result.kind === 'error' && result.status === 401) {
      try {
        token = await tokenProvider.getAccessToken({ force: true });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        this.log.debug(`chat_title request unavailable: ${error.message}`);
        return undefined;
      }
      result = await requestTitle(token);
    }
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
      return undefined;
    }
    return result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
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
