import { PassThrough, Readable, type Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentGoalService } from '#/agent/goal/goal';
import type { GoalSnapshot } from '#/agent/goal/types';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskOutputPage,
  type AgentTaskTrackOptions,
  type AgentTaskWaitDelivery,
  type ForegroundTaskReleaseReason,
  type IAgentTaskEntry,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TaskListInputSchema } from '#/agent/tools/task/task-list/task-list';
import { TaskListTool } from '#/agent/tools/task/task-list/taskListTool';
import { TaskOutputInputSchema } from '#/agent/tools/task/task-output/task-output';
import { TaskOutputTool } from '#/agent/tools/task/task-output/taskOutputTool';
import { TaskStopInputSchema } from '#/agent/tools/task/task-stop/task-stop';
import { TaskStopTool } from '#/agent/tools/task/task-stop/taskStopTool';
import { ITaskWaitTool, TaskWaitInputSchema } from '#/agent/tools/task/task-wait/task-wait';
import { TaskWaitTool, startWaitProgress, taskWaitProgressUpdate } from '#/agent/tools/task/task-wait/taskWaitTool';
import { abortError } from '#/_base/utils/abort';
import type { ITaskHandle } from '#/app/task/task';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { compileToolArgsValidator, validateToolArgs } from '#/tool/args-validator';
import { ProcessTask, type ProcessTaskInfo } from '#/agent/tools/os/bash/process-task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { executeTool } from '../../../tools/fixtures/execute-tool';
import { recordingTelemetry, type TelemetryRecord } from '../../../app/telemetry/stubs';
import { stubFlag } from '../../../app/flag/stubs';
import { agentService, createTestAgent, permissionModeServices, telemetryServices } from '../../../harness';
import { runWillBeginStepHooks, stubLoopWithHooks } from '../../loop/stubs';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

const signal = new AbortController().signal;
const waitToolDisposables = new DisposableStore();

afterEach(() => {
  waitToolDisposables.clear();
});

function createWaitTool(
  tasks: IAgentTaskService,
  telemetry: ITelemetryService,
  flags: IFlagService,
  scope: IAgentScopeContext = makeAgentScopeContext({ agentId: 'main', agentScope: 'main' }),
  goal: GoalSnapshot | null = null,
): ITaskWaitTool {
  const ix = createServices(waitToolDisposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(IAgentTaskService, tasks);
      reg.defineInstance(ITelemetryService, telemetry);
      reg.defineInstance(IFlagService, flags);
      reg.defineInstance(IAgentScopeContext, scope);
      reg.definePartialInstance(IAgentGoalService, { getGoal: () => ({ goal }) });
      reg.define(ITaskWaitTool, TaskWaitTool);
    },
  });
  return ix.get(ITaskWaitTool);
}

function context<Input>(
  toolCallId: string,
  args: Input,
  executionSignal: AbortSignal = signal,
) {
  return { turnId: 0, toolCallId, args, signal: executionSignal };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  expect(typeof result.output).toBe('string');
  return result.output as string;
}

function processTask(
  overrides: Partial<ProcessTaskInfo> = {},
): ProcessTaskInfo {
  return {
    taskId: 'bash-abc12345',
    kind: 'process',
    command: 'sleep 60',
    description: 'test task',
    pid: 12345,
    exitCode: null,
    status: 'running',
    detached: true,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    ...overrides,
  };
}

function agentTaskInfo(
  overrides: Partial<SubagentTaskInfo> = {},
): SubagentTaskInfo {
  return {
    taskId: 'agent-abc12345',
    kind: 'agent',
    description: 'agent task',
    agentId: 'agent-child',
    profile: 'coder',
    status: 'completed',
    detached: true,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...overrides,
  };
}

function outputSnapshot(
  preview = '',
  overrides: Partial<AgentTaskOutputSnapshot> = {},
): AgentTaskOutputSnapshot {
  const size = Buffer.byteLength(preview);
  return {
    outputSizeBytes: size,
    previewBytes: size,
    truncated: false,
    fullOutputAvailable: false,
    preview,
    ...overrides,
  };
}

interface FakeTaskEntry {
  info: AgentTaskInfo;
  output: AgentTaskOutputSnapshot;
}

class FakeTaskService implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;

  readonly stopCalls: Array<{ taskId: string; reason: string | undefined }> = [];
  readonly suppressCalls: string[] = [];
  readonly waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];
  readonly waitDeliveries: Array<readonly AgentTaskWaitDelivery[]> = [];
  waitDelegate:
    | ((
        taskId: string,
        timeoutMs: number | undefined,
        signal: AbortSignal | undefined,
      ) => Promise<AgentTaskInfo | undefined>)
    | undefined;

  private readonly entries = new Map<string, FakeTaskEntry>();

  add(
    info: AgentTaskInfo,
    output: AgentTaskOutputSnapshot = outputSnapshot(),
  ): string {
    this.entries.set(info.taskId, { info, output });
    return info.taskId;
  }

  settle(taskId: string, status: AgentTaskStatus = 'completed'): void {
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      status,
      endedAt: entry.info.endedAt ?? 1_700_000_002_000,
    } as AgentTaskInfo;
  }

  track(_handle: ITaskHandle, _options: AgentTaskTrackOptions): IAgentTaskEntry {
    throw new Error('track is not implemented in FakeTaskService.');
  }

  registerTask(_task: AgentTask, _options?: RegisterAgentTaskOptions): string {
    throw new Error('registerTask is not implemented in FakeTaskService.');
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    return this.entries.get(taskId)?.info;
  }

  async getTaskSnapshot(taskId: string): Promise<AgentTaskInfo | undefined> {
    return this.getTask(taskId);
  }

  list(activeOnly = true, limit?: number, offset = 0): readonly AgentTaskInfo[] {
    const result: AgentTaskInfo[] = [];
    let skipped = 0;
    for (const entry of this.entries.values()) {
      const info = entry.info;
      if (activeOnly && TERMINAL_STATUSES.has(info.status)) continue;
      if (!activeOnly && TERMINAL_STATUSES.has(info.status) && info.detached === false) continue;
      if (skipped++ < offset) continue;
      result.push(info);
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }

  persistOutput(_taskId: string): void {}

  readonly failSnapshotTaskIds = new Set<string>();

  async getOutputSnapshot(
    taskId: string,
    _maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot> {
    if (this.failSnapshotTaskIds.has(taskId)) throw new Error('snapshot read failed');
    return this.entries.get(taskId)?.output ?? outputSnapshot();
  }

  async getOutputPage(_taskId: string, _offset: number, _maxBytes: number): Promise<AgentTaskOutputPage | undefined> {
    return undefined;
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const preview = this.entries.get(taskId)?.output.preview ?? '';
    if (tail === undefined) return preview;
    return preview.slice(-Math.max(0, Math.trunc(tail)));
  }

  async suppressTerminalNotification(taskId: string): Promise<void> {
    this.suppressCalls.push(taskId);
    const entry = this.entries.get(taskId);
    if (entry === undefined) return;
    entry.info = {
      ...entry.info,
      terminalNotificationSuppressed: true,
    } as AgentTaskInfo;
  }

  async suppressAllTerminalNotifications(): Promise<void> {
    const active = this.list(true).filter((info) => info.detached === true);
    await Promise.all(active.map((info) => this.suppressTerminalNotification(info.taskId)));
  }

  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void {
    this.waitDeliveries.push(tasks);
  }

  detach(taskId: string): AgentTaskInfo | undefined {
    const entry = this.entries.get(taskId);
    if (entry === undefined) return undefined;
    entry.info = {
      ...entry.info,
      detached: true,
    } as AgentTaskInfo;
    return entry.info;
  }

  async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    this.stopCalls.push({ taskId, reason });
    const entry = this.entries.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.info.status)) return entry.info;
    entry.info = {
      ...entry.info,
      status: 'killed',
      endedAt: 1_700_000_002_000,
      stopReason: reason,
      ...(entry.info.kind === 'process' ? { exitCode: 143 } : undefined),
    } as AgentTaskInfo;
    return entry.info;
  }

  async stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    return this.stop(taskId, 'Aborted by the user');
  }

  async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
    const stopped = await Promise.all(
      Array.from(this.entries.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return stopped.filter((info): info is AgentTaskInfo => info !== undefined);
  }

  async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
    return this.stopAll(reason);
  }

  async wait(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    this.waitCalls.push({ taskId, timeoutMs });
    if (this.waitDelegate !== undefined) {
      return this.waitDelegate(taskId, timeoutMs, signal);
    }
    return this.entries.get(taskId)?.info;
  }

  async waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined> {
    return this.entries.has(taskId) ? 'detached' : undefined;
  }
}

describe('TaskListTool', () => {
  it('has name and accepts the current schema', () => {
    const tool = new TaskListTool(new FakeTaskService());

    expect(tool.name).toBe('TaskList');
    expect(TaskListInputSchema.safeParse({}).success).toBe(true);
    expect(TaskListInputSchema.safeParse({ active_only: true, limit: 1 }).success).toBe(true);
    expect(TaskListInputSchema.safeParse({ active_only: true, limit: 0 }).success).toBe(false);
    expect(TaskListInputSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(TaskListInputSchema.safeParse({ offset: 1.5 }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        active_only: { type: 'boolean' },
        limit: { type: 'integer' },
        offset: { type: 'integer', minimum: 0 },
      },
    });
  });

  it('returns the empty active-task message', async () => {
    const result = await executeTool(
      new TaskListTool(new FakeTaskService()),
      context('task_list_empty', { active_only: true }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain(
      'active_background_tasks: 0\nNo background tasks found.',
    );
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('lists active process tasks', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-running1',
        command: 'sleep 60',
        description: 'running list',
      }),
    );

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_active', { active_only: true }),
    );
    const output = outputString(result);

    expect(output).toMatch(/^active_background_tasks:\s*1/);
    expect(output).toContain('kind: process');
    expect(output).toContain('task_id: bash-running1');
    expect(output).toContain('command: sleep 60');
    expect(output).toContain('description: running list');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it(
    'excludes terminal tasks from active_only=true and includes them when all tasks are listed',
    async () => {
      const tasks = new FakeTaskService();
      const taskId = tasks.add(
        processTask({
          taskId: 'bash-failed01',
          command: 'exit 7',
          description: 'exit code test',
          status: 'failed',
          endedAt: 1_700_000_001_000,
          exitCode: 7,
        }),
      );

      const active = await executeTool(
        new TaskListTool(tasks),
        context('task_list_active_terminal', { active_only: true }),
      );
      expect(outputString(active)).toContain(
        'active_background_tasks: 0\nNo background tasks found.',
      );

      const all = await executeTool(
        new TaskListTool(tasks),
        context('task_list_all_terminal', { active_only: false }),
      );
      const output = outputString(all);

      expect(output).toMatch(/^background_tasks:\s*1/);
      expect(output).toContain(taskId);
      expect(output).toContain('status: failed');
      expect(output).toContain('exit_code: 7');
    },
    PARALLEL_WORKER_CONTENTION_TIMEOUT_MS,
  );

  it('honours the limit parameter', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-first001', description: 'one' }));
    tasks.add(processTask({ taskId: 'bash-second01', description: 'two' }));

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_limit', { active_only: true, limit: 1 }),
    );
    const output = outputString(result);

    expect(output).toContain('active_background_tasks: 1');
    expect(output).toContain('bash-first001');
    expect(output).not.toContain('bash-second01');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('pages through more than 100 terminal tasks without repeating rows', async () => {
    const tasks = new FakeTaskService();
    const ids = Array.from({ length: 105 }, (_, index) => `bash-${String(index).padStart(8, '0')}`);
    for (const taskId of ids) tasks.add(processTask({ taskId, status: 'completed', endedAt: 2 }));
    const tool = new TaskListTool(tasks);
    let offset = 0;
    const seen: string[] = [];
    for (let page = 0; page < 6; page++) {
      const result = await executeTool(tool, context(`list_page_${page}`, { active_only: false, limit: 20, offset }));
      const text = outputString(result);
      seen.push(...[...text.matchAll(/^task_id: (.+)$/gm)].map((match) => match[1]!));
      if (page < 5) {
        expect(text).toContain('has_more: true');
        offset = Number(/next_offset: (\d+)/.exec(text)?.[1]);
      } else {
        expect(text).toContain('has_more: false');
        expect(text).not.toContain('next_offset:');
      }
    }
    expect(seen).toEqual(ids);
    const exhausted = await executeTool(tool, context('list_past_end', { active_only: false, offset: 1000 }));
    expect(outputString(exhausted)).toContain('background_tasks: 0\nNo background tasks found.\nhas_more: false');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('exposes verified subagent receipt metadata but not a trusted path for invalid or legacy receipts', async () => {
    const tasks = new FakeTaskService();
    tasks.add(agentTaskInfo({
      receipt: { schemaVersion: 1, path: 'tasks/agent-abc12345/output.log', mediaType: 'text/plain; charset=utf-8',
        bytes: 0, sha256: 'a'.repeat(64), contentState: 'unavailable', committedAt: '2026-01-01T00:00:00.000Z' },
      receiptVerification: 'verified',
    }));
    tasks.add(agentTaskInfo({ taskId: 'agent-legacy01', receiptVerification: 'legacy_unverified' }));
    tasks.add(agentTaskInfo({ taskId: 'agent-invalid1', receiptVerification: 'invalid' }));
    const result = await executeTool(new TaskListTool(tasks), context('receipt_list', { active_only: false }));
    const [verified, legacy, invalid] = outputString(result).split('\n---\n');
    expect(verified).toContain('receipt_verification: verified');
    expect(verified).toContain('receipt_path: tasks/agent-abc12345/output.log');
    expect(verified).toContain('receipt_content_state: unavailable');
    expect(verified).not.toContain('[object Object]');
    expect(legacy).toContain('receipt_verification: legacy_unverified');
    expect(legacy).not.toContain('receipt_path:');
    expect(invalid).toContain('receipt_verification: invalid');
    expect(invalid).not.toContain('receipt_path:');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('includes stop_reason for stopped tasks in all-tasks view', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-stopped1',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: 'superseded by newer task',
      }),
    );

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_stop_reason', { active_only: false }),
    );

    expect(outputString(result)).toContain('stop_reason: superseded by newer task');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not wait when listing a running task', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-running2', description: 'running task' }));
    const wait = vi.spyOn(tasks, 'wait');

    const result = await executeTool(
      new TaskListTool(tasks),
      context('task_list_no_wait', { active_only: true }),
    );

    expect(outputString(result)).toContain('running task');
    expect(wait).not.toHaveBeenCalled();
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});

describe('TaskOutputTool', () => {
  it('describes non-blocking snapshots without redirecting to foreground waiting', async () => {
    const ctx = createTestAgent();
    try {
      const tool = ctx.get(IAgentToolRegistryService).resolve('TaskOutput');
      expect(tool).toBeDefined();
      expect(tool!.description).toContain('Inspect a running or completed background task without waiting');
      expect(tool!.description).toContain('Use TaskList first if you do not know its id');
      expect(tool!.description).toContain('Prefer completion notifications; do not poll merely to hold a turn open');
      expect(tool!.description).toContain('A subagent must resolve its own outstanding dependencies before returning a final receipt');
      expect(tool!.description).not.toContain('run that task in the foreground instead');
    } finally {
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('has name and accepts the current schema', () => {
    const tool = new TaskOutputTool(new FakeTaskService());

    expect(tool.name).toBe('TaskOutput');
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1', offset: -1 }).success).toBe(false);
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1', max_bytes: 3 }).success).toBe(false);
    expect(TaskOutputInputSchema.safeParse({ task_id: 'bash-1', max_bytes: 32 * 1024 + 1 }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        max_bytes: { type: 'integer', minimum: 4, maximum: 32768 },
      },
    });
    expect(JSON.stringify(tool.parameters)).not.toContain('"block"');
    expect(JSON.stringify(tool.parameters)).not.toContain('"timeout"');
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskOutputTool(new FakeTaskService()),
      context('task_output_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns live output when no persisted log is available', async () => {
    const tasks = new FakeTaskService();
    const payload = 'DETACHED-PAYLOAD-LINE\n';
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-live0001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot(payload),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_live', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(result).toMatchObject({ isError: false });
    expect(output).toContain('retrieval_status: success');
    expect(output).toContain('status: completed');
    expect(output).toContain('[output]\nDETACHED-PAYLOAD-LINE');
    expect(output).toContain(`output_size_bytes: ${Buffer.byteLength(payload).toString()}`);
    expect(output).not.toContain('output_path:');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns persisted output path and guidance when a log is available', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-persist1',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('STDOUT-PAYLOAD-LINE\n', {
        outputPath: '/tmp/session/tasks/bash-persist1/output.log',
        fullOutputAvailable: true,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_persisted', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: completed');
    expect(output).toContain('output_path: /tmp/session/tasks/bash-persist1/output.log');
    expect(output).toContain('full_output_available: true');
    expect(output).toContain('full_output_tool: Read');
    expect(output).not.toContain('full_output_hint:');
    expect(output).toContain('[output]\nSTDOUT-PAYLOAD-LINE');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns agent metadata and final summary without process fields', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(agentTaskInfo(), outputSnapshot('SUBAGENT-FINAL-SUMMARY\n'));

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_agent', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('kind: agent');
    expect(output).toContain('agent_id: agent-child');
    expect(output).toContain('profile: coder');
    expect(output).toContain('[output]\nSUBAGENT-FINAL-SUMMARY');
    expect(output).not.toMatch(/^pid:/m);
    expect(output).not.toMatch(/^command:/m);
    expect(output).not.toMatch(/^exit_code:/m);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns not_ready for non-blocking running tasks', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-running3' }));

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_not_ready', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('retrieval_status: not_ready');
    expect(output).toContain('status: running');
    expect(output).not.toContain('next_step');
    expect(tasks.waitCalls).toEqual([]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('rejects stale block/timeout args at the validator instead of waiting', () => {
    const validator = compileToolArgsValidator(new TaskOutputTool(new FakeTaskService()).parameters);

    expect(validateToolArgs(validator, { task_id: 'bash-1' })).toBeNull();
    const stale = validateToolArgs(validator, { task_id: 'bash-1', block: true, timeout: 1 });
    expect(stale).toContain("must NOT have additional property 'block'");
    expect(stale).toContain("must NOT have additional property 'timeout'");
  });

  it('surfaces timeout terminal metadata', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-timeout1',
        status: 'timed_out',
        endedAt: 1_700_000_001_000,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_timed_out', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: timed_out');
    expect(output).not.toContain('stop_reason:');
    expect(output).toContain('terminal_reason: timed_out');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('surfaces stopped terminal metadata', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-stopped2',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: 'operator cancelled',
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_stopped', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('status: killed');
    expect(output).toContain('stop_reason: operator cancelled');
    expect(output).toContain('terminal_reason: stopped');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not advertise output_path when the persisted log file does not exist', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-silent01',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_silent', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).not.toContain('output_path:');
    expect(output).toContain('output_size_bytes: 0');
    expect(output).toContain('full_output_available: false');
    expect(output).toContain('[output]\n[no output available]');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['output', 'wait'] as const)('only adds retrieval guidance for an available truncated log via %s', async (kind) => {
    for (const truncated of [false, true]) {
      for (const fullOutputAvailable of [false, true]) {
        const tasks = new FakeTaskService();
        const taskId = tasks.add(processTask({ status: 'completed', exitCode: 0 }), outputSnapshot('tail', {
          truncated,
          fullOutputAvailable,
          outputPath: fullOutputAvailable ? '/tmp/task/output.log' : undefined,
        }));
        const result = kind === 'output'
          ? await executeTool(new TaskOutputTool(tasks), context('retrieval_hint', { task_id: taskId }))
          : await executeTool(createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)), context('retrieval_hint', { task_id: taskId, timeout: 1 }));
        const output = outputString(result);
        expect(output.includes('full_output_hint:')).toBe(truncated && fullOutputAvailable);
        expect(output).not.toContain('lines per page');
        if (truncated && fullOutputAvailable) expect(output).toContain('Truncated tail; Read output_path for the full log.');
      }
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('renders a truncation banner and tail preview when the snapshot is truncated', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-trunc001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('TAIL-MARKER\n', {
        outputPath: '/tmp/session/tasks/bash-trunc001/output.log',
        outputSizeBytes: 200 * 1024,
        previewBytes: 32 * 1024,
        truncated: true,
        fullOutputAvailable: true,
      }),
    );

    const result = await executeTool(
      new TaskOutputTool(tasks),
      context('task_output_truncated', { task_id: taskId }),
    );
    const output = outputString(result);

    expect(output).toContain('output_truncated: true');
    expect(output).toContain('output_size_bytes: 204800');
    expect(output).toContain('full_output_available: true');
    expect(output).toContain('full_output_tool: Read');
    expect(output).toContain(
      '[Truncated. Full output: /tmp/session/tasks/bash-trunc001/output.log]',
    );
    expect(output).toContain('TAIL-MARKER');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});

describe('TaskStopTool', () => {
  const noLiveAgents = { list: () => [] } as unknown as IAgentLifecycleService;
  it('has name and accepts the current schema', () => {
    const tool = new TaskStopTool(new FakeTaskService(), noLiveAgents);

    expect(tool.name).toBe('TaskStop');
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({ task_id: 'bash-1', reason: '' }).success).toBe(true);
    expect(TaskStopInputSchema.safeParse({}).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
      },
    });
  });

  it('returns error for unknown task', async () => {
    const result = await executeTool(
      new TaskStopTool(new FakeTaskService(), noLiveAgents),
      context('task_stop_unknown', { task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('stops a running task, records the reason, and suppresses terminal notification', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-stop0001' }));

    const result = await executeTool(
      new TaskStopTool(tasks, noLiveAgents),
      context('task_stop_running', { task_id: taskId, reason: 'custom stop reason' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('task_id: bash-stop0001');
    expect(output).toContain('status: killed');
    expect(output).toContain('reason: custom stop reason');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'custom stop reason' }]);
    expect(tasks.suppressCalls).toEqual([taskId]);
    expect(tasks.getTask(taskId)).toMatchObject({
      status: 'killed',
      stopReason: 'custom stop reason',
      terminalNotificationSuppressed: true,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each([
    { label: 'an empty-string reason', reason: '' },
    { label: 'a whitespace-only reason', reason: '   ' },
    { label: 'an omitted reason', reason: undefined as string | undefined },
  ])('falls back to default reason given $label', async ({ reason }) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(processTask({ taskId: 'bash-default1' }));

    const result = await executeTool(
      new TaskStopTool(tasks, noLiveAgents),
      context('task_stop_default_reason', { task_id: taskId, reason }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result)).toContain('reason: Stopped by TaskStop');
    expect(tasks.stopCalls).toEqual([{ taskId, reason: 'Stopped by TaskStop' }]);
    expect(tasks.getTask(taskId)?.stopReason).toBe('Stopped by TaskStop');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns info when task is already terminal without suppressing notification', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-done0001',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );

    const result = await executeTool(
      new TaskStopTool(tasks, noLiveAgents),
      context('task_stop_terminal', { task_id: taskId }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')).toEqual([
      `task_id: ${taskId}`,
      'status: completed',
      'reason: Task already in terminal state',
    ]);
    expect(tasks.suppressCalls).toEqual([]);
    expect(tasks.getTask(taskId)?.terminalNotificationSuppressed).not.toBe(true);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('falls back to the placeholder when a terminal task has a blank stored reason', async () => {
    const tasks = new FakeTaskService();
    tasks.add(
      processTask({
        taskId: 'bash-blank001',
        status: 'killed',
        endedAt: 1_700_000_001_000,
        stopReason: '',
      }),
    );

    const result = await executeTool(
      new TaskStopTool(tasks, noLiveAgents),
      context('task_stop_blank_stored_reason', { task_id: 'bash-blank001' }),
    );

    expect(result.isError ?? false).toBe(false);
    expect(outputString(result).trim().split('\n')[2]).toBe(
      'reason: Task already in terminal state',
    );
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('reports other running subagents after stopping an agent task', async () => {
    const tasks = new FakeTaskService();
    const stoppedId = tasks.add(agentTaskInfo({
      status: 'running', endedAt: null, ownerAgentId: 'main',
    }));
    tasks.add(agentTaskInfo({
      taskId: 'agent-other-task', agentId: 'agent-other', collaborationTaskName: 'other',
      status: 'running', endedAt: null, ownerAgentId: 'main',
    }));

    const result = await executeTool(
      new TaskStopTool(tasks, noLiveAgents),
      context('task_stop_agent', { task_id: stoppedId }),
    );

    expect(outputString(result).trimEnd()).toMatch(/reason: Stopped by TaskStop\n(?:1 subagent still running: other|还有 1 个 subagent 正在运行：other)$/);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('omits a running-agent status when stopping the last agent task', async () => {
    const tasks = new FakeTaskService();
    const stoppedId = tasks.add(agentTaskInfo({
      status: 'running', endedAt: null, ownerAgentId: 'main',
    }));

    const result = await executeTool(
      new TaskStopTool(tasks, noLiveAgents),
      context('task_stop_last_agent', { task_id: stoppedId }),
    );

    expect(outputString(result).trimEnd().split('\n')).toEqual([
      `task_id: ${stoppedId}`,
      'status: killed',
      'reason: Stopped by TaskStop',
    ]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});

describe('TaskWait tool', () => {
  it('reserves synchronous waiting while distinguishing root turns from subagent completion', async () => {
    const ctx = createTestAgent();
    try {
      const tool = ctx.get(ITaskWaitTool);
      expect(tool.description).toContain('concrete same-turn dependency (e.g. verifying your own build or deletion)');
      expect(tool.description).toContain('An interactive main agent outside active goal mode must not wait merely to collect automatically notifying subagent reports');
      expect(tool.description).toContain('requires `sync_wait=true`, a specific `task_id`, and a concrete `sync_reason`');
      expect(tool.description).toContain('Do other useful work or end the turn with a brief pending status, then continue on notification');
      expect(tool.description).toContain("this neither cancels the work nor completes the user's task");
      expect(tool.description).toContain('Do not poll TaskWait/TaskOutput/TaskList/AgentList to hold that turn open');
      expect(tool.description).toContain('A timeout leaves tasks running; reassess rather than automatically repeat');
      expect(tool.description).toContain('Terminal tasks reported here do not also send an automatic completion notification');
      expect(tool.description).toContain('Subagents must instead resolve their own dependencies before returning a final receipt');
      expect(TaskWaitInputSchema.shape.sync_wait.description).toContain('not needed for subagents');
      expect(TaskWaitInputSchema.shape.sync_reason.description).toContain('main-to-agent sync_wait exception');
      expect(tool.description).not.toContain('To wait longer, call TaskWait again');
      expect(TaskWaitInputSchema.shape.timeout.description).toContain('explicit same-turn wait');
      expect(TaskWaitInputSchema.shape.timeout.description).toContain('do not automatically repeat');
    } finally {
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  function waitTelemetry(): { records: TelemetryRecord[]; telemetry: ReturnType<typeof recordingTelemetry> } {
    const records: TelemetryRecord[] = [];
    return { records, telemetry: recordingTelemetry(records) };
  }

  function lastEvent(records: TelemetryRecord[]): TelemetryRecord | undefined {
    return records.findLast((record) => record.event === 'task_wait_completed');
  }

  it('has name and accepts the current schema', () => {
    const tool = createWaitTool(new FakeTaskService(), recordingTelemetry([]), stubFlag(true));

    expect(tool.name).toBe('TaskWait');
    expect(TaskWaitInputSchema.safeParse({ timeout: 60 }).success).toBe(true);
    expect(TaskWaitInputSchema.safeParse({ timeout: 60, task_id: 'bash-1' }).success).toBe(true);
    expect(TaskWaitInputSchema.safeParse({ timeout: 600 }).success).toBe(true);
    expect(TaskWaitInputSchema.safeParse({}).success).toBe(false);
    expect(TaskWaitInputSchema.safeParse({ timeout: 0 }).success).toBe(false);
    expect(TaskWaitInputSchema.safeParse({ timeout: -5 }).success).toBe(false);
    expect(TaskWaitInputSchema.safeParse({ timeout: 601 }).success).toBe(true);
    expect(TaskWaitInputSchema.safeParse({ timeout: 86_400 }).success).toBe(true);
    for (const timeout of [86_401, 1.5, NaN, Infinity, -Infinity, '60', null]) {
      expect(TaskWaitInputSchema.safeParse({ timeout }).success).toBe(false);
    }
    for (const exception of [
      { sync_wait: false },
      { sync_wait: true },
      { sync_reason: 'User requires this response to contain the result' },
      { task_id: 'agent-1', sync_wait: true, sync_reason: 'Host consumes only this final response' },
    ]) {
      expect(TaskWaitInputSchema.safeParse({ timeout: 60, ...exception }).success).toBe(true);
    }
    expect(TaskWaitInputSchema.safeParse({ timeout: 60, sync_wait: 'true' }).success).toBe(false);
    expect(TaskWaitInputSchema.safeParse({ timeout: 60, sync_reason: 1 }).success).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['timeout'],
      properties: {
        timeout: { type: 'integer', maximum: 86_400 },
        task_id: { type: 'string' },
        sync_wait: { type: 'boolean' },
        sync_reason: { type: 'string' },
      },
    });
  });

  it.each([
    {},
    { sync_wait: false, sync_reason: 'Host consumes only this final response' },
    { sync_wait: true },
    { sync_wait: true, sync_reason: '' },
    { sync_wait: true, sync_reason: ' \n\t ' },
    { sync_reason: 'I am in goal mode' },
  ])('rejects a main wait on a running agent without a complete exception: %j', async (exception) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(agentTaskInfo({ taskId: 'bash-not-a-process', status: 'running' }));
    const onUpdate = vi.fn();
    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
      { ...context('wait_guard', { timeout: 86_400, task_id: taskId, ...exception }), onUpdate },
    );
    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Do independent work or end the turn');
    expect(outputString(result)).toContain('continue on notification');
    expect(tasks.waitCalls).toEqual([]);
    expect(tasks.waitDeliveries).toEqual([]);
    expect(tasks.suppressCalls).toEqual([]);
    expect(tasks.stopCalls).toEqual([]);
    expect(tasks.getTask(taskId)?.status).toBe('running');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('allows the explicit main-to-agent synchronous exception', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(agentTaskInfo({ status: 'running' }));
    tasks.waitDelegate = async (id) => {
      tasks.settle(id);
      return tasks.getTask(id);
    };
    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_sync', {
        timeout: 86_400, task_id: taskId, sync_wait: true,
        sync_reason: 'The host consumes only this final response and needs the result in it',
      }),
    );
    expect(result.isError).toBe(false);
    expect(tasks.waitCalls).toEqual([{ taskId, timeoutMs: 86_400_000 }]);
    expect(tasks.waitDeliveries).toEqual([[{ taskId, status: 'completed' }]]);
  });

  it.each([false, true])('rejects mixed wait-any without silently filtering agents (sync_wait=%s)', async (sync_wait) => {
    const tasks = new FakeTaskService();
    tasks.add(processTask());
    tasks.add(agentTaskInfo({ status: 'running' }));
    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_mixed', { timeout: 86_400, sync_wait, sync_reason: 'Host consumes this response' }),
    );
    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Specify a process task_id');
    expect(outputString(result)).toContain('A wait-any call cannot use this exception');
    expect(tasks.waitCalls).toEqual([]);
    expect(tasks.waitDeliveries).toEqual([]);
  });

  it.each(['completed', 'failed', 'killed', 'timed_out', 'lost'] as const)('returns a terminal agent (%s) without the main guard and preserves delivery deduplication', async (status) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(agentTaskInfo({ status }), outputSnapshot('FINAL RECEIPT'));
    tasks.add(agentTaskInfo({ taskId: 'other-running-agent', status: 'running' }));
    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_terminal_agent', { timeout: 86_400, task_id: taskId }),
    );
    expect(result.isError).toBe(false);
    expect(outputString(result)).toContain('FINAL RECEIPT');
    expect(tasks.waitDeliveries).toEqual([[{ taskId, status }]]);
  });

  it.each([
    { agentId: 'main', parentAgentId: undefined, kind: 'process' },
    { agentId: 'worker', parentAgentId: 'main', kind: 'process' },
    { agentId: 'worker', parentAgentId: 'main', kind: 'agent' },
    { agentId: 'main', parentAgentId: 'parent', kind: 'agent' },
  ] as const)('allows owned $kind waits using runtime binding ($agentId, parent=$parentAgentId)', async ({ agentId, parentAgentId, kind }) => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(kind === 'agent'
      ? agentTaskInfo({ status: 'running' }) : processTask({ taskId: 'agent-not-an-agent' }));
    tasks.waitDelegate = async (id) => {
      tasks.settle(id);
      return tasks.getTask(id);
    };
    const scope = makeAgentScopeContext({ agentId, parentAgentId, agentScope: 'test' });
    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true), scope),
      context('wait_binding', { timeout: 86_400, task_id: taskId }),
    );
    expect(result.isError).toBe(false);
    expect(tasks.waitCalls).toHaveLength(1);
  });

  it('allows a subagent mixed wait-any without main exception parameters', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(agentTaskInfo({ status: 'running' }));
    tasks.add(processTask());
    tasks.waitDelegate = async (id) => {
      tasks.settle(id);
      return tasks.getTask(id);
    };
    const scope = makeAgentScopeContext({ agentId: 'child', parentAgentId: 'main', agentScope: 'child' });
    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true), scope),
      context('wait_sub_any', { timeout: 86_400 }),
    );
    expect(result.isError).toBe(false);
    expect(tasks.waitCalls).toHaveLength(2);
    expect(outputString(result)).toContain(taskId);
  });

  it('returns error and tracks task_not_found for an unknown task_id', async () => {
    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      createWaitTool(new FakeTaskService(), telemetry, stubFlag(true)),
      context('wait_unknown', { timeout: 10, task_id: 'bash-unknown0' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('Task not found: bash-unknown0');
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'task_not_found',
      timeout_ms: 10_000,
      has_task_id: true,
      extra_completed_count: 0,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns immediately without waiting when no background tasks are running', async () => {
    const tasks = new FakeTaskService();
    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_none', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: no_tasks');
    expect(output).toContain('No background tasks are running');
    expect(tasks.waitCalls).toEqual([]);
    expect(tasks.waitDeliveries).toEqual([]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns a finished task immediately and marks it delivered via wait', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-done0002',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
      outputSnapshot('DONE-OUTPUT\n'),
    );

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      createWaitTool(tasks, telemetry, stubFlag(true)),
      context('wait_done', { timeout: 10, task_id: taskId }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('status: completed');
    expect(output).toContain('[finished]');
    expect(output).toContain('[output]\nDONE-OUTPUT');
    expect(tasks.waitDeliveries).toEqual([[{ taskId, status: 'completed' }]]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      has_task_id: true,
      extra_completed_count: 0,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('reports tasks that finished during the wait and marks all of them delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-wait001', description: 'main wait' }), outputSnapshot('WAITED-OUT\n'));
    tasks.add(processTask({ taskId: 'bash-extra001', description: 'side task' }));
    tasks.waitDelegate = async (taskId) => {
      tasks.settle('bash-wait001');
      tasks.settle('bash-extra001', 'failed');
      return tasks.getTask(taskId);
    };

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      createWaitTool(tasks, telemetry, stubFlag(true)),
      context('wait_extras', { timeout: 10, task_id: 'bash-wait001' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('[completed_during_wait]');
    expect(output).toContain('task_id: bash-extra001');
    expect(output).toContain('status: failed');
    expect(tasks.waitDeliveries).toEqual([
      [
        { taskId: 'bash-wait001', status: 'completed' },
        { taskId: 'bash-extra001', status: 'failed' },
      ],
    ]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      extra_completed_count: 1,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('waits for any running task when task_id is omitted', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-a1', description: 'task A' }), outputSnapshot('A-OUT\n'));
    tasks.add(processTask({ taskId: 'bash-b1', description: 'task B' }));
    tasks.waitDelegate = async (taskId) => {
      if (taskId === 'bash-a1') tasks.settle('bash-a1');
      return tasks.getTask(taskId);
    };

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      createWaitTool(tasks, telemetry, stubFlag(true)),
      context('wait_any', { timeout: 10 }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: completed');
    expect(output).toContain('task_id: bash-a1');
    expect(output).toContain('[output]\nA-OUT');
    expect(output).toContain('[still_running]');
    expect(output).toContain('task_id: bash-b1');
    expect(tasks.waitCalls).toHaveLength(2);
    expect(tasks.waitDeliveries).toEqual([[{ taskId: 'bash-a1', status: 'completed' }]]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'completed',
      has_task_id: false,
      extra_completed_count: 0,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns the still-running list on timeout without marking anything delivered', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-running9', description: 'slow task' }));

    const { records, telemetry } = waitTelemetry();
    const result = await executeTool(
      createWaitTool(tasks, telemetry, stubFlag(true)),
      context('wait_timeout', { timeout: 10, task_id: 'bash-running9' }),
    );
    const output = outputString(result);

    expect(result.isError ?? false).toBe(false);
    expect(output).toContain('wait_status: timed_out');
    expect(output).toContain('The wait timed out, not the task.');
    expect(output).toContain('still running');
    expect(output).not.toContain('when root is idle');
    expect(output).not.toContain('Call TaskWait again to keep waiting');
    expect(output).toContain('[still_running]');
    expect(output).toContain('bash-running9');
    expect(tasks.waitDeliveries).toEqual([]);
    expect(lastEvent(records)?.properties).toMatchObject({
      outcome: 'timed_out',
      timeout_ms: 10_000,
      has_task_id: true,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('propagates an abort of the execution signal and tracks the aborted outcome', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-abort01' }));
    tasks.waitDelegate = (_taskId, _timeoutMs, waitSignal) =>
      new Promise<never>((_resolve, reject) => {
        waitSignal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });

    const { records, telemetry } = waitTelemetry();
    const controller = new AbortController();
    const pending = executeTool(
      createWaitTool(tasks, telemetry, stubFlag(true)),
      context('wait_abort', { timeout: 600, task_id: 'bash-abort01' }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.waitDeliveries).toEqual([]);
    expect(lastEvent(records)?.properties).toMatchObject({ outcome: 'aborted' });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('propagates an abort from a general wait and leaves tasks running', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-abort02' }));
    tasks.add(processTask({ taskId: 'bash-abort03' }));
    tasks.waitDelegate = (_taskId, _timeoutMs, waitSignal) =>
      new Promise<never>((_resolve, reject) => {
        waitSignal?.addEventListener('abort', () => reject(abortError()), { once: true });
      });

    const controller = new AbortController();
    const pending = executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_abort_any', { timeout: 600 }, controller.signal),
    );
    controller.abort();

    await expect(pending).rejects.toThrow('Aborted');
    expect(tasks.getTask('bash-abort02')?.status).toBe('running');
    expect(tasks.getTask('bash-abort03')?.status).toBe('running');
    expect(tasks.waitDeliveries).toEqual([]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not mark tasks delivered when formatting the result fails', async () => {
    const tasks = new FakeTaskService();
    const taskId = tasks.add(
      processTask({
        taskId: 'bash-fmtfail1',
        status: 'completed',
        endedAt: 1_700_000_001_000,
        exitCode: 0,
      }),
    );
    tasks.failSnapshotTaskIds.add(taskId);

    await expect(
      executeTool(
        createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
        context('wait_fmt_fail', { timeout: 10, task_id: taskId }),
      ),
    ).rejects.toThrow('snapshot read failed');
    expect(tasks.waitDeliveries).toEqual([]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('aborts the losing waits once the race resolves', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-win0001' }));
    tasks.add(processTask({ taskId: 'bash-lose001' }));
    const signals = new Map<string, AbortSignal>();
    tasks.waitDelegate = (taskId, _timeoutMs, waitSignal) => {
      signals.set(taskId, waitSignal!);
      if (taskId === 'bash-win0001') {
        tasks.settle('bash-win0001');
        return Promise.resolve(tasks.getTask(taskId));
      }
      return new Promise<AgentTaskInfo | undefined>(() => {});
    };

    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(true)),
      context('wait_losers', { timeout: 600 }),
    );

    expect(outputString(result)).toContain('wait_status: completed');
    expect(signals.get('bash-lose001')?.aborted).toBe(true);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('rejects execution when the task_wait flag is off', async () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-flagoff1' }));

    const result = await executeTool(
      createWaitTool(tasks, recordingTelemetry([]), stubFlag(false)),
      context('wait_flag_off', { timeout: 10, task_id: 'bash-flagoff1' }),
    );

    expect(result.isError).toBe(true);
    expect(outputString(result)).toContain('task_wait experimental flag is off');
    expect(tasks.waitCalls).toEqual([]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('emits status progress updates while the wait is pending', async () => {
    const update = taskWaitProgressUpdate({ timeout: 600 }, 2, 1_000, 31_000);
    expect(update).toMatchObject({
      kind: 'status',
      replace: true,
      text: 'Waiting 30s / 10m · 2 background tasks still running',
    });
    expect(taskWaitProgressUpdate({ timeout: 600 }, 1, 1_000, 31_000).text).toContain(
      '1 background task still running',
    );
    expect(taskWaitProgressUpdate({ timeout: 600 }, 0, 1_000, 31_000).text).toContain(
      '0 background tasks still running',
    );
    expect(taskWaitProgressUpdate({ timeout: 600 }, 1, 1_000, 76_000).text).toContain(
      'Waiting 1m 15s / 10m',
    );
    expect(taskWaitProgressUpdate({ timeout: 180 }, 1, 1_000, 61_000).text).toContain(
      'Waiting 1m / 3m',
    );
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('limits a 24-hour wait to first-minute seconds and subsequent minute progress updates', () => {
    vi.useFakeTimers();
    const tasks = new FakeTaskService();
    tasks.add(processTask());
    const onUpdate = vi.fn();
    const progress = startWaitProgress({ timeout: 86_400 }, tasks, onUpdate, Date.now());
    try {
      expect(onUpdate).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(onUpdate).toHaveBeenCalledTimes(61);
      vi.advanceTimersByTime(59_999);
      expect(onUpdate).toHaveBeenCalledTimes(61);
      vi.advanceTimersByTime(1);
      expect(onUpdate).toHaveBeenCalledTimes(62);
      vi.advanceTimersByTime(86_400_000 - 120_000);
      expect(onUpdate).toHaveBeenCalledTimes(1_500);
      expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Waiting 24h / 24h · 1 background task still running' }));
      progress.stop();
      vi.advanceTimersByTime(60_000);
      expect(onUpdate).toHaveBeenCalledTimes(1_500);
    } finally {
      progress.stop();
      vi.useRealTimers();
    }
  });

  it('routes the composed progress update through onUpdate on a manual tick', () => {
    const tasks = new FakeTaskService();
    tasks.add(processTask({ taskId: 'bash-prog002' }));
    const onUpdate = vi.fn();

    const progress = startWaitProgress({ timeout: 600 }, tasks, onUpdate, Date.now() - 30_000);
    progress.tick();
    progress.stop();

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'status',
        replace: true,
        text: expect.stringMatching(/^Waiting 3\ds \/ 10m · 1 background task still running$/),
      }),
    );
  });
});

describe('TaskWait tool (harness)', () => {
  function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
    return {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from(stdoutText ? [stdoutText] : []),
      stderr: Readable.from([]),
      pid: 10000 + exitCode,
      exitCode,
      wait: vi.fn().mockResolvedValue(exitCode) as IHostProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    };
  }

  function controllableProcess(): {
    proc: IHostProcess;
    pushOutput: (text: string) => void;
    resolveWait: (code: number) => void;
  } {
    const stdout = new PassThrough();
    let resolveWait!: (code: number) => void;
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr: Readable.from([]),
      pid: 10099,
      exitCode: null,
      wait: vi.fn(() => waitPromise) as IHostProcess['wait'],
      kill: vi.fn(async () => {
        stdout.destroy();
        resolveWait(143);
      }) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    } as IHostProcess;
    return {
      proc,
      pushOutput: (text) => {
        stdout.write(text);
      },
      resolveWait: (code) => {
        stdout.end();
        resolveWait(code);
      },
    };
  }

  async function waitForTerminal(tasks: IAgentTaskService, taskId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const info = await tasks.wait(taskId, 5);
      if (info !== undefined && TERMINAL_STATUSES.has(info.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for task to terminate: ${taskId}`);
  }

  it.each(['specific', 'any'] as const)(
    'returns interrupted instead of a timeout when a steer arrives during a %s wait',
    async (target) => {
      const records: TelemetryRecord[] = [];
      const ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));
      const slow = controllableProcess();
      try {
        const tasks = ctx.get(IAgentTaskService);
        const tool = ctx.get(IAgentToolRegistryService).resolve('TaskWait');
        expect(tool).toBeDefined();
        const taskId = tasks.registerTask(new ProcessTask(slow.proc, 'sleep 60', 'background work'));

        const steered = new AbortController();
        const pending = executeTool(tool!, {
          ...context('wait_steered', {
            timeout: 600,
            task_id: target === 'specific' ? taskId : undefined,
          }),
          steerSignal: steered.signal,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        steered.abort(abortError('Steered by new input'));

        const result = await pending;
        expect(result.isError).toBeFalsy();
        const output = outputString(result);
        expect(output).toContain('wait_status: interrupted');
        expect(output).not.toContain('wait_status: aborted');
        expect(output).toContain('reason: steer');
        expect(output).toContain('[still_running]');
        expect(tasks.getTask(taskId)?.status).toBe('running');
        expect(slow.proc.kill).not.toHaveBeenCalled();
        expect(
          records.findLast((record) => record.event === 'task_wait_completed')?.properties,
        ).toMatchObject({ outcome: 'interrupted' });
      } finally {
        slow.resolveWait(0);
        await ctx.dispose();
      }
    },
    PARALLEL_WORKER_CONTENTION_TIMEOUT_MS,
  );

  it('interrupts a multi-task waitAny fan-out when the production steer reason aborts it', async () => {
    const ctx = createTestAgent();
    const first = controllableProcess();
    const second = controllableProcess();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('TaskWait');
      const firstId = tasks.registerTask(new ProcessTask(first.proc, 'sleep 60', 'first task'));
      const secondId = tasks.registerTask(new ProcessTask(second.proc, 'sleep 60', 'second task'));

      const steered = new AbortController();
      const pending = executeTool(tool!, {
        ...context('wait_fan_out', { timeout: 600 }),
        steerSignal: steered.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      steered.abort(abortError('Steered by new input'));

      const result = await pending;
      expect(result.isError).toBeFalsy();
      const output = outputString(result);
      expect(output).toContain('wait_status: interrupted');
      expect(output).not.toContain('wait_status: aborted');
      expect(tasks.getTask(firstId)?.status).toBe('running');
      expect(tasks.getTask(secondId)?.status).toBe('running');
      expect(first.proc.kill).not.toHaveBeenCalled();
      expect(second.proc.kill).not.toHaveBeenCalled();
    } finally {
      first.resolveWait(0);
      second.resolveWait(0);
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('keeps aborting the wait when the execution signal and the steer signal abort together', async () => {
    const ctx = createTestAgent();
    const slow = controllableProcess();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('TaskWait');
      const taskId = tasks.registerTask(new ProcessTask(slow.proc, 'sleep 60', 'background work'));

      const cancelled = new AbortController();
      const steered = new AbortController();
      const pending = executeTool(tool!, {
        ...context('wait_cancelled', { timeout: 600, task_id: taskId }, cancelled.signal),
        steerSignal: steered.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancelled.abort(new Error('Aborted by the user'));
      steered.abort(new Error('Steered by new input'));

      await expect(pending).rejects.toThrow('Aborted by the user');
      expect(tasks.getTask(taskId)?.status).toBe('running');
    } finally {
      slow.resolveWait(0);
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('ends an in-flight wait with interrupted when a prompt steers into the active turn', async () => {
    const ctx = createTestAgent();
    const slow = controllableProcess();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const taskId = tasks.registerTask(new ProcessTask(slow.proc, 'sleep 60', 'background work'));
      ctx.get(IAgentProfileService).update({ activeToolNames: ['TaskWait'] });
      ctx.mockNextResponse({
        type: 'function',
        id: 'wait-for-task',
        name: 'TaskWait',
        arguments: JSON.stringify({ timeout: 600, task_id: taskId }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'Handling the new request first.' });

      const waiting = ctx.once('tool.progress');
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Wait for the background work.' }] });
      await waiting;
      await ctx.rpc.steer({ input: [{ type: 'text', text: 'Handle this new request first.' }] });

      await vi.waitFor(
        () => {
          expect(ctx.llmCalls).toHaveLength(2);
        },
        { timeout: 5_000 },
      );

      const toolMessages = ctx.llmCalls[1]!.history.filter((message) => message.role === 'tool');
      expect(toolMessages).toMatchObject([
        {
          toolCallId: 'wait-for-task',
          content: [{ type: 'text', text: expect.stringContaining('wait_status: interrupted') }],
        },
      ]);
      expect(ctx.llmCalls[1]!.history.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'Handle this new request first.' }],
      });
      expect(ctx.allEvents).not.toContainEqual(
        expect.objectContaining({
          event: 'tool.result',
          args: expect.objectContaining({ toolCallId: 'wait-for-task', isError: true }),
        }),
      );
      expect(tasks.getTask(taskId)?.status).toBe('running');
      expect(slow.proc.kill).not.toHaveBeenCalled();
    } finally {
      slow.resolveWait(0);
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('waits for a real registered task end-to-end and suppresses its notification', async () => {
    const records: TelemetryRecord[] = [];
    const loop = stubLoopWithHooks();
    const ctx = createTestAgent(
      telemetryServices(recordingTelemetry(records)),
      agentService(IAgentLoopService, loop),
    );
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('TaskWait');
      expect(tool).toBeDefined();

      const slow = controllableProcess();
      const taskId = tasks.registerTask(new ProcessTask(slow.proc, 'echo done', 'wait target'));
      const pending = executeTool(tool!, context('wait_e2e', { timeout: 30, task_id: taskId }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      slow.pushOutput('DONE-OUTPUT\n');
      slow.resolveWait(0);
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskId}`);
      expect(output).toContain('[finished]');
      expect(output).toContain('[output]\nDONE-OUTPUT');
      expect(ctx.allEvents.some((event) => event.event === 'task.waitDelivered')).toBe(false);
      await loop.hooks.onDidAppendToolResult.run({ toolCallId: 'wait_e2e', isError: false });
      expect(ctx.allEvents.some((event) => event.event === 'task.waitDelivered')).toBe(true);

      expect(loop.hasPendingRequests()).toBe(false);
      loop.drainNextBatch(ctx.context);
      expect(ctx.context.get().some((message) => message.origin?.kind === 'task')).toBe(false);
      expect(ctx.allEvents.some((event) => event.event === 'task.notified')).toBe(false);
      expect(ctx.llmCalls).toHaveLength(0);
      expect(
        records.findLast((record) => record.event === 'task_wait_completed')?.properties,
      ).toMatchObject({ outcome: 'completed', has_task_id: true, extra_completed_count: 0 });
    } finally {
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not include tasks registered after the wait started', async () => {
    const ctx = createTestAgent(permissionModeServices('manual'));
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(IAgentToolRegistryService).resolve('TaskWait');
      expect(tool).toBeDefined();

      const slow = controllableProcess();
      const taskA = tasks.registerTask(new ProcessTask(slow.proc, 'sleep 30', 'slow'));
      const pending = executeTool(tool!, context('wait_race', { timeout: 30 }));

      const late = controllableProcess();
      const taskB = tasks.registerTask(new ProcessTask(late.proc, 'echo b', 'late comer'));
      await tasks.suppressTerminalNotification(taskB);
      late.pushOutput('B-OUT\n');
      late.resolveWait(0);
      await waitForTerminal(tasks, taskB);

      const race = await Promise.race([
        pending.then(() => 'resolved' as const),
        new Promise<'pending'>((resolve) => {
          setTimeout(() => resolve('pending'), 50);
        }),
      ]);
      expect(race).toBe('pending');

      slow.pushOutput('A-OUT\n');
      slow.resolveWait(0);
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: completed');
      expect(output).toContain(`task_id: ${taskA}`);
      expect(output).not.toContain(taskB);
      expect(output).not.toContain('[completed_during_wait]');
      expect(ctx.allEvents.filter((event) => event.event === 'task.waitDelivered')).toHaveLength(0);
      await ctx.get(IAgentLoopService).hooks.onDidAppendToolResult.run({ toolCallId: 'wait_race', isError: false });
      expect(ctx.allEvents.filter((event) => event.event === 'task.waitDelivered')).toHaveLength(1);
    } finally {
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('preserves automatic completion notification after rejecting a main agent wait', async () => {
    const loop = stubLoopWithHooks();
    const ctx = createTestAgent(agentService(IAgentLoopService, loop));
    let settle!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => { settle = resolve; });
    try {
      const tasks = ctx.get(IAgentTaskService);
      const taskId = tasks.registerTask(new SubagentTask(
        { agentId: 'child', profileName: 'coder', completion }, 'report work', new AbortController(),
      ));
      const result = await executeTool(ctx.get(ITaskWaitTool), context('wait_rejected', { timeout: 86_400, task_id: taskId }));
      expect(result.isError).toBe(true);
      await loop.hooks.onDidAppendToolResult.run({ toolCallId: 'wait_rejected', isError: true });
      expect(tasks.getTask(taskId)?.status).toBe('running');
      settle({ result: 'NOTIFICATION RECEIPT' });
      await vi.waitFor(() => expect(loop.hasPendingRequests()).toBe(true));
      loop.drainNextBatch(ctx.context);
      await runWillBeginStepHooks(loop);
      expect(JSON.stringify(ctx.context.get())).toContain('NOTIFICATION RECEIPT');
      expect(ctx.allEvents.some((event) => event.event === 'task.waitDelivered')).toBe(false);
      expect(ctx.context.get().filter((message) => message.origin?.kind === 'task' && message.origin.taskId === taskId)).toHaveLength(1);
      expect(ctx.allEvents.filter((event) => event.type === '[wire]' && event.event === 'task.notified')).toHaveLength(1);
    } finally {
      settle({ result: 'NOTIFICATION RECEIPT' });
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['active', 'paused', 'blocked', 'complete'] as const)('uses real goal state (%s) for specific and mixed waits', async (status) => {
    const ctx = createTestAgent();
    let settle!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => { settle = resolve; });
    const process = controllableProcess();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const taskId = tasks.registerTask(new SubagentTask(
        { agentId: 'goal-child', profileName: 'coder', completion }, 'goal work', new AbortController(),
      ));
      tasks.registerTask(new ProcessTask(process.proc, 'sleep 60', 'mixed process'));
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'Finish synchronous work' });
      if (status === 'paused') await goals.pauseGoal();
      if (status === 'blocked') await goals.markBlocked();
      if (status === 'complete') await goals.markComplete();
      const tool = ctx.get(ITaskWaitTool);
      const specific = executeTool(tool, context('wait_goal_specific', { timeout: 86_400, task_id: taskId }));
      const any = executeTool(tool, context('wait_goal_any', { timeout: 86_400 }));
      if (status === 'active') settle({ result: 'GOAL RECEIPT' });
      const results = await Promise.all([specific, any]);
      for (const result of results) {
        expect(result.isError).toBe(status !== 'active');
        expect(outputString(result)).toContain(status === 'active' ? 'wait_status: completed' : 'Do independent work or end the turn');
      }
    } finally {
      settle({ result: 'GOAL RECEIPT' });
      process.resolveWait(0);
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('keeps foreign tasks invisible even with an explicit synchronous exception', async () => {
    const owner = createTestAgent();
    const other = createTestAgent();
    const process = controllableProcess();
    try {
      const taskId = owner.get(IAgentTaskService).registerTask(new ProcessTask(process.proc, 'sleep 60', 'private work'));
      const result = await executeTool(other.get(ITaskWaitTool), context('wait_foreign', {
        timeout: 86_400, task_id: taskId, sync_wait: true, sync_reason: 'Host needs this result now',
      }));
      expect(result.isError).toBe(true);
      expect(outputString(result)).toBe(`Task not found: ${taskId}`);
      expect(owner.get(IAgentTaskService).getTask(taskId)?.status).toBe('running');
    } finally {
      process.resolveWait(0);
      await owner.dispose();
      await other.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['terminal', 'steer', 'abort', 'task_budget'] as const)('ends a 24-hour wait early on %s without extending the task budget', async (ending) => {
    const ctx = createTestAgent();
    let settle!: (value: { result: string }) => void;
    let rejectCompletion!: (reason: unknown) => void;
    const completion = new Promise<{ result: string }>((resolve, reject) => {
      settle = resolve;
      rejectCompletion = reject;
    });
    const childController = new AbortController();
    childController.signal.addEventListener('abort', () => { rejectCompletion(childController.signal.reason); }, { once: true });
    try {
      const tasks = ctx.get(IAgentTaskService);
      vi.useFakeTimers();
      const taskId = tasks.registerTask(new SubagentTask(
        { agentId: 'long-child', profileName: 'coder', completion }, 'bounded work', childController,
      ), { timeoutMs: ending === 'task_budget' ? 120_000 : undefined });
      const cancelled = new AbortController();
      const steered = new AbortController();
      const onUpdate = vi.fn();
      const pending = executeTool(ctx.get(ITaskWaitTool), {
        ...context('wait_long', {
          timeout: 86_400, task_id: taskId, sync_wait: true,
          sync_reason: 'The host needs the result in this synchronous response',
        }, cancelled.signal),
        steerSignal: steered.signal, onUpdate,
      });
      const checked = ending === 'abort' ? expect(pending).rejects.toThrow('Aborted by the user') : undefined;
      await vi.advanceTimersByTimeAsync(120_000);
      if (ending === 'terminal') settle({ result: 'LONG WAIT RECEIPT' });
      if (ending === 'steer') steered.abort(abortError('Steered by new input'));
      if (ending === 'abort') cancelled.abort(new Error('Aborted by the user'));
      if (ending === 'abort') {
        await checked;
      } else {
        const result = await pending;
        expect(result.isError).toBe(false);
        const output = outputString(result);
        expect(output).toContain(ending === 'steer' ? 'wait_status: interrupted' : 'wait_status: completed');
        expect(output).toContain('timeout_ms: 86400000');
        if (ending === 'task_budget') {
          expect(output).toContain('terminal_reason: timed_out');
          expect(tasks.getTask(taskId)?.status).toBe('timed_out');
          expect(childController.signal.aborted).toBe(true);
        }
      }
      if (ending === 'steer' || ending === 'abort') {
        expect(tasks.getTask(taskId)?.status).toBe('running');
        expect(childController.signal.aborted).toBe(false);
      }
      const updatesAtEnd = onUpdate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onUpdate).toHaveBeenCalledTimes(updatesAtEnd);
    } finally {
      vi.useRealTimers();
      settle({ result: 'LONG WAIT RECEIPT' });
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('returns from a wait on a task that never settles once the timeout elapses', async () => {
    const ctx = createTestAgent();
    try {
      const tasks = ctx.get(IAgentTaskService);
      const tool = ctx.get(ITaskWaitTool);
      const taskId = tasks.registerTask(
        new SubagentTask(
          {
            agentId: 'agent-hang',
            profileName: 'coder',
            completion: new Promise<{ result: string }>(() => {}),
          },
          'hung work',
          new AbortController(),
        ),
      );

      vi.useFakeTimers();
      const pending = executeTool(tool, context('wait_hang', {
        timeout: 86_400, task_id: taskId, sync_wait: true,
        sync_reason: 'The user explicitly requires a result in this response',
      }));
      await vi.advanceTimersByTimeAsync(86_400_000);
      const result = await pending;
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('wait_status: timed_out');
      expect(output).toContain('[still_running]');
      expect(output).toContain(taskId);
      expect(tasks.getTask(taskId)?.status).toBe('running');
    } finally {
      vi.useRealTimers();
      await ctx.dispose();
    }
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});
