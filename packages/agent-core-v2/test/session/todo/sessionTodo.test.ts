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
import { ContextAppendMessage, ContextUndo } from '#/agent/contextMemory/contextEvents';
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
    register: (variant: string, provider: () => string | undefined) => {
      registeredVariants.push(variant);
      reminders.set(variant, provider);
      return toDisposable(() => { reminders.delete(variant); });
    },
  };

  const instantiationStub = {
    createInstance: (ctor: { name: string }) => ({ name: ctor.name }),
  };

  const memoryStub = {
    _serviceBrand: undefined,
    get: () => Array.from({ length: 10 }, () => ({ role: 'assistant', content: [], toolCalls: [] })),
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
  it('injects only the receiving agent list and removes providers on disposal', () => {
    const reminders = new Map<string, () => string | undefined>();
    const main = makeFakeAgent('main');
    const child = makeFakeAgent('child', reminders);
    const lifecycle = makeLifecycleStub([main.handle, child.handle]);
    const service = makeTodoService(lifecycle.service);
    service.setTodos([{ title: 'main private task', status: 'pending' }]);
    const provider = reminders.get(TODO_LIST_REMINDER_VARIANT)!;
    expect(provider()).not.toContain('main private task');
    service.setTodos([{ title: 'child task', status: 'pending' }], 'child');
    expect(provider()).toContain('child task');
    expect(provider()).not.toContain('main private task');
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
