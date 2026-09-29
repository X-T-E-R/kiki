import { collectCompactableUserMessages, selectCompactionUserMessages } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { NotesMeta, TodoNotes } from '#/session/todo/todoNotes';

export type ContextStrategy = 'summarize' | 'auto' | 'fresh';
export type ReasonCode =
  | 'history_unavailable' | 'notes_missing' | 'notes_previous_window' | 'projected_too_large'
  | 'manual_instruction' | 'user_input_elided' | 'new_content_large' | 'tool_error'
  | 'non_replayable_result' | 'debug_chain' | 'elided_goal_missing' | 'multiple_sources'
  | 'non_text_result' | 'relay_render_failed' | 'summarize_failed_relay_rescue';

export interface FreshEligibilityInput {
  readonly history: readonly ContextMessage[];
  readonly compactCount: number;
  readonly notes?: TodoNotes;
  readonly meta?: NotesMeta;
  readonly windowEpoch: number;
  readonly strategy: ContextStrategy;
  readonly threshold: number;
  readonly projectedTokens: number;
  readonly instruction?: string;
  readonly historyAvailable: boolean;
  readonly estimateMessage: (message: ContextMessage) => number;
}

export function coveredMessageIndex(history: readonly ContextMessage[], meta?: NotesMeta): number {
  if (meta === undefined) return -1;
  return history.findIndex((message) => message.id === meta.coveredMessageId ||
    (meta.coveredMessageId.startsWith('toolcall:') && message.toolCalls.some((call) => call.id === meta.coveredMessageId.slice(9))));
}

export function evaluateFreshEligibility(input: FreshEligibilityInput): { eligible: boolean; safe: boolean; reasons: ReasonCode[] } {
  const reasons: ReasonCode[] = [];
  const { history, compactCount, estimateMessage, meta } = input;
  const section = history.slice(0, compactCount);
  const watermark = coveredMessageIndex(section, meta);
  const after = section.slice(watermark + 1);
  if (!input.historyAvailable) reasons.push('history_unavailable');
  if (input.notes === undefined || meta === undefined) reasons.push('notes_missing');
  if (meta !== undefined && meta.windowEpoch < input.windowEpoch) reasons.push('notes_previous_window');
  if (input.projectedTokens > input.threshold * 0.6) reasons.push('projected_too_large');
  if (input.instruction?.trim()) reasons.push('manual_instruction');
  const users = collectCompactableUserMessages(section);
  const selection = selectCompactionUserMessages(users, undefined, undefined, estimateMessage);
  if (after.some((message) => users.includes(message) && !selection.tail.includes(message))) reasons.push('user_input_elided');
  const newTokens = after.reduce((sum, message) => sum + estimateMessage(message), 0);
  if (newTokens > Math.max(16_000, input.threshold * 0.2)) reasons.push('new_content_large');
  if (after.some((message) => message.role === 'tool' && (message.isError || message.content.some((part) => part.type === 'text' && /(?:exit code|exit status|exit)[: ]+([1-9]\d*)\b/i.test(part.text))))) reasons.push('tool_error');
  const toolNames = new Map<string, string>();
  for (const message of section) for (const call of message.toolCalls) toolNames.set(call.id, call.name);
  const nonReplayable = after.filter((message) => message.role === 'tool' &&
    (/^(FetchURL|WebSearch|TaskOutput|mcp__)/.test(toolNames.get(message.toolCallId ?? '') ?? '') ||
      /spill/i.test(message.note ?? '')));
  if (nonReplayable.length > 0) reasons.push('non_replayable_result');
  if (section.filter((message) => message.role === 'tool' && message.isError).length >= 3 && hasChangingDebugNotes(section)) reasons.push('debug_chain');
  if (selection.elided && !input.notes?.goal) reasons.push('elided_goal_missing');
  if (nonReplayable.length >= 5 && new Set(nonReplayable.map((message) => toolNames.get(message.toolCallId ?? ''))).size >= 3) reasons.push('multiple_sources');
  if (after.some((message) => message.role === 'tool' &&
    message.content.some((part) => part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url'))) reasons.push('non_text_result');
  const safety = new Set<ReasonCode>(['history_unavailable', 'notes_missing', 'notes_previous_window', 'projected_too_large', 'manual_instruction', 'user_input_elided']);
  const safe = !reasons.some((reason) => safety.has(reason));
  return { safe, eligible: safe && (input.strategy === 'fresh' || reasons.length === 0), reasons };
}

function hasChangingDebugNotes(history: readonly ContextMessage[]): boolean {
  const writes: Array<{ next: string; current: string }> = [];
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name !== 'TodoList' || typeof call.arguments !== 'string') continue;
      try {
        const args = JSON.parse(call.arguments) as { notes?: TodoNotes; todos?: readonly { title: string; status: string }[] };
        if (args.notes?.next === undefined) continue;
        const current = args.todos?.find((item) => item.status === 'in_progress')?.title ?? '';
        writes.push({ next: args.notes.next, current });
      } catch { continue; }
    }
  }
  const recent = writes.slice(-3);
  return recent.length === 3 && recent.every((item) => item.current !== '' && item.current === recent[0]?.current) &&
    new Set(recent.map((item) => item.next)).size === 3;
}
