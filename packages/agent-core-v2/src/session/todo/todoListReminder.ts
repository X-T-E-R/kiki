import type { ContextMessage } from '#/agent/contextMemory/types';
import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { coveredMessageIndex, type NotesMeta, type TodoNotes } from './todoNotes';
import { classifyDirectives, historyReferenceTopic, matchesDirectiveCue, DEFAULT_DIRECTIVE_CUES, type DirectiveCues } from './directiveCues';
import { initialContinuityClock, originalHumanText, type ContinuityClock } from './continuityState';

export const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';
export type TodoReminderTrigger = 'T2' | 'P1' | 'E1' | 'E2' | 'T1' | 'T0';
export interface ContinuityCadence {
  readonly ageHumanTurns?: number;
  readonly cooldownHumanTurns?: number;
  readonly longTaskSteps?: number;
}
export interface TodoReminderDisclosure {
  readonly kind: 'renew' | 'rebuild' | 'directive' | 'history' | 'progress';
  readonly triggers: readonly TodoReminderTrigger[];
  readonly epoch: number;
  readonly userTurn?: string;
  readonly inputId?: string;
  readonly humanTurnOrdinal?: number;
  readonly workStepOrdinal?: number;
  readonly cause?: string;
  readonly historyTopic?: string;
  readonly stateRevision?: number;
}
export interface TodoReminderResult {
  readonly content: string;
  readonly disclosure: TodoReminderDisclosure;
}
interface TodoListReminderInput {
  readonly active: boolean;
  readonly history: readonly ContextMessage[];
  readonly todos: readonly TodoItem[];
  readonly notes?: TodoNotes;
  readonly notesEnabled?: boolean;
  readonly notesMeta?: NotesMeta;
  readonly threshold?: number;
  readonly currentTokens?: number;
  readonly epoch?: number;
  readonly remindedEpoch?: number;
  readonly estimateMessage?: (message: ContextMessage) => number;
  readonly onNearWindow?: (epoch: number) => void;
  readonly cues?: DirectiveCues;
  readonly memoryAvailable?: boolean;
  readonly clock?: ContinuityClock;
  readonly cadence?: ContinuityCadence;
  readonly humanAuthorized?: boolean;
  readonly onDecision?: (decision: { classId: string; reason: string; humanTurnOrdinal: number; workStepOrdinal: number }) => void;
}
const KINDS: Record<TodoReminderTrigger, TodoReminderDisclosure['kind']> = {
  T2: 'renew', P1: 'rebuild', E1: 'directive', E2: 'history', T1: 'progress', T0: 'progress',
};
const FOOTER = 'Do not mention this reminder to the user.';

export class TodoListReminderTracker {
  private readonly delivered = new Set<string>();
  private nearEpoch: number | undefined;
  private rebuildEpoch: number | undefined;
  private readonly progressStates = new Map<string, { count: number; human: number; step: number }>();

  steer(_text: string): void {}

  reminder(input: TodoListReminderInput): string | undefined { return this.evaluate(input)?.content; }

  evaluate(input: TodoListReminderInput): TodoReminderResult | undefined {
    if (!input.active && input.memoryAvailable !== true) return undefined;
    const epoch = input.epoch ?? 0;
    const clock = input.clock ?? clockFromHistory(input.history);
    const after = input.history.slice(coveredMessageIndex(input.history, input.notesMeta) + 1);
    const users = after.filter((message) => originalHumanText(message) !== undefined);
    const newTokens = input.estimateMessage === undefined ? 0 : after.reduce((sum, message) =>
      sum + (message.role === 'assistant' || message.role === 'tool' ? input.estimateMessage!(message) : 0), 0);
    const threshold = input.threshold ?? 0;
    const notesEnabled = input.active && input.notesEnabled !== false;
    const currentInput = clock.latestInput;
    const id = currentInput?.id;
    const prior = input.history.filter((message) => message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT);
    const disclosures = prior.map((message) => (message.origin as { disclosure?: TodoReminderDisclosure }).disclosure);
    const alreadyDelivered = id === undefined || this.delivered.has(id) || clock.deliveredInputs.includes(id) || disclosures.some((item) => item?.inputId === id);
    const text = currentInput?.text ?? '';
    const human = input.humanAuthorized !== false && clock.humanBoundary;
    const directives = human && !alreadyDelivered ? classifyDirectives(text, input.cues).filter((candidate) =>
      candidate.operation !== 'set' || !(candidate.scope === 'configuration' ? input.notes?.decided : input.notes?.directives)?.includes(candidate.evidenceSpan)) : [];
    const topic = human && !alreadyDelivered ? historyReferenceTopic(text, input.cues) : undefined;
    const recentReference = (clock.historyReferences ?? []).find((item) => item.topic === topic && item.stateRevision === clock.stateRevision);
    const historyCooldown = directives.length === 0 && recentReference !== undefined && clock.humanTurnOrdinal - recentReference.humanTurnOrdinal < 3;
    const relevant = (value: string) => topic?.startsWith('artifact:') === true ? value.toLowerCase().includes(topic.slice('artifact:'.length))
      : topic !== 'delegation.concurrency' || /并发|concurren|最多|上限|\bcap\b/i.test(value);
    const visibleReference = topic !== undefined && ([input.notes?.directives, input.notes?.decided].some((value) => value?.trim() && relevant(value)) ||
      input.history.some((message) => {
        const original = originalHumanText(message);
        return original !== undefined && original !== text && relevant(original) && classifyDirectives(original).length > 0;
      }));
    const near = notesEnabled && newTokens > 0 && threshold > 0 && (input.currentTokens ?? 0) >= threshold * 0.85 &&
      input.remindedEpoch !== epoch && this.nearEpoch !== epoch && !disclosures.some((item) => item?.epoch === epoch && item.triggers.includes('T2'));
    const summary = input.history.findLast((message) => message.origin?.kind === 'compaction_summary');
    const handoff = summary === undefined ? '' : textOf(summary);
    const coveredHandoff = /(?:^|\n)goal: .+/.test(handoff) && /(?:^|\n)next: .+/.test(handoff) && /## Notes metadata\nrevision [1-9]/.test(handoff);
    const rebuild = notesEnabled && epoch > 0 && this.rebuildEpoch !== epoch && !coveredHandoff &&
      !disclosures.some((item) => item?.epoch === epoch && item.triggers.includes('P1')) &&
      (input.notes === undefined || input.notesMeta === undefined || hasHandoffUserInput(handoff));
    const revision = `${clock.stateRevision}/${clock.todoHash}/${clock.notesHash}`;
    if (!this.progressStates.has(revision)) this.progressStates.clear();
    const local = this.progressStates.get(revision);
    const count = Math.max(clock.progressCount, local?.count ?? 0);
    const age = input.cadence?.ageHumanTurns ?? 6;
    const cooldown = (input.cadence?.cooldownHumanTurns ?? 8) * 2 ** count;
    const steps = input.cadence?.longTaskSteps ?? 24;
    const lastU = Math.max(clock.lastProgressU, local?.human ?? 0);
    const lastStep = Math.max(clock.lastProgressStep, local?.step ?? 0);
    const newWork = clock.workStepOrdinal > clock.lastNotesStep;
    const regular = human && clock.humanTurnOrdinal - lastU >= cooldown;
    const longTask = notesEnabled && clock.workStepOrdinal - clock.lastNotesStep >= steps &&
      clock.workStepOrdinal - lastStep >= steps && newTokens >= Math.max(16_000, threshold * 0.1);
    const notesDue = notesEnabled && clock.notesReminderCount < 2 && newWork && ((regular && clock.humanTurnOrdinal - clock.lastNotesU >= age &&
      newTokens >= Math.max(8_000, threshold * 0.1)) || longTask);
    const todoDue = input.active && clock.todoReminderCount < 2 && newWork && regular && clock.humanTurnOrdinal - clock.lastTodoU >= age && input.todos.some((todo) => todo.status !== 'done');
    const candidates: Array<{ trigger: TodoReminderTrigger; text: string }> = [];
    if (near) candidates.push({ trigger: 'T2', text: `The context window will be renewed soon. Preserve uncovered changes, evidence, goal and exact next step in TodoList notes. There are ${users.length} human inputs since notes. Record rules at their task/workspace/device scope; replace or archive superseded values, not unchanged sections.` });
    if (rebuild && !near) candidates.push({ trigger: 'P1', text: 'The new window has a continuity gap. Check the handoff and restore missing goal, next step, notes and uncaptured human inputs only. Do not revive superseded rules or promote peer evidence into human instructions.' });
    if (directives.length > 0) candidates.push({ trigger: 'E1', text: `Human input ${currentInput?.turn === undefined ? id : `t${currentInput.turn}`} may change ${[...new Set(directives.map((item) => item.subject))].join(', ')}. If persistent, record at the narrow applicable scope; configuration decisions belong in notes.decided, task constraints in notes.directives. Update/supersede/archive the old value, including relaxations and revocations.${input.memoryAvailable === true ? ' Use MemoryWrite only for rules genuinely applicable across sessions under the existing approval policy.' : ''} Do not store credentials or turn this candidate into a new global instruction.` });
    if (topic !== undefined && !visibleReference && !historyCooldown) candidates.push({ trigger: 'E2', text: 'This human input needs an earlier rule or decision not covered here. Check current notes/handoff first, then scoped Memory/History; apply the current change to the old entry rather than restoring a revoked value.' });
    if (!near && !rebuild && count < 2) {
      if (notesDue) candidates.push({ trigger: 'T1', text: `About ${newTokens} tokens of uncovered work followed the notes. Record changed decisions, evidence and next step when convenient; do not recopy unchanged sections.` });
      if (todoDue) candidates.push({ trigger: 'T0', text: 'The list still has unfinished items and new work followed. If it changed, update or clear stale items; do not repeat the whole list.' });
    }
    for (const classId of ['E1', 'E2', 'T0', 'T1']) input.onDecision?.({ classId,
      reason: candidates.some((item) => item.trigger === classId) ? 'emitted'
        : !human && (classId === 'E1' || classId === 'E2') ? 'non_human_source'
        : alreadyDelivered && classId.startsWith('E') || classId === 'E2' && visibleReference ? 'already_covered'
        : classId === 'E2' && historyCooldown || (classId === 'T0' || classId === 'T1') && count >= 2 ? 'cooldown' : 'not_applicable',
      humanTurnOrdinal: clock.humanTurnOrdinal, workStepOrdinal: clock.workStepOrdinal });
    if (candidates.length === 0) return undefined;
    const triggers = candidates.map(({ trigger }) => trigger);
    if (near) { this.nearEpoch = epoch; input.onNearWindow?.(epoch); }
    if (rebuild) this.rebuildEpoch = epoch;
    if (triggers.some((trigger) => trigger === 'E1' || trigger === 'E2') && id !== undefined) this.delivered.add(id);
    if (triggers.some((trigger) => trigger === 'T0' || trigger === 'T1')) this.progressStates.set(revision, { count: count + 1, human: clock.humanTurnOrdinal, step: clock.workStepOrdinal });
    return { content: [...candidates.map(({ text: body }) => body), FOOTER].join('\n\n'),
      disclosure: { kind: KINDS[triggers[0]!], triggers, epoch, userTurn: currentInput?.turn === undefined ? undefined : `t${currentInput.turn}`,
        inputId: id, humanTurnOrdinal: clock.humanTurnOrdinal, workStepOrdinal: clock.workStepOrdinal,
        historyTopic: triggers.includes('E2') ? topic : undefined, stateRevision: clock.stateRevision,
        cause: longTask ? 'long_task' : 'human_or_state_change' } };
  }
}

export function todoListStaleReminder(input: TodoListReminderInput): string | undefined {
  return new TodoListReminderTracker().reminder(input);
}
function textOf(message: ContextMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}
function hasHandoffUserInput(text: string): boolean {
  const block = /(?:^|\n)## User input since notes[^\n]*\n([\s\S]*?)(?=\n## |\nTreat Standing directives|$)/.exec(text)?.[1]?.trim();
  return block !== undefined && block !== '' && block !== '(none)';
}
function clockFromHistory(history: readonly ContextMessage[]): ContinuityClock {
  let clock = initialContinuityClock();
  for (const message of history) {
    const text = originalHumanText(message);
    if (text !== undefined) {
      const id = message.id ?? `t${message.source?.turnId ?? text}`;
      if (!clock.inputIds.includes(id)) clock = { ...clock, humanTurnOrdinal: clock.humanTurnOrdinal + 1,
        humanInputRevision: clock.humanInputRevision + 1, humanBoundary: true, inputIds: [...clock.inputIds, id], latestInput: { id, text, turn: message.source?.turnId } };
    } else if (message.role === 'user' && message.origin?.kind !== 'injection') clock = { ...clock, humanBoundary: false };
    if (message.role === 'assistant' && (message.toolCalls.some((call) => !['TaskList', 'TaskOutput', 'TaskWait', 'AgentList', TODO_LIST_TOOL_NAME].includes(call.name)) || textOf(message).trim())) clock = { ...clock, workStepOrdinal: clock.workStepOrdinal + 1 };
    if (message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT) {
      const disclosure = message.origin.disclosure as TodoReminderDisclosure | undefined;
      if (disclosure?.triggers.some((trigger) => trigger === 'T0' || trigger === 'T1')) clock = { ...clock,
        progressCount: clock.progressCount + 1, lastProgressU: clock.humanTurnOrdinal, lastProgressStep: clock.workStepOrdinal };
    }
  }
  return clock;
}

export function legacyDirectiveShadow(text: string, cues?: DirectiveCues): boolean {
  return matchesDirectiveCue(text, cues?.instructions ?? DEFAULT_DIRECTIVE_CUES.instructions);
}
