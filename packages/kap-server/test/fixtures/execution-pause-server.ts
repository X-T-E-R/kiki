import { IAgentContextMemoryService, IAgentLifecycleService, IAgentLoopService, IAgentProfileService, IAgentPromptService, IAgentTaskService, IAuthSummaryService, IModelCatalog, ISessionSubagentService, SubagentTask, ensureMainAgent, getLiveSessionById } from '@kiki/agent-core-v2';
import { mirrorAgentRun } from '@kiki/agent-core-v2/session/subagent/mirrorAgentRun';
import type { Model } from '@kiki/agent-core-v2/kosong/model/catalog';
import { ContinuationStepRequest } from '@kiki/agent-core-v2/agent/loop/stepRequest';
import { startServer } from '../../src/start';
import { TEST_HOST_IDENTITY } from '../helpers/hostIdentity';

const home = process.argv[2]!;
const firstBoot = process.argv[3] === 'first';
let requestCount = 0;
let releaseFirst!: () => void;
const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
const model = {
  id: 'stub', name: 'stub', aliases: [], protocol: 'openai', headers: {},
  capabilities: { image_in: false, video_in: false, audio_in: false, thinking: true, tool_use: false, max_context_tokens: 100000 },
  maxContextSize: 100000, supportEfforts: ['high'], defaultEffort: 'high', alwaysThinking: false,
  providerName: 'stub', imagePolicy: { acceptedTypes: new Set(['image/png']), convertUnsupported: 'off' },
  authProvider: { getAuth: async () => ({ apiKey: 'fixture' }) },
} as Model;
const unavailable = (): never => { throw new Error('Unused fixture model operation'); };
const catalog: IModelCatalog = {
  _serviceBrand: undefined, get: () => model,
  getRequester: () => ({ model, request: async function* () {
    requestCount++;
    process.send?.({ type: 'model', count: requestCount, pid: process.pid });
    if (firstBoot && requestCount === 1) await firstReleased;
    yield { type: 'finish' as const, message: { role: 'assistant' as const,
      content: [{ type: 'text' as const, text: firstBoot ? 'saved first step' : 'resumed second step' }], toolCalls: [] },
      providerFinishReason: 'completed' as const };
  } }),
  getConnectionRequester: unavailable, getConnectionEndpoint: unavailable,
  inspect: unavailable, ping: unavailable, findByName: () => [], listModels: async () => [],
  listProviders: async () => [], getProvider: unavailable, setDefaultModel: unavailable,
};
const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
  homeDir: home, logLevel: 'silent', seeds: [[IModelCatalog, catalog], [IAuthSummaryService, {
    _serviceBrand: undefined, summarize: async () => [], ensureReady: async () => {},
  }]] });
process.send?.({ type: 'ready', port: server.port, token: server.localOwnerToken, pid: process.pid });
process.on('message', (message: { type: string; sessionId?: string; sequence?: number }) => {
  void (async () => {
    if (message.type === 'prepare') {
      const session = getLiveSessionById(server.core.accessor, message.sessionId!)!;
      const main = await ensureMainAgent(session);
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'high' });
      main.accessor.get(IAgentLoopService).hooks.onDidFinishStep.register('fixture-continuation', async (step, next) => {
        await next();
        if (step.step === 1) main.accessor.get(IAgentLoopService).enqueue(new ContinuationStepRequest());
      });
      process.send?.({ type: 'prepared' });
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
      process.send?.({ type: `inspect-${message.sequence}`, prompt: main.accessor.get(IAgentPromptService).lookup('checkpoint-prompt'),
        history: main.accessor.get(IAgentContextMemoryService).get(), tasks: main.accessor.get(IAgentTaskService).list(false) });
    } else if (message.type === 'close') {
      await server.close();
      process.send?.({ type: 'closed', requestCount });
      process.disconnect();
    }
  })().catch(error => {
    process.send?.({ type: 'error', message: error instanceof Error ? error.stack : String(error) });
  });
});
