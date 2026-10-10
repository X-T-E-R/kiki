import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IEventService } from '#/app/event/event';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { ContextApplyCompaction } from '#/agent/contextMemory/contextEvents';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { PromptSubmitted } from '#/agent/prompt/promptService';
import { IAgentStateService } from '#/agent/state/agentState';
import { TurnPrompt, TurnEnded } from '#/agent/loop/turnOps';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ModelRequestEvent, ModelRequester } from '#/kosong/model/modelRequester';
import { IProviderService } from '#/kosong/provider/provider';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentTitlePromptSource, type TitleDigestExcerpt, type TitleTurnExcerpt } from '#/session/sessionTitle/agentTitlePromptSource';
import { ISessionTitleService } from '#/session/sessionTitle/sessionTitle';
import { FAST_MODEL_SECTION, SESSION_TITLE_SECTION, type SessionTitleTrigger } from '#/session/sessionTitle/configSection';
import { SessionTitleService } from '#/session/sessionTitle/sessionTitleService';
import { ISessionMetadata, type SessionMeta, type SessionMetaPatch, type SessionMetadataChangedEvent } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { registerLogServices } from '../../_base/log/stubs';

const SESSION_ID = 'sess-1';

class FakeSessionMetadata implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly emitter = new Emitter<SessionMetadataChangedEvent>();
  readonly onDidChangeMetadata = this.emitter.event;
  meta: SessionMeta = { id: SESSION_ID, createdAt: 0, updatedAt: 0, archived: false };
  read(): Promise<SessionMeta> { return Promise.resolve(this.meta); }
  async getAgentExecutor(agentId: string): Promise<string | undefined> { return this.meta.agents?.[agentId]?.executor; }
  usage(): SessionMeta['usage'] { return this.meta.usage; }
  recordUsage(): void {}
  update(patch: SessionMetaPatch): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    this.emitter.fire({ changed: Object.keys(patch) as (keyof SessionMeta)[] });
    return Promise.resolve();
  }
  setTitle(title: string): Promise<void> { return this.update({ title, titleKind: 'custom' }); }
  async setGeneratedTitleIfUncustomized(title: string, opts?: { force?: boolean }): Promise<boolean> {
    if (opts?.force !== true && this.meta.titleKind === 'custom') return false;
    await this.update({ title, titleKind: 'generated' });
    return true;
  }
  setArchived(archived: boolean): Promise<void> { return this.update({ archived }); }
  registerAgent(): Promise<void> { return Promise.resolve(); }
  async updateAgent(agentId: string, updater: Parameters<ISessionMetadata['updateAgent']>[1]): Promise<void> {
    const current = this.meta.agents?.[agentId];
    if (current !== undefined) await this.update({ agents: { ...this.meta.agents, [agentId]: updater(structuredClone(current)) } });
  }
}

describe('SessionTitleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let metadata: FakeSessionMetadata;
  let titlePrompts: readonly string[];
  let turnExcerpt: TitleTurnExcerpt;
  let digestExcerpt: TitleDigestExcerpt;
  let flagEnabled: boolean;
  let titleModelAlias: string | undefined;
  let fastModelAlias: string | undefined;
  let triggers: SessionTitleTrigger[] | undefined;
  let modelRequesters: Map<string, ModelRequester>;
  let requesterLookups: string[];
  let titleRequests: { text: string; params: Parameters<ModelRequester['request']>[2] }[];
  let published: Event2[];
  let created: Emitter<IAgentScopeHandle>;
  let removed: Emitter<string>;
  let main: IAgentScopeHandle;
  let nextTurnId: number;
  let beforeReply: (() => Promise<void>) | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;
  let tokenMock: ReturnType<typeof vi.fn<() => Promise<string>>>;

  beforeEach(() => {
    titlePrompts = ['hello']; turnExcerpt = {}; digestExcerpt = {};
    flagEnabled = true; titleModelAlias = 'title-model'; fastModelAlias = 'fast-title'; triggers = undefined;
    modelRequesters = new Map(); requesterLookups = []; titleRequests = []; published = [];
    nextTurnId = 0; beforeReply = undefined;
    metadata = new FakeSessionMetadata();
    fetchMock = vi.fn(); tokenMock = vi.fn(async () => 'test-token');
    vi.stubGlobal('fetch', fetchMock);
    disposables = new DisposableStore();
    created = disposables.add(new Emitter<IAgentScopeHandle>());
    removed = disposables.add(new Emitter<string>());
    main = {
      id: MAIN_AGENT_ID, kind: LifecycleScope.Agent,
      accessor: { get: (id) => ix.get(id) }, dispose: () => undefined,
    };
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: SESSION_ID, workspaceId: 'ws-1', sessionDir: '/tmp/sess-1', sessionScope: 'sessions/sess-1', cwd: '/tmp',
        }));
        reg.defineInstance(ISessionMetadata, metadata);
        reg.definePartialInstance(IAgentLifecycleService, { get: () => main, onDidCreate: created.event, onDidDispose: removed.event });
        reg.definePartialInstance(IEventService, { publish: (event) => { published.push(event); } });
        reg.define(IEventBus, EventBusService);
        reg.definePartialInstance(IAgentPromptService, { list: () => ({ active: undefined, pending: [] }) });
        reg.definePartialInstance(IAgentStateService, { get: (() => ({ nextTurnId })) as IAgentStateService['get'] });
        reg.defineInstance(IAgentTitlePromptSource, {
          _serviceBrand: undefined, firstUserPrompts: async (limit) => titlePrompts.slice(0, limit),
          firstTurnExcerpt: async () => turnExcerpt, digestExcerpt: async () => digestExcerpt,
        });
        reg.definePartialInstance(IProviderService, { get: () => ({ type: 'kimi', oauth: { storage: 'file', key: 'test-only' } }) });
        reg.definePartialInstance(IOAuthService, { resolveTokenProvider: () => ({ getAccessToken: tokenMock }) });
        reg.definePartialInstance(IFlagService, { enabled: () => flagEnabled });
        reg.definePartialInstance(IConfigService, {
          get: ((key: string) => key === SESSION_TITLE_SECTION ? { model: titleModelAlias, triggers } : key === FAST_MODEL_SECTION ? fastModelAlias : undefined) as IConfigService['get'],
        });
        reg.definePartialInstance(IModelCatalog, {
          getRequester: (alias) => {
            requesterLookups.push(alias);
            const requester = modelRequesters.get(alias);
            if (requester === undefined) throw new Error(`Unknown model: ${alias}`);
            return requester;
          },
        });
        reg.define(ISessionTitleService, SessionTitleService);
      },
    });
    modelRequesters.set('title-model', stubTitleRequester('生成的标题'));
    ix.get(ISessionTitleService);
  });
  afterEach(() => { disposables.dispose(); vi.unstubAllGlobals(); });

  function stubTitleRequester(answer: string): ModelRequester {
    return {
      model: { id: 'title-model' } as ModelRequester['model'],
      request: (input, _signal, params) => {
        titleRequests.push({
          params, text: input.messages.flatMap((message) => message.content).map((part) => part.type === 'text' ? part.text : '').join(''),
        });
        return (async function* (): AsyncGenerator<ModelRequestEvent> {
          await beforeReply?.();
          yield { type: 'finish', message: { role: 'assistant', content: [{ type: 'text', text: answer }], toolCalls: [] } };
        })();
      },
    };
  }
  function submitted(id = 'opening'): void {
    ix.get(IEventBus).publish(new PromptSubmitted({ agentId: MAIN_AGENT_ID, promptId: id,
      userMessageId: id, status: 'queued', content: [{ type: 'text', text: 'hello' }],
      createdAt: new Date().toISOString(), appendTiming: 'agent_idle', revision: 0 }));
  }
  function start(id = 0, promptId = 'opening'): void {
    ix.get(IEventBus).publish(new TurnPrompt({ turnId: id, promptId, input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' } }));
  }
  function complete(id = 0): void {
    turnExcerpt = { user: 'hello', assistant: 'first reply' };
    ix.get(IEventBus).publish(new TurnEnded({ turnId: id, reason: 'completed' }));
  }
  async function generated(count = 1): Promise<void> {
    await vi.waitFor(() => expect(published).toHaveLength(count));
  }
  async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

  it('requests only the explicit model and publishes persisted generated metadata', async () => {
    titlePrompts = ['先帮我搭一个 Vite 项目', '加上路由'];
    modelRequesters.set('title-model', stubTitleRequester('  "Vite 路由配置"\n'));
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('Vite 路由配置');
    expect(requesterLookups).toEqual(['title-model']);
    expect(titleRequests[0]!.text).toBe('user: 先帮我搭一个 Vite 项目\nuser: 加上路由');
    expect(titleRequests[0]!.params.attribution).toMatchObject({ sessionId: SESSION_ID, agentId: MAIN_AGENT_ID, purpose: 'session_title', logicalRequestId: expect.any(String), waitBudget: { waitedMs: 0 } });
    expect(titleRequests[0]!.params.maxCompletionTokens).toBeUndefined();
    expect(metadata.meta).toMatchObject({ title: 'Vite 路由配置', titleKind: 'generated' });
    expect((published[0] as SessionMetaUpdated).payload.patch).toEqual({ title: 'Vite 路由配置', isCustomTitle: false });
  });
  it.each([undefined, '', '   '])('makes zero automatic and manual requests with no selected model (%s), even with fast_model and managed credentials', async (model) => {
    titleModelAlias = model; triggers = ['first_user_message', 'first_turn_completed', 'context_compacted'];
    submitted(); start(); complete();
    ix.get(IEventBus).publish(new ContextApplyCompaction({ summary: 'summary', compactedCount: 1 }));
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    await expect(ix.get(ISessionTitleService).generateTitle({ force: true, source: 'digest' })).resolves.toBeUndefined();
    await flush();
    expect(requesterLookups).toEqual([]); expect(fetchMock).not.toHaveBeenCalled(); expect(tokenMock).not.toHaveBeenCalled();
  });
  it('uses only the first completed reply by default, not submitted, failed or later turns', async () => {
    submitted(); start(); await flush(); expect(titleRequests).toHaveLength(0);
    complete(); await generated();
    expect(titleRequests[0]!.text).toBe('user: hello\nassistant: first reply');
    submitted('second'); start(1, 'second'); complete(1); await flush();
    expect(titleRequests).toHaveLength(1);
  });
  it('first_user_message runs while queued, once, and not again after the reply', async () => {
    triggers = ['first_user_message']; submitted(); submitted('second'); await generated();
    expect(titleRequests[0]!.text).toBe('user: hello');
    start(); complete(); await flush(); expect(titleRequests).toHaveLength(1);
  });
  it('context_compacted runs only on actual main context compaction and updates a generated title', async () => {
    triggers = ['context_compacted']; submitted(); start(); complete(); await flush(); expect(titleRequests).toHaveLength(0);
    await metadata.setGeneratedTitleIfUncustomized('old generated');
    ix.get(IEventBus).publish(new ContextApplyCompaction({ contextSummary: 'compacted garden plans', compactedCount: 2 }));
    await generated(); expect(metadata.meta.title).toBe('生成的标题');
    expect(titleRequests[0]!.text).toBe('summary: compacted garden plans');
    ix.get(IEventBus).publish(new ContextApplyCompaction({ summary: 'next compression', compactedCount: 2 }));
    await generated(2);
  });
  it('multiple selected moments update in order rather than sharing away the later request', async () => {
    triggers = ['first_user_message', 'first_turn_completed']; submitted(); start(); complete();
    await generated(2); expect(titleRequests.map((request) => request.text)).toEqual(['user: hello', 'user: hello\nassistant: first reply']);
  });
  it('empty triggers and disabled flag suppress automation; empty triggers retain manual force', async () => {
    triggers = []; submitted(); start(); complete(); await flush(); expect(titleRequests).toHaveLength(0);
    await expect(ix.get(ISessionTitleService).generateTitle({ force: true })).resolves.toBe('生成的标题');
    flagEnabled = false;
    await expect(ix.get(ISessionTitleService).generateTitle({ force: true })).resolves.toBeUndefined();
    expect(titleRequests).toHaveLength(1);
  });
  it('rechecks deselected moments before a queued later request', async () => {
    triggers = ['first_user_message', 'first_turn_completed'];
    let release!: () => void; beforeReply = () => new Promise((resolve) => { release = resolve; });
    submitted(); await vi.waitFor(() => expect(titleRequests).toHaveLength(1)); start(); complete(); triggers = []; release();
    await generated(); await flush(); expect(titleRequests).toHaveLength(1);
  });
  it('does not attach child agents or duplicate listeners when main attachment is refreshed', async () => {
    created.fire({ ...main, id: 'child' }); created.fire(main); created.fire(main);
    triggers = ['first_user_message']; submitted(); await generated(); expect(titleRequests).toHaveLength(1);
  });
  it('does not treat restored conversation history as a new first turn', async () => {
    nextTurnId = 4; created.fire(main); submitted(); start(4); complete(4); await flush(); expect(titleRequests).toHaveLength(0);
  });
  it('does not request automatic titles for a manually named session', async () => {
    triggers = ['first_user_message', 'first_turn_completed', 'context_compacted']; await metadata.setTitle('my name');
    submitted(); start(); complete(); ix.get(IEventBus).publish(new ContextApplyCompaction({ summary: 'summary', compactedCount: 2 }));
    await flush(); expect(titleRequests).toHaveLength(0); expect(metadata.meta.title).toBe('my name');
  });
  it('never overwrites a manual rename during an automatic request', async () => {
    let release!: () => void; beforeReply = () => new Promise((resolve) => { release = resolve; });
    triggers = ['first_user_message']; submitted(); await vi.waitFor(() => expect(titleRequests).toHaveLength(1));
    await metadata.setTitle('my name'); release(); await flush(); expect(metadata.meta.title).toBe('my name'); expect(published).toHaveLength(0);
  });
  it('manual nonforce skips generated/custom; force intentionally replaces either', async () => {
    await metadata.setGeneratedTitleIfUncustomized('old generated');
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    await expect(ix.get(ISessionTitleService).generateTitle({ force: true })).resolves.toBe('生成的标题');
    await metadata.setTitle('my name');
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    await expect(ix.get(ISessionTitleService).generateTitle({ force: true })).resolves.toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
  });
  it.each(['missing', 'failed', 'empty'])('reports manual %s model failures, preserves the title and publishes no success', async (kind) => {
    if (kind === 'missing') titleModelAlias = 'missing-model';
    if (kind === 'failed') beforeReply = async () => { throw new Error('provider exploded'); };
    if (kind === 'empty') modelRequesters.set('title-model', stubTitleRequester(''));
    await metadata.setTitle('my name');
    await expect(ix.get(ISessionTitleService).generateTitle({ force: true })).rejects.toMatchObject({ code: 'session.title_generation_failed' });
    expect(metadata.meta.title).toBe('my name'); expect(published).toHaveLength(0); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('automatic failure preserves the title without silently emitting a success or retrying', async () => {
    titleModelAlias = 'missing-model'; triggers = ['first_user_message']; submitted(); await flush();
    expect(requesterLookups).toEqual(['missing-model']); expect(published).toHaveLength(0); expect(metadata.meta.title).toBeUndefined();
  });
  it('shares concurrent nonforce manual requests', async () => {
    let release!: () => void; beforeReply = () => new Promise((resolve) => { release = resolve; });
    const first = ix.get(ISessionTitleService).generateTitle(); const second = ix.get(ISessionTitleService).generateTitle();
    await vi.waitFor(() => expect(titleRequests).toHaveLength(1)); release();
    await expect(first).resolves.toBe('生成的标题'); await expect(second).resolves.toBe('生成的标题');
  });
  it('clamps model titles and ordered user prompt input without counting the character limit as a completion token budget', async () => {
    titlePrompts = ['很长的输入'.repeat(400), '第二条']; modelRequesters.set('title-model', stubTitleRequester(`标题\n${'很'.repeat(500)}`));
    const title = await ix.get(ISessionTitleService).generateTitle(); expect(title).toHaveLength(200); expect(title).not.toContain('\n');
    expect(titleRequests[0]!.text).toHaveLength(1000); expect(titleRequests[0]!.text.startsWith('user: 很长的输入')).toBe(true);
  });
  it('first_turn remains strict and bounds each user/reply segment', async () => {
    turnExcerpt = { user: '只有问题' }; await expect(ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' })).resolves.toBeUndefined();
    turnExcerpt = { user: '问'.repeat(500), assistant: '答'.repeat(1000) };
    await ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }); expect(titleRequests[0]!.text).toBe(`user: ${'问'.repeat(300)}\nassistant: ${'答'.repeat(600)}`);
  });
  it('digest composes head/tail text, tolerates missing reply and rejects an empty window', async () => {
    await expect(ix.get(ISessionTitleService).generateTitle({ source: 'digest' })).resolves.toBeUndefined();
    digestExcerpt = { firstUser: '开场', lastUser: '最新追问', assistant: '当前进展' };
    await ix.get(ISessionTitleService).generateTitle({ source: 'digest' }); expect(titleRequests[0]!.text).toBe('user: 开场\nuser: 最新追问\nassistant: 当前进展');
    digestExcerpt = { firstUser: '开场' }; await ix.get(ISessionTitleService).generateTitle({ force: true, source: 'digest' }); expect(titleRequests[1]!.text).toBe('user: 开场');
  });
  it('does not turn lastPrompt slash metadata or empty input into a model request', async () => {
    titlePrompts = []; await metadata.update({ lastPrompt: '/compact' });
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined(); expect(titleRequests).toHaveLength(0);
  });
});
