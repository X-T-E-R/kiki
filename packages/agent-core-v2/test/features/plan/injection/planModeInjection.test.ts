import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeHostFs } from '../../../tools/fixtures/fake-exec';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPlanService } from '#/features/plan/plan';
import {
  createTestAgent,
  execEnvServices,
  type TestAgentContext,
} from '../../../harness';

type InjectableDynamicInjector = IAgentContextInjectorService;

async function enterPlan(
  plan: IAgentPlanService,
  id = 'test-plan',
): Promise<string> {
  await plan.enter(id, false);
  const status = await plan.status();
  if (status === null) {
    throw new Error('expected plan file path');
  }
  return status.path;
}

async function injectDynamic(injector: InjectableDynamicInjector): Promise<void> {
  await injector.reconcileAllAtSafeBoundary();
}

function appendAssistantTurn(
  ctx: TestAgentContext,
  context: IAgentContextMemoryService,
  text: string,
): void {
  ctx.appendAssistantTurn(context.get().length, text);
}

function planReminderMessages(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'plan_mode';
  });
}

function lastPlanReminder(context: IAgentContextMemoryService): string {
  const message = planReminderMessages(context).at(-1);
  if (message === undefined) return '';
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('PlanModeService dynamic injection content', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: InjectableDynamicInjector;
  let plan: IAgentPlanService;
  let readText: (path: string) => Promise<string>;

  beforeEach(() => {
    readText = async () => '';
    ctx = createTestAgent(execEnvServices({
      hostFs: createFakeHostFs({
        mkdir: vi.fn().mockResolvedValue(undefined),
        readText: (path: string) => readText(path),
        writeText: vi.fn(async () => undefined),
      }),
    }));
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector;
    plan = ctx.get(IAgentPlanService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('injects the full reminder with the current plan file footer', async () => {
    const planFilePath = await enterPlan(plan);

    await injectDynamic(injector);
    const text = lastPlanReminder(context);

    expect(text).toContain('Write');
    expect(text).toContain('Edit');
    expect(text).toContain('ExitPlanMode');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('derives a plan file path before injecting the full reminder', async () => {
    const planFilePath = await enterPlan(plan, 'derived-plan');

    await injectDynamic(injector);

    expect(planFilePath).toContain('derived-plan.md');
    expect(lastPlanReminder(context)).toContain(`Plan file: ${planFilePath}`);
  });

  it('injects the exit reminder when plan mode turns off after being active', async () => {
    await enterPlan(plan);

    await injectDynamic(injector);
    plan.exit();
    await injectDynamic(injector);

    expect(planReminderMessages(context)).toHaveLength(2);
    expect(lastPlanReminder(context)).toContain('not user approval to implement');
    expect(lastPlanReminder(context)).toContain("user's current authorization");
    expect(lastPlanReminder(context)).toContain('keep their lifetime restrictions');
  });

  it('does not inject anything when plan mode is inactive from the start', async () => {
    await injectDynamic(injector);

    expect(planReminderMessages(context)).toHaveLength(0);
    expect(context.get()).toEqual([
      expect.objectContaining({
        origin: expect.objectContaining({ kind: 'injection', variant: 'permission_mode' }),
        content: [expect.objectContaining({ text: expect.stringContaining('Auto permission mode is active') })],
      }),
    ]);
  });

  it('injects a reentry reminder when restored plan mode already has plan content', async () => {
    readText = vi.fn(async () => '# Existing Plan\n\n- Keep this context');
    await ctx.dispatch({
      type: 'plan_mode.enter',
      id: 'restored-plan',
    });

    await injectDynamic(injector);

    const text = lastPlanReminder(context);
    expect(text).toContain('Re-entering Plan Mode');
    expect(text).toContain('do not edit it merely to re-enter or leave plan mode');
    expect(text).toContain('end the turn normally and continue on notification');
    expect(text).toContain('Answer a direct question about the plan normally');
    expect(text).not.toMatch(/Always edit|turn must end|supersedes any other/);
  });
});

describe('PlanModeService dynamic injection cadence', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let injector: InjectableDynamicInjector;
  let plan: IAgentPlanService;

  beforeEach(() => {
    ctx = createTestAgent(execEnvServices({
      hostFs: createFakeHostFs({
        mkdir: vi.fn().mockResolvedValue(undefined),
        readText: async () => '',
        writeText: vi.fn(async () => undefined),
      }),
    }));
    context = ctx.get(IAgentContextMemoryService);
    injector = ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector;
    plan = ctx.get(IAgentPlanService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('skips reinjection before the assistant-turn threshold', async () => {
    await enterPlan(plan);

    await injectDynamic(injector);
    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(injector);

    expect(planReminderMessages(context)).toHaveLength(1);
  });

  it('does not inject a sparse heartbeat after two assistant steps', async () => {
    const planFilePath = await enterPlan(plan);

    await injectDynamic(injector);
    appendAssistantTurn(ctx, context, 'assistant one');
    appendAssistantTurn(ctx, context, 'assistant two');
    await injectDynamic(injector);

    const text = lastPlanReminder(context);
    expect(planReminderMessages(context)).toHaveLength(1);
    expect(text).not.toContain('Plan mode still active');
    expect(text).toContain(`Plan file: ${planFilePath}`);
  });

  it('does not refresh the full reminder after five assistant steps', async () => {
    await enterPlan(plan);
    await injectDynamic(injector);
    for (let i = 0; i < 5; i += 1) appendAssistantTurn(ctx, context, `assistant ${String(i)}`);
    await injectDynamic(injector);
    expect(planReminderMessages(context)).toHaveLength(1);
  });

  it('does not refresh unchanged plan constraints for a new user input', async () => {
    await enterPlan(plan);
    await injectDynamic(injector);
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(injector);
    expect(planReminderMessages(context)).toHaveLength(1);
    plan.exit();
    await injectDynamic(injector);
    await enterPlan(plan);
    await injectDynamic(injector);
    expect(planReminderMessages(context)).toHaveLength(3);
  });
});
