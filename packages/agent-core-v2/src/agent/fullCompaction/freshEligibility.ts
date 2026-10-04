import { collectCompactableUserMessages, selectCompactionUserMessages } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { coveredMessageIndex, type NotesMeta, type TodoNotes } from '#/session/todo/todoNotes';
import { estimateTokens } from '#/kosong/contract/tokens';
import { renderUserInputSinceNotes } from './relayPackage';
export { coveredMessageIndex } from '#/session/todo/todoNotes';

export type ContextStrategy = 'summarize' | 'auto' | 'fresh';
export type ReasonCode =
  | 'history_unavailable' | 'notes_missing' | 'notes_previous_window' | 'projected_too_large'
  | 'handoff_unreviewed' | 'notes_directives_budget'
  | 'manual_instruction' | 'user_input_elided' | 'new_content_large' | 'tool_error'
  | 'non_replayable_result' | 'debug_chain' | 'elided_goal_directives_missing' | 'multiple_sources'
  | 'non_text_result' | 'relay_render_failed' | 'summarize_failed_relay_rescue'
  | `user_input_since_notes:${number}`;

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
  readonly estimateText?: (text: string) => number;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export function evaluateFreshEligibility(input: FreshEligibilityInput): { eligible: boolean; safe: boolean; reasons: ReasonCode[] } {
  const reasons: ReasonCode[] = [];
  const { history, compactCount, estimateMessage, meta } = input;
  const section = history.slice(0, compactCount);
  const watermark = coveredMessageIndex(history, meta);
  const after = watermark >= compactCount ? [] : section.slice(watermark + 1);
  if (!input.historyAvailable) reasons.push('history_unavailable');
  if (input.notes === undefined || meta === undefined) reasons.push('notes_missing');
  if (meta !== undefined && (meta.reviewedWindowEpoch ?? -1) < input.windowEpoch) reasons.push('notes_previous_window');
  if (watermark < 0 || after.some((message) => message.origin?.kind === 'compaction_summary')) reasons.push('handoff_unreviewed');
  if (input.projectedTokens > input.threshold * 0.6) reasons.push('projected_too_large');
  if (input.instruction?.trim()) reasons.push('manual_instruction');
  const users = collectCompactableUserMessages(section);
  const selection = selectCompactionUserMessages(users, undefined, undefined, estimateMessage);
  const delivery = renderUserInputSinceNotes({ history, compactCount, meta, notes: input.notes,
    sessionId: input.sessionId ?? 'current', agentId: input.agentId ?? 'main', epoch: input.windowEpoch,
    todos: [], estimateText: input.estimateText ?? estimateTokens });
  if (delivery.count > 0) reasons.push(`user_input_since_notes:${delivery.count}`);
  if (!delivery.fits) reasons.push('user_input_elided');
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
  if (selection.elided && !input.notes?.goal && !input.notes?.directives) reasons.push('elided_goal_directives_missing');
  if (nonReplayable.length >= 5 && new Set(nonReplayable.map((message) => toolNames.get(message.toolCallId ?? ''))).size >= 3) reasons.push('multiple_sources');
  if (after.some((message) => message.role === 'tool' &&
    message.content.some((part) => part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url'))) reasons.push('non_text_result');
  const safety = new Set<ReasonCode>(['history_unavailable', 'notes_missing', 'notes_previous_window', 'handoff_unreviewed', 'projected_too_large', 'manual_instruction', 'user_input_elided']);
  const safe = !reasons.some((reason) => safety.has(reason));
  return { safe, eligible: safe && (input.strategy === 'fresh' || reasons.every((reason) => reason.startsWith('user_input_since_notes:'))), reasons };
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
