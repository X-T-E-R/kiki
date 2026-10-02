/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import { defineState } from '#/state/state';

const configuredSchema = z.object({ rules: z.array(z.object({ id: z.string(), semanticHash: z.string(), counterScope: z.enum(['agent', 'turn']) })) });
export class HookRulesConfigured extends Event2<z.infer<typeof configuredSchema>> {
  static override readonly type = 'hook.rules.configured';
  static override readonly durable = true;
  static override readonly schema = configuredSchema;
}
export interface HookRulesConfigured extends z.infer<typeof configuredSchema> {}
registerEvent2Class(HookRulesConfigured);

const preparedSchema = z.object({
  stepId: z.string(), logicalStepId: z.string(), turnId: z.number(), modelId: z.string(),
  targets: z.array(z.object({ id: z.string(), partition: z.string(), semanticRevision: z.string() })),
});
export class HookStepPrepared extends Event2<z.infer<typeof preparedSchema>> {
  static override readonly type = 'hook.step.prepared';
  static override readonly durable = true;
  static override readonly schema = preparedSchema;
}
export interface HookStepPrepared extends z.infer<typeof preparedSchema> {}
registerEvent2Class(HookStepPrepared);

export interface HookBucket {
  readonly completed: number;
  readonly delivered: number;
  readonly lastStepId?: string;
  readonly lastEventId?: string;
}
export interface HookRuleClock {
  readonly semanticHash: string;
  readonly revision: number;
  readonly counterScope: 'agent' | 'turn';
  readonly buckets: Readonly<Record<string, HookBucket>>;
}
export interface HooksState {
  readonly rules: Readonly<Record<string, HookRuleClock>>;
  readonly revisionClock: number;
  readonly completed: Readonly<Record<string, number>>;
  readonly completedInTurn: Readonly<Record<string, number>>;
  readonly turnId?: number;
  readonly lastStepId?: string;
  readonly prepared?: z.infer<typeof preparedSchema>;
}

export const hookReceiptSchema = z.object({
  hookId: z.string(), semanticRevision: z.string(), partition: z.string(),
  milestone: z.number().int().nonnegative(), eventId: z.string(), key: z.string(),
});
export type HookReceipt = z.infer<typeof hookReceiptSchema>;
export class HookObserved extends Event2<HookReceipt> {
  static override readonly type = 'hook.observed';
  static override readonly durable = true;
  static override readonly schema = hookReceiptSchema;
}
export interface HookObserved extends HookReceipt {}
registerEvent2Class(HookObserved);

export const hookStateKey = defineState<HooksState>('externalHooks.clock', () => ({
  rules: {}, revisionClock: 0, completed: {}, completedInTurn: {},
})).replayable({ schema: z.custom<HooksState>() })
  .on(HookRulesConfigured, (state, event) => {
    const rules: Record<string, HookRuleClock> = {};
    let revisionClock = state.revisionClock;
    for (const rule of event.rules) {
      const previous = state.rules[rule.id];
      rules[rule.id] = previous?.semanticHash === rule.semanticHash ? previous : {
        semanticHash: rule.semanticHash, revision: ++revisionClock, counterScope: rule.counterScope, buckets: {},
      };
    }
    return { ...state, rules, revisionClock };
  })
  .on(HookStepPrepared, (state, event) => {
    const rules = state.turnId === event.turnId ? state.rules : Object.fromEntries(Object.entries(state.rules).map(([id, rule]) => [id, rule.counterScope === 'turn' ? { ...rule, buckets: {} } : rule]));
    return {
      ...state, rules, prepared: { stepId: event.stepId, logicalStepId: event.logicalStepId, turnId: event.turnId, modelId: event.modelId, targets: event.targets },
      turnId: event.turnId, completedInTurn: state.turnId === event.turnId ? state.completedInTurn : {},
    };
  })
  .on(ContextAppendLoopEvent, (state, { event }) => {
    const step = state.prepared;
    if (event.type !== 'step.end' || step === undefined || event.uuid !== step.stepId ||
        event.finishReason === undefined || ['error', 'interrupted', 'filtered'].includes(event.finishReason) ||
        state.lastStepId === step.logicalStepId) return;
    const rules = { ...state.rules };
    for (const target of step.targets) {
      const rule = rules[target.id];
      if (rule === undefined || semanticRevision(rule) !== target.semanticRevision) continue;
      const bucket = rule.buckets[target.partition] ?? { completed: 0, delivered: 0 };
      if (bucket.lastStepId === step.logicalStepId) continue;
      rules[target.id] = { ...rule, buckets: { ...rule.buckets, [target.partition]: { ...bucket, completed: bucket.completed + 1, lastStepId: step.logicalStepId } } };
    }
    return {
      ...state, rules, lastStepId: step.logicalStepId,
      completed: { ...state.completed, [step.modelId]: (state.completed[step.modelId] ?? 0) + 1 },
      completedInTurn: { ...state.completedInTurn, [step.modelId]: (state.completedInTurn[step.modelId] ?? 0) + 1 },
    };
  })
  .on(ContextAppendMessage, (state, { message }) => {
    if (message.origin?.kind !== 'injection' || !message.origin.variant.startsWith('hook_rule/')) return;
    const parsed = hookReceiptSchema.safeParse(message.origin.disclosure);
    if (parsed.success) return recordHookReceipt(state, parsed.data);
  })
  .on(HookObserved, (state, receipt) => recordHookReceipt(state, receipt));

function recordHookReceipt(state: HooksState, receipt: HookReceipt): HooksState | undefined {
  const rule = state.rules[receipt.hookId];
  if (rule === undefined || semanticRevision(rule) !== receipt.semanticRevision) return;
  const bucket = rule.buckets[receipt.partition] ?? { completed: 0, delivered: 0 };
  return { ...state, rules: { ...state.rules, [receipt.hookId]: {
    ...rule, buckets: { ...rule.buckets, [receipt.partition]: { ...bucket, delivered: Math.max(bucket.delivered, receipt.milestone), lastEventId: receipt.eventId } },
  } } };
}

export function semanticRevision(rule: HookRuleClock): string { return `${rule.semanticHash}:${rule.revision}`; }

export function hookPartition(modelId: string, turnId: number | undefined, scope: 'agent' | 'turn'): string {
  return scope === 'turn' ? JSON.stringify([turnId, modelId]) : modelId;
}
