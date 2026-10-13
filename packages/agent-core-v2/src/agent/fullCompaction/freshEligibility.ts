import { collectCompactableUserMessages, isContinuableMediaPart, selectCompactionUserMessages } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { coveredMessageIndex, type NotesMeta, type TodoNotes } from '#/session/todo/todoNotes';
import { originalHumanText } from '#/session/todo/continuityState';
import { hasRelayCoordinate, userInputSinceNotes } from './relayPackage';
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
  readonly historyReadAvailable?: boolean;
  readonly windowTokens?: number;
  readonly outputReserve?: number;
  readonly tokensBefore?: number;
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
  const postWatermarkUsers = userInputSinceNotes({ history, compactCount, meta });
  const compactable = collectCompactableUserMessages(section);
  const selection = selectCompactionUserMessages(compactable, undefined, undefined, estimateMessage);
  const keptUsers = [...selection.head, ...selection.tail];
  const historyRead = input.historyReadAvailable ?? input.historyAvailable === true;
  const omittedUsers = postWatermarkUsers.filter((message) => !keptUserText(keptUsers, message) && !(hasRelayCoordinate(message.source) && historyRead));
  if (omittedUsers.length > 0) {
    reasons.push('user_input_elided');
    reasons.push('history_unavailable');
  }
  if (input.notes === undefined || meta === undefined) reasons.push('notes_missing');
  if (meta !== undefined && (meta.reviewedWindowEpoch ?? -1) < input.windowEpoch) reasons.push('notes_previous_window');
  if (watermark < 0 || after.some((message) => message.origin?.kind === 'compaction_summary')) reasons.push('handoff_unreviewed');
  if (input.windowTokens !== undefined && input.windowTokens > 0) {
    const reserve = Math.max(0, Math.min(input.outputReserve ?? 0, input.windowTokens - 1));
    const overBudget = input.projectedTokens > input.windowTokens - reserve;
    const noRelease = input.tokensBefore !== undefined && input.tokensBefore > input.windowTokens - reserve && input.projectedTokens >= input.tokensBefore;
    if (overBudget || noRelease) reasons.push('projected_too_large');
  }
  if (input.instruction?.trim()) reasons.push('manual_instruction');
  if (postWatermarkUsers.length > 0) reasons.push(`user_input_since_notes:${postWatermarkUsers.length}`);
  const newTokens = after.reduce((sum, message) => sum + estimateMessage(message), 0);
  if (newTokens > Math.max(16_000, input.threshold * 0.2)) reasons.push('new_content_large');
  if (after.some((message) => message.role === 'tool' && (message.isError || message.content.some((part) => part.type === 'text' && /(?:exit code|exit status|exit)[: ]+([1-9]\d*)\b/i.test(part.text))))) reasons.push('tool_error');
  if (selection.elided && !input.notes?.goal && !input.notes?.directives) reasons.push('elided_goal_directives_missing');
  if (after.some((message) => message.content.some((part) => (part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url') && !isContinuableMediaPart(part)))) reasons.push('non_text_result');
  const blocking = reasons.some((reason) => !isDiagnosticReason(reason));
  return { safe: !blocking, eligible: input.strategy !== 'summarize' && !blocking, reasons };
}

function isDiagnosticReason(reason: ReasonCode): boolean {
  return reason.startsWith('user_input_since_notes:') || reason === 'tool_error' || reason === 'new_content_large' ||
    reason === 'notes_missing' || reason === 'notes_previous_window' || reason === 'handoff_unreviewed' ||
    reason === 'notes_directives_budget' || reason === 'elided_goal_directives_missing';
}

function keptUserText(kept: readonly ContextMessage[], message: ContextMessage): boolean {
  const full = (originalHumanText(message) ?? '').trim();
  if (full.length === 0) return true;
  return kept.some((item) => item === message || messageText(item).trim() === full);
}

function messageText(message: ContextMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}
