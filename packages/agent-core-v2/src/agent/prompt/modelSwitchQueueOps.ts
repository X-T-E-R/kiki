import { z } from 'zod';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import { defineState } from '#/state/state';
import type { ModelSwitchInput, ModelSwitchReceipt } from '#/agent/modelSwitch/modelSwitch';

export interface QueuedModelSwitch {
  readonly input: ModelSwitchInput;
  readonly receipt: ModelSwitchReceipt;
  readonly revision: number;
  readonly originalBinding: { readonly model: string; readonly thinking: string };
}

export class ModelSwitchQueued extends Event2<{ entry: QueuedModelSwitch; queueIndex: number }> {
  declare readonly entry: QueuedModelSwitch;
  declare readonly queueIndex: number;
  static override readonly type = 'prompt.model_switch_queued';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = z.object({ entry: z.custom<QueuedModelSwitch>(), queueIndex: z.number().int().nonnegative() });
}

export class ModelSwitchQueueStatus extends Event2<{ operationId: string; receipt: ModelSwitchReceipt }> {
  declare readonly operationId: string;
  declare readonly receipt: ModelSwitchReceipt;
  static override readonly type = 'prompt.model_switch_status';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = z.object({ operationId: z.string().min(1), receipt: z.custom<ModelSwitchReceipt>() });
}

export const modelSwitchQueueKey = defineState('prompt.modelSwitches', (): Map<string, QueuedModelSwitch> => new Map())
  .replayable({ schema: z.custom<Map<string, QueuedModelSwitch>>() })
  .on(ModelSwitchQueued, (state, event) => { state.set(event.entry.input.operationId, event.entry); })
  .on(ModelSwitchQueueStatus, (state, event) => {
    const entry = state.get(event.operationId);
    if (entry !== undefined) state.set(event.operationId, { ...entry, receipt: event.receipt });
  });

registerEvent2Class(ModelSwitchQueued);
registerEvent2Class(ModelSwitchQueueStatus);
