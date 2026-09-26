import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { IHostProcess } from '#/os/interface/hostProcess';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentTaskInfo,
  IAgentTaskService,
} from '#/agent/task/task';
import { TaskStopTool } from '#/agent/tools/task/task-stop/taskStopTool';
import {
  SubagentTask,
  type SubagentHandle,
} from '#/agent/tools/agent/subagent-task';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { QuestionBackgroundTask } from '#/agent/tools/ask-user-question/question-background-task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IEventBus } from '#/app/event/eventBus';
import type { IExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunner';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { ErrorCodes } from '#/errors';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  configServices,
  createTestAgent,
  externalHookServices,
  homeDirServices,
  telemetryServices,
  type TestAgentContext,
  type TestAgentServiceOverride,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { executeTool, type TestExecutableToolContext } from '../../tools/fixtures/execute-tool';
import {
  createAgentTaskPersistence,
  type TaskServiceTestManager,
} from './stubs';

type FireAndForgetTrigger = IExternalHooksRunnerService['fireAndForgetTrigger'];

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 15_000;

function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 30000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as IHostProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

function pendingProcess(): IHostProcess {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 99999,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn(async () => {
      if (currentExitCode !== null) return;
      currentExitCode = 143;
      resolveWait(143);
    }) as unknown as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
  options: {
    readonly agentId?: string;
    readonly profile?: string;
    readonly name?: string;
    readonly abortController?: AbortController;
    readonly timeoutMs?: number;
  } = {},
): SubagentTask {
  const handle: SubagentHandle = {
    agentId: options.agentId ?? 'agent-child',
    profileName: options.profile ?? 'coder',
    completion,
  };
  const task = new SubagentTask(
    handle,
    description,
    options.abortController ?? new AbortController(),
    options.name === undefined ? undefined : { taskName: options.name, agentType: handle.profileName },
  );
  if (options.timeoutMs !== undefined) {
    Object.defineProperty(task, 'timeoutMs', {
      value: options.timeoutMs,
      enumerable: true,
    });
  }
  return task;
}

function persistedProcess(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'process' }>> = {},
): Extract<AgentTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-done0000',
    kind: 'process',
    command: 'echo done',
    description: 'restored shell task',
    pid: 12345,
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_010,
    exitCode: 0,
    status: 'completed',
    ...overrides,
  };
}

function persistedAgent(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'agent' }>> = {},
): Extract<AgentTaskInfo, { kind: 'agent' }> {
  return {
    taskId: 'agent-done0000',
    kind: 'agent',
    description: 'restored task',
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_010,
    status: 'completed',
    agentId: 'agent-session-id',
    profile: 'coder',
    ...overrides,
  };
}

function persistedQuestion(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'question' }>> = {},
): Extract<AgentTaskInfo, { kind: 'question' }> {
  return {
    taskId: 'question-done0000',
    kind: 'question',
    description: 'Which database?',
    questionCount: 1,
    toolCallId: 'call-question',
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_010,
    status: 'completed',
    ...overrides,
  };
}

interface FakeTaskAgent {
  emitEvent: ReturnType<typeof vi.fn>;
  emittedEvents: Array<{ type: string; info?: unknown }>;
  kimiConfig?: { task?: { maxRunningTasks?: number } };
  context: { appendUserMessage: ReturnType<typeof vi.fn> };
  observableDeliveries: Array<{ message: TestContextMessage; delivery: unknown }>;
  hooks?: { fireAndForgetTrigger: FireAndForgetTrigger };
}

interface TaskServiceFixture {
  ctx: TestAgentContext;
  agent: FakeTaskAgent;
  manager: TaskServiceTestManager;
  records: TelemetryRecord[];
  persistence?: ReturnType<typeof createAgentTaskPersistence>;
}

type TestContextMessage = {
  readonly origin?: {
    readonly kind: string;
    readonly taskId: string;
    readonly status: string;
    readonly notificationId: string;
  };
  readonly content: readonly { readonly text: string }[];
};

function createAgentTaskService(options: {
  sessionDir?: string;
  maxRunningTasks?: number;
  hooks?: FakeTaskAgent['hooks'];
} = {}): TaskServiceFixture {
  const records: TelemetryRecord[] = [];
  const telemetry = recordingTelemetry(records);
  const hookEngine: Pick<IExternalHooksRunnerService, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'> | undefined = options.hooks === undefined
    ? undefined
    : {
        trigger: vi.fn().mockResolvedValue([]),
        triggerBlock: vi.fn().mockResolvedValue(undefined),
        fireAndForgetTrigger: options.hooks.fireAndForgetTrigger,
      };
  const overrides: TestAgentServiceOverride[] = [telemetryServices(telemetry)];
  if (options.sessionDir !== undefined) {
    overrides.push(homeDirServices(options.sessionDir));
  }
  const maxRunningTasks = options.maxRunningTasks;
  if (maxRunningTasks !== undefined) {
    overrides.push(configServices(() => ({
      providers: {},
      task: { maxRunningTasks },
    })));
  }
  if (hookEngine !== undefined) {
    overrides.push(externalHookServices(hookEngine));
  }
  const ctx = createTestAgent(...overrides);

  const emittedEvents: Array<{ type: string; info?: unknown }> = [];
  const events = ctx.get(IEventBus);
  const disposable = events.subscribe((event) => {
    emittedEvents.push(event as { type: string; info?: unknown });
  });

  const context = ctx.get(IAgentContextMemoryService);
  const appendSpy = vi.spyOn(context, 'append');
const contextWithAppend = context as unknown as {
  append: (m: TestContextMessage) => void;
  appendManaged: (m: TestContextMessage, d: unknown) => void;
};
const originalAppend = contextWithAppend.append.bind(context);
const observableDeliveries: Array<{ message: TestContextMessage; delivery: unknown }> = [];
contextWithAppend.appendManaged = (message: TestContextMessage, delivery: unknown) => {
  observableDeliveries.push({ message, delivery });
  originalAppend(message);
};
const appendHistorySpy = vi.spyOn(context, 'append');

  const agent: FakeTaskAgent = {
    emittedEvents,
    emitEvent: vi.fn((event: { type: string; info?: unknown }) => {
      emittedEvents.push(event);
    }),
    kimiConfig:
      options.maxRunningTasks === undefined
        ? undefined
        : { task: { maxRunningTasks: options.maxRunningTasks } },
    context: { appendUserMessage: appendHistorySpy },
    observableDeliveries,
    hooks: options.hooks,
  };

  const persistence =
    options.sessionDir === undefined
      ? undefined
      : createAgentTaskPersistence(options.sessionDir);

  return {
    ctx,
    agent,
    manager: ctx.get(IAgentTaskService) as TaskServiceTestManager,
    records,
    persistence,
  };
}

async function cleanupSessionDir(
  sessionDir: string,
  fixture?: TaskServiceFixture,
): Promise<void> {
  if (fixture !== undefined) {
    await fixture.ctx.get(ISessionMetadata).ready;
    await fixture.ctx.dispose();
  }
  await rm(sessionDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function firstAppendedContextMessage(agent: FakeTaskAgent): TestContextMessage {
  const call = agent.context.appendUserMessage.mock.calls[0] as unknown as TestContextMessage[];
  const message = call.at(-1);
  if (message === undefined) throw new Error('Expected an appended context message');
  return message;
}

function notifiedCount(ctx: TestAgentContext): number {
  return ctx.allEvents.filter((e) => e.type === '[rpc]' && e.event === 'task.notified').length;
}

async function drainNotifications(ctx: TestAgentContext): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: 'notification drain ack' });
  await vi.waitFor(() => {
    const loop = ctx.get(IAgentLoopService);
    expect(loop.status().state).toBe('idle');
    expect(loop.hasPendingRequests()).toBe(false);
  });
}

function notificationMessageFor(agent: FakeTaskAgent, taskId: string): TestContextMessage {
  for (const call of agent.context.appendUserMessage.mock.calls as unknown as TestContextMessage[][]) {
    for (const message of call) {
      if (message.origin?.kind === 'task' && message.origin.taskId === taskId) return message;
    }
  }
  throw new Error(`Expected an appended notification message for ${taskId}`);
}

function toolContext<Input>(
  toolCallId: string,
  args: Input,
): TestExecutableToolContext<Input> {
  return {
    turnId: 0,
    toolCallId,
    args,
    signal: new AbortController().signal,
  };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

function utf8SizedOutput(totalBytes: number, marker: string): string {
  const fillerBytes = totalBytes - Buffer.byteLength(marker, 'utf8');
  if (fillerBytes < 0) throw new Error('Marker exceeds requested output size');
  return `${'x'.repeat(fillerBytes)}${marker}`;
}

function utf8SizedQuestionAnswer(totalBytes: number, marker: string): string {
  const prefix = '{"answers":{"Which database?":"';
  const suffix = '"}}';
  const fixedBytes = Buffer.byteLength(`${prefix}${marker}${suffix}`, 'utf8');
  const fillerBytes = totalBytes - fixedBytes;
  if (fillerBytes < 0) throw new Error('Marker exceeds requested answer size');
  return `${prefix}${'x'.repeat(fillerBytes)}${marker}${suffix}`;
}

function registerProcess(
  manager: IAgentTaskService,
  proc: IHostProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessTask(proc, command, description));
}

describe('AgentTaskService — event emission', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits task.started for process tasks', () => {
    const { agent, manager, records } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'demo');

    expect(agent.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: 'task.started',
        info: expect.objectContaining({
          taskId,
          kind: 'process',
          status: 'running',
        }),
      }),
    );
    expect(records).toContainEqual({
      event: 'background_task_created',
      properties: { agent_id: 'main', task_id: taskId, kind: 'bash' },
    });
  });

  it('emits task.started for agent tasks', () => {
    const { agent, manager, records } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(new Promise(() => {}), 'agent task'),
    );

    expect(agent.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: 'task.started',
        info: expect.objectContaining({
          taskId,
          kind: 'agent',
          status: 'running',
        }),
      }),
    );
    expect(records).toContainEqual({
      event: 'background_task_created',
      properties: { agent_id: 'main', task_id: taskId, kind: 'agent' },
    });
  });

  it('emits task.terminated and telemetry on natural exit', async () => {
    const { agent, manager, records } = createAgentTaskService();
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');
    records.length = 0;

    await manager.wait(taskId);

    expect(agent.emittedEvents).toContainEqual(
      expect.objectContaining({
        type: 'task.terminated',
        info: expect.objectContaining({
          taskId,
          status: 'completed',
        }),
      }),
    );
    expect(records).toContainEqual({
      event: 'background_task_completed',
      properties: expect.objectContaining({
        agent_id: 'main',
        task_id: taskId,
        kind: 'process',
        duration_ms: expect.any(Number),
        status: 'completed',
      }),
    });
  });

  it('tracks failed and timed-out terminal statuses', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { manager, records } = createAgentTaskService();
    const failedId = registerProcess(manager, immediateProcess(1), 'false', 'failed');
    const timedOutId = manager.registerTask(
      agentTask(new Promise(() => {}), 'slow agent', { timeoutMs: 1 }),
    );
    records.length = 0;

    await manager.wait(failedId);
    const timedOut = manager.wait(timedOutId);
    await vi.advanceTimersByTimeAsync(5_010);
    await timedOut;

    expect(records).toContainEqual({
      event: 'background_task_completed',
      properties: expect.objectContaining({ agent_id: 'main', kind: 'process', status: 'failed' }),
    });
    expect(records).toContainEqual({
      event: 'background_task_completed',
      properties: expect.objectContaining({ agent_id: 'main', kind: 'agent', status: 'timed_out' }),
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('emits task.terminated on stop', async () => {
    const { agent, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long');
    agent.emittedEvents.length = 0;

    await manager.stop(taskId, 'user');

    expect(agent.emittedEvents.filter((e) => e.type === 'task.terminated')).toEqual([
      expect.objectContaining({
        type: 'task.terminated',
        info: expect.objectContaining({
          taskId,
          status: 'killed',
        }),
      }),
    ]);
  });

  it('emits task.terminated when a restored task is marked lost', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-reconcile-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-orphan00',
          command: 'sleep 60',
          description: 'orphan task',
          endedAt: null,
          exitCode: null,
          status: 'running',
        }),
      );
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.emittedEvents).toContainEqual(
        expect.objectContaining({
          type: 'task.terminated',
          info: expect.objectContaining({
            taskId: 'bash-orphan00',
            status: 'lost',
          }),
        }),
      );
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });
});

describe('AgentTaskService — notification delivery', () => {
  it('delivers completed agent task notifications through an auto-launched turn', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'final subagent summary' }),
        'agent task',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await turnEnd;

    const message = notificationMessageFor(agent, taskId);
    expect(message.origin).toEqual({
      kind: 'task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = message.content[0]!.text;
    expect(text).toContain('Background agent completed');
    expect(text).toContain('agent task completed.');
    expect(text).toContain('<output-file');
    expect(text).toContain('final subagent summary');
    expect(text).toContain('complete="true"');
    expect(text).toContain('Final agent receipt.');
    expect(text).not.toContain('no need to read the same result again');
    expect(text).not.toMatch(/(?:subagents? still running|subagent 正在运行)/);
    const hook = ctx.allEvents.find((event) => event.event === 'task.notified');
    expect(JSON.stringify(hook)).not.toContain('final subagent summary');
  });

  it('reports other running children at the end of a completed agent notification', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    let finishAlpha!: (value: { result: string }) => void;
    let finishBeta!: (value: { result: string }) => void;
    const alpha = new Promise<{ result: string }>((resolve) => { finishAlpha = resolve; });
    const beta = new Promise<{ result: string }>((resolve) => { finishBeta = resolve; });
    const alphaId = manager.registerTask(agentTask(alpha, 'first sibling', {
      agentId: 'agent-alpha', name: 'alpha',
    }));
    const betaId = manager.registerTask(agentTask(beta, 'second sibling', {
      agentId: 'agent-beta', name: 'beta',
    }));
    const completedId = manager.registerTask(agentTask(
      Promise.resolve({ result: 'completed child receipt' }),
      'completed child',
      { agentId: 'agent-done', name: 'done' },
    ));

    await manager.wait(completedId);
    await vi.waitFor(() => { expect(notifiedCount(ctx)).toBe(1); });
    await turnEnd;

    const text = notificationMessageFor(agent, completedId).content[0]!.text;
    expect(text).toMatch(/(?:2 subagents still running: alpha, beta|还有 2 个 subagent 正在运行：alpha、beta)\n<\/notification>$/);
    await Promise.all([manager.suppressTerminalNotification(alphaId), manager.suppressTerminalNotification(betaId)]);
    finishAlpha({ result: 'alpha done' });
    finishBeta({ result: 'beta done' });
    await Promise.all([manager.wait(alphaId), manager.wait(betaId)]);
  });

  it('reports surviving children after a failed agent notification', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    let finishSibling!: (value: { result: string }) => void;
    const sibling = new Promise<{ result: string }>((resolve) => { finishSibling = resolve; });
    const siblingId = manager.registerTask(agentTask(sibling, 'running sibling', {
      agentId: 'agent-still-running', name: 'still_running',
    }));
    const failedId = manager.registerTask(agentTask(
      Promise.reject(new Error('example failure')),
      'failing child',
      { agentId: 'agent-failed' },
    ));

    await manager.wait(failedId);
    await vi.waitFor(() => { expect(notifiedCount(ctx)).toBe(1); });
    await turnEnd;

    const text = notificationMessageFor(agent, failedId).content[0]!.text;
    expect(text).toContain('Background agent failed');
    expect(text).toMatch(/(?:1 subagent still running: still_running|还有 1 个 subagent 正在运行：still_running)\n<\/notification>$/);
    await manager.suppressTerminalNotification(siblingId);
    finishSibling({ result: 'done' });
    await manager.wait(siblingId);
  });

  it.each([
    { totalBytes: 16_000, previewBytes: 16_000, truncated: 'false', complete: 'true' },
    { totalBytes: 16_001, previewBytes: 16_000, truncated: 'true', complete: 'false' },
  ])(
    'uses the UTF-8 byte boundary for agent output at $totalBytes bytes',
    async ({ totalBytes, previewBytes, truncated, complete }) => {
      const { agent, ctx, manager } = createAgentTaskService();
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      const turnEnd = ctx.untilTurnEnd();
      const marker = '<unsafe & "quoted"> 🙂';
      const output = utf8SizedOutput(totalBytes, marker);
      expect(Buffer.byteLength(output, 'utf8')).toBe(totalBytes);
      const taskId = manager.registerTask(
        agentTask(Promise.resolve({ result: output }), 'boundary agent'),
      );

      await manager.wait(taskId);
      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
      await turnEnd;

      const text = notificationMessageFor(agent, taskId).content[0]!.text;
      expect(text).toContain(
        `<output-preview bytes="${previewBytes}" total_bytes="${totalBytes}" truncated="${truncated}" complete="${complete}">`,
      );
      expect(text).toContain('&lt;unsafe &amp; &quot;quoted&quot;&gt; 🙂');
      expect(text).not.toContain(marker);
      expect(text).toContain('<output-file');
    },
  );

  it.each([
    { totalBytes: 16_000, previewBytes: 16_000, truncated: false },
    { totalBytes: 16_001, previewBytes: 16_000, truncated: true },
  ])(
    'uses the UTF-8 byte boundary for question output at $totalBytes bytes',
    async ({ totalBytes, previewBytes, truncated }) => {
      const { agent, ctx, manager } = createAgentTaskService();
      ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      const turnEnd = ctx.untilTurnEnd();
      const answer = utf8SizedQuestionAnswer(totalBytes, '<unsafe 🙂>');
      expect(Buffer.byteLength(answer, 'utf8')).toBe(totalBytes);
      const taskId = manager.registerTask(
        new QuestionBackgroundTask(
          async () => ({ isError: false, output: answer }),
          'Which database?',
          { questionCount: 1, toolCallId: 'call-question-boundary' },
        ),
        { detached: true },
      );

      await manager.wait(taskId);
      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
      await turnEnd;

      const text = notificationMessageFor(agent, taskId).content[0]!.text;
      expect(text).toContain('&lt;unsafe 🙂&gt;');
      if (truncated) {
        expect(text).toContain(
          `<output-preview bytes="${previewBytes}" total_bytes="${totalBytes}" truncated="true" complete="false">`,
        );
        expect(text).not.toContain('<answer>');
        expect(text).toContain('<output-file');
      } else {
        expect(text).toContain(`<answer>\n${answer.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n</answer>`);
        expect(text).not.toContain('<output-preview');
        expect(text).not.toContain('<output-file');
      }
    },
  );

  it('inlines a short completed question answer in its notification', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    const answer = JSON.stringify({ answers: { 'Which database?': 'Postgres' } });
    const taskId = manager.registerTask(
      new QuestionBackgroundTask(
        async () => ({ isError: false, output: answer }),
        'Which database?',
        { questionCount: 1, toolCallId: 'call-question' },
      ),
      { detached: true },
    );

    await manager.wait(taskId);
    await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
    await turnEnd;

    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('Title: Background question answered');
    expect(text).toContain('The user answered "Which database?".');
    expect(text).toContain(`<answer>\n${answer}\n</answer>`);
    expect(text).not.toContain('<output-file');
    expect(text).not.toContain('<output-preview');
  });

  it('inlines a dismissed question result with dismissed notification text', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    const dismissed = JSON.stringify({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    const taskId = manager.registerTask(
      new QuestionBackgroundTask(
        async () => ({ isError: false, output: dismissed }),
        'Which database?',
        { questionCount: 1, toolCallId: 'call-question' },
      ),
      { detached: true },
    );

    await manager.wait(taskId);
    await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
    await turnEnd;

    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('Title: Background question dismissed');
    expect(text).toContain('The user dismissed "Which database?" without answering.');
    expect(text).toContain(`<answer>\n${dismissed}\n</answer>`);
    expect(text).not.toContain('<output-file');
  });

  it('uses the output file pointer when a question result exceeds the inline limit', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    const answer = JSON.stringify({ answers: { details: 'x'.repeat(16_000) } });
    const taskId = manager.registerTask(
      new QuestionBackgroundTask(
        async () => ({ isError: false, output: answer }),
        'Provide details?',
        { questionCount: 1, toolCallId: 'call-question-long' },
      ),
      { detached: true },
    );

    await manager.wait(taskId);
    await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
    await turnEnd;

    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('Title: Background question completed');
    expect(text).toContain('<output-preview');
    expect(text).toContain('truncated="true" complete="false"');
    expect(text).toContain('<output-file');
    expect(text).not.toContain('<answer>');
    expect(text).not.toContain('"details"');
  });

  it('reports a question tool error as failed without an answer block', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const turnEnd = ctx.untilTurnEnd();
    const taskId = manager.registerTask(
      new QuestionBackgroundTask(
        async () => ({ isError: true, output: 'Client does not support questions' }),
        'Which database?',
        { questionCount: 1, toolCallId: 'call-question-error' },
      ),
      { detached: true },
    );

    await manager.wait(taskId);
    await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
    await turnEnd;

    expect(manager.getTask(taskId)).toMatchObject({
      status: 'failed',
      stopReason: 'Client does not support questions',
    });
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('Title: Background question failed');
    expect(text).toContain('Which database? failed. Reason: Client does not support questions');
    expect(text).not.toContain('<answer>');
    expect(text).not.toContain('<output-file');
  });

  it.each([0, 2])('delivers process exit %s with useful output or an explicit empty result', async (exitCode) => {
    const { agent, ctx, manager } = createAgentTaskService();
    const output = exitCode === 0 ? '' : `early marker${'x'.repeat(4_000)}\nfailure detail`;
    const taskId = registerProcess(manager, immediateProcess(exitCode, output), 'example', 'process result');
    await manager.wait(taskId);
    await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
    await drainNotifications(ctx);
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain(`Exit code: ${exitCode}. Duration:`);
    if (exitCode === 0) {
      expect(text).toContain('No output was captured.');
      expect(text).not.toContain('<output-file');
      expect(text).not.toContain('<output-preview');
    } else {
      expect(text).toContain('task.failed');
      expect(text).toContain('failure detail');
      expect(text).not.toContain('early marker');
      expect(text).toContain('truncated="true" complete="false"');
      expect(text).toContain('<output-file');
    }
  });

  it('enqueues completed process task notifications into the turn flow', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'shell output'),
      'echo ok',
      'shell task',
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);

    const message = notificationMessageFor(agent, taskId);
    expect(message.origin).toEqual({
      kind: 'task',
      taskId,
      status: 'completed',
      notificationId: `task:${taskId}:completed`,
    });
    const text = message.content[0]!.text;
    expect(text).toContain('Background process completed');
    expect(text).toContain('shell task completed. Exit code: 0. Duration: ');
    expect(text).toContain('<output-preview bytes="12" total_bytes="12" truncated="false" complete="true">');
    expect(text).toContain('shell output');
    expect(text).toContain('<output-file');
  });

  it('enqueues stopped process task notifications into the turn flow', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'long shell task');

    await manager.stopByUser(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);

    const message = notificationMessageFor(agent, taskId);
    expect(message.origin).toEqual({
      kind: 'task',
      taskId,
      status: 'killed',
      notificationId: `task:${taskId}:killed`,
    });
    const text = message.content[0]!.text;
    expect(text).toContain('long shell task was stopped by user. Exit code: 143. Duration: ');
    expect(text).toContain('No output was captured.');
    expect(text).not.toContain('<output-preview');
    expect(text).not.toContain('<output-file');
  });

  it('TaskStopTool suppresses the real terminal notification for model-requested stops', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, pendingProcess(), 'sleep 60', 'stop test');

    const result = await executeTool(
      new TaskStopTool(manager, ctx.get(IAgentLifecycleService)),
      toolContext('task_stop_silent', { task_id: taskId }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain('status: killed');
    expect(notifiedCount(ctx)).toBe(0);
    expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    expect(ctx.get(IAgentLoopService).hasPendingRequests()).toBe(false);
    expect(manager.getTask(taskId)).toMatchObject({
      status: 'killed',
      terminalNotificationSuppressed: true,
    });
  });

  it('TaskStopTool persists stop reason and suppression across reload', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-tool-stop-'));
    let writerFixture: TaskServiceFixture | undefined;
    let readerFixture: TaskServiceFixture | undefined;
    try {
      writerFixture = createAgentTaskService({ sessionDir });
      const taskId = registerProcess(
        writerFixture.manager,
        pendingProcess(),
        'sleep 60',
        'persist stop',
      );

      const result = await executeTool(
        new TaskStopTool(writerFixture.manager, writerFixture.ctx.get(IAgentLifecycleService)),
        toolContext('task_stop_persisted', { task_id: taskId, reason: 'operator cancelled' }),
      );
      expect(result.isError ?? false).toBe(false);

      readerFixture = createAgentTaskService({ sessionDir });
      const { agent, manager: reader } = readerFixture;
      await reader.loadFromDisk();
      expect(reader.getTask(taskId)).toMatchObject({
        stopReason: 'operator cancelled',
        terminalNotificationSuppressed: true,
      });

      await reader.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
      expect(readerFixture.ctx.get(IAgentLoopService).hasPendingRequests()).toBe(false);
    } finally {
      if (readerFixture !== undefined) {
        await readerFixture.ctx.dispose();
      }
      await cleanupSessionDir(sessionDir, writerFixture);
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('replays restored terminal agent task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent());
      await persistence.appendTaskOutput('agent-done0000', 'restored subagent summary');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      expect(message.origin).toEqual({
        kind: 'task',
        taskId: 'agent-done0000',
        status: 'completed',
        notificationId: 'task:agent-done0000:completed',
      });
      const text = message.content[0]!.text;
      expect(text).toContain('Background agent completed');
      expect(text).toContain('restored subagent summary');
      expect(text).toContain('<output-preview');
      expect(text).toContain('complete="true"');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('agent-done0000'));
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('replays restored terminal process task notifications when undelivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-replay-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess());
      await persistence.appendTaskOutput('bash-done0000', 'restored shell output');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      expect(message.origin).toEqual({
        kind: 'task',
        taskId: 'bash-done0000',
        status: 'completed',
        notificationId: 'task:bash-done0000:completed',
      });
      const text = message.content[0]!.text;
      expect(text).toContain('Background process completed');
      expect(text).toContain('restored shell output');
      expect(text).toContain('<output-preview');
      expect(text).toContain('complete="true"');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile('bash-done0000'));
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('restores a completed question notification once with its short answer inline', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-question-replay-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const answer = JSON.stringify({ answers: { 'Which database?': 'SQLite' } });
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedQuestion());
      await persistence.appendTaskOutput('question-done0000', answer);
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      expect(message.origin).toEqual({
        kind: 'task',
        taskId: 'question-done0000',
        status: 'completed',
        notificationId: 'task:question-done0000:completed',
      });
      const text = message.content[0]!.text;
      expect(text).toContain('Title: Background question answered');
      expect(text).toContain(`<answer>\n${answer}\n</answer>`);
      expect(text).not.toContain('<output-file');
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('references persisted output without reading a tail for restored process notifications', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-bash-tail-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const taskId = 'bash-large000';
      const largeOutput = `early-output-marker\n${'x'.repeat(8_000)}\nfinal output line <unsafe & "quoted">`;
      const outputSizeBytes = Buffer.byteLength(largeOutput, 'utf8');
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedProcess({ taskId }));
      await persistence.appendTaskOutput(taskId, largeOutput);
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      const text = message.content[0]!.text;
      expect(text).toContain(
        `<output-preview bytes="3000" total_bytes="${outputSizeBytes}" truncated="true" complete="false">`,
      );
      expect(text).toContain('final output line');
      expect(text).toContain('&lt;unsafe &amp; &quot;quoted&quot;&gt;');
      expect(text).not.toContain('<unsafe & "quoted">');
      expect(text).not.toContain('early-output-marker');
      expect(text).toContain('<output-file');
      expect(text).toContain(persistence.taskOutputFile(taskId));
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('does not replay restored notifications already marked delivered', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-replay-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const origin = {
        kind: 'task',
        taskId: 'agent-seen0000',
        status: 'completed',
        notificationId: 'task:agent-seen0000:completed',
      } as const;
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent({ taskId: 'agent-seen0000' }));
      await persistence.appendTaskOutput('agent-seen0000', 'already delivered summary');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, ctx, manager } = fixture;
      const context = ctx.get(IAgentContextMemoryService);
      context.append(
        {
          role: 'user',
          content: [{ type: 'text', text: 'already delivered' }],
          toolCalls: [],
          origin,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      agent.context.appendUserMessage.mockClear();

      await manager.loadFromDisk();
      await manager.reconcile();

      expect(agent.context.appendUserMessage).not.toHaveBeenCalled();
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('restores notification delivery after undo for a locally archived execution without restarting it', async () => {
    const fixture = createAgentTaskService();
    const { ctx, manager } = fixture;
    try {
      ctx.appendUserTurn('start background work');
      ctx.mockNextResponse({ type: 'text', text: 'completion received' });
      const taskId = manager.registerTask(agentTask(Promise.resolve({ result: 'archived result' }), 'work'));
      await manager.wait(taskId);
      const internals = manager as unknown as { tasks: Map<string, unknown> };
      await vi.waitFor(() => {
        expect(internals.tasks.has(taskId)).toBe(false);
        expect(ctx.get(IAgentLoopService).status().state).toBe('idle');
        expect(ctx.context.get().filter((message) => message.origin?.kind === 'task')).toHaveLength(1);
      });
      const before = manager.getTask(taskId);
      await ctx.get(IAgentConversationUndoService).undo(1);
      expect(manager.getTask(taskId)).toEqual(before);
      expect(internals.tasks.has(taskId)).toBe(false);
      expect(await manager.readOutput(taskId)).toBe('archived result');
      expect(ctx.context.get().filter((message) => message.origin?.kind === 'task')).toHaveLength(1);
      await manager.reconcile();
      expect(ctx.context.get().filter((message) => message.origin?.kind === 'task')).toHaveLength(1);
      expect(notifiedCount(ctx)).toBe(2);
    } finally {
      await ctx.dispose();
    }
  });

  it('re-delivers a terminal task notification removed by undo when output is unavailable', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-undo-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent());
      await persistence.appendTaskOutput('agent-done0000', 'restored subagent summary');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, ctx, manager } = fixture;
      ctx.appendUserTurn('start the background task');
      agent.context.appendUserMessage.mockClear();

      await manager.loadFromDisk();
      await manager.reconcile();
      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      vi.spyOn(manager, 'getOutputSnapshot').mockRejectedValueOnce(
        new Error('output unavailable'),
      );

      await ctx.get(IAgentConversationUndoService).undo(1);

      expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(2);
      expect(ctx.context.get().some((message) => message.origin?.kind === 'user')).toBe(false);
      expect(
        ctx.context.get().filter((message) => message.origin?.kind === 'task'),
      ).toHaveLength(1);
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('preserves a queued notification when undo rejects an active turn', async () => {
    const fixture = createAgentTaskService();
    const { ctx, manager } = fixture;
    const loop = ctx.get(IAgentLoopService);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-notification-undo', async (_hookCtx, next) => {
      markStarted();
      await canFinish;
      await next();
    });

    try {
      ctx.appendTurnExchange('kept prompt', 'kept answer');
      const active = (
        await loop.enqueue(
          new MessageStepRequest(
            {
              role: 'user',
              content: [{ type: 'text', text: 'remove me' }],
              toolCalls: [],
              origin: { kind: 'user' },
            },
            { admission: 'newTurn' },
          ),
        ).assigned
      ).turn;
      await started;
      const taskId = registerProcess(manager, immediateProcess(0, 'done'), 'echo done', 'done');
      await vi.waitFor(() => {
        expect(manager.getTask(taskId)?.status).toBe('completed');
        expect(loop.hasPendingRequests()).toBe(true);
      });
      expect(notifiedCount(ctx)).toBe(0);

      await expect(ctx.get(IAgentConversationUndoService).undo(1)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_BUSY,
        details: { reason: 'loop' },
      });
      expect(active.signal.aborted).toBe(false);
      expect(
        ctx.context.get().filter((message) => message.origin?.kind === 'task'),
      ).toEqual([]);

      ctx.mockNextResponse({ type: 'text', text: 'notification acknowledged' });
      ctx.mockNextResponse({ type: 'text', text: 'turn completed' });
      release();
      await expect(active.result).resolves.toMatchObject({ type: 'completed' });
      expect(
        ctx.context.get().filter((message) => message.origin?.kind === 'task'),
      ).toEqual([
        expect.objectContaining({
          origin: expect.objectContaining({ taskId, status: 'completed' }),
        }),
      ]);
      expect(notifiedCount(ctx)).toBe(1);
    } finally {
      release();
      hook.dispose();
      await ctx.get(ISessionMetadata).ready;
      await ctx.dispose();
    }
  });

  it('does not double-notify newly lost restored agent tasks', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-lost-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(
        persistedAgent({
          taskId: 'agent-run00000',
          description: 'interrupted task',
          endedAt: null,
          status: 'running',
        }),
      );
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
      });
      const message = firstAppendedContextMessage(agent);
      expect(message.origin).toEqual({
        kind: 'task',
        taskId: 'agent-run00000',
        status: 'lost',
        notificationId: 'task:agent-run00000:lost',
      });
      expect(message.content[0]!.text).toContain(
        'Background agent lost',
      );
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });

  it('fires a Notification hook when a task agent notification is delivered', async () => {
    const fireAndForgetTrigger = vi.fn<FireAndForgetTrigger>(async () => []);
    const { ctx, manager } = createAgentTaskService({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'final agent output' }),
        'inspect repository',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', expect.objectContaining({
      matcherValue: 'task.completed',
      inputData: expect.objectContaining({
        sink: 'context',
        notificationType: 'task.completed',
        title: 'Background agent completed',
        body: 'inspect repository completed.',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: taskId,
      }),
    }));
  });

  it('does not let Notification hook failures interrupt notification delivery', async () => {
    const fireAndForgetTrigger = vi.fn<FireAndForgetTrigger>(async () => {
      throw new Error('notification hook failed');
    });
    const { agent, ctx, manager } = createAgentTaskService({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'final agent output' }),
        'inspect repository',
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });

    await drainNotifications(ctx);
    expect(notificationMessageFor(agent, taskId).content[0]!.text).toContain(
      'inspect repository completed.',
    );
  });

  it('fires Notification hooks for process task notifications', async () => {
    const fireAndForgetTrigger = vi.fn<FireAndForgetTrigger>(async () => []);
    const { ctx, manager } = createAgentTaskService({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = registerProcess(manager, immediateProcess(0), 'echo', 'done');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
      expect(fireAndForgetTrigger).toHaveBeenCalled();
    });
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', expect.objectContaining({
      matcherValue: 'task.completed',
      inputData: expect.objectContaining({
        sink: 'context',
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: expect.stringMatching(/^done completed\. Exit code: 0\. Duration: \d+ ms\.$/),
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: taskId,
      }),
    }));
  });
});

describe('AgentTaskService — agent recovery notification bodies', () => {
  it('failed agent task body includes resume instructions with the correct agent_id', async () => {
    const fireAndForgetTrigger = vi.fn<FireAndForgetTrigger>(async () => []);
    const { agent, ctx, manager } = createAgentTaskService({
      hooks: { fireAndForgetTrigger },
    });
    const taskId = manager.registerTask(
      agentTask(
        Promise.reject(new Error('subagent crashed')),
        'inspect repository',
        { agentId: 'agent-7' },
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('agent_id="agent-7"');
    expect(text).toMatch(/AgentRun\(resume="agent-7"/);
    expect(text).toContain('background=true');
    expect(text).toContain('inspect the existing work and side effects');
    expect(text).toMatch(/agent_id.*NOT source_id|source_id.*NOT agent_id/);
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('Notification', expect.objectContaining({
      matcherValue: 'task.failed',
      inputData: expect.objectContaining({
        body: 'inspect repository failed. Reason: subagent crashed',
      }),
    }));
    const notificationHook = fireAndForgetTrigger.mock.calls.find(
      ([name]) => name === 'Notification',
    );
    expect(JSON.stringify(notificationHook)).not.toContain('AgentRun');
  });

  it('stopped agent task body forbids automatic resume', async () => {
    const controller = new AbortController();
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason),
        { once: true },
      );
    });
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(completion, 'inspect repository', {
        agentId: 'agent-stopped',
        abortController: controller,
      }),
    );

    const stopped = await manager.stopByUser(taskId);
    expect(stopped).toMatchObject({ status: 'killed' });
    await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
    await drainNotifications(ctx);

    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('inspect repository was stopped by user.');
    expect(text).toContain('Do not resume automatically');
    expect(text).not.toContain('AgentRun(');
    expect(text).not.toContain('background=true');
  });

  it('completed agent task body does not add resume instructions', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = manager.registerTask(
      agentTask(
        Promise.resolve({ result: 'all good' }),
        'inspect repository',
        { agentId: 'agent-8' },
      ),
    );

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).toContain('agent_id="agent-8"');
    expect(text).not.toMatch(/AgentRun\(resume="agent-8"/);
  });

  it('process task body never mentions resume', async () => {
    const { agent, ctx, manager } = createAgentTaskService();
    const taskId = registerProcess(manager, immediateProcess(1), 'false', 'shell');

    await manager.wait(taskId);

    await vi.waitFor(() => {
      expect(notifiedCount(ctx)).toBe(1);
    });
    await drainNotifications(ctx);
    const text = notificationMessageFor(agent, taskId).content[0]!.text;
    expect(text).not.toContain('agent_id=');
    expect(text).not.toMatch(/AgentRun\(resume=/);
    expect(text).toContain(`source_id="${taskId}"`);
  });

  it('delivers a restored terminal task notification through the observable user channel', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-agent-delivery-'));
    let fixture: TaskServiceFixture | undefined;
    try {
      const persistence = createAgentTaskPersistence(sessionDir);
      await persistence.writeTask(persistedAgent());
      await persistence.appendTaskOutput('agent-done0000', 'restored delivery summary');
      fixture = createAgentTaskService({ sessionDir });
      const { agent, manager } = fixture;

      await manager.loadFromDisk();
      await manager.reconcile();

      await vi.waitFor(() => {
        expect(agent.context.appendUserMessage).toHaveBeenCalledTimes(1);
        expect(agent.observableDeliveries).toHaveLength(1);
      });
      const record = agent.observableDeliveries[0]!;
      expect(record.message.origin).toEqual({
        kind: 'task',
        taskId: 'agent-done0000',
        status: 'completed',
        notificationId: 'task:agent-done0000:completed',
      });
      expect(record.delivery).toEqual(
        expect.objectContaining({
          origin: 'queue',
          messageId: expect.stringMatching(/^msg_/),
          deliveryId: expect.stringMatching(/^dlv_/),
        }),
      );
    } finally {
      await cleanupSessionDir(sessionDir, fixture);
    }
  });
});
