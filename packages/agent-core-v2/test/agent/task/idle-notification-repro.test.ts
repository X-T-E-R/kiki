import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import { createControlledPromise } from '@antfu/utils';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { Emitter, Event } from '#/_base/event';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSubagentService, type AgentRunRequest } from '#/session/subagent/subagent';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { AgentTaskPersistence } from '#/agent/task/persist';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { IAgentCollaborationMessageStore } from '#/session/agentCollaboration/messageMailbox';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';
import { ChatProviderError } from '#/kosong/contract/errors';
import { IConfigService } from '#/app/config/config';
import { LOOP_CONTROL_SECTION } from '#/agent/loop/configSection';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { QuestionBackgroundTask } from '#/agent/tools/ask-user-question/question-background-task';
import { escapeXml } from '#/_base/utils/xml-escape';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService, reservePrompt } from '#/agent/prompt/prompt';
import { IAgentGoalService } from '#/agent/goal/goal';
import { GoalUpdate } from '#/agent/goal/goalOps';
import { IEventDispatcher } from '#/state/eventDispatcher';
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
  TASK_TEST_AGENT_SCOPE,
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

async function receiptPair(maxRunningTasks?: number) {
  const created = new Emitter<IAgentScopeHandle>();
  const handles = new Map<string, IAgentScopeHandle>();
  const mailbox = sessionService(IAgentCollaborationMessageStore, {
    _serviceBrand: undefined,
    listPendingAgents: async () => [], nextQueued: async () => undefined,
    accept: async () => { throw new Error('Mailbox writes are unused in this fixture'); },
    markDelivered: async () => true,
    discardPending: async () => ({ discarded: 0 }),
  });
  const parent = createTestAgent(mailbox, sessionService(IAgentLifecycleService, {
    _serviceBrand: undefined,
    onWillCreate: Event.None as Event<IAgentScopeHandle>,
    onDidCreate: created.event,
    onDidDispose: Event.None as Event<string>,
    get: (id: string) => handles.get(id),
    list: () => [...handles.values()],
    create: async () => { throw new Error('Agent creation is unused in this fixture'); },
    commitCreate: () => {}, discard: async () => {},
    fork: async () => { throw new Error('Agent forks are unused in this fixture'); },
    broadcastPermissionMode: () => {}, countPendingBackgroundTasks: () => 0,
    drainBackgroundTasks: async () => {}, remove: async () => {},
  }));
  if (maxRunningTasks !== undefined) {
    const config = parent.get(IConfigService);
    const get = config.get.bind(config);
    vi.spyOn(config, 'get').mockImplementation(((domain: string) => domain === 'task' ? { maxRunningTasks } : get(domain)) as IConfigService['get']);
  }
  const metadata = parent.get(ISessionMetadata);
  const child = createTestAgent(
    mailbox,
    sessionService(ISessionMetadata, metadata),
    sessionService(ISessionSubagentService, parent.get(ISessionSubagentService)),
    sessionService(IAgentLifecycleService, parent.get(IAgentLifecycleService)),
    agentService(IAgentScopeContext, makeAgentScopeContext({
      agentId: 'agent-child', parentAgentId: 'main', agentScope: 'agents/agent-child',
    })),
  );
  const parentHandle: IAgentScopeHandle = { kind: 'agent', id: 'main', accessor: { get: (id) => parent.get(id) }, dispose: () => {} };
  const childHandle: IAgentScopeHandle = { kind: 'agent', id: 'agent-child', accessor: { get: (id) => child.get(id) }, dispose: () => {} };
  handles.set('main', parentHandle);
  handles.set('agent-child', childHandle);
  await metadata.registerAgent('agent-child', { type: 'sub', parentAgentId: 'main', labels: { profileName: 'example-worker' } });
  created.fire(childHandle);
  return {
    parent, child, metadata, handles, parentHandle, childHandle,
    dispose: async () => {
      created.dispose();
      handles.clear();
      await child.dispose();
      await parent.dispose();
    },
  };
}

describe('autonomous child receipt return', () => {
  it('returns a final receipt after a failed parent task and a child-owned bash wakeup', async () => {
    const { parent, child, metadata, dispose } = await receiptPair();
    const processExit = createControlledPromise<number>();
    const output = new Readable({ read() {} });
    const proc = {
      _serviceBrand: undefined, pid: 61001, exitCode: null,
      stdout: output, stderr: Readable.from([]), stdin: { write: vi.fn(), end: vi.fn() },
      wait: () => processExit, kill: async () => {}, dispose: async () => {},
    } as unknown as IHostProcess;
    try {
      parent.mockNextResponse({ type: 'text', text: 'Waiting for the preserved child.' });
      const failed = createControlledPromise<{ result: string }>();
      const tasks = parent.get(IAgentTaskService) as TaskServiceTestManager;
      const failedId = tasks.registerTask(agentTask(failed, 'Original review'));
      failed.reject(new Error('example provider connection failed'));
      await tasks.wait(failedId);
      await vi.waitFor(() => expect(notifiedCount(parent)).toBe(1));
      await parent.get(IAgentLoopService).settled();
      await metadata.updateAgent('agent-child', (meta) => ({ ...meta, taskId: failedId, status: 'failed', error: 'example provider connection failed' }));
      const bashId = child.get(IAgentTaskService).registerTask(new ProcessTask(proc, 'example-command', 'background review check'), { detached: true });
      child.mockNextResponse({ type: 'text', text: 'Reject: preserved report contains a P1 finding.' });
      parent.mockNextResponse({ type: 'text', text: 'Received the continued review.' });
      const ended = child.untilTurnEnd();
      output.push('check finished');
      output.push(null);
      processExit.resolve(0);
      await ended;
      await child.get(IAgentLoopService).settled();
      expect(child.context.get().some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('P1 finding'))).toBe(true);
      await vi.waitFor(() => expect(notifiedCount(parent)).toBe(2));
      await parent.get(IAgentLoopService).settled();
      const continued = tasks.list(false).find((info) => info.kind === 'agent' && info.taskId !== failedId);
      expect(continued).toMatchObject({ kind: 'agent', agentId: 'agent-child', status: 'completed' });
      expect(tasks.getTask(failedId)?.status).toBe('failed');
      const notification = parent.context.get().find((message) => message.origin?.kind === 'task' && message.origin.taskId === continued!.taskId);
      expect(JSON.stringify(notification)).toContain('Reject: preserved report contains a P1 finding.');
      expect(JSON.stringify(notification)).toContain('output.log');
      expect(JSON.stringify(notification)).toContain(failedId);
      expect(JSON.stringify(child.contextData())).toContain(bashId);
      expect((await metadata.read()).agents?.['agent-child']).toMatchObject({ status: 'completed', taskId: continued!.taskId });
    } finally {
      output.push(null);
      processExit.resolve(0);
      await dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns cron receipts without a prior task and keeps separate turns separate', async () => {
    const { parent, child, dispose } = await receiptPair();
    try {
      const tasks = parent.get(IAgentTaskService);
      for (const text of ['first scheduled result', 'second scheduled result']) {
        child.mockNextResponse({ type: 'text', text });
        parent.mockNextResponse({ type: 'text', text: 'Received scheduled result.' });
        const handle = await child.get(IAgentPromptService).enqueueCron({
          origin: { kind: 'cron_job', jobId: 'example-job', cron: '* * * * *', recurring: true, coalescedCount: 1, stale: false },
          prompt: 'Run the scheduled review.',
        });
        expect((await handle.completion).state).toBe('completed');
        await vi.waitFor(() => expect(tasks.list(false).filter((task) => task.status === 'completed')).toHaveLength(text.startsWith('first') ? 1 : 2));
        await parent.get(IAgentLoopService).settled();
      }
      const results = tasks.list(false);
      expect(new Set(results.map((task) => task.taskId)).size).toBe(2);
      expect(notifiedCount(parent)).toBe(2);
      for (const task of results) {
        const output = await tasks.getOutputSnapshot(task.taskId, 4096);
        expect(output.preview).toMatch(/^(first|second) scheduled result$/);
        expect(output.outputPath).toContain('output.log');
      }
    } finally {
      await dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('delivers a completed receipt even when the parent has no free background-task slots', async () => {
    const { parent, child, dispose } = await receiptPair(1);
    const pending = createControlledPromise<{ result: string }>();
    try {
      const tasks = parent.get(IAgentTaskService);
      const runningId = tasks.registerTask(agentTask(pending, 'Unrelated running task'));
      expect(() => tasks.registerTask(agentTask(pending, 'Rejected extra work'))).toThrow('Too many background tasks');
      child.mockNextResponse({ type: 'text', text: 'Completed result uses no execution slot.' });
      parent.mockNextResponse({ type: 'text', text: 'Received completed result.' });
      const handle = await child.get(IAgentPromptService).enqueue({ message: {
        role: 'user', content: [{ type: 'text', text: 'Finish the result.' }], toolCalls: [],
        origin: { kind: 'system_trigger', name: 'example-wakeup' },
      } });
      expect((await handle.completion).state).toBe('completed');
      await vi.waitFor(() => { expect(notifiedCount(parent)).toBe(1); });
      await parent.get(IAgentLoopService).settled();
      const completed = tasks.list(false).find((task) => task.taskId !== runningId)!;
      expect(completed.status).toBe('completed');
      expect(await tasks.readOutput(completed.taskId)).toBe('Completed result uses no execution slot.');
      expect(tasks.getTask(runningId)?.status).toBe('running');
    } finally {
      await parent.get(IAgentTaskService).suppressAllTerminalNotifications();
      pending.resolve({ result: 'cleanup' });
      await dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['missing parent', 'archived session'] as const)('preserves an orphan receipt for a %s', async (orphan) => {
    const { parent, child, metadata, handles, dispose } = await receiptPair();
    try {
      if (orphan === 'missing parent') handles.delete('main');
      else await metadata.setArchived(true);
      child.mockNextResponse({ type: 'text', text: 'Preserved orphan review result.' });
      const handle = await child.get(IAgentPromptService).enqueue({ message: {
        role: 'user', content: [{ type: 'text', text: 'Finish the review.' }], toolCalls: [],
        origin: { kind: 'system_trigger', name: 'example-wakeup' },
      } });
      expect((await handle.completion).state).toBe('completed');
      await vi.waitFor(async () => expect((await metadata.read()).agents?.['agent-child']?.taskId).toBeDefined());
      const taskId = (await metadata.read()).agents!['agent-child']!.taskId!;
      const session = child.get(ISessionContext);
      const persistence = new AgentTaskPersistence(
        join(session.sessionDir, 'agents/main'), session.scope('agents/main'),
        child.get(IAtomicDocumentStore), child.get(IFileSystemStorageService),
      );
      await vi.waitFor(async () => expect(await persistence.readTask(taskId)).toMatchObject({
        taskId, ownerAgentId: 'main', agentId: 'agent-child', status: 'completed',
        receipt: { contentState: 'final', path: `tasks/${taskId}/output.log` },
      }));
      expect((await persistence.readTaskOutputSnapshot(taskId, 4096))?.preview).toBe('Preserved orphan review result.');
      expect(notifiedCount(parent)).toBe(0);
      expect(parent.get(IAgentTaskService).list(false)).toHaveLength(0);
    } finally {
      await dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['prompt', 'reserved prompt', 'mailbox', 'retry', 'summary continuation'] as const)('does not duplicate a managed %s receipt', async (kind) => {
    const { parent, child, parentHandle, childHandle, dispose } = await receiptPair();
    try {
      const tasks = parent.get(IAgentTaskService);
      child.mockNextResponse({ type: 'text', text: kind === 'summary continuation' ? 'Short.' : 'Managed final receipt.' });
      if (kind === 'summary continuation') child.mockNextResponse({ type: 'text', text: 'Adequate continued final receipt.' });
      if (kind === 'retry') child.context.append({ role: 'user', content: [{ type: 'text', text: 'Retry the review.' }], toolCalls: [] });
      const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Saved follow-up message.' }], toolCalls: [],
        origin: { kind: 'system_trigger' as const, name: 'agent-message' } };
      const request: AgentRunRequest = kind === 'mailbox' ? { kind: 'mailbox', prompt: 'Saved follow-up message.', message }
        : kind === 'retry' ? { kind: 'retry' } : { kind: 'prompt', prompt: 'Finish the review.' };
      const run = kind === 'reserved prompt' ? await (async () => {
        const reservation = reservePrompt(child.get(IAgentPromptService), undefined, false, undefined, { parentReceiptManaged: true });
        const prompt = await reservation.submit(message);
        const turn = await prompt.launched;
        if (turn === undefined) throw new Error('Managed reserved prompt did not launch');
        return { agentId: childHandle.id, turn, completion: prompt.completion.then(() => ({ summary: 'Managed final receipt.' })) };
      })() : await runAgentTurn(childHandle, request, {
        signal: new AbortController().signal,
        summaryPolicy: kind === 'summary continuation' ? { minChars: 20, retries: 1, continuationPrompt: 'Finish the summary.' } : undefined,
      });
      const taskId = tasks.registerTask(new SubagentTask({ agentId: childHandle.id, profileName: 'example-worker',
        completion: mirrorAgentRun(parentHandle, run, { profileName: 'example-worker', signal: new AbortController().signal })
          .then((result) => ({ result: result.summary })),
      }, 'Managed review', new AbortController()));
      parent.mockNextResponse({ type: 'text', text: 'Received managed result.' });
      await tasks.wait(taskId);
      await vi.waitFor(() => expect(notifiedCount(parent)).toBe(1));
      await parent.get(IAgentLoopService).settled();
      expect(tasks.list(false)).toHaveLength(1);
      expect(await tasks.readOutput(taskId)).toContain(kind === 'summary continuation' ? 'Adequate continued final receipt.' : 'Managed final receipt.');
    } finally {
      await dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('keeps in-flight message steering on the original managed receipt', async () => {
    const { parent, child, parentHandle, dispose } = await receiptPair();
    const entered = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    const hook = child.get(IAgentLoopService).hooks.onWillBeginStep.register('test.receipt-steer', async (_step, next) => {
      await hook.dispose();
      entered.resolve();
      await release;
      await next();
    });
    try {
      child.mockNextResponse({ type: 'text', text: 'Review in progress.' });
      child.mockNextResponse({ type: 'text', text: 'Final receipt incorporates the in-flight message.' });
      const running = parent.get(ISessionSubagentService).run('agent-child', { kind: 'prompt', prompt: 'Review the change.' }, { signal: new AbortController().signal });
      await entered;
      const run = await running;
      const tasks = parent.get(IAgentTaskService);
      const taskId = tasks.registerTask(new SubagentTask({ agentId: 'agent-child', profileName: 'example-worker',
        completion: mirrorAgentRun(parentHandle, run, { profileName: 'example-worker', signal: new AbortController().signal })
          .then((result) => ({ result: result.summary })),
      }, 'Steered review', new AbortController()));
      const delivered = child.get(IAgentExecutionService).steer!({ role: 'user', content: [{ type: 'text', text: 'In-flight message.' }], toolCalls: [],
        origin: { kind: 'system_trigger', name: 'agent-message' } });
      parent.mockNextResponse({ type: 'text', text: 'Received steered result.' });
      release.resolve();
      expect(await delivered).toBe(true);
      await tasks.wait(taskId);
      await vi.waitFor(() => expect(notifiedCount(parent)).toBe(1));
      await parent.get(IAgentLoopService).settled();
      expect(tasks.list(false)).toHaveLength(1);
      expect(await tasks.readOutput(taskId)).toBe('Final receipt incorporates the in-flight message.');
      expect(JSON.stringify(child.contextData())).toContain('In-flight message.');
    } finally {
      release.resolve();
      await hook.dispose();
      await dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not reuse an older receipt when this turn ends without text', async () => {
    const { parent, child, dispose } = await receiptPair();
    try {
      child.appendAssistantTurn(0, 'Previous receipt must not be redelivered.');
      child.mockNextResponse({ type: 'text', text: '' });
      const handle = await child.get(IAgentPromptService).enqueue({ message: {
        role: 'user', content: [{ type: 'text', text: 'Inspect without a reply.' }], toolCalls: [],
        origin: { kind: 'system_trigger', name: 'example-wakeup' },
      } });
      expect((await handle.completion).state).toBe('completed');
      await child.get(IAgentLoopService).settled();
      expect(parent.get(IAgentTaskService).list(false)).toHaveLength(0);
      expect(notifiedCount(parent)).toBe(0);
    } finally {
      await dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});

describe('task notification dispatch capacity', () => {
  it.each([false, true])('shares ordinary previews across a real merged step (overflow=%s), not question answers', async (overflow) => {
    const entered = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    let calls = 0;
    const requester: IAgentLLMRequesterService = {
      _serviceBrand: undefined,
      prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
      invalidatePromptSnapshots: () => 0,
      armAnthropicResponseCapture: () => { throw new Error('response capture is unused in this fixture'); },
      anthropicResponseCaptureStatus: async () => null,
      stopAnthropicResponseCapture: () => { throw new Error('response capture is unused in this fixture'); },
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
      expect(previewBytes).toBeGreaterThan(overflow ? 4 * 3_000 : 0);
      expect(previewBytes).toBeLessThanOrEqual(overflow ? 4 * 4_000 : Buffer.byteLength(output) * 4);
      for (const id of ids) expect(texts.some((text) => text.includes(id))).toBe(true);
      expect(ordinary.join('')).not.toContain('\uFFFD');
      expect(ordinary.join('')).not.toContain('中<&>');
      for (const text of ordinary) {
        expect(text).toContain('<output-preview bytes="');
        expect(text).toContain('<output-file');
        expect(text).toContain(escapeXml('中<&>🙂'));
        expect(text).not.toContain('Output preview omitted');
      }
      if (overflow) {
        expect(ordinary.every((text) => text.includes('truncated="true" complete="false"'))).toBe(true);
      } else {
        for (const text of ordinary) expect(text).toContain(escapeXml(output));
      }
      const question = texts.find((text) => text.includes(questionId))!;
      expect(question).toContain(answer);
      expect(question).toContain('Background question answered');
      expect(question).not.toContain('dismissed');
      const next = tasks.registerTask(agentTask(Promise.resolve({ result: output }), 'fresh batch'));
      await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(6));
      await loop.settled();
      const fresh = JSON.stringify(ctx.context.get().find((m) => m.origin?.kind === 'task' && m.origin.taskId === next)?.content);
      expect(fresh).toContain(escapeXml('中<&>🙂'));
      expect(fresh).toContain('<output-file');
      expect(fresh).toContain(escapeXml(output));
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
      armAnthropicResponseCapture: () => { throw new Error('response capture is unused in this fixture'); },
      anthropicResponseCaptureStatus: async () => null,
      stopAnthropicResponseCapture: () => { throw new Error('response capture is unused in this fixture'); },
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

    it('BLOCKED GOAL: live child completion wakes idle main without resuming the goal', async () => {
      const goals = ctx.get(IAgentGoalService);
      const goal = await goals.createGoal({ objective: 'finish delegated work' });
      await goals.markBlocked({ reason: 'waiting for a dependency' });
      const completion = createControlledPromise<{ result: string }>();
      const taskId = background.registerTask(agentTask(completion, 'authorized dependency'));
      expect(background.getTask(taskId)?.goalId).toBe(goal.goalId);
      ctx.mockNextResponse({ type: 'text', text: 'waiting for child' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue authorized dependency' }] });
      await ctx.untilTurnEnd();
      await loop.settled();
      const enqueue = vi.spyOn(loop, 'enqueue');
      ctx.mockNextResponse({ type: 'text', text: 'dependency received, goal remains blocked' });
      const ended = ctx.untilTurnEnd();
      completion.resolve({ result: 'dependency ready' });
      await background.wait(taskId);
      await vi.waitFor(() => expect(enqueue.mock.calls.some(([r]) => r.kind === 'task_notification')).toBe(true));
      expect(enqueue.mock.calls.find(([r]) => r.kind === 'task_notification')![0].admission).toBe('activeOrNewTurn');
      await ended;
      await loop.settled();
      expect(notifiedCount(ctx)).toBe(1);
      expect(ctx.llmCalls).toHaveLength(2);
      expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).toContain('dependency ready');
      expect(goals.getGoal().goal?.status).toBe('blocked');
      expect(ctx.context.get().filter((m) => m.origin?.kind === 'system_trigger' && m.origin.name === 'goal_continuation')).toHaveLength(0);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('ACTIVE GOAL: a finished child is delivered while another child keeps running', async () => {
      const goals = ctx.get(IAgentGoalService);
      const tasks = background as TaskServiceTestManager;
      const finished = createControlledPromise<{ result: string }>();
      const running = createControlledPromise<{ result: string }>();
      const finishedId = background.registerTask(new SubagentTask(
        { agentId: 'agent-finished', profileName: 'coder', completion: finished },
        'finished before the goal',
        new AbortController(),
      ));
      const goal = await goals.createGoal({
        objective: 'finish delegated work',
        followUpTiming: 'subagents_done',
      });
      expect(goal.budget.tokenBudget).toBeNull();
      expect(goal.budget.turnBudget).toBeNull();
      expect(goal.budget.wallClockBudgetMs).toBeNull();
      const runningId = background.registerTask(new SubagentTask(
        { agentId: 'agent-running', profileName: 'coder', completion: running },
        'still running sibling',
        new AbortController(),
      ));
      expect(background.getTask(finishedId)?.goalId).toBeUndefined();
      expect(background.getTask(runningId)?.goalId).toBe(goal.goalId);
      try {
        ctx.mockNextResponse({ type: 'text', text: 'parent turn done' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start delegated work' }] });
        await ctx.untilTurnEnd();
        await loop.settled();
        const turnsAfterParent = goals.getGoal().goal?.turnsUsed;
        expect(goals.getGoal().goal?.status).toBe('active');
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'system_trigger' && m.origin.name === 'goal_continuation')).toHaveLength(0);
        expect(notifiedCount(ctx)).toBe(0);

        ctx.mockNextResponse({ type: 'text', text: 'saw the finished child' });
        const ended = ctx.untilTurnEnd();
        finished.resolve({ result: 'child receipt ready' });
        await ended;
        await loop.settled();
        expect(notifiedCount(ctx)).toBe(1);
        expect(ctx.llmCalls).toHaveLength(2);
        const delivered = JSON.stringify(ctx.llmCalls.at(-1)!.history);
        expect(delivered).toContain('<notification');
        expect(delivered).toContain(finishedId);
        expect(delivered).toContain('child receipt ready');
        expect(delivered).not.toContain('Continue the active goal');
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === finishedId)).toHaveLength(1);
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'system_trigger' && m.origin.name === 'goal_continuation')).toHaveLength(0);
        expect(goals.getGoal().goal).toMatchObject({ status: 'active', turnsUsed: turnsAfterParent });
        expect(background.getTask(runningId)?.status).toBe('running');
        await tasks.reconcile();
        expect(notifiedCount(ctx)).toBe(1);
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === finishedId)).toHaveLength(1);
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === runningId)).toHaveLength(0);
      } finally {
        finished.resolve({ result: 'cleanup' });
        running.resolve({ result: 'cleanup' });
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('ACTIVE GOAL: cancelling the notification turn holds the next completion', async () => {
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'finish delegated work' });
      const first = createControlledPromise<{ result: string }>();
      const second = createControlledPromise<{ result: string }>();
      const sibling = createControlledPromise<{ result: string }>();
      const firstId = background.registerTask(agentTask(first, 'first completion'));
      background.registerTask(new SubagentTask(
        { agentId: 'agent-sibling', profileName: 'coder', completion: sibling },
        'keeps the goal from following up',
        new AbortController(),
      ));
      let secondId = '';
      let armCancel = false;
      const hook = loop.hooks.onDidFinishStep.register('test.goal-notification-cancel', async (step, next) => {
        if (armCancel && step.firstStepOfTurn) {
          armCancel = false;
          secondId = background.registerTask(new SubagentTask(
            { agentId: 'agent-second', profileName: 'coder', completion: second },
            'completion from cancelled turn',
            new AbortController(),
          ));
          loop.cancel();
        }
        await next();
      });
      try {
        ctx.mockNextResponse({ type: 'text', text: 'parent turn done' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start delegated work' }] });
        await ctx.untilTurnEnd();
        await loop.settled();
        armCancel = true;
        ctx.mockNextResponse({ type: 'text', text: 'notification response' });
        const ended = ctx.untilTurnEnd();
        first.resolve({ result: 'first receipt' });
        await ended;
        await loop.settled();
        expect(loop.status().lastTurnResult).toBe('cancelled');
        expect(goals.getGoal().goal?.status).toBe('active');
        const enqueue = vi.spyOn(loop, 'enqueue');
        second.resolve({ result: 'held receipt' });
        await background.wait(secondId);
        await vi.waitFor(() => expect(enqueue.mock.calls.some(([request]) => request.kind === 'task_notification')).toBe(true));
        expect(enqueue.mock.calls.find(([request]) => request.kind === 'task_notification')![0].admission).toBe('activeOrNextTurn');
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === secondId)).toHaveLength(0);
        ctx.mockNextResponse({ type: 'text', text: 'authorized handling' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'inspect the held completion' }] });
        await ctx.untilTurnEnd();
        await loop.settled();
        expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).toContain('held receipt');
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === firstId)).toHaveLength(1);
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === secondId)).toHaveLength(1);
      } finally {
        armCancel = false;
        first.resolve({ result: 'cleanup' });
        second.resolve({ result: 'cleanup' });
        sibling.resolve({ result: 'cleanup' });
        await hook.dispose();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('COMMIT: a completion wakes main only after the terminal event flushes', async () => {
      const saving = createControlledPromise<void>();
      const save = createControlledPromise<void>();
      const dispatcher = ctx.get(IEventDispatcher);
      const originalFlush = dispatcher.flush.bind(dispatcher);
      const flush = vi.spyOn(dispatcher, 'flush').mockImplementationOnce(async () => {
        saving.resolve();
        await save;
        await originalFlush();
      });
      const enqueue = vi.spyOn(loop, 'enqueue');
      ctx.mockNextResponse({ type: 'text', text: 'durable receipt received' });
      const ended = ctx.untilTurnEnd();
      const taskId = background.registerTask(agentTask(Promise.resolve({ result: 'durable receipt' }), 'saved completion'));
      try {
        await saving;
        expect(background.getTask(taskId)?.status).toBe('completed');
        expect(enqueue.mock.calls.filter(([request]) => request.kind === 'task_notification')).toHaveLength(0);
        expect(ctx.llmCalls).toHaveLength(0);
        save.resolve();
        await ended;
        await loop.settled();
        expect(enqueue.mock.calls.filter(([request]) => request.kind === 'task_notification')).toHaveLength(1);
        expect(notifiedCount(ctx)).toBe(1);
        expect(JSON.stringify(ctx.llmCalls[0]!.history)).toContain('durable receipt');
      } finally {
        save.resolve();
        flush.mockRestore();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('RACE: an explicit pause after notification enqueue is honored when wake admission resumes', async () => {
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'finish delegated work' });
      const hold = loop.tryAcquireQuiescence();
      expect(hold).toBeDefined();
      const enqueue = vi.spyOn(loop, 'enqueue');
      const taskId = background.registerTask(agentTask(Promise.resolve({ result: 'receipt saved before pause' }), 'held notification'));
      try {
        await background.wait(taskId);
        await vi.waitFor(() => {
          expect(enqueue.mock.calls.some(([request]) => request.kind === 'task_notification')).toBe(true);
        });
        await goals.pauseGoal();
        await hold!.dispose();
        await loop.settled();
        expect(ctx.llmCalls).toHaveLength(0);
        expect(notifiedCount(ctx)).toBe(0);
        ctx.mockNextResponse({ type: 'text', text: 'authorized handling' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'inspect the retained receipt' }] });
        await ctx.untilTurnEnd();
        await loop.settled();
        expect(notifiedCount(ctx)).toBe(1);
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === taskId)).toHaveLength(1);
        expect(goals.getGoal().goal?.status).toBe('paused');
      } finally {
        await hold?.dispose();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('RUNTIME PAUSE: child receipts wake main after a successful user turn without resuming the goal', async () => {
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'finish delegated work' });
      const first = createControlledPromise<{ result: string }>();
      const second = createControlledPromise<{ result: string }>();
      const firstId = background.registerTask(agentTask(first, 'first receipt'));
      const secondId = background.registerTask(new SubagentTask(
        { agentId: 'agent-second', profileName: 'coder', completion: second },
        'second receipt', new AbortController(),
      ));
      try {
        await ctx.get(IConfigService).set(LOOP_CONTROL_SECTION, { maxAttemptsPerStep: 1 });
        ctx.mockNextProviderResponse({ error: new ChatProviderError(
          'Responses websocket connection limit reached', 'provider.api_error',
        ) });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start delegated work' }] });
        await ctx.untilTurnEnd();
        await loop.settled();
        expect(goals.getGoal().goal).toMatchObject({
          status: 'paused', terminalReason: 'Paused after provider API error: Responses websocket connection limit reached',
        });
        ctx.mockNextResponse({ type: 'text', text: 'provider recovered' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'check current progress' }] });
        await ctx.untilTurnEnd();
        await loop.settled();
        const enqueue = vi.spyOn(loop, 'enqueue');
        for (const [completion, taskId, result] of [
          [first, firstId, 'first durable receipt'],
          [second, secondId, 'second durable receipt'],
        ] as const) {
          ctx.mockNextResponse({ type: 'text', text: 'receipt received' });
          const ended = ctx.untilTurnEnd();
          completion.resolve({ result });
          await background.wait(taskId);
          await vi.waitFor(() => {
            expect(enqueue.mock.calls.at(-1)?.[0].admission).toBe('activeOrNewTurn');
          });
          await ended;
          await loop.settled();
          expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).toContain(result);
          expect(goals.getGoal().goal?.status).toBe('paused');
          expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === taskId)).toHaveLength(1);
        }
        await (background as TaskServiceTestManager).reconcile();
        expect(notifiedCount(ctx)).toBe(2);
        expect(ctx.llmCalls).toHaveLength(4);
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'system_trigger' && m.origin.name === 'goal_continuation')).toHaveLength(0);
      } finally {
        first.resolve({ result: 'cleanup' });
        second.resolve({ result: 'cleanup' });
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it.each(['paused', 'runtime then user pause', 'runtime pause with token budget', 'token budget', 'turn budget', 'time budget'] as const)(
      'GOAL CONTROL: %s retains completion until an authorized prompt', async (control) => {
        const goals = ctx.get(IAgentGoalService);
        await goals.createGoal({ objective: 'finish delegated work' });
        const completion = createControlledPromise<{ result: string }>();
        const taskId = background.registerTask(agentTask(completion, 'controlled dependency'));
        if (control === 'paused') await goals.pauseGoal();
        else if (control === 'runtime then user pause') {
          await goals.pauseGoal({ reason: 'Paused after provider API error' }, 'runtime');
          await goals.pauseGoal();
        } else if (control === 'runtime pause with token budget') {
          await goals.pauseGoal({ reason: 'Paused after provider API error' }, 'runtime');
          await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 0 } });
        } else {
          const budgetLimits = control === 'token budget' ? { tokenBudget: 0 }
            : control === 'turn budget' ? { turnBudget: 0 } : { wallClockBudgetMs: 0 };
          await goals.setBudgetLimits({ budgetLimits });
        }
        const enqueue = vi.spyOn(loop, 'enqueue');
        completion.resolve({ result: 'retained dependency result' });
        await background.wait(taskId);
        await vi.waitFor(() => expect(enqueue.mock.calls.some(([r]) => r.kind === 'task_notification')).toBe(true));
        expect(enqueue.mock.calls.find(([r]) => r.kind === 'task_notification')![0].admission).toBe('activeOrNextTurn');
        expect(notifiedCount(ctx)).toBe(0);
        expect(ctx.llmCalls).toHaveLength(0);
        ctx.mockNextResponse({ type: 'text', text: 'authorized handling' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'inspect retained completion' }] });
        await ctx.untilTurnEnd();
        await loop.settled();
        expect(notifiedCount(ctx)).toBe(1);
        expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).toContain('retained dependency result');
      }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS,
    );

    it.each(['retained complete', 'cleared complete', 'cleared cancelled', 'replaced blocked', 'replaced paused', 'replaced runtime pause'] as const)(
      'ENDED GOAL: %s does not prevent idle completion wakeup', async (control) => {
        const goals = ctx.get(IAgentGoalService);
        const goal = await goals.createGoal({ objective: 'finish delegated work' });
        const completion = createControlledPromise<{ result: string }>();
        if (control === 'retained complete') {
          await ctx.get(IEventDispatcher).dispatch(new GoalUpdate({
            status: 'complete', actor: 'model', budgetLimits: { tokenBudget: 0, turnBudget: 0, wallClockBudgetMs: 0 },
          }));
        }
        const taskId = background.registerTask(control === 'cleared complete'
          ? new QuestionBackgroundTask(async () => ({ output: (await completion).result }), 'finished goal dependency', { questionCount: 1 })
          : agentTask(completion, 'finished goal dependency'));
        expect(background.getTask(taskId)?.goalId).toBe(goal.goalId);
        if (control === 'cleared complete') await goals.markComplete();
        else if (control === 'cleared cancelled') await goals.cancelGoal();
        else if (control.startsWith('replaced')) {
          await goals.createGoal({ objective: 'other work', replace: true });
          if (control === 'replaced blocked') await goals.markBlocked();
          else await goals.pauseGoal({}, control === 'replaced paused' ? 'user' : 'runtime');
        }
        const expectedGoal = goals.getGoal().goal;
        if (control.startsWith('cleared')) expect(expectedGoal).toBeNull();
        const enqueue = vi.spyOn(loop, 'enqueue');
        ctx.mockNextResponse({ type: 'text', text: 'completion received' });
        completion.resolve({ result: 'receipt from finished goal work' });
        await background.wait(taskId);
        await vi.waitFor(() => expect(enqueue.mock.calls.some(([r]) => r.kind === 'task_notification')).toBe(true));
        expect(enqueue.mock.calls.find(([r]) => r.kind === 'task_notification')![0].admission).toBe('activeOrNewTurn');
        await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
        await loop.settled();
        expect(ctx.llmCalls).toHaveLength(1);
        expect(JSON.stringify(ctx.llmCalls[0]!.history)).toContain('receipt from finished goal work');
        expect(goals.getGoal().goal).toEqual(expectedGoal);
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'system_trigger' && m.origin.name === 'goal_continuation')).toHaveLength(0);
      }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS,
    );

    it.each(['unrelated user pause', 'system pause'] as const)(
      'PAUSE SCOPE: %s allows a completion to wake idle main', async (control) => {
        const completion = createControlledPromise<{ result: string }>();
        const goals = ctx.get(IAgentGoalService);
        if (control === 'system pause') await goals.createGoal({ objective: 'finish delegated work' });
        const taskId = background.registerTask(agentTask(completion, 'independent completion'));
        if (control === 'unrelated user pause') await goals.createGoal({ objective: 'other work' });
        await goals.pauseGoal({}, control === 'system pause' ? 'system' : 'user');
        const expectedGoal = goals.getGoal().goal;
        ctx.mockNextResponse({ type: 'text', text: 'receipt received, goal stays paused' });
        completion.resolve({ result: 'independent receipt' });
        await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
        await loop.settled();
        expect(ctx.llmCalls).toHaveLength(1);
        expect(JSON.stringify(ctx.llmCalls[0]!.history)).toContain(taskId);
        expect(goals.getGoal().goal).toEqual(expectedGoal);
      }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS,
    );

    it.each(['issuing turn', 'earlier task', 'new task'] as const)(
      'CANCELLED TURN: applies wake protection only to its own task (%s)', async (owner) => {
        const completion = createControlledPromise<{ result: string }>();
        let taskId = owner === 'earlier task'
          ? background.registerTask(agentTask(completion, 'independently started task')) : '';
        const hook = loop.hooks.onDidFinishStep.register('test.task-owner-cancel', async (_step, next) => {
          await hook.dispose();
          if (owner === 'issuing turn') taskId = background.registerTask(agentTask(completion, 'task from cancelled turn'));
          loop.cancel();
          await next();
        });
        try {
          ctx.mockNextResponse({ type: 'text', text: 'cancel this response' });
          await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start work' }] });
          await ctx.untilTurnEnd();
          await loop.settled();
          expect(loop.status().lastTurnResult).toBe('cancelled');
          if (owner === 'new task') taskId = background.registerTask(agentTask(completion, 'task started after cancellation'));
          expect(background.getTask(taskId)?.ownerTurnId).toBe(owner === 'issuing turn' ? 0 : undefined);
          const enqueue = vi.spyOn(loop, 'enqueue');
          ctx.mockNextResponse({ type: 'text', text: 'completion received' });
          completion.resolve({ result: 'receipt after cancellation' });
          await background.wait(taskId);
          await vi.waitFor(() => expect(enqueue.mock.calls.some(([r]) => r.kind === 'task_notification')).toBe(true));
          expect(enqueue.mock.calls.find(([r]) => r.kind === 'task_notification')![0].admission)
            .toBe(owner === 'issuing turn' ? 'activeOrNextTurn' : 'activeOrNewTurn');
          if (owner === 'issuing turn') {
            expect(notifiedCount(ctx)).toBe(0);
            expect(ctx.llmCalls).toHaveLength(1);
            await ctx.rpc.prompt({ input: [{ type: 'text', text: 'handle the retained completion' }] });
            await ctx.untilTurnEnd();
          }
          await vi.waitFor(() => expect(notifiedCount(ctx)).toBe(1));
          await loop.settled();
          expect(ctx.llmCalls).toHaveLength(2);
          expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).toContain('receipt after cancellation');
        } finally {
          completion.resolve({ result: 'cleanup' });
          await hook.dispose();
        }
      }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS,
    );

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

    it.each(['completed', 'cancelled'] as const)(
      'delivers a child completion in the first queued prompt step after %s turn exit', async (outcome) => {
      const firstFinished = createControlledPromise<void>();
      const finishFirst = createControlledPromise<void>();
      const launching = createControlledPromise<void>();
      const launch = createControlledPromise<void>();
      const childCompletion = createControlledPromise<{ result: string }>();
      const prompts = ctx.get(IAgentPromptService);
      const enqueue = vi.spyOn(loop, 'enqueue');
      const finishHook = loop.hooks.onDidFinishStep.register('test.queue-order', async (_step, next) => {
        await finishHook.dispose();
        firstFinished.resolve();
        await finishFirst;
        if (outcome === 'cancelled') loop.cancel();
        await next();
      });
      const launchHook = prompts.hooks.onBeforeSubmitPrompt.register('test.queue-order', async ({ promptMessage }, next) => {
        if (promptMessage.id === 'queued-user') {
          launching.resolve();
          await launch;
        }
        await next();
      });
      try {
        ctx.mockNextResponse({ type: 'text', text: 'first ack' });
        ctx.mockNextResponse({ type: 'text', text: 'queued prompt ack' });
        ctx.mockNextResponse({ type: 'text', text: 'late notification ack' });
        const taskId = background.registerTask(agentTask(childCompletion, 'queued child report'));
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
        await firstFinished;
        const queued = await prompts.enqueue({
          id: 'queued-user',
          message: { role: 'user', content: [{ type: 'text', text: 'use the child result' }], toolCalls: [], origin: { kind: 'user' } },
        });
        expect(queued.state).toBe('pending');
        finishFirst.resolve();
        await launching;
        childCompletion.resolve({ result: 'child completed before queued prompt launch' });
        await vi.waitFor(() => {
          expect(enqueue.mock.calls.some(([request]) => request.kind === 'task_notification')).toBe(true);
        });
        expect(notifiedCount(ctx)).toBe(0);
        launch.resolve();
        await queued.completion;
        await loop.settled();
        const queuedCall = ctx.llmCalls.find((call) => JSON.stringify(call.history).includes('use the child result'));
        expect(queuedCall).toBeDefined();
        expect(JSON.stringify(queuedCall!.history)).toContain(taskId);
        expect(JSON.stringify(queuedCall!.history)).toContain('child completed before queued prompt launch');
        const promptMessage = ctx.context.get().find((message) => message.id === queued.id)!;
        const notifications = ctx.context.get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]!.source).toEqual(promptMessage.source);
        expect(notifiedCount(ctx)).toBe(1);
        expect(ctx.llmCalls).toHaveLength(2);
      } finally {
        finishFirst.resolve();
        launch.resolve();
        childCompletion.resolve({ result: 'cleanup' });
        await finishHook.dispose();
        await launchHook.dispose();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it.each(['completed', 'cancelled'] as const)(
      'readmits an unconsumed notification after %s turn exit under the current wake policy', async (outcome) => {
      ctx.mockNextResponse({ type: 'text', text: 'first ack' });
      ctx.mockNextResponse({ type: 'text', text: 'second ack' });
      ctx.mockNextResponse({ type: 'text', text: 'third ack' });
      let taskId = '';
      const enqueue = vi.spyOn(loop, 'enqueue');
      const hook = loop.hooks.onDidFinishStep.register('test.exit-race', async (step, next) => {
        await hook.dispose();
        taskId = background.registerTask(agentTask(Promise.resolve({ result: 'durable child report' }), 'exit race'));
        await background.wait(taskId);
        await vi.waitFor(() => expect(enqueue.mock.calls.some(([request]) => request.kind === 'task_notification')).toBe(true));
        if (outcome === 'cancelled') loop.cancel();
        else step.stopTurn = true;
        await next();
      });
      try {
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
        await ctx.untilTurnEnd();
        if (outcome === 'cancelled') {
          await loop.settled();
          expect(ctx.context.get().filter((m) => m.origin?.kind === 'task')).toHaveLength(0);
          expect(notifiedCount(ctx)).toBe(0);
          await ctx.rpc.prompt({ input: [{ type: 'text', text: 'next authorized prompt' }] });
          await ctx.untilTurnEnd();
        } else {
          await vi.waitFor(() => {
            expect(notifiedCount(ctx)).toBe(1);
          });
          await loop.settled();
          expect(ctx.llmCalls).toHaveLength(2);
          expect(JSON.stringify(ctx.llmCalls.at(-1)!.history)).toContain('durable child report');
        }
        expect(ctx.context.get().filter((m) => m.origin?.kind === 'task' && m.origin.taskId === taskId)).toHaveLength(1);
        expect(notifiedCount(ctx)).toBe(1);
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'another prompt' }] });
        await ctx.untilTurnEnd();
        expect(notifiedCount(ctx)).toBe(1);
      } finally {
        await hook.dispose();
      }
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
      await backgroundPersistence.commitTerminalTask((await backgroundPersistence.readTask('bash-prev0000'))!);

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

    it('RESUME: delivers a damaged receipt status once without injecting the untrusted log', async () => {
      const persistence = createAgentTaskPersistence(sessionDir);
      const taskId = 'agent-damaged1';
      await persistence.commitTerminalTask({
        taskId, kind: 'agent', agentId: 'child-damaged', description: 'damaged task',
        status: 'failed', stopReason: 'child failed', detached: true, startedAt: 20, endedAt: 21,
      }, 'trusted completion');
      await writeFile(join(sessionDir, TASK_TEST_AGENT_SCOPE, 'tasks', taskId, 'output.log'), 'malicious completion');
      await background.loadFromDisk();
      expect(background.getTask(taskId)).toMatchObject({ receipt: undefined, receiptVerification: 'invalid' });
      await background.reconcile();
      const notifications = ctx.context.get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId);
      expect(notifications).toHaveLength(1);
      const text = notifications[0]!.content.map((part) => part.type === 'text' ? part.text : '').join('');
      expect(text).toContain('task.failed');
      expect(text).toContain('child failed');
      expect(text).toContain('AgentRun(resume="child-damaged"');
      expect(text).toContain('Task receipt verification failed');
      expect(text).not.toContain('malicious completion');
      expect(text).not.toContain('<output-preview');
      expect(text).not.toContain('<output-file');
      await background.reconcile();
      expect(ctx.context.get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId))
        .toHaveLength(1);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

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
        await persistence.commitTerminalTask((await persistence.readTask(taskId))!, output);
      }
      await persistence.writeTask({
        taskId: 'question-batch000', kind: 'question', questionCount: 1, description: 'restored answer',
        startedAt: 30, endedAt: 31, status: 'completed',
      });
      await persistence.appendTaskOutput('question-batch000', answer);
      await persistence.commitTerminalTask((await persistence.readTask('question-batch000'))!);
      await persistence.writeTask({
        taskId: 'agent-nofile00', kind: 'agent', description: 'no receipt captured',
        startedAt: 32, endedAt: 33, status: 'failed', stopReason: 'no output exists',
      });
      await persistence.commitTerminalTask((await persistence.readTask('agent-nofile00'))!);
      await background.loadFromDisk();
      await background.reconcile();
      const notifications = ctx.context.get().filter((m) => m.origin?.kind === 'task');
      expect(notifications).toHaveLength(9);
      const texts = notifications.map((m) => m.content.map((p) => p.type === 'text' ? p.text : '').join(''));
      const ordinary = texts.filter((text) => !text.includes('question-batch000'));
      const bytes = ordinary.flatMap((text) => [...text.matchAll(/<output-preview bytes="(\d+)"/g)]).reduce((sum, match) => sum + Number(match[1]), 0);
      expect(bytes).toBeLessThanOrEqual(16_000);
      expect(bytes).toBeGreaterThan(10_000);
      expect(ordinary.join('')).not.toContain('Output preview omitted');
      expect(ordinary.join('')).not.toContain('\uFFFD');
      expect(ordinary.join('')).not.toContain('中<&>');
      for (let i = 0; i < 5; i++) {
        const text = texts.find((text) => text.includes(`agent-batch00${i}`))!;
        expect(text).toContain(`child-${i}`);
        expect(text).toContain('<output-file');
        expect(text).toContain('<output-preview bytes="');
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
