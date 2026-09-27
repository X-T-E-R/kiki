import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskPersistence, IAgentTaskService } from '#/agent/task/task';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { TaskOutputTool } from '#/agent/tools/task/task-output/taskOutputTool';
import { TaskListTool } from '#/agent/tools/task/task-list/taskListTool';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { createAgentTaskPersistence, TASK_TEST_SESSION_SCOPE, TASK_TEST_AGENT_SCOPE, type TaskServiceTestManager } from './stubs';
import { taskServices, createTestAgent, homeDirServices, type TestAgentContext } from '../../harness';
import { executeTool, type TestExecutableToolContext } from '../../tools/fixtures/execute-tool';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

interface TaskServiceFixture {
  readonly ctx: TestAgentContext;
  readonly manager: TaskServiceTestManager;
  readonly persistence: ReturnType<typeof createAgentTaskPersistence>;
}

function createTaskService(homedir: string): TaskServiceFixture {
  const persistence = createAgentTaskPersistence(homedir);
  const ctx = createTestAgent(homeDirServices(homedir), taskServices());
  const manager = ctx.get(IAgentTaskService) as TaskServiceTestManager;
  return {
    ctx,
    manager,
    persistence,
  };
}

function registerProcess(
  manager: IAgentTaskService,
  proc: IHostProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessTask(proc, command, description));
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

async function waitForOutput(
  manager: IAgentTaskService,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}

async function waitForTaskNotifications(
  ctx: TestAgentContext,
  manager: TaskServiceTestManager,
): Promise<void> {
  const tasks = manager.list(false).filter(
    (task) =>
      TERMINAL_STATUSES.has(task.status) &&
      task.detached !== false &&
      task.terminalNotificationSuppressed !== true,
  );
  if (tasks.length === 0) return;

  ctx.mockNextResponse({ type: 'text', text: 'notification drain ack' });
  await vi.waitFor(() => {
    const delivered = ctx.allEvents.filter((e) => e.event === 'task.notified').length;
    expect(delivered).toBeGreaterThanOrEqual(tasks.length);
  });
  await vi.waitFor(() => {
    const loop = ctx.get(IAgentLoopService);
    expect(loop.status().state).toBe('idle');
    expect(loop.hasPendingRequests()).toBe(false);
  });

  const origins = ctx.context.get().map((message) => message.origin);
  for (const task of tasks) {
    expect(origins).toContainEqual({
      kind: 'task',
      taskId: task.taskId,
      status: task.status,
      notificationId: `task:${task.taskId}:${task.status}`,
    });
  }
}

function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 50000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as IHostProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

describe('AgentTaskService — readOutput / getOutputSnapshot', () => {
  let sessionDir: string;
  let ctx: TestAgentContext;
  let manager: TaskServiceTestManager;
  let persistence: ReturnType<typeof createAgentTaskPersistence>;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-output-'));
    const fixture = createTaskService(sessionDir);
    ctx = fixture.ctx;
    manager = fixture.manager;
    persistence = fixture.persistence;
  });

  afterEach(async () => {
    try {
      await waitForTaskNotifications(ctx, manager);
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      rmSync(sessionDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('getOutputSnapshot returns output.log path when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'hello\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'hello');
    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputPath).toContain(sessionDir);
    expect(snapshot.outputPath).toContain(taskId);
    expect(snapshot.outputPath!.endsWith('output.log')).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('getOutputSnapshot truncates large persisted output to a tail preview with paging metadata', async () => {
    const head = 'HEAD-MARKER\n';
    const tail = 'TAIL-MARKER\n';
    const output = head + 'x'.repeat(200 * 1024) + tail;
    const taskId = registerProcess(manager, immediateProcess(0, output), 'echo big', 'large');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 32 * 1024);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputSizeBytes).toBe(Buffer.byteLength(output));
    expect(snapshot.previewBytes).toBe(32 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.preview).toContain(tail);
    expect(snapshot.preview).not.toContain(head);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('pages a restored long receipt by stable UTF-8 byte offsets without dropping characters', async () => {
    const receipt = `HEAD🙂${'中🙂'.repeat(6_000)}TAIL`;
    const taskId = registerProcess(manager, immediateProcess(0, receipt), 'produce report', 'long report');
    await manager.wait(taskId);

    const restored = createTaskService(sessionDir);
    try {
      await restored.manager.loadFromDisk();
      const tool = new TaskOutputTool(restored.manager);
      let offset = 0;
      let combined = '';
      for (let index = 0; index < 40; index++) {
        const result = await executeTool(tool, toolContext(`page_${index}`, { task_id: taskId, offset, max_bytes: 2049 }));
        const text = outputString(result);
        expect(result.isError ?? false).toBe(false);
        expect(text).toContain('receipt_verification: verified');
        expect(text).toContain('full_output_available: true');
        expect(text).toContain(`output_path: ${persistence.taskOutputFile(taskId)}`);
        const page = text.split('\n[output]\n')[1]!;
        expect(page).not.toContain('\uFFFD');
        combined += page;
        const next = Number(/^next_offset: (\d+)$/m.exec(text)?.[1]);
        expect(next).toBeGreaterThan(offset);
        expect(Buffer.byteLength(page, 'utf-8')).toBeLessThanOrEqual(2049);
        if (text.includes('has_more: false')) {
          expect(next).toBe(Buffer.byteLength(receipt, 'utf-8'));
          break;
        }
        offset = next;
      }
      expect(combined).toBe(receipt);
      const middle = await executeTool(tool, toolContext('mid_codepoint', { task_id: taskId, offset: 5, max_bytes: 4 }));
      expect(outputString(middle)).toContain('offset: 8\nnext_offset: 11');
      expect(outputString(middle)).toContain('[output]\n中');
      const exhausted = await executeTool(tool, toolContext('past_end', { task_id: taskId, offset: 100_000, max_bytes: 4 }));
      expect(outputString(exhausted)).toContain('has_more: false');
      expect(outputString(exhausted)).toContain(`next_offset: ${Buffer.byteLength(receipt, 'utf-8')}`);
    } finally {
      await restored.ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not page an invalid or legacy-unverified terminal receipt as trusted full output', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'original content'), 'echo', 'tampered');
    await manager.wait(taskId);
    await persistence.appendTaskOutput(taskId, 'corruption');
    const legacyId = 'bash-legacy01';
    await persistence.writeTask({
      taskId: legacyId, kind: 'process', description: 'old task', status: 'completed', detached: true,
      startedAt: 1, endedAt: 2, command: 'echo old', pid: 1, exitCode: 0,
    });
    await persistence.appendTaskOutput(legacyId, 'old output');

    const restored = createTaskService(sessionDir);
    try {
      await restored.manager.loadFromDisk();
      expect(restored.manager.getTask(taskId)).toMatchObject({ receipt: undefined, receiptVerification: 'invalid' });
      expect(restored.manager.getTask(legacyId)).toMatchObject({ receiptVerification: 'legacy_unverified' });
      for (const [id, verification] of [[taskId, 'invalid'], [legacyId, 'legacy_unverified']] as const) {
        const result = await executeTool(new TaskOutputTool(restored.manager), toolContext(`untrusted_${id}`, { task_id: id, offset: 0 }));
        const text = outputString(result);
        expect(text).toContain(`receipt_verification: ${verification}`);
        expect(text).toContain('full_output_available: false');
        expect(text).toContain('[Full output unavailable; no verified page can be returned.]');
        expect(text).not.toContain('output_path:');
        expect(text).not.toContain('[output]\n');
      }
    } finally {
      await restored.ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('refuses a same-size log mutation after receipt verification without advertising the full log', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'original content'), 'echo', 'mutated');
    await manager.wait(taskId);
    expect((await manager.getOutputSnapshot(taskId, 0)).fullOutputAvailable).toBe(true);
    const before = await executeTool(new TaskListTool(manager), toolContext('list_before_change', { active_only: false }));
    expect(outputString(before)).toContain('receipt_verification: verified');
    writeFileSync(persistence.taskOutputFile(taskId), 'modified content');
    expect(Buffer.byteLength('modified content')).toBe(Buffer.byteLength('original content'));
    const after = await executeTool(new TaskListTool(manager), toolContext('list_after_change', { active_only: false }));
    expect(outputString(after)).toContain('receipt_verification: invalid');
    expect(outputString(after)).not.toContain('receipt_sha256:');
    expect(await manager.getTaskSnapshot(taskId)).toMatchObject({ receipt: undefined, receiptVerification: 'invalid' });
    const result = await executeTool(new TaskOutputTool(manager), toolContext('changed_after_commit', { task_id: taskId, offset: 0 }));
    const text = outputString(result);
    expect(text).toContain('full_output_available: false');
    expect(text).not.toContain('output_path:');
    expect(text).not.toContain('[output]\nmodified content');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('pages the verified fallback log despite a same-size orphan primary output', async () => {
    const taskId = 'bash-fallbac1';
    const storage = new FileStorageService(sessionDir);
    const legacy = new AgentTaskPersistence(join(sessionDir, TASK_TEST_SESSION_SCOPE), TASK_TEST_SESSION_SCOPE,
      new JsonAtomicDocumentStore(storage), storage);
    await legacy.commitTerminalTask({
      taskId, kind: 'process', command: 'echo', pid: 1, exitCode: 0,
      description: 'fallback receipt', status: 'completed', detached: true, startedAt: 1, endedAt: 2,
    }, 'fallback text');
    const restored = createTaskService(sessionDir);
    try {
      await restored.manager.loadFromDisk();
      expect((await restored.manager.getOutputSnapshot(taskId, 0)).outputPath)
        .toBe(join(sessionDir, TASK_TEST_SESSION_SCOPE, 'tasks', taskId, 'output.log'));
      const outputPath = join(sessionDir, TASK_TEST_AGENT_SCOPE, 'tasks', taskId, 'output.log');
      mkdirSync(join(sessionDir, TASK_TEST_AGENT_SCOPE, 'tasks', taskId), { recursive: true });
      writeFileSync(outputPath, 'primary decoy');
      expect(Buffer.byteLength('primary decoy')).toBe(Buffer.byteLength('fallback text'));
      const snapshot = await restored.manager.getOutputSnapshot(taskId, 100);
      expect(snapshot).toMatchObject({ preview: 'fallback text', fullOutputAvailable: true });
      expect(snapshot.outputPath).not.toBe(outputPath);
      expect((await restored.manager.getOutputPage(taskId, 0, 100))?.text).toBe('fallback text');
      const result = await executeTool(new TaskOutputTool(restored.manager), toolContext('fallback_page', { task_id: taskId, offset: 0 }));
      expect(outputString(result)).toContain('[output]\nfallback text');
      expect(outputString(result)).not.toContain('primary decoy');
    } finally {
      await restored.ctx.dispose();
    }
    await manager.loadFromDisk();
    await manager.reconcile();
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('getOutputSnapshot verifies an empty output log for a silent terminal task', async () => {
    const taskId = registerProcess(manager, immediateProcess(0), 'sleep 1', 'silent task');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    expect(snapshot.outputPath).toContain('output.log');
    expect(snapshot.outputSizeBytes).toBe(0);
    expect(snapshot.fullOutputAvailable).toBe(true);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('getOutputSnapshot returns an empty snapshot for unknown task ids', async () => {
    await expect(manager.getOutputSnapshot('bash-deadbeef', 1_000)).resolves.toEqual({
      outputSizeBytes: 0,
      previewBytes: 0,
      truncated: false,
      fullOutputAvailable: false,
      preview: '',
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('readOutput returns live ring-buffer content while task is in memory', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'live content\n'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'live content');

    expect(await manager.readOutput(taskId)).toContain('live content');
    await manager.wait(taskId);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('readOutput prefers disk over the live ring buffer when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'ring-only\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'ring-only');
    await persistence.appendTaskOutput(taskId, 'disk-only\n');

    expect(await manager.readOutput(taskId)).toContain('disk-only');
    await manager.wait(taskId);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('readOutput falls back to disk for ghost tasks', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'persisted line\n'),
      'echo',
      'demo',
    );
    await waitForOutput(manager, taskId, 'persisted line');
    await manager.wait(taskId);

    const freshFixture = createTaskService(sessionDir);
    const fresh = freshFixture.manager;
    try {
      await fresh.loadFromDisk();
      await fresh.reconcile();

      expect(await fresh.readOutput(taskId)).toContain('persisted line');
      await freshFixture.ctx.expectResumeMatches();
    } finally {
      await freshFixture.ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('TaskOutputTool reads persisted output for a ghost task loaded after restart', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'persisted output\n'),
      'echo persisted output',
      'persist output test',
    );
    await waitForOutput(manager, taskId, 'persisted output');
    await manager.wait(taskId);

    const freshFixture = createTaskService(sessionDir);
    const fresh = freshFixture.manager;
    try {
      await fresh.loadFromDisk();
      await fresh.reconcile();

      const result = await executeTool(
        new TaskOutputTool(fresh),
        toolContext('task_output_restored', { task_id: taskId }),
      );
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('status: completed');
      expect(output).toContain('output_path:');
      expect(output).toContain('persisted output');
      await freshFixture.ctx.expectResumeMatches();
    } finally {
      await freshFixture.ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('readOutput respects tail length', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'aaaaa-bbbbb-ccccc-ddddd'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'ddddd');

    expect(await manager.readOutput(taskId, 5)).toBe('ddddd');
    await manager.wait(taskId);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});
