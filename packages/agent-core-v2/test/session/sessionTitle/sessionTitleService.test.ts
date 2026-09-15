import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { OAuthConnectionError, OAuthUnauthorizedError } from '@kiki/oauth';
import type { ContentPart } from '#/kosong/contract/message';

import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IEventService } from '#/app/event/event';
import type { Event2 } from '#/app/event/event2';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ModelRequestEvent, ModelRequester } from '#/kosong/model/modelRequester';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
} from '#/kosong/provider/provider';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  IAgentTitlePromptSource,
  type TitleDigestExcerpt,
  type TitleTurnExcerpt,
} from '#/session/sessionTitle/agentTitlePromptSource';
import { ISessionTitleService } from '#/session/sessionTitle/sessionTitle';
import { SESSION_TITLE_SECTION } from '#/session/sessionTitle/configSection';
import { SessionTitleService } from '#/session/sessionTitle/sessionTitleService';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import '#/kosong/provider/providers/kimi/kimi.contrib';

import { registerLogServices } from '../../_base/log/stubs';
import { stubProviderService } from '../../app/provider/stubs';

const SESSION_ID = 'sess-1';
const MANAGED_PROVIDER: ProviderConfig = {
  type: 'kimi',
  baseUrl: 'https://api.example.test/coding/v1',
  oauth: { storage: 'file', key: 'kimi-code' },
};

class FakeEventService implements IEventService {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<Event2>();
  readonly onDidPublish = this.emitter.event;
  readonly published: Event2[] = [];

  publish(event: Event2): void {
    this.published.push(event);
    this.emitter.fire(event);
  }

  subscribe(handler: (event: Event2) => void): IDisposable {
    return this.emitter.event(handler);
  }
}

class FakeSessionMetadata implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly emitter = new Emitter<SessionMetadataChangedEvent>();
  readonly onDidChangeMetadata = this.emitter.event;
  meta: SessionMeta;

  constructor() {
    this.meta = {
      id: SESSION_ID,
      createdAt: 0,
      updatedAt: 0,
      archived: false,
    };
  }

  read(): Promise<SessionMeta> {
    return Promise.resolve(this.meta);
  }

  usage(): SessionMeta['usage'] {
    return this.meta.usage;
  }

  recordUsage(): void {}

  update(patch: SessionMetaPatch): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    this.emitter.fire({ changed: Object.keys(patch) as (keyof SessionMeta)[] });
    return Promise.resolve();
  }

  setTitle(title: string): Promise<void> {
    return this.update({ title, titleKind: 'custom' });
  }

  async setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    if (opts?.force !== true && this.meta.titleKind === 'custom') return false;
    await this.update({ title, titleKind: 'generated' });
    return true;
  }

  setArchived(archived: boolean): Promise<void> {
    return this.update({ archived });
  }

  registerAgent(): Promise<void> {
    return Promise.resolve();
  }
}

function createPendingFetch() {
  let markStarted!: () => void;
  let resolveResponse!: (response: Response) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    fetch: async () => {
      markStarted();
      return response;
    },
    started,
    resolve: resolveResponse,
  };
}

describe('SessionTitleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let events: FakeEventService;
  let metadata: FakeSessionMetadata;
  let providers: Record<string, ProviderConfig>;
  let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
  let tokenError: Error | undefined;
  let forceTokenError: Error | undefined;
  let resolvedOAuthRefs: Array<OAuthRef | undefined>;
  let titlePrompts: readonly string[];
  let promptSourceImpl: (limit: number) => Promise<readonly string[]>;
  let turnExcerpt: TitleTurnExcerpt;
  let digestExcerpt: TitleDigestExcerpt;
  let tokenCalls: boolean[];
  let flagEnabled: boolean;
  let titleModelAlias: string | undefined;
  let modelRequesters: Map<string, ModelRequester>;
  let requesterLookups: string[];
  let titleRequests: Array<{ readonly systemPrompt: string; readonly text: string }>;

  beforeEach(() => {
    tokenError = undefined;
    forceTokenError = undefined;
    resolvedOAuthRefs = [];
    titlePrompts = [];
    promptSourceImpl = async (limit) => titlePrompts.slice(0, limit);
    turnExcerpt = {};
    digestExcerpt = {};
    tokenCalls = [];
    flagEnabled = true;
    titleModelAlias = undefined;
    modelRequesters = new Map();
    requesterLookups = [];
    titleRequests = [];
    providers = { 'managed:kimi-code': MANAGED_PROVIDER };
    metadata = new FakeSessionMetadata();
    events = new FakeEventService();
    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ title: '生成的标题' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(
          ISessionContext,
          makeSessionContext({
            sessionId: SESSION_ID,
            workspaceId: 'ws-1',
            sessionDir: '/tmp/sess-1',
            sessionScope: 'sessions/sess-1',
            cwd: '/tmp',
          }),
        );
        reg.defineInstance(ISessionMetadata, metadata);
        const promptSource: IAgentTitlePromptSource = {
          _serviceBrand: undefined,
          firstUserPrompts: (limit) => promptSourceImpl(limit),
          firstTurnExcerpt: async () => turnExcerpt,
          digestExcerpt: async () => digestExcerpt,
        };
        const mainAgent: IAgentScopeHandle = {
          id: MAIN_AGENT_ID,
          kind: LifecycleScope.Agent,
          accessor: { get: <T>() => promptSource as T },
          dispose: () => undefined,
        };
        reg.definePartialInstance(IAgentLifecycleService, {
          get: () => mainAgent,
        });
        reg.defineInstance(IEventService, events);
        reg.defineInstance(IProviderService, stubProviderService(providers));
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider: (_provider, oauthRef) => {
            resolvedOAuthRefs.push(oauthRef);
            return {
              getAccessToken: async (options) => {
                tokenCalls.push(options?.force === true);
                if (tokenError !== undefined) throw tokenError;
                if (options?.force === true && forceTokenError !== undefined) {
                  throw forceTokenError;
                }
                return 'test-token';
              },
            };
          },
        });
        reg.defineInstance(IHostRequestHeaders, {
          headers: { 'User-Agent': 'test' },
          thirdPartyHeaders: {},
        });
        reg.definePartialInstance(IFlagService, { enabled: () => flagEnabled });
        reg.definePartialInstance(IConfigService, {
          get: ((key: string) =>
            key === SESSION_TITLE_SECTION && titleModelAlias !== undefined
              ? { model: titleModelAlias }
              : undefined) as unknown as IConfigService['get'],
        });
        reg.definePartialInstance(IModelCatalog, {
          getRequester: (alias: string) => {
            requesterLookups.push(alias);
            const requester = modelRequesters.get(alias);
            if (requester === undefined) throw new Error(`Unknown model: ${alias}`);
            return requester;
          },
        } as unknown as IModelCatalog);
        reg.define(ISessionTitleService, SessionTitleService);
      },
    });
    ix.get(ISessionTitleService);
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubTitleRequester(answer: string): ModelRequester {
    return {
      model: { id: 'title-model' } as ModelRequester['model'],
      request: (input: { readonly messages: readonly { readonly content: readonly ContentPart[] }[] }) => {
        titleRequests.push({
          systemPrompt: '',
          text: input.messages
            .flatMap((message) => message.content)
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join(''),
        });
        return (async function* generate() {
          yield {
            type: 'finish',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: answer }],
              toolCalls: [],
            },
          } as ModelRequestEvent;
        })();
      },
    } as unknown as ModelRequester;
  }

  function stubFailingTitleRequester(): ModelRequester {
    return {
      model: { id: 'title-model' } as ModelRequester['model'],
      request: () =>
        (async function* generate(): AsyncGenerator<ModelRequestEvent> {
          throw new Error('provider exploded');
        })(),
    } as unknown as ModelRequester;
  }

  it('is unavailable while the experimental auto_session_title flag is off', async () => {
    flagEnabled = false;
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true, source: 'digest' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('generates through the pinned model instead of the managed chat_title tool', async () => {
    titleModelAlias = 'title-model';
    titlePrompts = ['先帮我搭一个 Vite 项目', '加上路由'];
    modelRequesters.set('title-model', stubTitleRequester('  "Vite 路由配置"\n'));

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toBe('Vite 路由配置');
    expect(metadata.meta.titleKind).toBe('generated');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requesterLookups).toEqual(['title-model']);
    expect(titleRequests).toHaveLength(1);
    expect(titleRequests[0]!.text).toBe('user: 先帮我搭一个 Vite 项目\nuser: 加上路由');
  });

  it('clamps a chatty model answer to the shared title budget', async () => {
    titleModelAlias = 'title-model';
    titlePrompts = ['hello'];
    modelRequesters.set('title-model', stubTitleRequester(`标题\n${'很'.repeat(500)}`));

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toHaveLength(200);
    expect(title).not.toContain('\n');
    expect(title!.startsWith('标题 很')).toBe(true);
  });

  it('degrades without touching the managed endpoint when the pinned model is unknown', async () => {
    titleModelAlias = 'missing-model';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();

    expect(requesterLookups).toEqual(['missing-model']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadata.meta.title).toBeUndefined();
  });

  it('degrades when the pinned model request fails', async () => {
    titleModelAlias = 'title-model';
    titlePrompts = ['hello'];
    modelRequesters.set('title-model', stubFailingTitleRequester());

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps calling the managed chat_title tool when no title model is pinned', async () => {
    titlePrompts = ['hello'];

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requesterLookups).toEqual([]);
  });

  it('replaces the easy title with the generated one', async () => {
    titlePrompts = ['帮我看一下这个 Go 的 nil pointer 报错'];

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 帮我看一下这个 Go 的 nil pointer 报错' },
    });
    expect(new Headers(init?.headers as Record<string, string>).get('authorization')).toBe(
      'Bearer test-token',
    );

    const rebroadcast = events.published.find(
      (event): event is SessionMetaUpdated =>
        event.type === 'session.meta.updated' &&
        (event as SessionMetaUpdated).payload.patch.title === '生成的标题',
    );
    expect(rebroadcast).toBeDefined();
  });

  it('composes the title input from the recorded prompts in order', async () => {
    titlePrompts = ['先帮我搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'];

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: {
        chat_content: 'user: 先帮我搭一个 Vite 项目\nuser: 加上路由\nuser: 现在配一下 ESLint',
      },
    });
  });

  it('truncates the composed title input to the total budget, keeping the head', async () => {
    titlePrompts = ['很长的输入'.repeat(400), '第二条'];

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as { params: { chat_content: string } };
    expect(body.params.chat_content.startsWith('user: 很长的输入')).toBe(true);
    expect(body.params.chat_content).toHaveLength(1000);
  });

  it('returns unavailable when only a slash activation updated lastPrompt', async () => {
    await metadata.update({ lastPrompt: '/compact' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing without a managed OAuth provider', async () => {
    delete providers['managed:kimi-code'];
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never overwrites a custom title set while generation is in flight', async () => {
    const pendingFetch = createPendingFetch();
    fetchMock.mockImplementationOnce(pendingFetch.fetch);

    titlePrompts = ['hello'];
    const generation = ix.get(ISessionTitleService).generateTitle();
    await pendingFetch.started;
    await metadata.setTitle('user 取的标题');
    pendingFetch.resolve(
      new Response(JSON.stringify({ title: '生成的标题' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generation).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('user 取的标题');
    expect(metadata.meta.titleKind).toBe('custom');
  });

  it('skips generation when the current title was already generated', async () => {
    await metadata.setGeneratedTitleIfUncustomized('已生成的标题');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadata.meta.title).toBe('已生成的标题');
  });

  it('force regenerates an already-generated title', async () => {
    await metadata.setGeneratedTitleIfUncustomized('已生成的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
  });

  it('force overwrites a custom title and drops its custom marking', async () => {
    await metadata.setTitle('user 取的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
  });

  it('force still degrades when the backend request fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
    await metadata.setTitle('user 取的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('user 取的标题');
    expect(metadata.meta.titleKind).toBe('custom');
  });

  it('first_turn composes the opening prompt with the first reply, within budget', async () => {
    turnExcerpt = { user: '最初的问题', assistant: '第一轮的回答' };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBe('生成的标题');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 最初的问题\nassistant: 第一轮的回答' },
    });
  });

  it('first_turn is strict: no assistant reply yet means unavailable', async () => {
    turnExcerpt = { user: '只有问题' };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('first_turn truncates each segment to its budget', async () => {
    turnExcerpt = { user: '问'.repeat(500), assistant: '答'.repeat(1000) };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBe('生成的标题');

    const [, init] = fetchMock.mock.calls[0]!;
    const content = (JSON.parse(init?.body as string) as { params: { chat_content: string } })
      .params.chat_content;
    expect(content).toBe(`user: ${'问'.repeat(300)}\nassistant: ${'答'.repeat(600)}`);
  });

  it('digest composes head and tail segments, tolerating a missing reply', async () => {
    digestExcerpt = { firstUser: '开场', lastUser: '最新追问', assistant: '当前进展' };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBe('生成的标题');

    let [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 开场\nuser: 最新追问\nassistant: 当前进展' },
    });

    fetchMock.mockClear();
    digestExcerpt = { firstUser: '开场' };
    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true, source: 'digest' }),
    ).resolves.toBe('生成的标题');
    [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 开场' },
    });
  });

  it('digest is unavailable when the window yields no segments at all', async () => {
    digestExcerpt = {};

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the current title when the backend request fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
    titlePrompts = ['hello'];
    await metadata.update({ title: 'hello', titleKind: 'replaceable' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('hello');
    expect(tokenCalls).toEqual([false]);
  });

  it('retries once with a force-refreshed token on a 401', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 401 }));
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('gives up when the 401 persists after the force refresh', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 401 }));
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('degrades when the force refresh after a 401 fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 401 }));
    forceTokenError = new OAuthUnauthorizedError('refresh rejected');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('returns unavailable when the OAuth token is missing or revoked', async () => {
    tokenError = new OAuthUnauthorizedError('re-login required');
    titlePrompts = ['hello'];

    const svc = ix.get(ISessionTitleService);
    await expect(svc.generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unavailable when OAuth token retrieval has an operational failure', async () => {
    tokenError = new OAuthConnectionError('connection failed');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates unexpected token provider failures', async () => {
    tokenError = new Error('unexpected failure');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).rejects.toThrow(
      'unexpected failure',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes environment custom headers', async () => {
    vi.stubEnv('KIMI_CODE_CUSTOM_HEADERS', 'X-Proxy-Header: from-env\n');
    titlePrompts = ['hello'];

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers as Record<string, string>);
    expect(headers.get('x-proxy-header')).toBe('from-env');
    expect(headers.get('user-agent')).toBe('test');
  });

  it('pairs the environment endpoint with its credential slot when it overrides persisted config', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.env.example.test/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.env.example.test');
    titlePrompts = ['hello'];

    await ix.get(ISessionTitleService).generateTitle();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.env.example.test/coding/v1/tools');
    expect(resolvedOAuthRefs[0]).toMatchObject({
      storage: 'file',
      oauthHost: 'https://auth.env.example.test',
    });
    expect(resolvedOAuthRefs[0]?.key).not.toBe(MANAGED_PROVIDER.oauth?.key);
  });

  it('shares an in-flight generation between concurrent requests', async () => {
    const pendingFetch = createPendingFetch();
    fetchMock.mockImplementationOnce(pendingFetch.fetch);

    titlePrompts = ['hello'];
    const first = ix.get(ISessionTitleService).generateTitle();
    const second = ix.get(ISessionTitleService).generateTitle();
    await pendingFetch.started;

    pendingFetch.resolve(
      new Response(JSON.stringify({ title: '生成的标题' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(first).resolves.toBe('生成的标题');
    await expect(second).resolves.toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable without calling the backend when no prompt was seen', async () => {
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
