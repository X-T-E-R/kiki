import type { ContextMessage } from '#/agent/contextMemory/types';
import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { coveredMessageIndex, type NotesMeta, type TodoNotes } from './todoNotes';
import { DEFAULT_DIRECTIVE_CUES, matchesDirectiveCue, type DirectiveCues } from './directiveCues';

export const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';
export type TodoReminderTrigger = 'T2' | 'P1' | 'E1' | 'E2' | 'T1' | 'T0';
export interface TodoReminderDisclosure {
  readonly kind: 'renew' | 'rebuild' | 'directive' | 'history' | 'progress';
  readonly triggers: readonly TodoReminderTrigger[];
  readonly epoch: number;
  readonly userTurn?: string;
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
}
const KINDS: Record<TodoReminderTrigger, TodoReminderDisclosure['kind']> = {
  T2: 'renew', P1: 'rebuild', E1: 'directive', E2: 'history', T1: 'progress', T0: 'progress',
};
const FOOTER = 'Ignore if not relevant. Do not mention this reminder to the user.';

export class TodoListReminderTracker {
  private scannedLength = 0;
  private lastScannedMessage: ContextMessage | undefined;
  private turnsSinceLastWrite = 0;
  private turnsSinceLastReminder = 0;
  private unansweredProgress = 0;
  private epoch: number | undefined;
  private rebuilt = false;
  private readonly directiveTurns = new Set<string>();
  private readonly historyTurns = new Set<string>();
  private seenUsers = new WeakSet<ContextMessage>();
  private nearEpoch: number | undefined;
  private steeredText: string | undefined;

  steer(text: string): void { this.steeredText = text.trim() || undefined; }

  reminder(input: TodoListReminderInput): string | undefined { return this.evaluate(input)?.content; }

  evaluate(input: TodoListReminderInput): TodoReminderResult | undefined {
    if (!input.active) return undefined;
    const epoch = input.epoch ?? 0;
    if (this.epoch !== epoch) {
      this.epoch = epoch;
      this.reset();
    }
    this.scan(input.history, epoch);
    const after = input.history.slice(coveredMessageIndex(input.history, input.notesMeta) + 1);
    const users = after.filter(isReminderUser);
    const newUser = users.findLast((message) => !this.seenUsers.has(message));
    const userText = newUser === undefined ? '' : textOf(newUser);
    const turnKey = newUser === undefined ? undefined : newUser.source?.turnId === undefined ? newUser.id ?? newUser.source?.ref ?? userText : `t${newUser.source.turnId}`;
    const steered = userText.length > 0 && this.steeredText !== undefined &&
      (userText.includes(this.steeredText) || this.steeredText.includes(userText));
    const spacing = Math.min(40, 10 * 2 ** Math.floor(this.unansweredProgress / 2));
    const progressDue = this.turnsSinceLastReminder >= spacing;
    const todoStale = this.turnsSinceLastWrite >= 10 && progressDue;
    const notesEnabled = input.notesEnabled !== false;
    const newTokens = input.estimateMessage === undefined ? 0 : after.reduce((sum, message) => sum + input.estimateMessage!(message), 0);
    const threshold = input.threshold ?? 0;
    const near = notesEnabled && threshold > 0 && (input.currentTokens ?? 0) >= threshold * 0.85 &&
      input.epoch !== undefined && input.remindedEpoch !== epoch && this.nearEpoch !== epoch;
    const stale = notesEnabled && after.filter((message) => message.role === 'assistant').length >= 10 &&
      newTokens >= Math.max(8_000, threshold * 0.1) && progressDue;
    const summary = input.history.findLast((message) => message.origin?.kind === 'compaction_summary');
    const rebuild = notesEnabled && epoch > 0 && !this.rebuilt &&
      (input.notes === undefined || Object.values(input.notes).every((value) => !value.trim()) || input.notesMeta === undefined ||
        input.notesMeta.windowEpoch < epoch || (summary !== undefined && hasHandoffUserInput(textOf(summary))));
    this.rebuilt = true;
    const directive = turnKey !== undefined && !this.directiveTurns.has(turnKey) &&
      (steered || matchesDirectiveCue(userText, input.cues?.instructions ?? DEFAULT_DIRECTIVE_CUES.instructions));
    const history = epoch > 0 && turnKey !== undefined && !this.historyTurns.has(turnKey) &&
      matchesDirectiveCue(userText, input.cues?.history ?? DEFAULT_DIRECTIVE_CUES.history);
    const candidates: Array<{ trigger: TodoReminderTrigger; text: string }> = [];
    if (near) candidates.push({ trigger: 'T2', text: `The context window will be renewed soon (about ${Math.max(0, Math.round(threshold - (input.currentTokens ?? 0)))} tokens left). Bring TodoList notes up to date: goal (the user's request and success criteria), directives, decisions, rejected options, evidence, and the exact next step. There are ${users.length} user inputs since notes. Record standing instructions in notes.directives${input.memoryAvailable === false ? '' : ' or MemoryWrite'} before the switch. Include earlier content you need to keep when replacing a section.` });
    if (rebuild) candidates.push({ trigger: 'P1', text: 'A new window started. Rebuild TodoList notes from the handoff before continuing: goal, directives (including User input since notes), next.' });
    if (directive) candidates.push({ trigger: 'E1', text: `The user's latest input may set a standing instruction. If it applies beyond this step, add it to TodoList notes.directives (quote + t<turn>).${input.memoryAvailable === false ? '' : ' If it should hold in future sessions too, MemoryWrite type=feedback.'} Otherwise ignore.` });
    if (history) candidates.push({ trigger: 'E2', text: 'The user refers to earlier conversation. Check Standing directives and User input since notes in the latest handoff first; if absent, HistorySearch this session.' });
    if (stale) candidates.push({ trigger: 'T1', text: `Working notes were last updated at ${input.notesMeta?.writtenStep ?? 'none'} and ~${newTokens} tokens of new work followed. Update TodoList notes when convenient, especially goal (the user's request and success criteria), directives, and the next step. Include earlier content you need to keep when replacing a section.` });
    if (todoStale) candidates.push({ trigger: 'T0', text: renderTodoListReminder(input.todos) });
    const selected = candidates.slice(0, 3);
    if (selected.length === 0) {
      for (const message of users) this.seenUsers.add(message);
      return undefined;
    }
    const triggers = selected.map(({ trigger }) => trigger);
    if (triggers.includes('T2')) { this.nearEpoch = epoch; input.onNearWindow?.(epoch); }
    if (triggers.includes('E1') && turnKey !== undefined) { this.directiveTurns.add(turnKey); this.steeredText = undefined; }
    if (triggers.includes('E2') && turnKey !== undefined) this.historyTurns.add(turnKey);
    for (const message of users) this.seenUsers.add(message);
    return { content: [...selected.map(({ text }) => text), FOOTER].join('\n\n'),
      disclosure: { kind: KINDS[triggers[0]!], triggers, epoch, userTurn: turnKey } };
  }

  private reset(): void {
    this.scannedLength = 0;
    this.lastScannedMessage = undefined;
    this.turnsSinceLastWrite = 0;
    this.turnsSinceLastReminder = 0;
    this.unansweredProgress = 0;
    this.rebuilt = false;
    this.directiveTurns.clear();
    this.historyTurns.clear();
    this.seenUsers = new WeakSet();
    this.nearEpoch = undefined;
  }

  private scan(history: readonly ContextMessage[], epoch: number): void {
    if (history.length < this.scannedLength || (this.scannedLength > 0 && history[this.scannedLength - 1] !== this.lastScannedMessage)) this.reset();
    const pendingUsers: ContextMessage[] = [];
    for (const message of history.slice(this.scannedLength)) {
      if (isReminderUser(message)) pendingUsers.push(message);
      if (message.role === 'assistant') {
        if (hasTodoListWrite(message)) { this.turnsSinceLastWrite = 0; this.unansweredProgress = 0; }
        else this.turnsSinceLastWrite++;
        this.turnsSinceLastReminder++;
      } else if (message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT) {
        const disclosure = message.origin.disclosure as Partial<TodoReminderDisclosure> | undefined;
        if (disclosure?.epoch !== undefined && disclosure.epoch !== epoch) continue;
        for (const user of pendingUsers) this.seenUsers.add(user);
        pendingUsers.length = 0;
        this.turnsSinceLastReminder = 0;
        if (disclosure?.triggers === undefined || disclosure.triggers.some((trigger) => trigger === 'T0' || trigger === 'T1')) this.unansweredProgress++;
        if (disclosure?.triggers?.includes('P1')) this.rebuilt = true;
        if (disclosure?.triggers?.includes('T2')) this.nearEpoch = epoch;
        if (disclosure?.userTurn !== undefined && disclosure.triggers?.includes('E1') && !this.directiveTurns.has(disclosure.userTurn)) {
          this.directiveTurns.add(disclosure.userTurn);
        }
        if (disclosure?.userTurn !== undefined && disclosure.triggers?.includes('E2')) this.historyTurns.add(disclosure.userTurn);
      }
    }
    this.scannedLength = history.length;
    this.lastScannedMessage = history.at(-1);
  }
}

export function todoListStaleReminder(input: TodoListReminderInput): string | undefined {
  return new TodoListReminderTracker().reminder(input);
}
function textOf(message: ContextMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}
function isReminderUser(message: ContextMessage): boolean {
  return message.role === 'user' && (message.origin === undefined || ['user', 'peer_thread', 'agent_message'].includes(message.origin.kind));
}
function hasHandoffUserInput(text: string): boolean {
  const block = /(?:^|\n)## User input since notes[^\n]*\n([\s\S]*?)(?=\n## |\nTreat Standing directives|$)/.exec(text)?.[1]?.trim();
  return block !== undefined && block !== '' && block !== '(none)';
}
function hasTodoListWrite(message: ContextMessage): boolean {
  return message.toolCalls.some((call) => {
    if (call.name !== TODO_LIST_TOOL_NAME || typeof call.arguments !== 'string') return false;
    try {
      const args = JSON.parse(call.arguments) as { todos?: unknown; notes?: unknown };
      return Array.isArray(args.todos) || args.notes !== undefined;
    } catch { return false; }
  });
}
function renderTodoListReminder(todos: readonly TodoItem[]): string {
  const items = todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.title}`).join('\n');
  return `TodoList has not been updated recently. If it still helps, update it; clear or rewrite it if stale. Update working notes too when they changed.${items ? `\n\nCurrent todo list:\n${items}` : ''}`;
}
