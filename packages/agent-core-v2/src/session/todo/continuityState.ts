import { z } from 'zod';
import { defineState } from '#/state/state';
import { TurnPrompt, TurnSteer } from '#/agent/loop/turnOps';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { ToolsUpdateStore } from './todoOps';
import { hashTodoNotes, type TodoNotes } from './todoNotes';
import type { TodoReminderDisclosure } from './todoListReminder';

export interface ContinuityClock {
  readonly humanTurnOrdinal: number;
  readonly humanInputRevision: number;
  readonly workStepOrdinal: number;
  readonly lastTodoU: number;
  readonly lastNotesU: number;
  readonly lastNotesStep: number;
  readonly lastProgressU: number;
  readonly lastProgressStep: number;
  readonly progressCount: number;
  readonly todoReminderCount: number;
  readonly notesReminderCount: number;
  readonly stateRevision: number;
  readonly todoHash: string;
  readonly notesHash: string;
  readonly latestInput?: { readonly id: string; readonly text: string; readonly turn?: number };
  readonly humanBoundary: boolean;
  readonly inputIds: readonly string[];
  readonly stepIds: readonly string[];
  readonly deliveredInputs: readonly string[];
  readonly historyReferences?: readonly { topic: string; humanTurnOrdinal: number; stateRevision: number }[];
  readonly openStep?: string;
  readonly pollingCalls: readonly string[];
  readonly substantial: boolean;
}

export function initialContinuityClock(): ContinuityClock {
  return { humanTurnOrdinal: 0, humanInputRevision: 0, workStepOrdinal: 0, lastTodoU: 0, lastNotesU: 0,
    lastNotesStep: 0, lastProgressU: 0, lastProgressStep: 0, progressCount: 0, todoReminderCount: 0, notesReminderCount: 0, stateRevision: 0, todoHash: '', notesHash: hashTodoNotes(undefined),
    humanBoundary: false, inputIds: [], stepIds: [], deliveredInputs: [], pollingCalls: [], substantial: false };
}

export function isHumanOrigin(origin: PromptOrigin | undefined): boolean {
  return origin?.kind === 'user' || origin?.kind === 'plugin_command' ||
    (origin?.kind === 'skill_activation' && origin.trigger === 'user-slash');
}

export function originalHumanText(message: ContextMessage): string | undefined {
  const origin = message.origin;
  if (!isHumanOrigin(origin)) return undefined;
  if (origin?.kind === 'plugin_command') return origin.commandArgs ?? '';
  if (origin?.kind === 'skill_activation') return origin.skillArgs ?? '';
  const content = origin?.kind === 'user' ? origin.originalInput ?? (origin.skillActivations?.length ? [] : message.content) : [];
  return content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

export function advanceContinuityClock(state: ContinuityClock, event: TurnPrompt | TurnSteer | ContextAppendLoopEvent | ContextAppendMessage | ToolsUpdateStore): ContinuityClock {
  if (event.type === TurnPrompt.type || event.type === TurnSteer.type) {
    const input = event as TurnPrompt;
    if (!isHumanOrigin(input.origin)) return { ...state, humanBoundary: false };
    const id = `${input.promptId ?? `t${input.turnId}`}@${input.revision ?? 0}`;
    if (state.inputIds.includes(id)) return state;
    const text = originalHumanText({ role: 'user', toolCalls: [], content: [...input.input], origin: input.origin }) ?? '';
    return { ...state, humanTurnOrdinal: state.humanTurnOrdinal + (event.type === TurnPrompt.type ? 1 : 0),
      humanInputRevision: state.humanInputRevision + 1, humanBoundary: true,
      latestInput: { id, text, turn: input.turnId }, inputIds: [...state.inputIds, id] };
  }
  if (event.type === ContextAppendLoopEvent.type) {
    const loop = (event as ContextAppendLoopEvent).event;
    if (loop.type === 'step.begin') return { ...state, openStep: loop.uuid, substantial: false, pollingCalls: [] };
    if (loop.type === 'content.part' && loop.part.type === 'text' && loop.part.text.trim()) return { ...state, substantial: true };
    if (loop.type === 'tool.result' && !state.pollingCalls.includes(loop.toolCallId) && !loop.result.isError &&
      (typeof loop.result.output !== 'string' || loop.result.output.trim().length > 0)) return { ...state, substantial: true };
    if (loop.type === 'tool.call' && ['TaskWait', 'TaskOutput', 'TaskList', 'AgentList'].includes(loop.name)) {
      return { ...state, substantial: false, pollingCalls: [...state.pollingCalls, loop.toolCallId] };
    }
    const stepId = loop.type === 'step.end' ? loop.turnId === undefined || loop.step === undefined ? loop.uuid : `t${loop.turnId}.${loop.step}` : undefined;
    if (stepId !== undefined && state.substantial && !state.stepIds.includes(stepId)) {
      return { ...state, workStepOrdinal: state.workStepOrdinal + 1, stepIds: [...state.stepIds, stepId], substantial: false };
    }
    return state;
  }
  if (event.type === ToolsUpdateStore.type) {
    const update = event as ToolsUpdateStore;
    if (update.key === 'todo') {
      const hash = JSON.stringify(update.value);
      if (hash === state.todoHash) return state;
      return { ...state, todoHash: hash, lastTodoU: state.humanTurnOrdinal, progressCount: 0, todoReminderCount: 0, stateRevision: state.stateRevision + 1 };
    }
    if (update.key === 'todo_notes') {
      const hash = hashTodoNotes((update.value as { notes?: TodoNotes }).notes);
      if (hash === state.notesHash) return state;
      return { ...state, notesHash: hash, lastNotesU: state.humanTurnOrdinal, lastNotesStep: state.workStepOrdinal, progressCount: 0, notesReminderCount: 0, stateRevision: state.stateRevision + 1 };
    }
    return state;
  }
  const message = (event as ContextAppendMessage).message;
  if (message.origin?.kind !== 'injection' || message.origin.variant !== 'todo_list_reminder') return state;
  const disclosure = message.origin.disclosure as TodoReminderDisclosure | undefined;
  const delivered = disclosure?.inputId === undefined || state.deliveredInputs.includes(disclosure.inputId) ||
    !disclosure.triggers.some((trigger) => trigger === 'E1' || trigger === 'E2')
    ? state.deliveredInputs : [...state.deliveredInputs, disclosure.inputId];
  const historyReferences = disclosure?.historyTopic !== undefined && disclosure.triggers.includes('E2')
    ? [...(state.historyReferences ?? []).filter((item) => item.topic !== disclosure.historyTopic),
      { topic: disclosure.historyTopic, humanTurnOrdinal: state.humanTurnOrdinal, stateRevision: state.stateRevision }]
    : state.historyReferences;
  if (!disclosure?.triggers.some((trigger) => trigger === 'T0' || trigger === 'T1')) return { ...state, deliveredInputs: delivered, historyReferences };
  return { ...state, deliveredInputs: delivered, historyReferences, lastProgressU: state.humanTurnOrdinal,
    lastProgressStep: state.workStepOrdinal, progressCount: state.progressCount + 1,
    todoReminderCount: state.todoReminderCount + (disclosure.triggers.includes('T0') ? 1 : 0),
    notesReminderCount: state.notesReminderCount + (disclosure.triggers.includes('T1') ? 1 : 0) };
}

export const continuityClockKey = defineState('todo.continuityClock', initialContinuityClock)
  .replayable({ schema: z.custom<ContinuityClock>() })
  .on(TurnPrompt, advanceContinuityClock)
  .on(TurnSteer, advanceContinuityClock)
  .on(ContextAppendLoopEvent, advanceContinuityClock)
  .on(ContextAppendMessage, advanceContinuityClock)
  .on(ToolsUpdateStore, advanceContinuityClock);
