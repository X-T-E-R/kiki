import { Readable, type Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionProvider,
} from '#/agent/contextInjector/contextInjector';
import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskInfo,
} from '#/agent/task/task';
import { renderNotificationXml } from '#/agent/task/notificationXml';
import { runningSubagentStatus } from '#/agent/task/runningSubagentStatus';
import { AgentTaskService, taskNotificationDeliveryKey } from '#/agent/task/taskService';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { TaskStopTool } from '#/agent/tools/task/task-stop/taskStopTool';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, TaskOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { type TaskWaitInput } from '#/agent/tools/task/task-wait/task-wait';
import { TaskWaitTool } from '#/agent/tools/task/task-wait/taskWaitTool';
import { IWireService } from '#/wire/wire';
import { WireService } from '#/wire/wireService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { ITaskService } from '#/app/task/task';
import { TaskService } from '#/app/task/taskService';
import { QuestionBackgroundTask } from '#/agent/tools/ask-user-question/question-background-task';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

import { stubLog } from '../../_base/log/stubs';
import { stubContextMemory, type StubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, type StubLoop } from '../loop/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { executeTool } from '../../tools/fixtures/execute-tool';
import type { TaskServiceTestManager } from './stubs';

const PARALLEL_WORKER_CONTENTION_TIMEOUT_MS = 30_000;

function fakeProcessTask(): AgentTask {
  return {
    idPrefix: 'test',
    kind: 'process',
    description: 'fake process task',
    start: () => {},
    toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: null }),
  };
}

type RestoreHook = IEventDispatcher['hooks']['onDidRestore'];

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function stubWireService(): IWireService {
  return {
    _serviceBrand: undefined,
    seal: async () => {},
    appendRecord: () => {},
    readJournal: async function* () {},
    flush: async () => {},
  };
}

describe('AgentTaskService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let eventBus: EventBusService;
  let injectionProviders: Map<string, ContextInjectionProvider>;
  let agentHandles: Map<string, IAgentScopeHandle>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    eventBus = disposables.add(new EventBusService());
    injectionProviders = new Map();
    agentHandles = new Map();
    ix.stub(IAgentLifecycleService, { get: (agentId) => agentHandles.get(agentId), list: () => [] });
    ix.stub(ILogService, stubLog());
    ix.stub(IAgentConversationUndoParticipantRegistry, {
      register: () => toDisposable(() => {}),
      list: () => [],
    });
    ix.stub(IWireService, stubWireService());
    ix.stub(IEventBus, eventBus);
    ix.stub(IAgentContextInjectorService, {
      register: (name, provider) => {
        injectionProviders.set(name, provider as ContextInjectionProvider);
        return toDisposable(() => {
          injectionProviders.delete(name);
        });
      },
    });
    ix.stub(ITaskService, {
      run: () => {
        throw new Error('ITaskService.run is not used by this test');
      },
      defer: () => {
        throw new Error('ITaskService.defer is not used by this test');
      },
    });
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(ITelemetryService, { track: () => {}, track2: () => {} });
    ix.stub(IAgentToolRegistryService, {
      register: () => toDisposable(() => {}),
    });
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.stub(IConfigRegistry, { registerSection: () => {} });
    ix.stub(IConfigService, {
      get: (() => undefined) as IConfigService['get'],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 'test-session',
        workspaceId: 'test-ws',
        sessionDir: '/tmp/test-session',
        sessionScope: 'sessions/test-ws/test-session',
        cwd: '/tmp/test-session',
      }),
    );
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId: 'main',
        agentScope: 'sessions/test-ws/test-session/agents/main',
      }),
    );
    ix.stub(IAtomicDocumentStore, {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    });
    ix.stub(IFileSystemStorageService, {
      read: async () => undefined,
      readStream: async function* () {},
      write: async () => {},
      writeStream: async () => {},
      append: async () => {},
      list: async () => [],
      delete: async () => {},
      flush: async () => {},
      close: async () => {},
    });
    ix.stub(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentTaskService, new SyncDescriptor(AgentTaskService));
  });
  afterEach(() => disposables.dispose());

  it('registerTask / list / readOutput / stop', async () => {
    const svc = ix.get(IAgentTaskService);
    const id = svc.registerTask(fakeProcessTask());
    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.taskId).toBe(id);
    expect(listed[0]?.kind).toBe('process');
    expect(await svc.readOutput(id)).toBe('');
    await svc.stop(id);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['TaskStop', 'stopByUser'] as const)(
    '%s stops grandchild tasks and executions before the parent task, retaining resumable scopes',
    async (path) => {
      const docs = mapBackedDocs();
      const bytes = new InMemoryStorageService();
      const childIx = buildAgentIx('agent-child', docs, bytes);
      const grandchildIx = buildAgentIx('agent-grandchild', docs, bytes);
      agentHandles.set('agent-child', { id: 'agent-child', accessor: childIx } as unknown as IAgentScopeHandle);
      agentHandles.set('agent-grandchild', { id: 'agent-grandchild', accessor: grandchildIx } as unknown as IAgentScopeHandle);
      const order: string[] = [];
      let rejectGrandchild!: (reason: unknown) => void;
      const grandchildCompletion = new Promise<{ result: string }>((_resolve, reject) => {
        rejectGrandchild = reject;
      });
      let rejectChild!: (reason: unknown) => void;
      const childCompletion = new Promise<{ result: string }>((_resolve, reject) => {
        rejectChild = reject;
      });
      const cancelGrandchild = vi.fn(() => true);
      const cancelChild = vi.fn(() => true);
      grandchildIx.stub(IAgentExecutionService, {
        cancel: cancelGrandchild,
        status: () => ({ state: order.includes('grandchild execution') ? 'cancelling' : 'running' }),
      });
      childIx.stub(IAgentExecutionService, {
        cancel: cancelChild,
        status: () => ({ state: order.includes('child execution') ? 'cancelling' : 'running' }),
      });
      const rootTasks = ix.get(IAgentTaskService);
      const childTasks = childIx.get(IAgentTaskService);
      const grandchildTasks = grandchildIx.get(IAgentTaskService);
      const grandchildTaskId = grandchildTasks.registerTask({
        ...fakeProcessTask(),
        start: async (sink) => {
          await new Promise<void>((resolve) => {
            sink.signal.addEventListener('abort', () => {
              order.push('grandchild task');
              resolve();
            }, { once: true });
          });
          await sink.settle({ status: 'killed' });
        },
      });
      const childController = new AbortController();
      childController.signal.addEventListener('abort', () => {
        order.push('child task', 'grandchild execution');
        rejectGrandchild(childController.signal.reason);
      });
      const childTaskId = childTasks.registerTask(new SubagentTask(
        { agentId: 'agent-grandchild', profileName: 'coder', completion: grandchildCompletion },
        'run grandchild',
        childController,
      ));
      const rootController = new AbortController();
      rootController.signal.addEventListener('abort', () => {
        order.push('parent task', 'child execution');
        rejectChild(rootController.signal.reason);
      });
      const rootTaskId = rootTasks.registerTask(new SubagentTask(
        { agentId: 'agent-child', profileName: 'coder', completion: childCompletion },
        'run child',
        rootController,
      ));
      await Promise.resolve();

      if (path === 'TaskStop') {
        const result = await executeTool(new TaskStopTool(rootTasks, ix.get(IAgentLifecycleService)), {
          turnId: 0,
          toolCallId: 'stop-parent',
          args: { task_id: rootTaskId, reason: 'stop the tree' },
          signal: new AbortController().signal,
        });
        expect(result.isError).not.toBe(true);
      } else {
        await rootTasks.stopByUser(rootTaskId);
      }

      expect(order).toEqual([
        'grandchild task', 'child task', 'grandchild execution', 'parent task', 'child execution',
      ]);
      expect(grandchildTasks.getTask(grandchildTaskId)).toMatchObject({ status: 'killed' });
      expect(childTasks.getTask(childTaskId)).toMatchObject({ status: 'killed' });
      expect(rootTasks.getTask(rootTaskId)).toMatchObject({ status: 'killed' });
      expect(grandchildIx.get(IAgentExecutionService).status().state).toBe('cancelling');
      expect(childIx.get(IAgentExecutionService).status().state).toBe('cancelling');
      expect(cancelGrandchild).not.toHaveBeenCalled();
      expect(cancelChild).not.toHaveBeenCalled();
      expect(agentHandles.has('agent-child')).toBe(true);
      expect(agentHandles.has('agent-grandchild')).toBe(true);
    },
    PARALLEL_WORKER_CONTENTION_TIMEOUT_MS,
  );

  it('shares concurrent stops and cancels only the task-owned run without child tasks', async () => {
    const childIx = buildAgentIx('agent-child', mapBackedDocs(), new InMemoryStorageService());
    agentHandles.set('agent-child', { id: 'agent-child', accessor: childIx } as unknown as IAgentScopeHandle);
    const childTasks = childIx.get(IAgentTaskService);
    expect(childTasks.list()).toEqual([]);
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopAll = vi.spyOn(childTasks, 'stopAll').mockImplementation(async () => {
      await stopGate;
      return [];
    });
    let rejectChild!: (reason: unknown) => void;
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      rejectChild = reject;
    });
    const cancel = vi.fn(() => true);
    childIx.stub(IAgentExecutionService, { cancel });
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => rejectChild(controller.signal.reason));
    const rootTasks = ix.get(IAgentTaskService);
    const taskId = rootTasks.registerTask(new SubagentTask(
      { agentId: 'agent-child', profileName: 'coder', completion },
      'run child',
      controller,
    ));
    await Promise.resolve();

    const firstStop = rootTasks.stop(taskId, 'first stop');
    const secondStop = rootTasks.stop(taskId, 'second stop');
    expect(controller.signal.aborted).toBe(false);
    expect(stopAll).toHaveBeenCalledTimes(1);
    releaseStop();
    const [first, second] = await Promise.all([firstStop, secondStop]);
    expect(first).toMatchObject({ status: 'killed', stopReason: 'first stop' });
    expect(second).toEqual(first);
    expect(controller.signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('stops one prompt-owned subagent task without cancelling another run on its child scope', async () => {
    const childIx = buildAgentIx('agent-child', mapBackedDocs(), new InMemoryStorageService());
    agentHandles.set('agent-child', { id: 'agent-child', accessor: childIx } as unknown as IAgentScopeHandle);
    const rootTasks = ix.get(IAgentTaskService);
    const registerPromptRun = (label: string) => {
      const controller = new AbortController();
      const completion = new Promise<{ result: string }>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const taskId = rootTasks.registerTask(new SubagentTask(
        { agentId: 'agent-child', profileName: 'coder', completion },
        label,
        controller,
      ));
      return { taskId, controller };
    };
    const first = registerPromptRun('first prompt');
    const second = registerPromptRun('queued prompt');
    const cancelScope = vi.fn((reason?: unknown) => {
      first.controller.abort(reason);
      second.controller.abort(reason);
      return true;
    });
    childIx.stub(IAgentExecutionService, { cancel: cancelScope });
    await Promise.resolve();

    expect(await rootTasks.stopByUser(first.taskId)).toMatchObject({ status: 'killed' });
    expect(first.controller.signal.aborted).toBe(true);
    expect(rootTasks.getTask(second.taskId)).toMatchObject({ status: 'running' });
    expect(second.controller.signal.aborted).toBe(false);
    expect(cancelScope).not.toHaveBeenCalled();
    expect(await rootTasks.stopByUser(second.taskId)).toMatchObject({ status: 'killed' });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('wait with a timeout beyond the timer ceiling does not resolve immediately', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask());
    const waited = svc.wait(taskId, 10 * 365 * 24 * 3600 * 1000);
    const early = await Promise.race([
      waited.then(() => 'returned' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => {
        resolve('waiting');
      }, 50)),
    ]);
    expect(early).toBe('waiting');
    await svc.stop(taskId);
    await expect(waited).resolves.toMatchObject({ taskId });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  function capturingWire(): { records: Record<string, unknown>[] } {
    const records: Record<string, unknown>[] = [];
    ix.stub(IWireService, {
      ...stubWireService(),
      appendRecord: (record: Record<string, unknown>) => {
        records.push(record);
      },
    } as IWireService);
    return { records };
  }

  function outputtingTask(output: string): AgentTask {
    return {
      ...fakeProcessTask(),
      start: async (sink) => {
        sink.appendOutput(output);
        await sink.settle({ status: 'completed' });
      },
    };
  }

  it('task.terminated dispatch carries the retained output tail as outputTail', async () => {
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('line one\nline two\n'));

    await svc.wait(taskId, 1000);

    const terminated = records.filter((record) => record['type'] === 'task.terminated');
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatchObject({
      info: { taskId, status: 'completed' },
      outputTail: 'line one\nline two\n',
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('task.terminated outputTail is bounded to the last 4 KiB of retained output', async () => {
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('x'.repeat(8 * 1024)));

    await svc.wait(taskId, 1000);

    const terminated = records.find((record) => record['type'] === 'task.terminated');
    expect(terminated?.['outputTail']).toBe('x'.repeat(4 * 1024));
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('task.terminated dispatch omits outputTail when the task produced no output', async () => {
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        await sink.settle({ status: 'completed' });
      },
    });

    await svc.wait(taskId, 1000);

    const terminated = records.find((record) => record['type'] === 'task.terminated');
    expect(terminated?.['outputTail']).toBeUndefined();
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  function stubLoop(): StubLoop {
    return ix.get(IAgentLoopService) as unknown as StubLoop;
  }

  async function waitForCondition(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  it('bounds output retained across simultaneous active tasks without evicting execution records', async () => {
    ix.set(IFileSystemStorageService, new InMemoryStorageService());
    const svc = ix.get(IAgentTaskService);
    const output = 'x'.repeat(256 * 1024);
    const ids = Array.from({ length: 12 }, () => svc.registerTask({
      ...fakeProcessTask(),
      start: (sink) => sink.appendOutput(output),
    }, { detached: false }));
    const internals = svc as unknown as { tasks: Map<string, { retainedOutputBytes: number; outputSizeBytes: number }> };
    await vi.waitFor(() => {
      expect(internals.tasks.size).toBe(12);
      const entries = [...internals.tasks.values()];
      expect(entries.every((entry) => entry.outputSizeBytes === output.length)).toBe(true);
      expect(entries.reduce((sum, entry) => sum + entry.retainedOutputBytes, 0)).toBeLessThanOrEqual(1024 * 1024);
    });
    for (const taskId of ids) {
      expect(svc.getTask(taskId)?.status).toBe('running');
      expect(await svc.readOutput(taskId)).toBe(output);
    }
    await svc.stopAll();
    await vi.waitFor(() => expect(internals.tasks.size).toBe(0));
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('archives process, subagent, question and tracked executions while preserving output and notification deduplication', async () => {
    ix.set(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(ITaskService, new SyncDescriptor(TaskService));
    const svc = ix.get(IAgentTaskService);
    const internals = svc as unknown as { tasks: Map<string, unknown>; cachedOutputs: Map<string, unknown> };
    const ids: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 8; i++) {
        const tasks: AgentTask[] = [
          outputtingTask('process-output'),
          new SubagentTask({ agentId: 'child', profileName: 'coder', completion: Promise.resolve({ result: 'agent-output' }) }, 'child', new AbortController()),
          new QuestionBackgroundTask(async () => ({ output: '{"answers":{"choice":"yes"}}' }), 'question', { questionCount: 1 }),
        ];
        for (const task of tasks) {
          const taskId = svc.registerTask(task);
          ids.push(taskId);
          await svc.wait(taskId);
        }
        const handle = disposables.add(ix.get(ITaskService).run(async (_signal, output) => {
          await Promise.resolve();
          output('tracked-output');
        }));
        const entry = svc.track(handle, {
          description: 'tracked',
          toInfo: (base) => ({ ...base, kind: 'question', questionCount: 1 }),
        });
        ids.push(entry.taskId);
        await svc.wait(entry.taskId);
      }
      await vi.waitFor(() => expect(internals.tasks.size).toBe(0));
      expect(internals.cachedOutputs.size).toBe(0);
    }
    expect(svc.list(false).map((info) => info.taskId)).toEqual(ids);
    for (let i = 0; i < ids.length; i++) {
      expect(await svc.readOutput(ids[i]!)).toBe([
        'process-output', 'agent-output', '{"answers":{"choice":"yes"}}', 'tracked-output',
      ][i % 4]);
      expect(await svc.wait(ids[i]!)).toMatchObject({ status: 'completed' });
    }
    const requests = stubLoop().queue.drain();
    expect(requests).toHaveLength(ids.length);
    for (const request of requests) stubLoop().queue.enqueue(request);
    await (svc as TaskServiceTestManager).reconcile();
    expect(stubLoop().queue.drain()).toEqual(requests);
    svc.markTasksDeliveredViaWait(ids.map((taskId) => ({ taskId, status: 'completed' })));
    await (svc as TaskServiceTestManager).reconcile();
    expect(requests.every((request) => request.aborted)).toBe(true);
    expect(stubLoop().hasPendingRequests()).toBe(false);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('retains all unpersisted output after an append failure rather than advertising a partial file as complete', async () => {
    const storage = new InMemoryStorageService();
    ix.set(IFileSystemStorageService, storage);
    const append = vi.spyOn(storage, 'append');
    const svc = ix.get(IAgentTaskService);
    const prefix = 'persisted-prefix\n';
    const failed = 'not-on-disk\n' + 'x'.repeat(2 * 1024 * 1024);
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        sink.appendOutput(prefix);
        await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
        append.mockRejectedValue(new Error('storage unavailable'));
        sink.appendOutput(failed);
        sink.appendOutput('after-failure');
        await sink.settle({ status: 'completed' });
      },
    });
    await svc.wait(taskId);
    const internals = svc as unknown as { tasks: Map<string, unknown>; cachedOutputs: Map<string, unknown> };
    await vi.waitFor(() => expect(internals.tasks.size).toBe(0));
    expect(internals.cachedOutputs.has(taskId)).toBe(true);
    expect(await svc.readOutput(taskId)).toBe(prefix + failed + 'after-failure');
    expect(await svc.getOutputSnapshot(taskId, 13)).toMatchObject({
      fullOutputAvailable: false,
      outputSizeBytes: Buffer.byteLength(prefix + failed + 'after-failure'),
      truncated: true,
      preview: 'after-failure',
    });
    vi.spyOn(storage, 'read').mockRejectedValue(new Error('prefix unavailable'));
    expect(await svc.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)).toMatchObject({
      preview: failed + 'after-failure',
      outputSizeBytes: Buffer.byteLength(prefix + failed + 'after-failure'),
      truncated: true,
      fullOutputAvailable: false,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('retains ownership when a spill replaces the output queue after archive has read the old queue', async () => {
    const storage = new InMemoryStorageService();
    ix.set(IFileSystemStorageService, storage);
    let failWrite!: () => void;
    const writeGate = new Promise<void>((_resolve, reject) => {
      failWrite = () => reject(new Error('late spill failed'));
    });
    const append = vi.spyOn(storage, 'append').mockImplementation(() => writeGate);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        sink.appendOutput('only-output');
        await sink.settle({ status: 'completed' });
        await cleanupGate;
      },
    }, { detached: false });
    const internals = svc as unknown as {
      tasks: Map<string, { outputWriteQueue: Promise<void> }>;
      cachedOutputs: Map<string, unknown>;
    };
    const entry = internals.tasks.get(taskId)!;
    let queue = entry.outputWriteQueue;
    let oldQueueRead = false;
    Object.defineProperty(entry, 'outputWriteQueue', {
      get: () => {
        if (!oldQueueRead) {
          oldQueueRead = true;
          queueMicrotask(() => svc.persistOutput(taskId));
        }
        return queue;
      },
      set: (value: Promise<void>) => { queue = value; },
    });
    await svc.wait(taskId);
    releaseCleanup();
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    expect(oldQueueRead).toBe(true);
    expect(internals.tasks.has(taskId)).toBe(true);
    failWrite();
    await vi.waitFor(() => expect(internals.tasks.has(taskId)).toBe(false));
    expect(internals.cachedOutputs.has(taskId)).toBe(true);
    expect(await svc.getOutputSnapshot(taskId, 1_000)).toMatchObject({
      preview: 'only-output',
      outputSizeBytes: 11,
      fullOutputAvailable: false,
      truncated: false,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it.each(['commit', 'rollback'] as const)('keeps pressure-spilled private metadata unpublished through settlement until %s', async (action) => {
    const docs = mapBackedDocs();
    const storage = new InMemoryStorageService();
    ix.set(IAtomicDocumentStore, docs);
    ix.set(IFileSystemStorageService, storage);
    const svc = ix.get(IAgentTaskService);
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const output = 'p'.repeat(600 * 1024);
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        sink.appendOutput(output);
        await completion;
        await sink.settle({ status: 'completed' });
      },
    }, { deferVisibility: true });
    const otherId = svc.registerTask({
      ...fakeProcessTask(),
      start: (sink) => sink.appendOutput('q'.repeat(600 * 1024)),
    }, { detached: false });
    const scope = 'sessions/test-ws/test-session/agents/main/tasks';
    await vi.waitFor(async () => {
      expect(await storage.read(`${scope}/${taskId}`, 'output.log')).toHaveLength(output.length);
    });
    finish();
    await svc.wait(taskId);
    expect(await docs.get(scope, `${taskId}.json`)).toBeUndefined();
    expect(svc.getTask(taskId)).toBeUndefined();
    expect(stubLoop().hasPendingRequests()).toBe(false);
    const freshIx = buildAgentIx('main', docs, storage);
    const fresh = freshIx.get(IAgentTaskService) as TaskServiceTestManager;
    await fresh.loadFromDisk();
    await fresh.reconcile();
    expect(fresh.getTask(taskId)).toBeUndefined();
    expect(freshIx.get(IAgentContextMemoryService).get()).toEqual([]);
    if (action === 'commit') {
      svc.commitTaskRegistration!(taskId);
      await vi.waitFor(async () => {
        expect(await docs.get(scope, `${taskId}.json`)).toMatchObject({ taskId, status: 'completed' });
      });
      await fresh.loadFromDisk();
      await fresh.reconcile();
      expect(fresh.getTask(taskId)).toMatchObject({ taskId, status: 'completed' });
      expect(await fresh.readOutput(taskId)).toBe(output);
      expect(freshIx.get(IAgentContextMemoryService).get()).toHaveLength(1);
      await fresh.reconcile();
      expect(freshIx.get(IAgentContextMemoryService).get()).toHaveLength(1);
    } else {
      await svc.rollbackTaskRegistration!(taskId);
      expect(await storage.read(`${scope}/${taskId}`, 'output.log')).toBeUndefined();
      await fresh.loadFromDisk();
      await fresh.reconcile();
      expect(fresh.getTask(taskId)).toBeUndefined();
    }
    await svc.stop(otherId);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('keeps the execution record until lifecycle cleanup and output persistence have both finished', async () => {
    const storage = new InMemoryStorageService();
    ix.set(IFileSystemStorageService, storage);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const append = storage.append.bind(storage);
    vi.spyOn(storage, 'append').mockImplementation(async (...args) => {
      await writeGate;
      await append(...args);
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        sink.appendOutput('held output');
        await sink.settle({ status: 'completed' });
        await cleanupGate;
      },
    });
    await svc.wait(taskId);
    const internals = svc as unknown as { tasks: Map<string, unknown> };
    expect(internals.tasks.has(taskId)).toBe(true);
    releaseWrite();
    expect(await svc.readOutput(taskId)).toBe('held output');
    expect(internals.tasks.has(taskId)).toBe(true);
    releaseCleanup();
    await vi.waitFor(() => expect(internals.tasks.has(taskId)).toBe(false));
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('keeps a completed private registration invisible until commit and then archives it once', async () => {
    ix.set(IFileSystemStorageService, new InMemoryStorageService());
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('private result'), { deferVisibility: true });
    await svc.wait(taskId);
    const internals = svc as unknown as { tasks: Map<string, unknown> };
    expect(svc.getTask(taskId)).toBeUndefined();
    expect(svc.list(false)).toEqual([]);
    expect(stubLoop().hasPendingRequests()).toBe(false);
    expect(internals.tasks.has(taskId)).toBe(true);
    svc.commitTaskRegistration!(taskId);
    await vi.waitFor(() => expect(internals.tasks.has(taskId)).toBe(false));
    expect(await svc.readOutput(taskId)).toBe('private result');
    expect(stubLoop().queue.drain()).toHaveLength(1);
    svc.commitTaskRegistration!(taskId);
    expect(stubLoop().hasPendingRequests()).toBe(false);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('rolls back a completed private registration without leaving an output cache or notification', async () => {
    const storage = new InMemoryStorageService();
    ix.set(IFileSystemStorageService, storage);
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('private result'), { deferVisibility: true });
    await svc.wait(taskId);
    await svc.rollbackTaskRegistration!(taskId);
    expect(svc.getTask(taskId)).toBeUndefined();
    expect(await svc.readOutput(taskId)).toBe('');
    expect(stubLoop().hasPendingRequests()).toBe(false);
    expect(await storage.read(`sessions/test-ws/test-session/agents/main/tasks/${taskId}`, 'output.log')).toBeUndefined();
    const internals = svc as unknown as { tasks: Map<string, unknown>; cachedOutputs: Map<string, unknown> };
    expect(internals.tasks.size).toBe(0);
    expect(internals.cachedOutputs.size).toBe(0);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('enqueues a terminal notification for a finished detached task', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('done\n'));

    await svc.wait(taskId, 1000);
    const loop = stubLoop();
    await waitForCondition(() => loop.hasPendingRequests());

    expect(loop.hasPendingRequests()).toBe(true);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('markTasksDeliveredViaWait suppresses the automatic terminal notification', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('done\n'));
    svc.markTasksDeliveredViaWait([{ taskId, status: 'completed' }]);

    await svc.wait(taskId, 1000);
    const loop = stubLoop();
    await waitForCondition(() => loop.hasPendingRequests());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(loop.hasPendingRequests()).toBe(false);
    expect(loop.launches).toEqual([]);

    const deliveryKey = `${taskId}\0completed\0task:${taskId}:completed`;
    const states = ix.get(IAgentStateService);
    await waitForCondition(() => states.get(taskNotificationDeliveryKey).length > 0);
    expect(states.get(taskNotificationDeliveryKey)).toContain(deliveryKey);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('aborts an already-enqueued terminal notification when the task is marked delivered via wait', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('done\n'));

    await svc.wait(taskId, 1000);
    const loop = stubLoop();
    await waitForCondition(() => loop.hasPendingRequests());
    expect(loop.hasPendingRequests()).toBe(true);

    svc.markTasksDeliveredViaWait([{ taskId, status: 'completed' }]);

    expect(loop.hasPendingRequests()).toBe(false);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('suppresses only the notification whose status was reported via wait', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('done\n'));
    svc.markTasksDeliveredViaWait([{ taskId, status: 'failed' }]);

    await svc.wait(taskId, 1000);
    const loop = stubLoop();
    await waitForCondition(() => loop.hasPendingRequests());

    expect(loop.hasPendingRequests()).toBe(true);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('keeps the automatic notification of tasks that were not reported via wait', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskA = svc.registerTask(outputtingTask('a\n'));
    const taskB = svc.registerTask(outputtingTask('b\n'));
    svc.markTasksDeliveredViaWait([{ taskId: taskA, status: 'completed' }]);

    await svc.wait(taskA, 1000);
    await svc.wait(taskB, 1000);
    const loop = stubLoop();
    await waitForCondition(() => loop.hasPendingRequests());

    const context = ix.get(IAgentContextMemoryService) as StubContextMemory;
    loop.drainNextBatch(context);

    const delivered = context.messages.filter((message) => message.origin?.kind === 'task');
    expect(delivered.map((message) => (message.origin as TaskOrigin).taskId)).toEqual([taskB]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  function waitContext(toolCallId: string, args: TaskWaitInput) {
    return { turnId: 0, toolCallId, args, signal: new AbortController().signal };
  }

  function waitResultString(result: { readonly output: string | readonly unknown[] }): string {
    expect(typeof result.output).toBe('string');
    return result.output as string;
  }

  function pendingSubagentTask(agentId: string, description: string): {
    task: SubagentTask;
    settle: (value: { result: string }) => void;
  } {
    let settle!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      settle = resolve;
    });
    return {
      task: new SubagentTask(
        { agentId, profileName: 'coder', completion },
        description,
        new AbortController(),
      ),
      settle,
    };
  }

  it('unwinds a nested wait chain leaf-first without deadlocking', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const mainSvc = buildAgentIx('main', docs, bytes).get(IAgentTaskService);
    const childSvc = buildAgentIx('child-1', docs, bytes).get(IAgentTaskService);
    const mainTool = new TaskWaitTool(mainSvc, noopTelemetryService, stubFlag(true));
    const childTool = new TaskWaitTool(childSvc, noopTelemetryService, stubFlag(true));

    const leaf = pendingSubagentTask('agent-grandchild', 'leaf work');
    const taskC = childSvc.registerTask(leaf.task);
    await childSvc.suppressTerminalNotification(taskC);

    const childWait = executeTool(
      childTool,
      waitContext('wait_child', { timeout: 30, task_id: taskC }),
    );
    const order: string[] = [];
    void childWait.then(() => {
      order.push('childWait');
    });
    const completionM = childWait.then(() => {
      order.push('taskM');
      return { result: 'parent done after child' };
    });
    const taskM = mainSvc.registerTask(
      new SubagentTask(
        { agentId: 'agent-parent', profileName: 'coder', completion: completionM },
        'parent work',
        new AbortController(),
      ),
    );
    const mainWait = executeTool(
      mainTool,
      waitContext('wait_main', { timeout: 30, task_id: taskM }),
    );
    void mainWait.then(() => {
      order.push('mainWait');
    });

    leaf.settle({ result: 'leaf findings' });

    const childResult = waitResultString(await childWait);
    const mainResult = waitResultString(await mainWait);
    expect(childResult).toContain('wait_status: completed');
    expect(childResult).toContain('leaf findings');
    expect(mainResult).toContain('wait_status: completed');
    expect(mainResult).toContain('parent done after child');
    expect(order).toEqual(['childWait', 'taskM', 'mainWait']);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('rejects waiting on a task owned by another agent, so a wait cycle cannot form', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const mainSvc = buildAgentIx('main', docs, bytes).get(IAgentTaskService);
    const childSvc = buildAgentIx('child-1', docs, bytes).get(IAgentTaskService);
    const mainTool = new TaskWaitTool(mainSvc, noopTelemetryService, stubFlag(true));
    const childTool = new TaskWaitTool(childSvc, noopTelemetryService, stubFlag(true));

    const parent = pendingSubagentTask('agent-parent', 'parent work');
    const taskM = mainSvc.registerTask(parent.task);
    const leaf = pendingSubagentTask('agent-grandchild', 'leaf work');
    const taskC = childSvc.registerTask(leaf.task);

    const childWaitingOnParent = await executeTool(
      childTool,
      waitContext('wait_cross_up', { timeout: 30, task_id: taskM }),
    );
    expect(childWaitingOnParent.isError).toBe(true);
    expect(waitResultString(childWaitingOnParent)).toContain(`Task not found: ${taskM}`);

    const parentWaitingOnChild = await executeTool(
      mainTool,
      waitContext('wait_cross_down', { timeout: 30, task_id: taskC }),
    );
    expect(parentWaitingOnChild.isError).toBe(true);
    expect(waitResultString(parentWaitingOnChild)).toContain(`Task not found: ${taskC}`);

    parent.settle({ result: 'parent done' });
    leaf.settle({ result: 'leaf done' });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  function stubTaskConfig(value: unknown): void {
    ix.stub(IConfigService, {
      get: ((domain: string) => (domain === 'task' ? value : undefined)) as IConfigService['get'],
    });
  }

  function stubTaskWrites(): AgentTaskInfo[] {
    const writes: AgentTaskInfo[] = [];
    ix.stub(IAtomicDocumentStore, {
      get: async () => undefined,
      set: async <T,>(_scope: string, _key: string, value: T) => {
        writes.push(value as AgentTaskInfo);
      },
      delete: async () => {},
      list: async () => [],
    });
    return writes;
  }

  function abortObservingTask(onAbort: (reason: unknown) => void): AgentTask {
    return {
      ...fakeProcessTask(),
      start: ({ signal }) => {
        if (signal.aborted) {
          onAbort(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => onAbort(signal.reason));
      },
    };
  }

  it('stopAllOnExit suppresses and persists terminal state for detached tasks', async () => {
    const writes = stubTaskWrites();
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const first = svc.registerTask(fakeProcessTask());
    const second = svc.registerTask(fakeProcessTask());

    await svc.suppressAllTerminalNotifications();
    const third = svc.registerTask(fakeProcessTask());

    const stopped = await svc.stopAllOnExit('Session closed');

    expect(stopped.map((info) => info.taskId).toSorted()).toEqual(
      [first, second, third].toSorted(),
    );
    for (const taskId of [first, second, third]) {
      const info = svc.getTask(taskId);
      expect(info?.status).toBe('killed');
      expect(info?.stopReason).toBe('Session closed');
      expect(info?.terminalNotificationSuppressed).toBe(true);
      expect(writes.filter((write) => write.taskId === taskId).at(-1)).toMatchObject({
        status: 'killed',
        terminalNotificationSuppressed: true,
      });
    }
    expect(records.filter((record) => record['type'] === 'task.terminated')).toHaveLength(3);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('stopAllOnExit does not persist a foreground-only task', async () => {
    const writes = stubTaskWrites();
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask(), { detached: false });

    await svc.stopAllOnExit('Session closed');

    expect(writes).toEqual([]);
    expect(svc.getTask(taskId)).toMatchObject({
      status: 'killed',
      detached: false,
      terminalNotificationSuppressed: undefined,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('stopAllOnExit leaves tasks running when keepAliveOnExit is set', async () => {
    stubTaskConfig({ keepAliveOnExit: true });
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask());

    const stopped = await svc.stopAllOnExit('Session closed');

    expect(stopped).toEqual([]);
    expect(svc.getTask(taskId)?.status).toBe('running');

    await svc.stop(taskId);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('silences a settlement that lands after suppression armed while still recording the terminal state', async () => {
    const { records } = capturingWire();
    const svc = ix.get(IAgentTaskService);
    const loop = stubLoop();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        await gate;
        await sink.settle({ status: 'completed' });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(svc.getTask(taskId)?.status).toBe('running');

    await svc.suppressAllTerminalNotifications();
    release();
    await vi.waitFor(() => {
      expect(svc.getTask(taskId)?.status).toBe('completed');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(records.filter((record) => record['type'] === 'task.terminated')).toHaveLength(1);
    expect(loop.hasPendingRequests()).toBe(false);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('suppresses in-flight terminal notifications on exit even when tasks stay alive', async () => {
    stubTaskConfig({ keepAliveOnExit: true });
    const svc = ix.get(IAgentTaskService);
    const loop = stubLoop();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: async (sink) => {
        await gate;
        await sink.settle({ status: 'completed' });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stopped = await svc.stopAllOnExit('Session closed');

    expect(stopped).toEqual([]);
    expect(svc.getTask(taskId)?.status).toBe('running');

    release();
    await vi.waitFor(() => {
      expect(svc.getTask(taskId)?.status).toBe('completed');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(svc.getTask(taskId)?.terminalNotificationSuppressed).toBeUndefined();
    expect(loop.hasPendingRequests()).toBe(false);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('dispose aborts live tasks as a last resort', async () => {
    const svc = ix.get(IAgentTaskService);
    let abortReason: unknown;
    svc.registerTask(abortObservingTask((reason) => (abortReason = reason)), {
      timeoutMs: 60_000,
    });

    disposables.dispose();
    await Promise.resolve();

    expect(abortReason).toBe('Session closed');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('scope disposal requests SIGKILL when a process ignores SIGTERM', async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let resolveWait!: (code: number) => void;
    const wait = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const kill = vi.fn(async (signal: NodeJS.Signals) => {
      if (signal !== 'SIGKILL') return;
      stdout.push(null);
      stderr.push(null);
      resolveWait(137);
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4244,
      exitCode: null,
      wait: () => wait,
      kill,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    const svc = ix.get(IAgentTaskService);
    svc.registerTask(new ProcessTask(proc, 'ignore-term', 'long-running process'));
    await Promise.resolve();

    disposables.dispose();
    await Promise.resolve();

    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('dispose leaves tasks running when keepAliveOnExit is set', async () => {
    stubTaskConfig({ keepAliveOnExit: true });
    const svc = ix.get(IAgentTaskService);
    let aborted = false;
    const forceStop = vi.fn(async () => {});
    svc.registerTask({
      ...abortObservingTask(() => (aborted = true)),
      forceStop,
    });
    await Promise.resolve();

    disposables.dispose();

    expect(aborted).toBe(false);
    expect(forceStop).not.toHaveBeenCalled();
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('scope disposal leaves a process running when keepAliveOnExit is set', async () => {
    stubTaskConfig({ keepAliveOnExit: true });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let resolveWait!: (code: number) => void;
    const wait = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4245,
      exitCode: null,
      wait: () => wait,
      kill: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    const svc = ix.get(IAgentTaskService);
    svc.registerTask(new ProcessTask(proc, 'keep-running', 'long-running process'));
    await Promise.resolve();

    disposables.dispose();
    await Promise.resolve();

    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.dispose).not.toHaveBeenCalled();

    stdout.push(null);
    stderr.push(null);
    resolveWait(0);
    await Promise.resolve();
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('stop requests force-stop when killGracePeriodMs is zero', async () => {
    stubTaskConfig({ killGracePeriodMs: 0 });
    const svc = ix.get(IAgentTaskService);
    let forceStopped = false;
    const taskId = svc.registerTask({
      ...fakeProcessTask(),
      start: () => new Promise<void>(() => {}),
      forceStop: async () => {
        forceStopped = true;
      },
    });

    const info = await svc.stop(taskId);

    expect(forceStopped).toBe(true);
    expect(info?.status).toBe('killed');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  function mapBackedDocs(): IAtomicDocumentStore {
    const map = new Map<string, unknown>();
    return {
      _serviceBrand: undefined,
      get: async <T,>(scope: string, key: string): Promise<T | undefined> =>
        map.get(`${scope}/${key}`) as T | undefined,
      set: async <T,>(scope: string, key: string, value: T): Promise<void> => {
        map.set(`${scope}/${key}`, value);
      },
      delete: async (scope: string, key: string): Promise<void> => {
        map.delete(`${scope}/${key}`);
      },
      list: async (scope: string, prefix = ''): Promise<readonly string[]> =>
        [...map.keys()]
          .filter((key) => key.startsWith(`${scope}/${prefix}`))
          .map((key) => key.slice(scope.length + 1)),
    } as unknown as IAtomicDocumentStore;
  }

  function buildAgentIx(
    agentId: string,
    docs: IAtomicDocumentStore,
    bytes: IFileSystemStorageService,
  ): TestInstantiationService {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentLifecycleService, { get: (id) => agentHandles.get(id), list: () => [] });
    ix.stub(ILogService, stubLog());
    ix.stub(IAgentConversationUndoParticipantRegistry, {
      register: () => toDisposable(() => {}),
      list: () => [],
    });
    ix.stub(IWireService, stubWireService());
    ix.stub(IEventBus, disposables.add(new EventBusService()));
    ix.stub(IAgentContextInjectorService, {
      register: () => toDisposable(() => {}),
    });
    ix.stub(ITaskService, {
      run: () => {
        throw new Error('ITaskService.run is not used by this test');
      },
      defer: () => {
        throw new Error('ITaskService.defer is not used by this test');
      },
    });
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(ITelemetryService, { track: () => {}, track2: () => {} });
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.stub(IConfigService, {
      get: (() => undefined) as IConfigService['get'],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 'test-session',
        workspaceId: 'test-ws',
        sessionDir: '/tmp/test-session',
        sessionScope: 'sessions/test-ws/test-session',
        cwd: '/tmp/test-session',
      }),
    );
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId,
        agentScope: `sessions/test-ws/test-session/agents/${agentId}`,
      }),
    );
    ix.stub(IAtomicDocumentStore, docs);
    ix.stub(IFileSystemStorageService, bytes);
    ix.stub(IAgentBlobService, noopBlob);
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentTaskService, new SyncDescriptor(AgentTaskService));
    return ix;
  }

  function buildWiredAgentIx(
    agentId: string,
    docs: IAtomicDocumentStore,
    bytes: IFileSystemStorageService,
    context: StubContextMemory,
  ): TestInstantiationService {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentLifecycleService, { get: (id) => agentHandles.get(id), list: () => [] });
    ix.stub(ILogService, stubLog());
    ix.stub(IAgentConversationUndoParticipantRegistry, {
      register: () => toDisposable(() => {}),
      list: () => [],
    });
    ix.stub(IEventBus, disposables.add(new EventBusService()));
    ix.stub(IAgentContextInjectorService, {
      register: () => toDisposable(() => {}),
    });
    ix.stub(ITaskService, {
      run: () => {
        throw new Error('ITaskService.run is not used by this test');
      },
      defer: () => {
        throw new Error('ITaskService.defer is not used by this test');
      },
    });
    ix.stub(IAgentContextMemoryService, context);
    ix.stub(ITelemetryService, { track: () => {}, track2: () => {} });
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.stub(IConfigService, {
      get: (() => undefined) as IConfigService['get'],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 'test-session',
        workspaceId: 'test-ws',
        sessionDir: '/tmp/test-session',
        sessionScope: 'sessions/test-ws/test-session',
        cwd: '/tmp/test-session',
      }),
    );
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId,
        agentScope: `sessions/test-ws/test-session/agents/${agentId}`,
      }),
    );
    ix.stub(IAtomicDocumentStore, docs);
    ix.stub(IFileSystemStorageService, bytes);
    ix.stub(IAgentBlobService, noopBlob);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IWireService, new SyncDescriptor(WireService));
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentTaskService, new SyncDescriptor(AgentTaskService));
    return ix;
  }

  it('rebuilds wait-delivered keys on restore and skips their re-delivery', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();

    const one = buildWiredAgentIx('main', docs, bytes, stubContextMemory());
    const svc1 = one.get(IAgentTaskService);
    await one.get(IEventDispatcher).restore();

    const taskA = svc1.registerTask(outputtingTask('a\n'));
    const taskB = svc1.registerTask(outputtingTask('b\n'));
    svc1.markTasksDeliveredViaWait([{ taskId: taskA, status: 'completed' }]);
    await svc1.wait(taskA, 1000);
    await svc1.wait(taskB, 1000);
    await one.get(IEventDispatcher).flush();

    const context2 = stubContextMemory();
    const two = buildWiredAgentIx('main', docs, bytes, context2);
    two.get(IAgentTaskService);
    await two.get(IEventDispatcher).restore();

    const keyA = `${taskA}\0completed\0task:${taskA}:completed`;
    expect(two.get(IAgentStateService).get(taskNotificationDeliveryKey)).toContain(keyA);
    const redelivered = context2.messages.filter((message) => message.origin?.kind === 'task');
    expect(redelivered.map((message) => (message.origin as TaskOrigin).taskId)).toEqual([taskB]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('restore touches only the agent own task records', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const subScope = 'sessions/test-ws/test-session/agents/agent-1';
    await docs.set(`${subScope}/tasks`, 'bash-abcdef01.json', {
      taskId: 'bash-abcdef01',
      kind: 'process',
      command: 'sleep 60',
      description: 'sub task',
      pid: 4242,
      startedAt: 1,
      endedAt: null,
      exitCode: null,
      status: 'running',
      detached: true,
    });

    const main = buildAgentIx('main', docs, bytes).get(
      IAgentTaskService,
    ) as TaskServiceTestManager;
    await main.loadFromDisk();
    const lost = await main.reconcile();

    expect(lost).toEqual([]);
    expect(main.list(false)).toEqual([]);
    const untouched = await docs.get<{ status: string }>(
      `${subScope}/tasks`,
      'bash-abcdef01.json',
    );
    expect(untouched?.status).toBe('running');

    const sub = buildAgentIx('agent-1', docs, bytes).get(
      IAgentTaskService,
    ) as TaskServiceTestManager;
    await sub.loadFromDisk();
    const subLost = await sub.reconcile();
    expect(subLost.map((info) => info.taskId)).toEqual(['bash-abcdef01']);
    expect(subLost[0]?.status).toBe('lost');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('main restore claims a previous v2 session task with its legacy output path', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const sessionScope = 'sessions/test-ws/test-session';
    const taskId = 'bash-legacy01';
    await docs.set(`${sessionScope}/tasks`, `${taskId}.json`, {
      taskId,
      kind: 'process',
      command: 'echo legacy',
      description: 'legacy task',
      pid: 4242,
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      status: 'completed',
      detached: true,
    });
    await bytes.write(
      `${sessionScope}/tasks/${taskId}`,
      'output.log',
      new TextEncoder().encode('legacy output'),
    );
    let restoreHook!: RestoreHook;
    const mainIx = buildAgentIx('main', docs, bytes);
    const main = mainIx.get(IAgentTaskService);
    restoreHook = mainIx.get(IEventDispatcher).hooks.onDidRestore;

    await restoreHook.run({});

    expect(main.list(false)).toEqual([
      expect.objectContaining({ taskId, description: 'legacy task', status: 'completed' }),
    ]);
    expect(await main.getOutputSnapshot(taskId, 100)).toEqual({
      outputPath: `/tmp/test-session/tasks/${taskId}/output.log`,
      outputSizeBytes: 13,
      previewBytes: 13,
      truncated: false,
      fullOutputAvailable: true,
      preview: 'legacy output',
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('keeps a buffered UTF-8 tail within the byte limit without splitting a character', async () => {
    ix.set(IFileSystemStorageService, new InMemoryStorageService());
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(outputtingTask('prefix🙂tail'), { detached: false });
    await svc.wait(taskId);
    expect(await svc.getOutputSnapshot(taskId, 5)).toMatchObject({
      preview: 'tail',
      previewBytes: 4,
      truncated: true,
      fullOutputAvailable: false,
    });
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('subagent restore does not claim previous v2 session tasks', async () => {
    const docs = mapBackedDocs();
    const bytes = new InMemoryStorageService();
    const sessionScope = 'sessions/test-ws/test-session';
    const taskId = 'bash-legacy02';
    await docs.set(`${sessionScope}/tasks`, `${taskId}.json`, {
      taskId,
      kind: 'process',
      command: 'echo legacy',
      description: 'legacy task',
      pid: 4242,
      startedAt: 1,
      endedAt: 2,
      exitCode: 0,
      status: 'completed',
      detached: true,
    });
    let restoreHook!: RestoreHook;
    const subIx = buildAgentIx('agent-1', docs, bytes);
    const subagent = subIx.get(IAgentTaskService);
    restoreHook = subIx.get(IEventDispatcher).hooks.onDidRestore;

    await restoreHook.run({});

    expect(subagent.list(false)).toEqual([]);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  function compactionSummary(text: string): ContextMessage {
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
  }

  function publishCompactionSplice(): void {
    eventBus.publish(new ContextSpliced({
      start: 0,
      deleteCount: 2,
      messages: [compactionSummary('Compacted summary.')],
    }));
  }

  async function backgroundTaskReminder(
    context: ContextInjectionContext = {
      injectedPositions: [],
      lastInjectedAt: null,
      isNewTurn: false,
    },
  ): Promise<string | undefined> {
    const provider = injectionProviders.get('background_task_status');
    expect(provider).toBeDefined();
    const content = await provider!(context);
    return typeof content === 'string' ? content : undefined;
  }

  it('injects active background task status when compaction dropped the original launch context', async () => {
    const svc = ix.get(IAgentTaskService);
    const taskId = svc.registerTask(fakeProcessTask());

    expect(await backgroundTaskReminder()).toBeUndefined();

    publishCompactionSplice();

    const reminder = await backgroundTaskReminder();
    expect(reminder).toContain('still running after compaction. Do not start duplicates.');
    expect(reminder).toContain('Completion arrives via automatic notification.');
    expect(reminder).toContain('active_background_tasks: 1');
    expect(reminder).toContain(taskId);
    expect(await backgroundTaskReminder()).toBeUndefined();

    await svc.stop(taskId);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not carry post-compaction task reminder eligibility forward when no task is active', async () => {
    const svc = ix.get(IAgentTaskService);
    publishCompactionSplice();

    expect(await backgroundTaskReminder()).toBeUndefined();

    const taskId = svc.registerTask(fakeProcessTask());
    expect(await backgroundTaskReminder()).toBeUndefined();

    await svc.stop(taskId);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  const MiB = 1024 * 1024;
  const LIMIT_BYTES = 16 * MiB;

  function streamingProcess(chunks: string[]): {
    proc: IHostProcess;
    kill: ReturnType<typeof vi.fn>;
  } {
    const stdout = Readable.from(chunks);
    const stderr = Readable.from([]);
    let resolveWait!: (code: number) => void;
    const waitP = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    stdout.on('end', () => {
      resolveWait(0);
    });
    const kill = vi.fn(async (signal: string) => {
      stdout.destroy();
      resolveWait(signal === 'SIGKILL' ? 137 : 143);
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4242,
      exitCode: null,
      wait: () => waitP,
      kill,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    return { proc, kill };
  }

  function sigtermIgnoringProcess(chunks: string[]): {
    proc: IHostProcess;
    kill: ReturnType<typeof vi.fn>;
  } {
    const stdout = Readable.from(chunks);
    const stderr = Readable.from([]);
    let resolveWait!: (code: number) => void;
    const waitP = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    stdout.on('end', () => {
      resolveWait(0);
    });
    const kill = vi.fn(async (signal: string) => {
      if (signal === 'SIGKILL') {
        stdout.destroy();
        resolveWait(137);
      }
    });
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 4243,
      exitCode: null,
      wait: () => waitP,
      kill,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as IHostProcess;
    return { proc, kill };
  }

  function agentLikeTask(result: string, description: string): AgentTask {
    return {
      idPrefix: 'agent',
      kind: 'agent',
      description,
      start: async (sink) => {
        sink.appendOutput(result);
        await sink.settle({ status: 'completed' });
      },
      toInfo: (base) => ({ ...base, kind: 'agent' }),
    };
  }

  async function waitForTerminal(
    svc: IAgentTaskService,
    taskId: string,
    timeoutMs = 30_000,
  ): Promise<AgentTaskInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const info = await svc.wait(taskId, 5);
      if (
        info?.status === 'completed' ||
        info?.status === 'failed' ||
        info?.status === 'timed_out' ||
        info?.status === 'killed' ||
        info?.status === 'lost'
      ) {
        return info;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return svc.getTask(taskId);
  }

  function serviceWithAppendCounter(): {
    svc: IAgentTaskService;
    persistedChars: () => number;
  } {
    let persistedChars = 0;
    ix.stub(IFileSystemStorageService, {
      read: async () => undefined,
      readStream: async function* () {},
      write: async () => {},
      writeStream: async () => {},
      append: async (_scope: string, _key: string, chunk: Uint8Array) => {
        persistedChars += chunk.byteLength;
      },
      list: async () => [],
      delete: async () => {},
      flush: async () => {},
      close: async () => {},
    });
    return { svc: ix.get(IAgentTaskService), persistedChars: () => persistedChars };
  }

  it('terminates a foreground command that exceeds the output limit and stops forwarding', async () => {
    const svc = ix.get(IAgentTaskService);
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, kill } = streamingProcess(chunks);

    let forwardedChars = 0;
    const onOutput = vi.fn((_kind: 'stdout' | 'stderr', text: string) => {
      forwardedChars += text.length;
    });

    const taskId = svc.registerTask(
      new ProcessTask(proc, 'b3sum --length 18446744073709551615', 'hash', onOutput),
      { detached: false, signal: new AbortController().signal, timeoutMs: 60_000 },
    );

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('killed');
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(forwardedChars).toBeLessThanOrEqual(LIMIT_BYTES);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('also terminates a detached (background) task for the same output', async () => {
    const svc = ix.get(IAgentTaskService);
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, kill } = streamingProcess(chunks);

    const taskId = svc.registerTask(new ProcessTask(proc, 'producer', 'bg'), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('killed');
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('stops enqueuing output to disk once the foreground cap trips', async () => {
    const { svc, persistedChars } = serviceWithAppendCounter();

    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc } = sigtermIgnoringProcess(chunks);

    const taskId = svc.registerTask(new ProcessTask(proc, 'runaway', 'hash', () => {}), {
      detached: false,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('killed');
    expect(persistedChars()).toBeLessThanOrEqual(17 * MiB);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('stops appending persisted output once the output limit trips for a detached process task', async () => {
    const { svc, persistedChars } = serviceWithAppendCounter();

    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc } = sigtermIgnoringProcess(chunks);

    const taskId = svc.registerTask(new ProcessTask(proc, 'runaway', 'bg', () => {}), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);
    await svc.getOutputSnapshot(taskId, 1);

    expect(info?.status).toBe('killed');
    expect(persistedChars()).toBeLessThanOrEqual(17 * MiB);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);

  it('does not cap or drop a detached subagent result larger than the limit', async () => {
    const { svc, persistedChars } = serviceWithAppendCounter();

    const bigResult = 'y'.repeat(20 * MiB);
    const taskId = svc.registerTask(agentLikeTask(bigResult, 'big subagent result'), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(svc, taskId);

    expect(info?.status).toBe('completed');
    expect(persistedChars()).toBeGreaterThanOrEqual(bigResult.length);
  }, PARALLEL_WORKER_CONTENTION_TIMEOUT_MS);
});

describe('Agent task notification XML', () => {
  it('renders task notifications with escaped attributes and generic children', () => {
    const text = renderNotificationXml({
      id: 'n_"1&2',
      category: 'task',
      type: 'task.done',
      source_kind: 'background_task',
      source_id: 'bg&1',
      title: 'Task finished',
      severity: 'info',
      body: 'The task completed.',
      children: [
        [
          '<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">',
          'Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log',
          '</output-file>',
        ].join('\n'),
      ],
    });

    expect(text).toContain('id="n_&quot;1&amp;2"');
    expect(text).toContain('source_id="bg&amp;1"');
    expect(text).toContain('Title: Task finished');
    expect(text).toContain('Severity: info');
    expect(text).toContain('<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">');
    expect(text).toContain(
      'Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log',
    );
    expect(text).not.toContain('<task-notification>');
    expect(text.trimEnd()).toMatch(/<\/notification>$/);
  });

  it('renders an agent_id attribute when the notification carries one', () => {
    const text = renderNotificationXml({
      id: 'n_lost1',
      category: 'task',
      type: 'task.lost',
      source_kind: 'background_task',
      source_id: 'agent-w7gq3wwj',
      agent_id: 'agent-0',
      title: 'Background agent lost',
      severity: 'warning',
      body: 'Background agent 1 lost.',
    });

    expect(text).toContain('source_id="agent-w7gq3wwj"');
    expect(text).toContain('agent_id="agent-0"');
  });

  it('omits the agent_id attribute when the notification does not carry one', () => {
    const text = renderNotificationXml({
      id: 'n_bash',
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bash-abcdef00',
      title: 'Background task completed',
      severity: 'info',
      body: 'echo done completed.',
    });

    expect(text).not.toContain('agent_id=');
  });

  it('ignores unrelated fields while applying attribute fallbacks', () => {
    const text = renderNotificationXml({
      id: '',
      source_kind: 'host',
      tail_output: 'should stay out of the XML',
    });

    expect(text).toContain('id="unknown"');
    expect(text).toContain('category="unknown"');
    expect(text).not.toContain('<task-notification>');
    expect(text).not.toContain('should stay out of the XML');
  });
});

describe('running subagent status', () => {
  it('counts live direct children and running task fallback, not idle, broken, or grandchildren', () => {
    const disposables = new DisposableStore();
    const child = (id: string, parentAgentId: string, state: 'running' | 'idle' | 'broken') => {
      const accessor = disposables.add(new TestInstantiationService());
      accessor.stub(IAgentScopeContext, makeAgentScopeContext({
        agentId: id, agentScope: `agents/${id}`, parentAgentId,
      }));
      accessor.stub(IAgentExecutionService, { status: () => ({ state }) });
      return { id, accessor } as unknown as IAgentScopeHandle;
    };
    const lifecycle = { list: () => [
      child('agent-live', 'main', 'running'),
      child('agent-idle', 'main', 'idle'),
      child('agent-broken', 'main', 'broken'),
      child('agent-grandchild', 'agent-live', 'running'),
    ] };
    const tasks = { list: () => [
      {
        taskId: 'agent-task-idle', agentId: 'agent-idle', collaborationTaskName: 'named',
        kind: 'agent' as const, description: 'tracked', status: 'running' as const,
        startedAt: 1, endedAt: null,
      },
      {
        taskId: 'agent-task-broken', agentId: 'agent-broken',
        kind: 'agent' as const, description: 'broken', status: 'running' as const,
        startedAt: 1, endedAt: null,
      },
    ] };

    expect(runningSubagentStatus(tasks, lifecycle, 'main', undefined, 'en'))
      .toBe('2 subagents still running: agent-live, named');
    expect(runningSubagentStatus(tasks, lifecycle, 'main', 'agent-live', 'en'))
      .toBe('1 subagent still running: named');
    disposables.dispose();
  });

  it('truncates long name lists in both English and Chinese', () => {
    const tasks = { list: () => Array.from({ length: 7 }, (_, index) => ({
      taskId: `agent-task-${index}`, agentId: `agent-${index}`,
      collaborationTaskName: `worker_${index + 1}`,
      kind: 'agent' as const, description: 'tracked', status: 'running' as const,
      startedAt: 1, endedAt: null,
    })) };
    const lifecycle = { list: () => [] };

    expect(runningSubagentStatus(tasks, lifecycle, 'main', undefined, 'en'))
      .toBe('7 subagents still running: worker_1, worker_2, worker_3, worker_4, worker_5, and 2 more');
    expect(runningSubagentStatus(tasks, lifecycle, 'main', undefined, 'zh'))
      .toBe('还有 7 个 subagent 正在运行：worker_1、worker_2、worker_3、worker_4、worker_5 等 2 个');
  });
});
