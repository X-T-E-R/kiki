import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import { createControlledPromise } from '@antfu/utils';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { QuestionBackgroundTask } from '#/agent/tools/ask-user-question/question-background-task';
import { escapeXml } from '#/_base/utils/xml-escape';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  agentService,
  sessionService,
  taskServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  type TaskServiceTestManager,
} from './stubs';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
): SubagentTask {
  return new SubagentTask(
    { agentId: 'agent-child', profileName: 'coder', completion },
    description,
    new AbortController(),
  );
}

function notifiedCount(ctx: TestAgentContext): number {
  return ctx.allEvents.filter((e) => e.type === '[rpc]' && e.event === 'task.notified').length;
}

describe('task notification dispatch capacity', () => {
  it.each([false, true])('shares ordinary previews across a real merged step (overflow=%s), not question answers', async (overflow) => {
    const entered = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    let calls = 0;
    const requester: IAgentLLMRequesterService = {
      _serviceBrand: undefined,
      prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
      invalidatePromptSnapshots: () => 0,
      async request() {
        calls++;
        if (calls === 1) { entered.resolve(); await release; }
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }], toolCalls: [] },
          usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        };
      },
      start(overrides, onPart, signal) {
        return { trace: { traceId: undefined }, result: this.request(overrides, onPart, signal) };
      },
    };
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, requester));
    const tasks = ctx.get(IAgentTaskService) as TaskServiceTestManager;
    const loop = ctx.get(IAgentLoopService);
    const enqueue = vi.spyOn(loop, 'enqueue');
    const output = 'x' + '中<&>🙂'.repeat(overflow ? 700 : 2);
    const answer = JSON.stringify({ answers: { choice: '完整回答🙂'.repeat(600) } });
    try {
      const run = await ctx.get(IAgentExecutionService).run(
        { kind: 'prompt', prompt: 'hold this step' },
        { signal: new AbortController().signal },
      );
      await entered;
      const suppressed = tasks.registerTask(agentTask(Promise.resolve({ result: 's'.repeat(16_000) }), 'already consumed via wait'));
      await vi.waitFor(() => expect(enqueue.mock.calls.filter(([r]) => r.kind === 'task_notification')).toHaveLength(1));
      const suppressedRequest = enqueue.mock.calls.find(([r]) => r.kind === 'task_notification')![0];
      tasks.markTasksDeliveredViaWait([{ taskId: suppressed, status: 'completed' }]);
      expect(suppressedRequest.aborted).toBe(true);
      enqueue.mockClear();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(tasks.registerTask(agentTask(Promise.resolve({ result: output }), `batch-${i}`)));
        await vi.waitFor(() => expect(enqueue.mock.calls.filter(([r]) => r.kind === 'task_notification')).toHaveLength(i + 1));
      }
      const questionId = tasks.registerTask(new QuestionBackgroundTask(
        async () => ({ output: answer }), 'choose explicitly', { questionCount: 1 },
      ));
      await vi.waitFor(() => expect(enqueue.mock.calls.filter(([r]) => r.kind === 'task_notification')).toHaveLength(5));
      expect(notifiedCount(ctx)).toBe(0);
      release.resolve();
      await run.completion;
      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(5));
      await loop.settled();
      expect(calls).toBe(2);
      const notifications = ctx.context.get().filter((m) => m.origin?.kind === 'task');
      expect(notifications).toHaveLength(5);
      const texts = notifications.map((m) => m.content.map((p) => p.type === 'text' ? p.text : '').join(''));
      const ordinary = texts.filter((text) => !text.includes(questionId));
      const previewBytes = ordinary.flatMap((text) => [...text.matchAll(/<output-preview bytes="(\d+)"/g)]).reduce((sum, match) => sum + Number(match[1]), 0);
      expect(previewBytes).toBeLessThanOrEqual(16_000);
      expect(previewBytes).toBe(overflow ? 15_999 : Buffer.byteLength(output) * 4);
      for (const id of ids) expect(texts.some((text) => text.includes(id))).toBe(true);
      expect(ordinary[0]).toContain(escapeXml(output));
      expect(ordinary.join('')).not.toContain('\uFFFD');
      expect(ordinary.join('')).not.toContain('中<&>');
      if (overflow) {
        expect(ordinary[1]).toContain(escapeXml(output));
        expect(ordinary[2]).toContain('truncated="true" complete="false"');
        expect(ordinary[2]).toContain(escapeXml('<&>🙂' + '中<&>🙂'.repeat(199)));
        expect(ordinary[3]).not.toContain('<output-preview');
        expect(ordinary[3]).toContain('Output preview omitted');
        expect(ordinary[3]).toContain('<output-file');
        expect(ordinary[3]).not.toContain('No final agent receipt');
      } else {
        for (const text of ordinary) expect(text).toContain(escapeXml(output));
        expect(ordinary.join('')).not.toContain('Output preview omitted');
      }
      const question = texts.find((text) => text.includes(questionId))!;
      expect(question).toContain(answer);
      expect(question).toContain('Background question answered');
      expect(question).not.toContain('dismissed');
      const next = tasks.registerTask(agentTask(Promise.resolve({ result: output }), 'fresh batch'));
      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(6));
      await loop.settled();
      expect(JSON.stringify(ctx.context.get().find((m) => m.origin?.kind === 'task' && m.origin.taskId === next)?.content)).toContain(escapeXml(output));
    } finally {
      release.resolve();
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
  it.each(['completed', 'failed', 'cancelled'])('holds an admitted automatic turn until %s settlement', async (outcome) => {
    const entered = createControlledPromise<void>();
    const finish = createControlledPromise<AgentLLMRequestFinish>();
    const requester: IAgentLLMRequesterService = {
      _serviceBrand: undefined, prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
      invalidatePromptSnapshots: () => 0,
      request: async () => { entered.resolve(); return finish; },
      start(overrides, onPart, signal) {
        return { trace: { traceId: undefined }, result: this.request(overrides, onPart, signal) };
      },
    };
    const ctx = createTestAgent(
      { initialConfig: { subagent: { maxDirectChildren: 1, maxTotalSubagents: 1 } } },
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'A', parentAgentId: 'main', agentScope: 'agents/A' })),
      agentService(IAgentLLMRequesterService, requester),
    );
    try {
      const dispatch = ctx.get(ISessionDispatchService);
      const loop = ctx.get(IAgentLoopService);
      const ended = ctx.untilTurnEnd();
      ctx.get(IAgentTaskService).registerTask(agentTask(Promise.resolve({ result: 'ready' }), 'automatic wakeup'));
      await entered;
      expect(() => dispatch.reserveExecution('B', 'main')).toThrow(expect.objectContaining({ code: 'dispatch.limit_exceeded' }));
      if (outcome === 'cancelled') {
        loop.cancel(undefined, new Error('cancel automatic turn'));
        expect(() => dispatch.reserveExecution('B', 'main')).toThrow(expect.objectContaining({ code: 'dispatch.limit_exceeded' }));
      }
      if (outcome === 'completed') {
        finish.resolve({ message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] }, usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } });
      } else {
        finish.reject(new Error('request unwound'));
      }
      await ended;
      await loop.settled();
      const release = dispatch.reserveExecution('B', 'main');
      release();
      expect(notifiedCount(ctx)).toBe(1);
    } finally {
      finish.reject(new Error('cleanup'));
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
  it.each([1, 0])('rejects a child wakeup before consumption with direct limit %s and tree limit 1', async (maxDirectChildren) => {
    const childScope = (agentId: string) => agentService(IAgentScopeContext, makeAgentScopeContext({
      agentId, agentScope: `agents/${agentId}`, parentAgentId: 'main',
    }));
    const a = createTestAgent({ initialConfig: { subagent: { maxDirectChildren, maxTotalSubagents: 1 } } }, childScope('A'));
    const dispatch = a.get(ISessionDispatchService);
    const started = createControlledPromise<void>();
    const blocked: typeof kosongGenerate = async (_chat, _prompt, _tools, _history, _callbacks, options) => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => { reject(options.signal?.reason); }, { once: true });
      });
      throw new Error('unreachable');
    };
    const b = createTestAgent({ generate: blocked }, childScope('B'), sessionService(ISessionDispatchService, dispatch));
    const finishProcess = createControlledPromise<number>();
    const output = new Readable({ read() {} });
    const proc = {
      _serviceBrand: undefined, pid: 61000, exitCode: null,
      stdout: output, stderr: Readable.from([]), stdin: { write: vi.fn(), end: vi.fn() },
      wait: () => finishProcess, kill: async () => {}, dispose: async () => {},
    } as unknown as IHostProcess;
    const controller = new AbortController();
    try {
      a.mockNextResponse({ type: 'text', text: 'A launched its background process' });
      const runA = await a.get(IAgentExecutionService).run({ kind: 'prompt', prompt: 'start work' }, { signal: new AbortController().signal });
      const tasks = a.get(IAgentTaskService) as TaskServiceTestManager;
      const taskId = tasks.registerTask(new ProcessTask(proc, 'example-command', 'retained process result'), { detached: true, timeoutMs: 0 });
      await runA.completion;
      await a.get(IAgentExecutionService).settled();
      const runB = await b.get(IAgentExecutionService).run({ kind: 'prompt', prompt: 'occupy capacity' }, { signal: controller.signal });
      await started;
      a.mockNextResponse({ type: 'text', text: 'unexpected capacity bypass' });
      const ended = a.untilTurnEnd();
      output.push('completed output retained');
      output.push(null);
      finishProcess.resolve(0);
      await tasks.wait(taskId);
      await ended;
      expect(a.llmCalls).toHaveLength(1);
      expect(JSON.stringify(a.allEvents)).toContain('dispatch.limit_exceeded');
      expect(notifiedCount(a)).toBe(0);
      expect(JSON.stringify(a.contextData())).not.toContain('task.completed');
      expect(tasks.getTask(taskId)?.status).toBe('completed');
      controller.abort(new Error('release B'));
      await expect(runB.completion).rejects.toThrow('release B');
      await b.get(IAgentExecutionService).settled();
      await tasks.reconcile();
      expect(notifiedCount(a)).toBe(1);
      expect(JSON.stringify(a.contextData())).toContain('completed output retained');
      await tasks.reconcile();
      expect(notifiedCount(a)).toBe(1);
      const next = dispatch.reserveExecution('C', 'main');
      next();
    } finally {
      controller.abort(new Error('cleanup'));
      output.push(null);
      finishProcess.resolve(0);
      await b.dispose();
      await a.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});

describe('task notification → main agent (real Agent instance)', () => {
  describe('live notification delivery', () => {
    let ctx: TestAgentContext;
    let background: IAgentTaskService;
    let loop: IAgentLoopService;
    let profile: IAgentProfileService;

    beforeEach(() => {
      ctx = createTestAgent();
      background = ctx.get(IAgentTaskService);
      loop = ctx.get(IAgentLoopService);
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: [] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('IDLE: completed bg agent notification auto-launches a turn that consumes it', async () => {
      expect(loop.status().activeTurnId).toBeUndefined();
      expect(ctx.llmCalls.length).toBe(0);

      ctx.mockNextResponse({ type: 'text', text: 'ack from main agent' });
      const turnEnd = ctx.untilTurnEnd();
      const taskId = background.registerTask(agentTask(
        Promise.resolve({ result: 'background agent finished its job' }),
        'idle-state repro',
      ));
      await background.wait(taskId);

      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(1);
        },
        { timeout: 2000 },
      );
      await turnEnd;

      expect(ctx.llmCalls.length).toBe(1);
      const lastCall = ctx.llmCalls.at(-1)!;
      const flatHistoryText = JSON.stringify(lastCall.history);
      expect(flatHistoryText).toContain('<notification');
      expect(flatHistoryText).toContain('task.completed');
      expect(flatHistoryText).toContain(taskId);
      expect(flatHistoryText).toContain('idle-state repro completed.');
      expect(flatHistoryText).toContain('<output-file');
      expect(flatHistoryText).toContain('background agent finished its job');
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('BUSY: completed bg agent during an active turn is flushed into an LLM call', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'first turn ack' });
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      ctx.mockNextResponse({ type: 'text', text: 'drain turn ack' });

      const promptPromise = ctx.rpc.prompt({
        input: [{ type: 'text', text: 'kick off a turn' }],
      });

      const taskId = background.registerTask(agentTask(
        Promise.resolve({ result: 'busy-state bg result' }),
        'busy-state repro',
      ));

      await promptPromise;
      await ctx.untilTurnEnd();
      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(1);
        },
        { timeout: 2000 },
      );

      await ctx.rpc.prompt({
        input: [{ type: 'text', text: 'drain the queue' }],
      });
      await ctx.untilTurnEnd();

      const delivered = ctx.llmCalls.some((call) => {
        const flat = JSON.stringify(call.history);
        return flat.includes('<notification') && flat.includes(taskId);
      });
      expect(delivered).toBe(true);

      const data = ctx.contextData();
      const flatContext = JSON.stringify(data);
      expect(flatContext).toContain('<notification');
      expect(flatContext).toContain('task.completed');
      expect(flatContext).toContain(taskId);
      expect(flatContext).toContain('busy-state repro completed.');
      expect(flatContext).toContain('<output-file');
      expect(flatContext).toContain('busy-state bg result');
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('IDLE × N: a GROUP of bg agents completes — the first notification launches one turn, the rest fold in', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'ack group 1' });
      ctx.mockNextResponse({ type: 'text', text: 'ack group 2' });
      ctx.mockNextResponse({ type: 'text', text: 'ack group 3' });
      const turnEnd = ctx.untilTurnEnd();
      const taskIds = [
        background.registerTask(agentTask(
          Promise.resolve({ result: 'bg #1 result' }),
          'group-1',
        )),
        background.registerTask(agentTask(
          Promise.resolve({ result: 'bg #2 result' }),
          'group-2',
        )),
        background.registerTask(agentTask(
          Promise.resolve({ result: 'bg #3 result' }),
          'group-3',
        )),
      ];

      for (const id of taskIds) {
        await background.wait(id);
      }

      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(3);
        },
        { timeout: 2000 },
      );
      await turnEnd;
      await vi.waitFor(
        () => {
          expect(loop.status().state).toBe('idle');
          expect(loop.status().hasPendingRequests).toBe(false);
        },
        { timeout: 2000 },
      );

      const flatHistoryText = JSON.stringify(ctx.llmCalls.map((call) => call.history));
      for (const id of taskIds) {
        expect(flatHistoryText).toContain(id);
      }
      expect(flatHistoryText).toContain('group-1 completed.');
      expect(flatHistoryText).toContain('group-2 completed.');
      expect(flatHistoryText).toContain('group-3 completed.');
      expect(flatHistoryText).toContain('<output-file');
      expect(flatHistoryText).toContain('bg #1 result');
      expect(flatHistoryText).toContain('bg #2 result');
      expect(flatHistoryText).toContain('bg #3 result');
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('RACE: bg completion right after turn end launches its own turn', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'first user-prompted ack' });
      await ctx.rpc.prompt({
        input: [{ type: 'text', text: 'hello main agent' }],
      });
      await ctx.untilTurnEnd();
      expect(ctx.llmCalls.length).toBe(1);

      ctx.mockNextResponse({ type: 'text', text: 'ack from bg notification' });
      const turnEnd = ctx.untilTurnEnd();
      const taskId = background.registerTask(agentTask(
        Promise.resolve({ result: 'post-turn bg result' }),
        'race-after-turn',
      ));
      await background.wait(taskId);
      await vi.waitFor(
        () => {
          expect(notifiedCount(ctx)).toBe(1);
        },
        { timeout: 2000 },
      );
      await turnEnd;

      expect(ctx.llmCalls.length).toBe(2);
      const lastCall = ctx.llmCalls.at(-1)!;
      const flatHistoryText = JSON.stringify(lastCall.history);
      expect(flatHistoryText).toContain('<notification');
      expect(flatHistoryText).toContain(taskId);
      expect(flatHistoryText).toContain('race-after-turn completed.');
      expect(flatHistoryText).toContain('<output-file');
      expect(flatHistoryText).toContain('post-turn bg result');
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
  });

  describe('kill ordering vs child loop unwind', () => {
    type GenerateFn = typeof kosongGenerate;

    function agentScopeHandle(ctx: TestAgentContext, id: string): IAgentScopeHandle {
      return {
        id,
        kind: LifecycleScope.Agent,
        accessor: { get: ctx.get.bind(ctx) },
        dispose: () => {},
      } as IAgentScopeHandle;
    }

    it('stop settles killed + notifies only after the child loop goes idle', async () => {
      let generateStarted!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        generateStarted = resolve;
      });
      const slowToCancelGenerate: GenerateFn = async (
        _chat,
        _systemPrompt,
        _tools,
        _history,
        _callbacks,
        options,
      ) => {
        const signal = options?.signal;
        signal?.throwIfAborted();
        generateStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                reject(signal.reason);
              }, 200);
            },
            { once: true },
          );
        });
        throw new Error('slowToCancelGenerate returned without being aborted');
      };

      const main = createTestAgent(taskServices());
      const child = createTestAgent({ generate: slowToCancelGenerate });
      try {
        const childHandle = agentScopeHandle(child, 'agent-child');
        const childLoop = child.get(IAgentLoopService);

        const controller = new AbortController();
        const run = await runAgentTurn(
          childHandle,
          { kind: 'prompt', prompt: 'do background work' },
          { signal: controller.signal },
        );
        const completion = run.completion.then((r) => ({ result: r.summary, usage: r.usage }));
        void completion.catch(() => {});

        await inFlight;
        expect(childLoop.status().state).toBe('running');

        const background = main.get(IAgentTaskService);
        const taskId = background.registerTask(
          new SubagentTask(
            { agentId: 'agent-child', profileName: 'coder', completion },
            'kill-order repro',
            controller,
          ),
          { detached: true, timeoutMs: 0 },
        );

        main.mockNextResponse({ type: 'text', text: 'ack from main agent' });
        const notificationTurnEnd = main.untilTurnEnd();

        const info = await background.stop(taskId, 'User initiated stop');
        expect(info?.status).toBe('killed');
        expect(childLoop.status().state).toBe('idle');

        await vi.waitFor(
          () => {
            expect(main.llmCalls.length).toBeGreaterThanOrEqual(1);
          },
          { timeout: 2000 },
        );
        const notified = JSON.stringify(main.llmCalls.at(-1)!.history);
        expect(notified).toContain('task.killed');
        expect(notified).toContain(taskId);
        expect(childLoop.status().state).toBe('idle');

        await notificationTurnEnd;
      } finally {
        await main.dispose();
        await child.dispose();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
  });

  describe('resumed notifications', () => {
    let sessionDir: string;
    let ctx: TestAgentContext;
    let background: TaskServiceTestManager;
    let loop: IAgentLoopService;

    beforeEach(async () => {
      sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-repro-'));
      const backgroundPersistence = createAgentTaskPersistence(sessionDir);
      await backgroundPersistence.writeTask({
        taskId: 'bash-prev0000',
        kind: 'process',
        command: 'echo previous',
        description: 'previous bash task',
        pid: 12345,
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_005,
        exitCode: 0,
        status: 'completed',
      });
      await backgroundPersistence.appendTaskOutput('bash-prev0000', 'previous bash output');

      await backgroundPersistence.writeTask({
        taskId: 'agent-prev0000',
        kind: 'agent',
        description: 'previous agent task',
        startedAt: 1_700_000_000,
        endedAt: null,
        status: 'running',
      });

      ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
      background = ctx.get(IAgentTaskService) as TaskServiceTestManager;
      loop = ctx.get(IAgentLoopService);
      const profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: [] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        await rm(sessionDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    });

    it('RESUME: shares the preview pool, retains failure facts and complete answers, and does not redeliver', async () => {
      const persistence = createAgentTaskPersistence(sessionDir);
      const output = 'x' + '中<&>🙂'.repeat(700);
      const answer = JSON.stringify({ answers: { choice: '保留完整回答🙂'.repeat(500) } });
      for (let i = 0; i < 5; i++) {
        const taskId = `agent-batch00${i}`;
        await persistence.writeTask({
          taskId, kind: 'agent', agentId: `child-${i}`, description: `restored-${i}`,
          startedAt: 10 + i, endedAt: 20 + i, status: i === 4 ? 'failed' : 'completed',
          stopReason: i === 4 ? '错误 <failure> & reason' : undefined,
        });
        await persistence.appendTaskOutput(taskId, output);
      }
      await persistence.writeTask({
        taskId: 'question-batch000', kind: 'question', questionCount: 1, description: 'restored answer',
        startedAt: 30, endedAt: 31, status: 'completed',
      });
      await persistence.appendTaskOutput('question-batch000', answer);
      await persistence.writeTask({
        taskId: 'agent-nofile00', kind: 'agent', description: 'no receipt captured',
        startedAt: 32, endedAt: 33, status: 'failed', stopReason: 'no output exists',
      });
      await background.loadFromDisk();
      await background.reconcile();
      const notifications = ctx.context.get().filter((m) => m.origin?.kind === 'task');
      expect(notifications).toHaveLength(9);
      const texts = notifications.map((m) => m.content.map((p) => p.type === 'text' ? p.text : '').join(''));
      const ordinary = texts.filter((text) => !text.includes('question-batch000'));
      const bytes = ordinary.flatMap((text) => [...text.matchAll(/<output-preview bytes="(\d+)"/g)]).reduce((sum, match) => sum + Number(match[1]), 0);
      expect(bytes).toBeLessThanOrEqual(16_000);
      expect(bytes).toBeGreaterThan(15_990);
      expect(ordinary.join('')).toContain('Output preview omitted');
      expect(ordinary.join('')).not.toContain('\uFFFD');
      expect(ordinary.join('')).not.toContain('中<&>');
      for (let i = 0; i < 5; i++) {
        const text = texts.find((text) => text.includes(`agent-batch00${i}`))!;
        expect(text).toContain(`child-${i}`);
        expect(text).toContain('<output-file');
        expect(text).toContain(i === 4 ? 'task.failed' : 'task.completed');
      }
      const failed = texts.find((text) => text.includes('agent-batch004'))!;
      expect(failed).toContain('错误 &lt;failure&gt; & reason');
      expect(failed).toContain('AgentRun(resume="child-4"');
      const question = texts.find((text) => text.includes('question-batch000'))!;
      expect(question).toContain(answer);
      expect(question).toContain('Background question answered');
      const noFile = texts.find((text) => text.includes('agent-nofile00'))!;
      expect(noFile).toContain('no output exists');
      expect(noFile).not.toContain('<output-file');
      expect(ctx.llmCalls).toHaveLength(0);
      const before = notifiedCount(ctx);
      await background.reconcile();
      expect(notifiedCount(ctx)).toBe(before);
      expect(ctx.context.get().filter((m) => m.origin?.kind === 'task')).toHaveLength(9);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('RESUME: terminal bg tasks discovered on reconcile are SILENTLY injected (no auto-turn)', async () => {

      const launchSpy = vi.spyOn(loop as unknown as { startTurn: () => unknown }, 'startTurn');

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('agent-prev0000')?.status).toBe('lost');

      await vi.waitFor(() => {
        const flatContext = JSON.stringify(ctx.contextData());
        expect(flatContext).toContain('bash-prev0000');
        expect(flatContext).toContain('agent-prev0000');
      });

      expect(launchSpy).not.toHaveBeenCalled();
      expect(ctx.llmCalls.length).toBe(0);
      expect(loop.status().activeTurnId).toBeUndefined();

      const flatContext = JSON.stringify(ctx.contextData());
      expect(flatContext).toContain('<output-file');
      expect(flatContext).toContain('previous bash output');
      expect(flatContext).toContain('Exit code: 0. Duration: 5 ms.');
      expect(flatContext).toMatch(/task\.completed/);
      expect(flatContext).toMatch(/task\.lost/);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
  });
});
