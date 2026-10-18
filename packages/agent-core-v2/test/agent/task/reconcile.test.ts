import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPluginMediaService } from '#/app/pluginMedia/pluginMedia';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { EMPTY_AGENT_RECEIPT_REASON } from '#/agent/tools/agent/subagent-task';
import { readCommittedAgentRunOutcomes } from '#/agent/task/agentOutcome';
import { SubagentCompleted, SubagentFailed } from '#/session/subagent/mirrorAgentRun';

import {
  IAgentTaskService,
  type AgentTaskInfo,
} from '#/agent/task/task';
import { IEventBus } from '#/app/event/eventBus';
import {
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

let sessionDir: string;
let persistence: ReturnType<typeof createAgentTaskPersistence>;

function persistedAgent(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'agent' }>> = {},
): Extract<AgentTaskInfo, { kind: 'agent' }> {
  return {
    taskId: 'agent-track001',
    kind: 'agent',
    agentId: 'agent-child',
    description: 'tracked child',
    executorId: 'native',
    executorProtocol: 'native',
    startedAt: 1_700_000_000,
    endedAt: null,
    status: 'running',
    detached: true,
    ...overrides,
  };
}

async function appendJournal(
  ctx: TestAgentContext,
  event: SubagentCompleted | SubagentFailed,
): Promise<void> {
  ctx.wire.appendRecord(event.serialize());
  await ctx.wire.flush();
}

function persistedProcess(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'process' }>> = {},
): Extract<AgentTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-orphan00',
    kind: 'process',
    command: 'npm install',
    description: 'install',
    pid: 99999,
    startedAt: 1_700_000_000,
    endedAt: null,
    exitCode: null,
    status: 'running',
    ...overrides,
  };
}

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-bg-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  persistence = createAgentTaskPersistence(sessionDir);
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('AgentTaskService — loadFromDisk + reconcile', () => {
  describe('without persisted tasks', () => {
    let ctx: TestAgentContext;
    let background: TaskServiceTestManager;

    beforeEach(() => {
      ctx = createTestAgent(taskServices());
      background = ctx.get(IAgentTaskService) as TaskServiceTestManager;
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('loadFromDisk does nothing when no tasks are persisted', async () => {
      await background.loadFromDisk();

      expect(background.list(false)).toEqual([]);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
  });

  describe('with persistence', () => {
    let ctx: TestAgentContext;
    let background: TaskServiceTestManager;
    let emittedEvents: unknown[];

    beforeEach(() => {
      ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
      background = ctx.get(IAgentTaskService) as TaskServiceTestManager;
      emittedEvents = [];
      const events = ctx.get(IEventBus);
      events.subscribe((event) => {
        emittedEvents.push(event);
      });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('reattaches a persisted media task to its job and commits one normal terminal receipt', async () => {
      const jobId = 'media-0123456789abcdef0123456789abcdef';
      await persistence.writeTask({ taskId: 'media-restore0', kind: 'media', jobId, description: 'media restore', status: 'running', startedAt: 1, endedAt: null, detached: true });
      const media = ctx.get(IPluginMediaService);
      const run = vi.spyOn(media, 'run').mockResolvedValue({ job_id: jobId, state: 'succeeded', artifacts: [{ file_id: 'f_existing_original' }] } as Awaited<ReturnType<IPluginMediaService['run']>>);
      const stored = vi.spyOn(media, 'stored').mockResolvedValue({ owner: { sessionId: ctx.get(ISessionContext).sessionId, agentId: ctx.get(IAgentScopeContext).agentId } } as Awaited<ReturnType<IPluginMediaService['stored']>>);
      try {
        await background.loadFromDisk();
        expect(await background.reconcile()).toEqual([]);
        await vi.waitFor(() => expect(background.getTask('media-restore0')).toMatchObject({ kind: 'media', jobId, status: 'completed', receiptVerification: 'verified' }));
        expect(await persistence.readTask('media-restore0')).toMatchObject({ status: 'completed', receiptVerification: 'verified' });
        expect((await background.getOutputSnapshot('media-restore0', 4096)).preview).toContain('f_existing_original');
        await background.reconcile();
        expect(run).toHaveBeenCalledTimes(1);
        expect(emittedEvents.filter((event) => (event as { type?: string }).type === 'task.terminated')).toHaveLength(1);
      } finally { run.mockRestore(); stored.mockRestore(); }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('reconciles a previously-running task as lost', async () => {
      await persistence.writeTask(persistedProcess());

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-orphan00')).toMatchObject({
        taskId: 'bash-orphan00',
        status: 'lost',
      });
      expect(await persistence.readTask('bash-orphan00')).toMatchObject({
        taskId: 'bash-orphan00',
        status: 'lost',
      });
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          type: 'task.terminated',
          info: expect.objectContaining({
            taskId: 'bash-orphan00',
            status: 'lost',
          }),
        }),
      );
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('runtime restore reconciles persisted tasks through the task resume hook', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-restore0',
          command: 'sleep 9999',
          description: 'restore hook check',
          pid: 4242,
        }),
      );

      await ctx.restore([]);

      expect(background.getTask('bash-restore0')).toMatchObject({
        taskId: 'bash-restore0',
        status: 'lost',
      });
      expect(await persistence.readTask('bash-restore0')).toMatchObject({
        taskId: 'bash-restore0',
        status: 'lost',
      });
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          type: 'task.terminated',
          info: expect.objectContaining({
            taskId: 'bash-restore0',
            status: 'lost',
          }),
        }),
      );
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('does not reclassify already-terminal tasks', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-done0000',
          command: 'echo hi',
          description: 'echo',
          pid: 88888,
          endedAt: 1_700_000_010,
          exitCode: 0,
          status: 'completed',
        }),
      );
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-running0',
          command: 'sleep 1000',
          description: 'sleep',
          pid: 77777,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(await persistence.readTask('bash-done0000')).toMatchObject({
        status: 'completed',
      });
      expect(await persistence.readTask('bash-running0')).toMatchObject({
        status: 'lost',
      });
      const terminationEvents = emittedEvents.filter(
        (event) => (event as { type?: string }).type === 'task.terminated',
      );
      expect(terminationEvents).toHaveLength(1);
      expect(terminationEvents[0]).toMatchObject({
        type: 'task.terminated',
        info: { taskId: 'bash-running0', status: 'lost' },
      });
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('list(activeOnly=false) includes ghosts; list(true) excludes them', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-lost0000',
          command: 'x',
          description: 'd',
          pid: 1,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.list(true)).toEqual([]);
      expect(background.list(false)).toEqual([
        expect.objectContaining({ taskId: 'bash-lost0000', status: 'lost' }),
      ]);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('getTask returns ghost when the live process map has no entry', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-ghost000',
          command: 'x',
          description: 'd',
          pid: 1,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-ghost000')).toMatchObject({
        taskId: 'bash-ghost000',
        status: 'lost',
      });
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('reconcile emits nothing when no ghosts were loaded', async () => {
      await background.loadFromDisk();
      await background.reconcile();

      expect(emittedEvents).toEqual([]);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('does not emit duplicate termination events on a second reconcile pass', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-nodup000',
          command: 'sleep 9999',
          description: 'dedupe check',
          pid: 42,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();
      await background.reconcile();

      expect(
        emittedEvents.filter(
          (event) => (event as { type?: string }).type === 'task.terminated',
        ),
      ).toHaveLength(1);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('restores terminal ghost notifications into context', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-done0001',
          command: 'echo done',
          description: 'one-shot',
          pid: 42,
          endedAt: 1_700_000_010,
          exitCode: 0,
          status: 'completed',
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-done0001')).toMatchObject({
        taskId: 'bash-done0001',
        status: 'completed',
      });
      expect(
        emittedEvents.filter(
          (event) => (event as { type?: string }).type === 'task.terminated',
        ),
      ).toEqual([]);
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('adopts a matching journal outcome as completed without starting execution', async () => {
      await persistence.writeTask(persistedAgent());
      const run = vi.spyOn(ctx.get(IAgentExecutionService), 'run');
      const agentsBefore = ctx.get(IAgentLifecycleService).list().length;
      await appendJournal(ctx, new SubagentCompleted({
        subagentId: 'agent-child',
        taskId: 'agent-track001',
        resultSummary: 'inspected the tree',
      }, 1_700_000_100));
      try {
        await background.loadFromDisk();
        await background.reconcile();
        expect(background.getTask('agent-track001')).toMatchObject({
          kind: 'agent',
          agentId: 'agent-child',
          status: 'completed',
          receiptVerification: 'verified',
        });
        expect((await background.getOutputSnapshot('agent-track001', 4096)).preview).toBe('inspected the tree');
        expect(await persistence.readTask('agent-track001')).toMatchObject({
          status: 'completed',
          agentId: 'agent-child',
          receiptVerification: 'verified',
        });
        expect(run).not.toHaveBeenCalled();
        expect(ctx.get(IAgentLifecycleService).list()).toHaveLength(agentsBefore);
      } finally {
        run.mockRestore();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('records an empty journal outcome as failed without treating it as success', async () => {
      await persistence.writeTask(persistedAgent());
      const run = vi.spyOn(ctx.get(IAgentExecutionService), 'run');
      await appendJournal(ctx, new SubagentCompleted({
        subagentId: 'agent-child',
        taskId: 'agent-track001',
        resultSummary: '   ',
      }, 1_700_000_100));
      try {
        await background.loadFromDisk();
        await background.reconcile();
        expect(background.getTask('agent-track001')).toMatchObject({
          status: 'failed',
          stopReason: EMPTY_AGENT_RECEIPT_REASON,
        });
        expect((await background.getOutputSnapshot('agent-track001', 4096)).preview).toBe('');
        expect(run).not.toHaveBeenCalled();
      } finally {
        run.mockRestore();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('adopts the last journal outcome and maps terminated to killed', async () => {
      await persistence.writeTask(persistedAgent());
      await persistence.writeTask(persistedAgent({ taskId: 'agent-killed01', description: 'killed child' }));
      await appendJournal(ctx, new SubagentCompleted({
        subagentId: 'agent-child',
        taskId: 'agent-track001',
        resultSummary: 'first receipt',
      }, 1_700_000_100));
      await appendJournal(ctx, new SubagentFailed({
        subagentId: 'agent-child',
        taskId: 'agent-track001',
        error: 'tool rejected',
      }, 1_700_000_200));
      await appendJournal(ctx, new SubagentFailed({
        subagentId: 'agent-child',
        taskId: 'agent-killed01',
        error: 'terminated',
      }, 1_700_000_300));
      await background.loadFromDisk();
      await background.reconcile();
      expect(background.getTask('agent-track001')).toMatchObject({
        status: 'failed',
        stopReason: 'tool rejected',
      });
      expect(background.getTask('agent-killed01')).toMatchObject({ status: 'killed' });
      expect(background.getTask('agent-killed01')?.stopReason).toBeUndefined();
      expect((await background.getOutputSnapshot('agent-track001', 4096)).preview).not.toContain('first receipt');
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('leaves a process and an unmatched agent lost when the journal outcome does not identify them', async () => {
      await persistence.writeTask(persistedProcess());
      await persistence.writeTask(persistedAgent({ taskId: 'agent-mismatch', description: 'wrong child' }));
      await persistence.writeTask(persistedAgent({
        taskId: 'agent-noid0001',
        agentId: undefined,
        description: 'missing child id',
      }));
      const run = vi.spyOn(ctx.get(IAgentExecutionService), 'run');
      const agentsBefore = ctx.get(IAgentLifecycleService).list().length;
      await appendJournal(ctx, new SubagentCompleted({
        subagentId: 'someone-else',
        taskId: 'agent-mismatch',
        resultSummary: 'not this agent',
      }, 1_700_000_100));
      await appendJournal(ctx, new SubagentCompleted({
        subagentId: 'agent-child',
        taskId: 'agent-noid0001',
        resultSummary: 'no stored identity',
      }, 1_700_000_200));
      try {
        await background.loadFromDisk();
        await background.reconcile();
        for (const taskId of ['bash-orphan00', 'agent-mismatch', 'agent-noid0001']) {
          expect(background.getTask(taskId)).toMatchObject({ status: 'lost' });
          expect(background.getTask(taskId)?.stopReason).toContain('external execution outcome is unconfirmed');
        }
        expect((await background.getOutputSnapshot('agent-mismatch', 4096)).preview).not.toContain('not this agent');
        expect(run).not.toHaveBeenCalled();
        expect(ctx.get(IAgentLifecycleService).list()).toHaveLength(agentsBefore);
      } finally {
        run.mockRestore();
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('leaves an agent lost when the journal outcome cannot be read', async () => {
      await persistence.writeTask(persistedAgent());
      const wire = ctx.wire;
      const original = wire.readJournal.bind(wire);
      wire.readJournal = () => {
        throw new Error('journal unavailable');
      };
      try {
        await background.loadFromDisk();
        await background.reconcile();
        expect(background.getTask('agent-track001')).toMatchObject({ status: 'lost' });
        expect(background.getTask('agent-track001')?.stopReason).toContain('external execution outcome is unconfirmed');
      } finally {
        wire.readJournal = original;
      }
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

    it('does not rewrite an already-terminal lost agent from a later journal outcome', async () => {
      await persistence.writeTask(persistedAgent({
        status: 'lost',
        endedAt: 1_700_000_050,
        stopReason: 'already terminal',
      }));
      await appendJournal(ctx, new SubagentCompleted({
        subagentId: 'agent-child',
        taskId: 'agent-track001',
        resultSummary: 'should-not-apply',
      }, 1_700_000_100));
      await background.loadFromDisk();
      await background.reconcile();
      expect(background.getTask('agent-track001')).toMatchObject({
        status: 'lost',
        stopReason: 'already terminal',
      });
      expect((await background.getOutputSnapshot('agent-track001', 4096)).preview).not.toContain('should-not-apply');
    }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
  });
});

describe('readCommittedAgentRunOutcomes', () => {
  it('journal outcome reader keeps the last record and ignores a completion without a task id', async () => {
    const read = await readCommittedAgentRunOutcomes({
      readJournal: async function* () {
        yield new SubagentCompleted({
          subagentId: 'agent-child',
          taskId: 'agent-track001',
          resultSummary: 'first receipt',
        }, 10).serialize();
        yield new SubagentCompleted({
          subagentId: 'agent-child',
          resultSummary: 'no task',
        }, 11).serialize();
        yield new SubagentFailed({
          subagentId: 'agent-child',
          taskId: 'agent-track001',
          error: 'terminated',
        }, 12).serialize();
      },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.outcomes.size).toBe(1);
    expect(read.outcomes.get('agent-track001')).toMatchObject({
      status: 'killed',
      subagentId: 'agent-child',
    });
    expect(read.outcomes.get('agent-track001')?.stopReason).toBeUndefined();
  });
});
