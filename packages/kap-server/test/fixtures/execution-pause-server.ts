import { IAgentContextMemoryService, IAgentLifecycleService, IAgentLoopService, IAgentProfileService, IAgentPromptService, IAgentTaskService, IAuthSummaryService, IModelCatalog, ISessionSubagentService, SubagentTask, ensureMainAgent, getLiveSessionById } from '@kiki/agent-core-v2';
import { mirrorAgentRun, SubagentStarted } from '@kiki/agent-core-v2/session/subagent/mirrorAgentRun';
import { IEventBus } from '@kiki/agent-core-v2/app/event/eventBus';
import { ToolProgress } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { Model } from '@kiki/agent-core-v2/kosong/model/catalog';
import { ContinuationStepRequest } from '@kiki/agent-core-v2/agent/loop/stepRequest';
import { startServer } from '../../src/start';
import { TEST_HOST_IDENTITY } from '../helpers/hostIdentity';

const home = process.argv[2]!;
const firstBoot = process.argv[3] === 'first';
let requestCount = 0;
let observer: 'task' | 'agent' | undefined;
let releaseFirst!: () => void;
const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
const model = {
  id: 'stub', name: 'stub', aliases: [], protocol: 'openai', headers: {},
  capabilities: { image_in: false, video_in: false, audio_in: false, thinking: true, tool_use: true, max_context_tokens: 100000 },
  maxContextSize: 100000, supportEfforts: ['high'], defaultEffort: 'high', alwaysThinking: false,
  providerName: 'stub', imagePolicy: { acceptedTypes: new Set(['image/png']), convertUnsupported: 'off' },
  authProvider: { getAuth: async () => ({ apiKey: 'fixture' }) },
} as Model;
const unavailable = (): never => { throw new Error('Unused fixture model operation'); };
const catalog: IModelCatalog = {
  _serviceBrand: undefined, get: () => model,
  getRequester: () => ({ model, request: async function* () {
    const count = ++requestCount;
    process.send?.({ type: 'model', count, pid: process.pid });
    if (firstBoot && count === (observer === 'agent' ? 2 : 1)) await firstReleased;
    const tool = firstBoot && observer === 'task' && count === 2
      ? { name: 'TaskWait', arguments: JSON.stringify({ task_id: 'agent-checkpoint-child', timeout: 86400, sync_wait: true,
        sync_reason: 'Use the original fixture result in this turn' }) }
      : firstBoot && observer === 'agent' && count === 1
        ? { name: 'AgentRun', arguments: JSON.stringify({ description: 'Retain original child', prompt: 'child work once', background: false,
          model_alias: 'stub', effort: 'high' }) }
        : undefined;
    yield { type: 'finish' as const, message: { role: 'assistant' as const,
      content: [{ type: 'text' as const, text: firstBoot ? 'saved first step' : 'resumed second step' }],
      toolCalls: tool === undefined ? [] : [{ type: 'function' as const, id: 'observer-call', ...tool }] },
      providerFinishReason: tool === undefined ? 'completed' as const : 'tool_calls' as const };
  } }),
  getConnectionRequester: unavailable, getConnectionEndpoint: unavailable,
  inspect: unavailable, ping: unavailable, findByName: () => [], listModels: async () => [],
  listProviders: async () => [], getProvider: unavailable, setDefaultModel: unavailable,
};
process.send?.({ type: 'phase', phase: 'server.start', pid: process.pid });
const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
  homeDir: home, env: { ...process.env, KIKI_DESKTOP_BUNDLED: '1' }, logLevel: 'silent', seeds: [[IModelCatalog, catalog], [IAuthSummaryService, {
    _serviceBrand: undefined, summarize: async () => [], ensureReady: async () => {},
  }]] });
process.send?.({ type: 'ready', port: server.port, token: server.localOwnerToken, pid: process.pid });
process.on('message', (message: { type: string; sessionId?: string; sequence?: number; taskId?: string }) => {
  void (async () => {
    process.send?.({ type: 'phase', phase: message.type, pid: process.pid });
    if (message.type === 'prepare') {
      const session = getLiveSessionById(server.core.accessor, message.sessionId!)!;
      const main = await ensureMainAgent(session);
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'high' });
      main.accessor.get(IAgentLoopService).hooks.onDidFinishStep.register('fixture-continuation', async (step, next) => {
        await next();
        if (step.step === 1) main.accessor.get(IAgentLoopService).enqueue(new ContinuationStepRequest());
      });
      process.send?.({ type: 'prepared' });
    } else if (message.type === 'observe' || message.type === 'foreground') {
      observer = message.type === 'observe' ? 'task' : 'agent';
      const session = getLiveSessionById(server.core.accessor, message.sessionId!)!;
      const main = await ensureMainAgent(session);
      if (observer === 'task') {
        main.accessor.get(IEventBus).subscribe(ToolProgress, event => {
          if (event.toolCallId === 'observer-call') process.send?.({ type: 'waiting' });
        });
      } else {
        await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'high' });
        session.accessor.get(IAgentLifecycleService).onWillCreate(child => {
          child.accessor.get(IAgentLoopService).hooks.onDidFinishStep.register('child-continuation', async (step, next) => {
            await next();
            if (step.step === 1) child.accessor.get(IAgentLoopService).enqueue(new ContinuationStepRequest());
          });
        });
        main.accessor.get(IEventBus).subscribe(SubagentStarted, event => {
          process.send?.({ type: 'waiting', childId: event.subagentId, tasks: main.accessor.get(IAgentTaskService).list(false) });
        });
      }
      await main.accessor.get(IAgentPromptService).enqueue({ id: 'checkpoint-prompt', message: {
        role: 'user', content: [{ type: 'text', text: 'observe original child' }], toolCalls: [], origin: { kind: 'user' },
      }, waitForLaunch: false });
      process.send?.({ type: 'observing' });
    } else if (message.type === 'child') {
      const session = getLiveSessionById(server.core.accessor, message.sessionId!)!;
      const main = await ensureMainAgent(session);
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'high' });
      const child = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'paused-child',
        delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
      child.accessor.get(IAgentLoopService).hooks.onDidFinishStep.register('child-continuation', async (step, next) => {
        await next();
        if (step.step === 1) child.accessor.get(IAgentLoopService).enqueue(new ContinuationStepRequest());
      });
      const controller = new AbortController();
      const run = await session.accessor.get(ISessionSubagentService).run(child.id, { kind: 'prompt', prompt: 'child work once' },
        { signal: controller.signal, parentReceiptManaged: true });
      const completion = mirrorAgentRun(main, run, { profileName: 'agent', signal: controller.signal,
        deferStarted: true, resolveTaskId: () => 'agent-checkpoint-child' });
      main.accessor.get(IAgentTaskService).registerTask(new SubagentTask({ agentId: child.id, profileName: 'agent',
        model: 'stub', thinkingEffort: 'high', completion: completion.then(result => ({ result: result.summary, usage: result.usage })) },
        'Retained child', controller), { taskId: 'agent-checkpoint-child', detached: true });
      process.send?.({ type: 'child-started', tasks: main.accessor.get(IAgentTaskService).list(false) });
    } else if (message.type === 'release') releaseFirst();
    else if (message.type === 'inventory') {
      const session = getLiveSessionById(server.core.accessor, message.sessionId!);
      process.send?.({ type: 'inventory', live: session !== undefined, agents: session?.accessor.get(IAgentLifecycleService).list() ?? [] });
    } else if (message.type === 'inspect') {
      const main = getLiveSessionById(server.core.accessor, message.sessionId!)!.accessor.get(IAgentLifecycleService).get('main')!;
      const tasks = main.accessor.get(IAgentTaskService);
      process.send?.({ type: `inspect-${message.sequence}`, prompt: main.accessor.get(IAgentPromptService).lookup('checkpoint-prompt'),
        history: main.accessor.get(IAgentContextMemoryService).get(), tasks: tasks.list(false),
        task: message.taskId === undefined ? undefined : await tasks.getTaskSnapshot(message.taskId) });
    } else if (message.type === 'close') {
      await server.close();
      process.send?.({ type: 'closed', requestCount });
      process.disconnect();
    }
  })().catch(error => {
    process.send?.({ type: 'error', message: error instanceof Error ? error.stack : String(error) });
  });
});
