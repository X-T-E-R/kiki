import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import { createTestAgent, type TestAgentContext } from '../../harness';

interface DeliveryAppendRecord {
  readonly type: string;
  readonly message?: { readonly id?: string };
  readonly delivery?: {
    readonly deliveryId: string;
    readonly messageId: string;
    readonly origin: string;
  };
}

describe('AgentSystemReminderService delivery routing', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let reminders: IAgentSystemReminderService;

  beforeEach(() => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    reminders = ctx.get(IAgentSystemReminderService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function recordObservableAppends(): DeliveryAppendRecord[] {
    const events: DeliveryAppendRecord[] = [];
    ctx.get(IEventBus).subscribe((event) => {
      const record = event as DeliveryAppendRecord;
      if (record.type === 'context.append_message') events.push(record);
    });
    return events;
  }

  it('appends a system reminder as an observable user message with delivery metadata', () => {
    const events = recordObservableAppends();

    reminders.appendSystemReminder('Remember this.', { kind: 'injection', variant: 'host' });

    const stored = context.get().at(-1);
    expect(stored?.role).toBe('user');
    expect(typeof stored?.id).toBe('string');
    expect(stored?.origin).toEqual({ kind: 'injection', variant: 'host' });
    expect(events).toHaveLength(1);
    expect(events[0]?.message?.id).toBe(stored?.id);
    expect(events[0]?.delivery).toEqual(
      expect.objectContaining({
        origin: 'injection',
        messageId: stored?.id,
        deliveryId: expect.stringMatching(/^dlv_/),
      }),
    );
  });

  it('derives the delivery channel from the reminder origin kind', () => {
    const events = recordObservableAppends();

    reminders.appendSystemReminder('Shell finished.', { kind: 'shell_command', phase: 'output' });

    expect(events).toHaveLength(1);
    expect(events[0]?.delivery?.origin).toBe('queue');
  });
});
