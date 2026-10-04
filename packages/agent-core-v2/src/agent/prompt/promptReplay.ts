import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import type { PromptInput, PromptTerminalResult } from './prompt';

export interface PromptLookup {
  readonly promptId: string;
  readonly phase: 'pending' | 'launched' | 'terminal';
  readonly turnId?: number;
  readonly terminal?: PromptTerminalResult;
}

export class PromptOutcomeCommitted extends Event2<{ terminal: PromptTerminalResult }> {
  declare readonly terminal: PromptTerminalResult;
  static override readonly type = 'prompt.outcome_committed';
  static override readonly durable = true;
  static override readonly schema = z.object({ terminal: z.custom<PromptTerminalResult>() });
}
registerEvent2Class(PromptOutcomeCommitted);

export function promptFingerprint(input: Pick<PromptInput, 'message' | 'execution' | 'appendTiming' | 'alreadyMaterialized' | 'deferredDisabledTools'>): string {
  const value = { message: { ...input.message, id: undefined }, execution: input.execution,
    appendTiming: input.appendTiming ?? 'agent_idle', alreadyMaterialized: input.alreadyMaterialized === true,
    deferredDisabledTools: input.deferredDisabledTools };
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
  return createHash('sha256').update(canonical).digest('hex');
}
