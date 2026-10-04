import { z } from 'zod';
import { defineState } from '#/state/state';
import type { ContextMessageSource } from '#/agent/contextMemory/types';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { originalHumanText } from '#/session/todo/continuityState';
import type { ModelSwitchInput, ModelSwitchReceipt } from './modelSwitch';
import { AgentModelSwitch } from './modelSwitchEvent';

export { AgentModelSwitch } from './modelSwitchEvent';

export interface ModelSwitchCompletion {
  readonly input: ModelSwitchInput;
  readonly receipt: ModelSwitchReceipt;
}

export const modelSwitchCompletionsKey = defineState('modelSwitch.completions', (): Map<string, ModelSwitchCompletion> => new Map())
  .replayable({ schema: z.custom<Map<string, ModelSwitchCompletion>>() })
  .on(AgentModelSwitch, (s, e) => {
    s.set(e.operationId, { input: e.input, receipt: {
      operationId: e.operationId, agentId: e.agentId, state: 'completed', fromModel: e.fromModel,
      toModel: e.toModel, mode: e.mode, binding: { model: e.toModel, thinking: e.thinking },
      windowEpoch: e.newEpoch, summaryGenerated: e.summaryGenerated,
    } });
  });

export interface ModelSwitchInputReference {
  readonly text: string;
  readonly messageId?: string;
  readonly source?: ContextMessageSource;
  readonly truncated?: boolean;
}

export interface ModelSwitchContinuityState {
  readonly latestHumanInput?: ModelSwitchInputReference;
  readonly taskDescription?: ModelSwitchInputReference;
}

export const modelSwitchContinuityKey = defineState('modelSwitch.continuity', (): ModelSwitchContinuityState => ({}))
  .replayable({ schema: z.custom<ModelSwitchContinuityState>() })
  .undoable()
  .on(ContextAppendMessage, (s, e) => {
    const message = e.message;
    const legacyHumanText = message.role === 'user' && message.origin === undefined
      ? message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') : undefined;
    const text = originalHumanText(message) ?? legacyHumanText;
    const reference = (body: string): ModelSwitchInputReference => ({ text: body.slice(0, 12_000), messageId: message.id, source: message.source, truncated: body.length > 12_000 });
    if (text?.trim()) s.latestHumanInput = reference(text);
    if (s.taskDescription === undefined && message.role === 'user' && message.origin?.kind === 'system_trigger' && message.origin.name === 'subagent') {
      s.taskDescription = reference(message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'));
    }
  });
