import { z } from 'zod';
import { defineState } from '#/state/state';
import { TurnPrompt, TurnSteer } from '#/agent/loop/turnOps';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { ToolsUpdateStore } from './todoOps';
import { hashTodoNotes, type TodoNotes } from './todoNotes';
import type { TodoReminderDisclosure } from './todoListReminder';
import { initialMemoryMaintenance, type MemoryMaintenanceState } from './memoryCadence';

export interface ContinuityClock {
  readonly humanTurnOrdinal: number;
  readonly humanInputRevision: number;
  readonly workStepOrdinal: number;
  readonly workTokens?: number;
  readonly stepTokens?: number;
  readonly lastTodoStep?: number;
  readonly lastTodoReminderU?: number;
  readonly lastTodoReminderStep?: number;
  readonly lastNotesReminderU?: number;
  readonly lastNotesReminderStep?: number;
  readonly memoryMaintenance?: MemoryMaintenanceState;
  readonly successfulWork?: boolean;
  readonly notesRenewalEpoch?: number;
  readonly notesRebuildEpoch?: number;
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
    humanBoundary: false, inputIds: [], stepIds: [], deliveredInputs: [], pollingCalls: [], substantial: false,
    workTokens: 0, stepTokens: 0, lastTodoStep: 0, lastTodoReminderU: 0, lastTodoReminderStep: 0,
    lastNotesReminderU: 0, lastNotesReminderStep: 0, memoryMaintenance: initialMemoryMaintenance() };
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
      latestInput: { id, text, turn: input.turnId }, inputIds: [...state.inputIds.slice(-255), id] };
  }
  if (event.type === ContextAppendLoopEvent.type) {
    const loop = (event as ContextAppendLoopEvent).event;
    if (loop.type === 'step.begin') return { ...state, openStep: loop.uuid, substantial: false, successfulWork: false, stepTokens: 0, pollingCalls: [] };
    if (loop.type === 'content.part' && loop.part.type === 'text' && loop.part.text.trim()) return { ...state, substantial: true,
      stepTokens: (state.stepTokens ?? 0) + Math.ceil(loop.part.text.length / 4) };
    const maintenance = state.memoryMaintenance ?? initialMemoryMaintenance();
    if (loop.type === 'tool.call' && loop.name === 'MemoryWrite') {
      const source = maintenance.offer?.inputRevision === state.humanInputRevision ? maintenance.offer.source : `unassociated:${loop.toolCallId}`;
      return { ...state, memoryMaintenance: { ...maintenance, calls: { ...maintenance.calls, [loop.toolCallId]: source } } };
    }
    if (loop.type === 'tool.result') {
      const { [loop.toolCallId]: source, ...calls } = maintenance.calls;
      const receipt = loop.result.isError ? undefined : loop.result.memoryReceipt;
      const memoryMaintenance = { ...maintenance, calls,
        receipts: receipt === undefined ? maintenance.receipts : [...maintenance.receipts.filter((entry) => entry.id !== receipt.id).slice(-255),
          { ...receipt, source: source ?? `unassociated:${loop.toolCallId}` }] };
      const text = typeof loop.result.output === 'string' ? loop.result.output : loop.result.output.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
      const useful = !state.pollingCalls.includes(loop.toolCallId) && !loop.result.isError && text.trim().length > 0;
      return { ...state, memoryMaintenance, substantial: state.substantial || useful, successfulWork: state.successfulWork || useful,
        stepTokens: (state.stepTokens ?? 0) + (useful ? Math.ceil(text.length / 4) : 0) };
    }
    if (loop.type === 'tool.call' && ['TaskWait', 'TaskOutput', 'TaskList', 'AgentList', 'TodoList'].includes(loop.name)) {
      return { ...state, substantial: state.successfulWork === true, stepTokens: state.successfulWork ? state.stepTokens : 0,
        pollingCalls: [...state.pollingCalls, loop.toolCallId] };
    }
    if (loop.type === 'tool.call') return { ...state, substantial: state.successfulWork === true };
    const stepId = loop.type === 'step.end' ? loop.turnId === undefined || loop.step === undefined ? loop.uuid : `t${loop.turnId}.${loop.step}` : undefined;
    if (stepId !== undefined && state.substantial && !state.stepIds.includes(stepId)) {
      return { ...state, workStepOrdinal: state.workStepOrdinal + 1, workTokens: (state.workTokens ?? 0) + (state.stepTokens ?? 0),
        stepIds: [...state.stepIds.slice(-255), stepId], substantial: false, stepTokens: 0 };
    }
    return state;
  }
  if (event.type === ToolsUpdateStore.type) {
    const update = event as ToolsUpdateStore;
    if (update.key === 'todo') {
      const hash = JSON.stringify(update.value);
      if (hash === state.todoHash) return state;
      return { ...state, todoHash: hash, lastTodoU: state.humanTurnOrdinal, lastTodoStep: state.workStepOrdinal, progressCount: 0, todoReminderCount: 0, stateRevision: state.stateRevision + 1 };
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
    ? state.deliveredInputs : [...state.deliveredInputs.slice(-255), disclosure.inputId];
  const historyReferences = disclosure?.historyTopic !== undefined && disclosure.triggers.includes('E2')
    ? [...(state.historyReferences ?? []).filter((item) => item.topic !== disclosure.historyTopic).slice(-255),
      { topic: disclosure.historyTopic, humanTurnOrdinal: state.humanTurnOrdinal, stateRevision: state.stateRevision }]
    : state.historyReferences;
  const maintenance = state.memoryMaintenance ?? initialMemoryMaintenance();
  const offer = disclosure?.memory;
  const memoryMaintenance = offer === undefined ? state.memoryMaintenance : { ...maintenance, offer,
    inputIds: offer.reason === 'M1' && disclosure?.inputId !== undefined
      ? [...maintenance.inputIds.filter((id) => id !== disclosure.inputId).slice(-255), disclosure.inputId] : maintenance.inputIds,
    periodicEpoch: offer.reason === 'M3' ? offer.epoch : maintenance.periodicEpoch,
    renewalEpoch: offer.reason === 'M2' ? offer.epoch : maintenance.renewalEpoch };
  const common = { ...state, deliveredInputs: delivered, historyReferences, memoryMaintenance,
    notesRenewalEpoch: disclosure?.triggers.includes('T2') ? disclosure.epoch : state.notesRenewalEpoch,
    notesRebuildEpoch: disclosure?.triggers.includes('P1') ? disclosure.epoch : state.notesRebuildEpoch };
  if (!disclosure?.triggers.some((trigger) => trigger === 'T0' || trigger === 'T1')) return common;
  const todo = disclosure.triggers.includes('T0');
  const notes = disclosure.triggers.includes('T1');
  return { ...common, lastProgressU: state.humanTurnOrdinal,
    lastProgressStep: state.workStepOrdinal, progressCount: state.progressCount + 1,
    lastTodoReminderU: todo ? state.humanTurnOrdinal : state.lastTodoReminderU,
    lastTodoReminderStep: todo ? state.workStepOrdinal : state.lastTodoReminderStep,
    lastNotesReminderU: notes ? state.humanTurnOrdinal : state.lastNotesReminderU,
    lastNotesReminderStep: notes ? state.workStepOrdinal : state.lastNotesReminderStep,
    todoReminderCount: state.todoReminderCount + (todo ? 1 : 0),
    notesReminderCount: state.notesReminderCount + (notes ? 1 : 0) };
}

export const continuityClockKey = defineState('todo.continuityClock', initialContinuityClock)
  .replayable({ schema: z.custom<ContinuityClock>() })
  .on(TurnPrompt, advanceContinuityClock)
  .on(TurnSteer, advanceContinuityClock)
  .on(ContextAppendLoopEvent, advanceContinuityClock)
  .on(ContextAppendMessage, advanceContinuityClock)
  .on(ToolsUpdateStore, advanceContinuityClock);
