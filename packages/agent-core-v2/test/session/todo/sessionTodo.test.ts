import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IInstantiationService } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { ContextAppendLoopEvent, ContextAppendMessage, ContextUndo } from '#/agent/contextMemory/contextEvents';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ContextUndone } from '#/agent/undo/undoService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { type TodoItem } from '#/session/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/session/todo/todoListReminder';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

import { stubWireJournal } from '../../wire/stubs';
import { IConfigService } from '#/app/config/config';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { PromptSteered } from '#/agent/prompt/promptService';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { TodoReminderResult } from '#/session/todo/todoListReminder';

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly registeredTools: string[];
  readonly registeredVariants: string[];
  readonly journal: WireRecord[];
  readonly eventBus: EventBusService;
  readonly dispatcher: IEventDispatcher;
  readonly restore: (records: readonly WireRecord[]) => Promise<void>;
}

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function makeFakeAgent(
  agentId: string,
  reminders = new Map<string, () => string | undefined>(),
  history: ContextMessage[] = Array.from({ length: 10 }, () => ({ role: 'assistant', content: [], toolCalls: [] })),
  currentTokens = 1_000,
): FakeAgent {
  const registeredTools: string[] = [];
  const registeredVariants: string[] = [];
  const journal: WireRecord[] = [];
  const eventBus = new EventBusService();

  const registryStub = {
    _serviceBrand: undefined,
    register: (tool: { name: string }) => {
      registeredTools.push(tool.name);
      return toDisposable(() => {});
    },
    list: () => [],
    resolve: () => undefined,
    hooks: {},
  };

  const injectorStub = {
    _serviceBrand: undefined,
    register: (variant: string, provider: () => TodoReminderResult | undefined) => {
      registeredVariants.push(variant);
      reminders.set(variant, () => {
        const result = provider();
        if (result === undefined) return undefined;
        const message: ContextMessage = { role: 'user', toolCalls: [], content: [{ type: 'text', text: result.content }],
          origin: { kind: 'injection', variant, disclosure: result.disclosure } };
        history.push(message);
        void dispatcher.dispatch(new ContextAppendMessage({ message }));
        return result.content;
      });
      return toDisposable(() => { reminders.delete(variant); });
    },
  };

  const instantiationStub = {
    createInstance: (ctor: { name: string }) => ({ name: ctor.name }),
  };

  const memoryStub = {
    _serviceBrand: undefined,
    get: () => history,
  };

  const profileStub = {
    _serviceBrand: undefined,
    isToolActive: () => true,
  };

  const ix = new TestInstantiationService();
  ix.set(IEventBus, eventBus);
  ix.set(IAgentBlobService, noopBlob);
  ix.set(IWireService, stubWireJournal(journal));
  ix.set(IAgentStateService, new AgentStateService());
  ix.get(IAgentStateService).contributeState(contextWindowEpochKey);
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  const dispatcher = ix.get(IEventDispatcher);

  const restore = async (records: readonly WireRecord[]): Promise<void> => {
    journal.push(...records);
    await dispatcher.restore();
  };

  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IAgentToolRegistryService) return registryStub as unknown as T;
      if (id === IAgentContextInjectorService) return injectorStub as unknown as T;
      if (id === IInstantiationService) return instantiationStub as unknown as T;
      if (id === IAgentContextMemoryService) return memoryStub as unknown as T;
      if (id === IAgentProfileService) return profileStub as unknown as T;
      if (id === IAgentToolPolicyService) return profileStub as unknown as T;
      if (id === IAgentFullCompactionService) return { getAutoCompact: () => ({ tokens: 100_000 }), getContextStrategy: () => ({ strategy: 'summarize', source: 'default', shadow: false }) } as unknown as T;
      if (id === IAgentTokenCountingService) return { get: () => ({ size: currentTokens }), estimateMessage: () => 1 } as unknown as T;
      if (id === IConfigService) return { get: (section: string) => section === 'memory' ? { enabled: true, approval: 'auto', workspaces: {} } : {} } as unknown as T;
      if (id === ISessionContext) return { workspaceId: 'test-workspace' } as unknown as T;
      if (id === IEventBus) return eventBus as unknown as T;
      if (id === IWireService) return ix.get(IWireService) as unknown as T;
      if (id === IEventDispatcher) return dispatcher as unknown as T;
      if (id === IAgentStateService) return ix.get(IAgentStateService) as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };

  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor,
    dispose: () => {},
  };

  return {
    handle,
    registeredTools,
    registeredVariants,
    journal,
    eventBus,
    dispatcher,
    restore,
  };
}

interface LifecycleStub {
  readonly service: IAgentLifecycleService;
  readonly fireCreate: (handle: IAgentScopeHandle) => void;
  readonly fireDispose: (agentId: string) => void;
}

function makeLifecycleStub(handles: readonly IAgentScopeHandle[] = []): LifecycleStub {
  const onWillCreate = new Emitter<IAgentScopeHandle>();
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const onDidDispose = new Emitter<string>();
  const byId = new Map(handles.map((h) => [h.id, h]));

  const service: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onWillCreate: onWillCreate.event,
    onDidCreate: onDidCreate.event,
    onDidDispose: onDidDispose.event,
    get: (id: string) => byId.get(id),
    list: () => [...byId.values()],
    broadcastPermissionMode: () => {},
    create: async () => {
      throw new Error('not implemented');
    },
    commitCreate: () => {
      throw new Error('not implemented');
    },
    discard: async () => {
      throw new Error('not implemented');
    },
    fork: async () => {
      throw new Error('not implemented');
    },
    remove: async () => {},
    countPendingBackgroundTasks: () => {
      throw new Error('IAgentLifecycleService.countPendingBackgroundTasks is not supported in this test');
    },
    drainBackgroundTasks: async () => {
      throw new Error('IAgentLifecycleService.drainBackgroundTasks is not supported in this test');
    },
  };

  return {
    service,
    fireCreate: (h) => {
      byId.set(h.id, h);
      onWillCreate.fire(h);
      onDidCreate.fire(h);
    },
    fireDispose: (id) => {
      byId.delete(id);
      onDidDispose.fire(id);
    },
  };
}

function makeTodoService(lifecycle: IAgentLifecycleService): ISessionTodoService {
  const ix = new TestInstantiationService();
  ix.set(IAgentLifecycleService, lifecycle);
  ix.set(ISessionTodoService, new SyncDescriptor(SessionTodoService));
  return ix.get(ISessionTodoService);
}

describe('SessionTodoService', () => {
  it.each(['available', 'unregistered', 'policy-disabled', 'ephemeral', 'memory-disabled', 'approval-off', 'child'] as const)('uses actual MemoryWrite availability, without TodoList: %s', async (condition) => {
    const { TurnPrompt } = await import('#/agent/loop/turnOps');
    const reminders = new Map<string, () => string | undefined>();
    const main = makeFakeAgent(condition === 'child' ? 'child' : 'main', reminders, []);
    const original = main.handle.accessor;
    const handle = { ...main.handle, accessor: { get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IAgentToolRegistryService) return { resolve: () => condition === 'unregistered' ? undefined : { name: 'MemoryWrite' } } as unknown as T;
      if (id === IAgentToolPolicyService) return { isToolActive: (name: string) => name === 'MemoryWrite' && condition !== 'policy-disabled' } as unknown as T;
      if (id === IAgentLoopService) return { status: () => ({ state: 'running' }) } as unknown as T;
      if (id === ISessionContext) return { workspaceId: 'test-workspace', ephemeral: condition === 'ephemeral' } as unknown as T;
      if (id === IConfigService) return { get: (section: string) => section === 'memory' ? { enabled: condition !== 'memory-disabled', approval: condition === 'approval-off' ? 'off' : 'review', workspaces: {} } : {} } as unknown as T;
      return original.get(id);
    } } };
    makeTodoService(makeLifecycleStub([handle]).service);
    await main.dispatcher.dispatch(new TurnPrompt({ turnId: 1, promptId: 'p1', origin: { kind: 'user' }, input: [{ type: 'text', text: '以后回答都用中文' }] }));
    const provider = reminders.get(TODO_LIST_REMINDER_VARIANT)!;
    if (condition !== 'available') { expect(provider()).toBeUndefined(); return; }
    expect(provider()).toContain('authoritative record');
    expect(provider()).toBeUndefined();
    for (let step = 0; step < 64; step++) {
      for (const event of [
        { type: 'step.begin' as const, uuid: `s${step}` },
        { type: 'tool.call' as const, stepUuid: `s${step}`, toolCallId: `c${step}`, name: 'Read' },
        { type: 'tool.result' as const, toolCallId: `c${step}`, result: { output: 'a'.repeat(2_000) } },
        { type: 'step.end' as const, uuid: `s${step}`, turnId: '1', step },
      ]) await main.dispatcher.dispatch(new ContextAppendLoopEvent({ event }));
    }
    expect(provider()).toContain('Consider only the new material');
    expect(provider()).toBeUndefined();
    const persisted = main.journal.findLast((record) => record.type === ContextAppendMessage.type);
    expect(persisted).toMatchObject({ message: { origin: { disclosure: { memory: { reason: 'M3' } } } } });
  });
  it('writes durable continuity decisions only for emitted reminders', async () => {
    const { TurnPrompt } = await import('#/agent/loop/turnOps');
    const reminders = new Map<string, () => string | undefined>();
    const main = makeFakeAgent('main', reminders, []);
    makeTodoService(makeLifecycleStub([main.handle]).service);
    const provider = reminders.get(TODO_LIST_REMINDER_VARIANT)!;
    expect(provider()).toBeUndefined();
    await main.dispatcher.dispatch(new TurnPrompt({ turnId: 1, promptId: 'p1', origin: { kind: 'user' }, input: [{ type: 'text', text: 'never push to main' }] }));
    expect(provider()).toContain('standing rule');
    expect(provider()).toBeUndefined();
    await main.dispatcher.dispatch(new TurnPrompt({ turnId: 2, promptId: 'p2', origin: { kind: 'user' }, input: [{ type: 'text', text: 'ordinary request' }] }));
    expect(provider()).toBeUndefined();
    const decisions = main.journal.filter((record) => record.type === 'todo.continuity_decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ classId: 'E1', reason: 'emitted' });
  });
  it('injects T2 under the default summarize strategy and persists its epoch latch', () => {
    const reminders = new Map<string, () => string | undefined>();
    const main = makeFakeAgent('main', reminders, [{ role: 'assistant', content: [{ type: 'text', text: 'uncovered work' }], toolCalls: [] }], 86_000);
    makeTodoService(makeLifecycleStub([main.handle]).service);
    const provider = reminders.get(TODO_LIST_REMINDER_VARIANT)!;
    expect(provider()).toContain('The context window will be renewed soon');
    expect(provider()).toBeUndefined();
    expect(main.journal.some((record) => record.type === ContextAppendMessage.type)).toBe(true);
  });

  it('does not promote a keyword-free steer into a persistent directive', async () => {
    const history: ContextMessage[] = [];
    const reminders = new Map<string, () => string | undefined>();
    const main = makeFakeAgent('main', reminders, history);
    makeTodoService(makeLifecycleStub([main.handle]).service);
    const provider = reminders.get(TODO_LIST_REMINDER_VARIANT)!;
    const content = [{ type: 'text' as const, text: 'The blue option is correct.' }];
    await main.dispatcher.dispatch(new PromptSteered({ activePromptId: 'active', promptIds: ['steer'], content, steeredAt: new Date().toISOString() }));
    expect(provider()).toBeUndefined();
    history.push({ role: 'user', content, toolCalls: [], origin: { kind: 'user' }, source: { turnId: 424 } });
    expect(provider()).toBeUndefined();
    expect(provider()).toBeUndefined();
  });

  it('keeps content writes separate from explicit review and binds review to a real tool call', () => {
    const history: ContextMessage[] = [{ role: 'user', id: 'human-1', toolCalls: [], content: [{ type: 'text', text: 'Keep the permission condition.' }] },
      { role: 'assistant', id: 'review-1', content: [], toolCalls: [{ id: 'review-call', type: 'function', name: 'TodoList', arguments: '{}' }] }];
    const main = makeFakeAgent('main', new Map(), history);
    const service = makeTodoService(makeLifecycleStub([main.handle]).service);
    service.setNotes({ directives: 'Keep the permission condition.' }, { turnId: 1, step: 1, toolCallId: 'first' });
    expect(service.getNotes().meta?.reviewedMessageId).toBeUndefined();
    service.setNotes({}, { turnId: 1, step: 2, toolCallId: 'review-call', reviewHandoff: true });
    const reviewed = service.getNotes();
    expect(reviewed.meta?.reviewedMessageId).toBe('review-1');
    expect(reviewed.meta?.writtenStep).toBe('t1.1');
    expect(reviewed.meta?.rev).toBe(1);
    history.push({ role: 'user', id: 'human-2', toolCalls: [], content: [{ type: 'text', text: 'New permission condition.' }] });
    service.setNotes({ next: 'run tests' }, { turnId: 2, step: 3, toolCallId: 'next' });
    expect(service.getNotes().meta).toMatchObject({ rev: 2, writtenStep: 't2.3', reviewedMessageId: 'review-1', coveredMessageId: '' });
    const before = service.getNotes();
    expect(() => service.setNotes({ next: 'must not write' }, { turnId: 999, step: 0, toolCallId: 'future', reviewHandoff: true })).toThrow('current conversation');
    expect(service.getNotes()).toEqual(before);
  });

  it('injects only the receiving agent list and removes providers on disposal', () => {
    const reminders = new Map<string, () => string | undefined>();
    const main = makeFakeAgent('main');
    const child = makeFakeAgent('child', reminders);
    const lifecycle = makeLifecycleStub([main.handle, child.handle]);
    const service = makeTodoService(lifecycle.service);
    service.setTodos([{ title: 'main private task', status: 'pending' }]);
    const provider = reminders.get(TODO_LIST_REMINDER_VARIANT)!;
    expect(provider()).toBeUndefined();
    service.setTodos([{ title: 'child task', status: 'pending' }], 'child');
    expect(provider()).toBeUndefined();
    expect(service.getTodos('child')).toEqual([{ title: 'child task', status: 'pending' }]);
    lifecycle.fireDispose('child');
    expect(reminders.size).toBe(0);
  });

  it('rolls back only child todo checkpoints and restores the same result from wire', async () => {
    const main = makeFakeAgent('main');
    const child = makeFakeAgent('child');
    const lifecycle = makeLifecycleStub([main.handle, child.handle]);
    const service = makeTodoService(lifecycle.service);
    service.setTodos([{ title: 'main stays', status: 'pending' }]);
    service.setTodos([{ title: 'child before turn', status: 'pending' }], 'child');
    await child.dispatcher.dispatch(new ContextAppendMessage({
      message: { role: 'user', content: [{ type: 'text', text: 'Start' }], toolCalls: [] },
    }));
    service.setTodos([{ title: 'child during turn', status: 'done' }], 'child');
    await child.dispatcher.dispatch(new ContextUndo({ count: 1 }));
    await child.dispatcher.dispatch(new ContextUndone({ turns: 1 }));
    expect(service.getTodos('child')).toEqual([{ title: 'child before turn', status: 'pending' }]);
    expect(service.getTodos()).toEqual([{ title: 'main stays', status: 'pending' }]);
    const restoredChild = makeFakeAgent('child');
    const restored = makeTodoService(makeLifecycleStub([restoredChild.handle]).service);
    await restoredChild.restore(child.journal);
    expect(restored.getTodos('child')).toEqual(service.getTodos('child'));
    expect(restored.getTodos()).toEqual([]);
  });

  it('isolates main and child storage, projections, clear and unknown targets', () => {
    const main = makeFakeAgent('main');
    const child = makeFakeAgent('child');
    const sibling = makeFakeAgent('sibling');
    const lifecycle = makeLifecycleStub([main.handle, child.handle, sibling.handle]);
    const service = makeTodoService(lifecycle.service);
    const mainEvents: Array<readonly TodoItem[]> = [];
    const agentEvents: string[] = [];
    service.onDidChange((todos) => mainEvents.push(todos));
    service.onDidChangeAgent(({ agentId }) => agentEvents.push(agentId));
    service.setTodos([{ title: 'main only', status: 'pending' }]);
    service.setTodos([{ title: 'child only', status: 'in_progress' }], 'child');
    service.setTodos([{ title: 'must not fall back', status: 'done' }], 'missing');
    expect(service.getTodos()).toEqual([{ title: 'main only', status: 'pending' }]);
    expect(service.getTodos('child')).toEqual([{ title: 'child only', status: 'in_progress' }]);
    expect(service.getTodos('sibling')).toEqual([]);
    expect(service.getTodos('missing')).toEqual([]);
    expect(main.journal).toHaveLength(1);
    expect(child.journal).toHaveLength(1);
    expect(sibling.journal).toEqual([]);
    service.clear('child');
    expect(service.getTodos('child')).toEqual([]);
    expect(service.getTodos()).toEqual([{ title: 'main only', status: 'pending' }]);
    expect(mainEvents).toHaveLength(1);
    expect(agentEvents).toEqual(['main', 'child', 'child']);
  });

  it('restores child wire independently and emits child-only undo updates', async () => {
    const main = makeFakeAgent('main');
    const child = makeFakeAgent('child');
    const lifecycle = makeLifecycleStub([main.handle, child.handle]);
    const service = makeTodoService(lifecycle.service);
    service.setTodos([{ title: 'legacy shared list', status: 'pending' }]);
    service.setTodos([{ title: 'new child list', status: 'in_progress' }], 'child');
    const events: string[] = [];
    service.onDidChangeAgent(({ agentId }) => events.push(agentId));
    await child.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'child restored', status: 'done' }] },
    ]);
    await child.dispatcher.dispatch(new ContextUndone({ turns: 1 }));
    await child.dispatcher.dispatch(new ContextUndone({ turns: 1 }));
    expect(events).toEqual(['child']);
    expect(service.getTodos('child')).toEqual([{ title: 'child restored', status: 'done' }]);
    expect(service.getTodos()).toEqual([{ title: 'legacy shared list', status: 'pending' }]);
    lifecycle.fireDispose('child');
    expect(service.getTodos('child')).toEqual([]);
  });

  it('starts empty and updates the list on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = makeTodoService(lifecycle.service);

    expect(service.getTodos()).toEqual([]);

    const next: TodoItem[] = [
      { title: 'a', status: 'pending' },
      { title: 'b', status: 'in_progress' },
    ];
    service.setTodos(next);
    expect(service.getTodos()).toEqual(next);

    service.clear();
    expect(service.getTodos()).toEqual([]);
  });

  it('fires onDidChange after each setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = makeTodoService(lifecycle.service);

    const seen: Array<readonly TodoItem[]> = [];
    const d = service.onDidChange((todos) => seen.push(todos));
    service.setTodos([{ title: 'x', status: 'pending' }]);
    service.setTodos([{ title: 'y', status: 'done' }]);
    d.dispose();

    expect(seen).toEqual([
      [{ title: 'x', status: 'pending' }],
      [{ title: 'y', status: 'done' }],
    ]);
  });

  it('fires the restored list once when undo changes the main wire state', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = makeTodoService(lifecycle.service);
    service.setTodos([{ title: 'doomed', status: 'in_progress' }]);

    const seen: Array<readonly TodoItem[]> = [];
    const subscription = service.onDidChange((todos) => seen.push(todos));
    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'kept', status: 'pending' }] },
    ]);
    await main.dispatcher.dispatch(new ContextUndone({ turns: 1 }));
    await main.dispatcher.dispatch(new ContextUndone({ turns: 1 }));
    subscription.dispose();

    expect(seen).toEqual([[{ title: 'kept', status: 'pending' }]]);
  });

  it('publishes undo corrections when only the review boundary changed', async () => {
    const history: ContextMessage[] = [{ role: 'assistant', id: 'review-boundary', content: [], toolCalls: [{ id: 'review', type: 'function', name: 'TodoList', arguments: '{}' }] }];
    const main = makeFakeAgent('main', new Map(), history);
    const service = makeTodoService(makeLifecycleStub([main.handle]).service);
    service.setNotes({ goal: 'keep' }, { turnId: 1, step: 1, toolCallId: 'content' });
    const original = service.getNotes();
    await main.dispatcher.dispatch(new ContextAppendMessage({ message: { role: 'user', content: [{ type: 'text', text: 'review now' }], toolCalls: [] } }));
    service.setNotes({}, { turnId: 2, step: 1, toolCallId: 'review', reviewHandoff: true });
    expect(service.getNotes().meta?.rev).toBe(original.meta?.rev);
    expect(service.getNotes().meta?.reviewedMessageId).toBe('review-boundary');
    await main.dispatcher.dispatch(new ContextUndo({ count: 1 }));
    const before = main.journal.length;
    await main.dispatcher.dispatch(new ContextUndone({ turns: 1 }));
    expect(service.getNotes()).toEqual(original);
    expect(main.journal.slice(before)).toContainEqual(expect.objectContaining({ type: 'tools.update_store', key: 'todo_notes', value: { notes: original.notes, notesMeta: original.meta } }));
    const reader = makeFakeAgent('main');
    const restored = makeTodoService(makeLifecycleStub([reader.handle]).service);
    await reader.restore(main.journal);
    expect(restored.getNotes()).toEqual(original);
  });

  it('persists notes separately from todo updates and rolls notes back with undo', async () => {
    const main = makeFakeAgent('main');
    const service = makeTodoService(makeLifecycleStub([main.handle]).service);
    service.setNotes({ goal: 'preserved' }, { turnId: 1, step: 3, toolCallId: 'first' });
    const before = service.getNotes().meta!;
    expect(before.writtenStep).toBe('t1.3');
    service.setTodos([{ title: 'x', status: 'pending' }]);
    expect(service.getNotes().notes).toEqual({ goal: 'preserved' });
    service.setNotes({ goal: 'preserved' }, { turnId: 2, step: 1, toolCallId: 'same' });
    expect(service.getNotes().meta?.rev).toBe(before.rev);
    expect(service.getNotes().meta?.writtenStep).toBe(before.writtenStep);
    expect(service.getNotes().meta?.coveredMessageId).toBe(before.coveredMessageId);
    await main.dispatcher.dispatch(new ContextAppendMessage({ message: { role: 'user', content: [{ type: 'text', text: 'next' }], toolCalls: [] } }));
    service.setNotes({ next: 'new work' }, { turnId: 2, step: 5, toolCallId: 'changed' });
    expect(service.getNotes().meta?.rev).toBe(before.rev + 1);
    expect(service.getNotes().meta?.writtenStep).toBe('t2.5');
    await main.dispatcher.dispatch(new ContextUndo({ count: 1 }));
    expect(service.getNotes().notes).toEqual({ goal: 'preserved' });
    const restoredMain = makeFakeAgent('main');
    const restored = makeTodoService(makeLifecycleStub([restoredMain.handle]).service);
    await restoredMain.restore(main.journal);
    expect(restored.getNotes().notes).toEqual(service.getNotes().notes);
    expect(restored.getTodos()).toEqual(service.getTodos());
  });

  it('appends a tools.update_store correction when undo rewinds a todo checkpoint', async () => {
    const main = makeFakeAgent('main');
    const service = makeTodoService(makeLifecycleStub([main.handle]).service);
    service.setTodos([{ title: 'kept', status: 'pending' }]);
    service.setNotes({ goal: 'kept goal' }, { turnId: 1, step: 1, toolCallId: 'notes-kept' });
    await main.dispatcher.dispatch(new ContextAppendMessage({ message: { role: 'user', content: [{ type: 'text', text: 'undo me' }], toolCalls: [] } }));
    service.setTodos([{ title: 'doomed', status: 'in_progress' }]);
    service.setNotes({ next: 'doomed work' }, { turnId: 2, step: 5, toolCallId: 'notes-doomed' });

    const before = main.journal.length;
    await main.dispatcher.dispatch(new ContextUndo({ count: 1 }));
    await main.dispatcher.dispatch(new ContextUndone({ turns: 1 }));

    expect(main.journal.slice(before).filter((record) => record.type === 'tools.update_store')).toEqual([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'kept', status: 'pending' }],
        time: expect.any(Number),
      },
      {
        type: 'tools.update_store',
        key: 'todo_notes',
        value: { notes: { goal: 'kept goal' }, notesMeta: expect.objectContaining({ rev: 1 }) },
        time: expect.any(Number),
      },
    ]);

    const reader = makeFakeAgent('main');
    const projection = makeTodoService(makeLifecycleStub([reader.handle]).service);
    await reader.restore(main.journal);
    expect(projection.getTodos()).toEqual(service.getTodos());
    expect(projection.getNotes()).toEqual(service.getNotes());

    const settled = main.journal.filter((record) => record.type === 'tools.update_store').length;
    await main.dispatcher.dispatch(new ContextUndone({ turns: 1 }));
    expect(main.journal.filter((record) => record.type === 'tools.update_store')).toHaveLength(settled);
  });

  it('appends a tools.update_store record to the main agent wire on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = makeTodoService(lifecycle.service);

    service.setTodos([{ title: 'persist me', status: 'in_progress' }]);

    expect(main.journal).toEqual([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'persist me', status: 'in_progress' }],
        time: expect.any(Number),
      },
    ]);
  });

  it('does not append to the wire when the main agent is absent', () => {
    const lifecycle = makeLifecycleStub();
    const service = makeTodoService(lifecycle.service);
    expect(() => service.setTodos([{ title: 'x', status: 'pending' }])).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('binds the stale-todo reminder into every created agent', () => {
    const lifecycle = makeLifecycleStub();
    const service = makeTodoService(lifecycle.service);
    void service;

    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    lifecycle.fireCreate(main.handle);
    lifecycle.fireCreate(sub.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(sub.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
  });

  it('rebuilds the list when a todo tools.update_store record is replayed', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = makeTodoService(lifecycle.service);

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'restored', status: 'done' }] },
    ]);

    expect(service.getTodos()).toEqual([{ title: 'restored', status: 'done' }]);
  });

  it('disposes per-agent bindings when the agent is disposed', () => {
    const lifecycle = makeLifecycleStub();
    const service = makeTodoService(lifecycle.service);
    const main = makeFakeAgent('main');
    lifecycle.fireCreate(main.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(() => lifecycle.fireDispose('main')).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('satisfies the ISessionTodoService contract', () => {
    const lifecycle = makeLifecycleStub();
    const service: ISessionTodoService = makeTodoService(lifecycle.service);
    expect(typeof service.getTodos).toBe('function');
    expect(typeof service.setTodos).toBe('function');
    expect(typeof service.clear).toBe('function');
    expect(typeof service.onDidChange).toBe('function');
  });

  it('cleans malformed items from a replayed todo tools.update_store record', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = makeTodoService(lifecycle.service);

    await main.restore([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'valid', status: 'done' },
          { title: 'missing status' },
          { title: 123, status: 'pending' },
          'garbage',
          { title: 'bad status', status: 'wip' },
        ],
      } as unknown as WireRecord,
    ]);

    expect(service.getTodos()).toEqual([{ title: 'valid', status: 'done' }]);
  });

  it('treats a non-array todo tools.update_store value as an empty list on replay', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = makeTodoService(lifecycle.service);

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: 'not-an-array' } as unknown as WireRecord,
    ]);

    expect(service.getTodos()).toEqual([]);
  });
});
