import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { AgentContextInjectorService } from '#/agent/contextInjector/contextInjectorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { AgentSwarmService } from '#/features/swarm/agent/swarmService';
import SWARM_MODE_ENTER_REMINDER from '../../../src/features/swarm/agent/enter-reminder.md?raw';
import { swarmKey } from '#/features/swarm/swarmOps';
import { IAgentSystemReminderService, wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { tokenCountingKey } from '#/agent/tokenCounting/tokenCountingOps';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubLog } from '../../_base/log/stubs';
import { stubLoopWithHooks } from '../../agent/loop/stubs';
import { stubToolExecutorEvents } from '../../agent/toolExecutor/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';
import { createTestAgent } from '../../harness';

const signal = new AbortController().signal;
const HISTORIC_SUBAGENT_SUSPENDED_RECORD: WireRecord = {
  type: 'subagent.suspended',
  subagentId: 'child-3',
  reason: 'approval',
  time: 5_000,
};

async function runInjectionBoundary(loop: IAgentLoopService): Promise<void> {
  await loop.hooks.onWillBeginStep.run({ turnId: 0, step: 1, firstStepOfTurn: true, signal });
}

function messageText(message: ContextMessage | undefined): string {
  return (
    message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
  );
}

function swarmReminder(
  content: string,
  disclosure?: { readonly kind: 'swarm_mode'; readonly state: 'active' },
): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: wrapSystemReminder(content) }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'swarm_mode', disclosure },
  };
}

describe('AgentSwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(ILogService, stubLog());
    ix.stub(IAgentTokenCountingService, {
      estimateText: () => 0,
      estimateMessage: () => 0,
      estimateMessages: () => 0,
    } as unknown as IAgentTokenCountingService);
    ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IAgentContextInjectorService, new SyncDescriptor(AgentContextInjectorService));
    ix.stub(IAgentToolApprovalService, {
      formatDenyMessage: (message: string) => message,
    });
    ix.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    registerTestAgentWire(ix, testWireScope('wire', 'swarm-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    registerTestEventDispatcher(ix);
    ix.get(IAgentStateService).contributeState(tokenCountingKey);
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.set(IAgentSwarmService, new SyncDescriptor(AgentSwarmService));
  });
  afterEach(() => {
    disposables.dispose();
  });

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const swarm = ix.get(IAgentSwarmService);
    const events: { readonly type: string; readonly swarmMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, swarmMode: (e as AgentStatusUpdated).swarmMode });
        }
      }),
    );

    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', swarmMode: true },
      { type: 'agent.status.updated', swarmMode: false },
    ]);
  });

  it('renders enter guidance when manual swarm mode becomes active', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);

    swarm.enter('manual');
    await runInjectionBoundary(ix.get(IAgentLoopService));

    const reminder = context.get().at(-1);
    expect(reminder?.origin).toEqual({
      kind: 'injection',
      variant: 'swarm_mode',
      disclosure: { kind: 'swarm_mode', state: 'active' },
    });
    expect(context.get()).toHaveLength(1);
  });

  it('keeps one enter guidance when a later boundary sees the same active state', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);

    swarm.enter('manual');
    await runInjectionBoundary(ix.get(IAgentLoopService));
    await runInjectionBoundary(ix.get(IAgentLoopService));

    expect(context.get()).toHaveLength(1);
  });

  it('removes trailing enter guidance when manual swarm mode becomes inactive', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);

    swarm.enter('manual');
    await runInjectionBoundary(ix.get(IAgentLoopService));
    swarm.exit();
    await runInjectionBoundary(ix.get(IAgentLoopService));

    expect(context.get()).toHaveLength(0);
  });

  it('keeps enter guidance when a later context message makes it non-trailing', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);

    swarm.enter('manual');
    await runInjectionBoundary(ix.get(IAgentLoopService));
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'later prompt' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    swarm.exit();

    expect(context.get()).toHaveLength(2);
    expect(context.get()[0]?.origin).toMatchObject({
      kind: 'injection',
      variant: 'swarm_mode',
    });
    expect(messageText(context.get()[1])).toBe('later prompt');
  });

  it('renders no reminder at all for tool-triggered swarms', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);

    swarm.enter('tool');
    await runInjectionBoundary(ix.get(IAgentLoopService));
    swarm.exit();
    await runInjectionBoundary(ix.get(IAgentLoopService));

    expect(context.get()).toHaveLength(0);
  });

  it('does not duplicate the enter guidance on resume while it is still live in history', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);
    await restoreTestEventDispatcher(
      ix.get(IEventDispatcher),
      ix.get(IAppendLogStore),
      testWireScope('wire', 'swarm-test'),
      [
        { type: 'context.append_message', message: swarmReminder(SWARM_MODE_ENTER_REMINDER) },
        { type: 'swarm_mode.enter', trigger: 'manual' },
      ],
    );

    await runInjectionBoundary(ix.get(IAgentLoopService));

    expect(swarm.isActive).toBe(true);
    expect(context.get()).toHaveLength(1);
  });

  it('replays exit by removing a trailing enter reminder', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);
    await restoreTestEventDispatcher(
      ix.get(IEventDispatcher),
      ix.get(IAppendLogStore),
      testWireScope('wire', 'swarm-test'),
      [
        { type: 'context.append_message', message: swarmReminder(SWARM_MODE_ENTER_REMINDER) },
        { type: 'swarm_mode.enter', trigger: 'manual' },
        { type: 'swarm_mode.exit' },
      ],
    );

    await runInjectionBoundary(ix.get(IAgentLoopService));

    expect(swarm.isActive).toBe(false);
    expect(context.get()).toHaveLength(0);
  });

  it('derives the rendered state from the disclosure, not the reminder text', async () => {
    const swarm = ix.get(IAgentSwarmService);
    const context = ix.get(IAgentContextMemoryService);
    await restoreTestEventDispatcher(
      ix.get(IEventDispatcher),
      ix.get(IAppendLogStore),
      testWireScope('wire', 'swarm-test'),
      [
        {
          type: 'context.append_message',
          message: swarmReminder('outdated enter copy', {
            kind: 'swarm_mode',
            state: 'active',
          }),
        },
        { type: 'swarm_mode.enter', trigger: 'manual' },
      ],
    );

    await runInjectionBoundary(ix.get(IAgentLoopService));

    expect(swarm.isActive).toBe(true);
    expect(context.get()).toHaveLength(1);
  });

  it('dispatch persists enter/exit records and replay rebuilds the trigger (silent)', async () => {
    const swarm = ix.get(IAgentSwarmService);
    swarm.enter('manual');

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'swarm-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'swarm_mode.enter', trigger: 'manual', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix2, testWireScope('wire', 'swarm-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    const fresh = registerTestEventDispatcher(ix2);
    const freshState = ix2.get(IAgentStateService);
    freshState.contributeState(swarmKey);
    await restoreTestEventDispatcher(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'swarm-replay'),
      records,
    );
    expect(freshState.get(swarmKey)).toBe('manual');
  });
});

describe('swarm context reconciliation', () => {
  it('renders the corrective exit again when undo removes the latest exit render', async () => {
    const ctx = createTestAgent();
    try {
      const swarm = ctx.get(IAgentSwarmService);
      swarm.enter('manual');
      ctx.mockNextResponse({ type: 'text', text: 'first answer' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
      await ctx.untilTurnEnd();

      swarm.exit();
      ctx.mockNextResponse({ type: 'text', text: 'second answer' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
      await ctx.untilTurnEnd();

      await ctx.undoHistory(1);
      ctx.mockNextResponse({ type: 'text', text: 'third answer' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'third prompt' }] });
      await ctx.untilTurnEnd();

      const reminders = ctx.contextData().history.filter(
        (message) =>
          message.origin?.kind === 'injection' && message.origin.variant === 'swarm_mode',
      );
      const latest = reminders.at(-1);
      const text = latest?.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('');
      expect(text).toContain('Swarm Mode has ended.');
    } finally {
      await ctx.dispose();
    }
  });
});

describe('retired AgentSwarm tool', () => {
  it('omits AgentSwarm from the tool registry while decoding historic suspended events', async () => {
    const ctx = createTestAgent();
    try {
      expect(ctx.get(IAgentToolRegistryService).resolve('AgentSwarm')).toBeUndefined();
      await ctx.dispatch(HISTORIC_SUBAGENT_SUSPENDED_RECORD);
      await expect(ctx.persistedWireRecords()).resolves.toContainEqual(
        HISTORIC_SUBAGENT_SUSPENDED_RECORD,
      );
    } finally {
      await ctx.dispose();
    }
  });
});
