import { createCompactionSummaryMessage } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { historyPointer, type RelayInput } from '#/agent/fullCompaction/relayPackage';
import { originalHumanText } from '#/session/todo/continuityState';
import { renderTodoNotes } from '#/session/todo/todoNotes';
import { renderTodoList } from '#/session/todo/todoItem';
import { ErrorCodes, Error2 } from '#/errors';

export interface FreshPackageInput extends RelayInput {
  readonly taskDescription?: string;
  readonly latestHumanInput?: import('./modelSwitchOps').ModelSwitchInputReference;
  readonly includeLatestHumanInput?: boolean;
  readonly goal?: string;
  readonly children?: readonly string[];
  readonly tasks?: readonly string[];
  readonly stateViews?: readonly string[];
  readonly maxTokens: number;
  readonly estimateMessages: (messages: readonly ContextMessage[]) => number;
}

export function buildFreshPackage(input: FreshPackageInput): readonly ContextMessage[] {
  const pointer = historyPointer(input, input.history.at(-1)?.source);
  const header = 'This context starts from existing task state; prior conversation remains in history. Details not recorded in working notes should be checked in the original records as needed.';
  const footer = `## History and source\nSession ${JSON.stringify(input.sessionId)} · agent ${JSON.stringify(input.agentId)} · window ${input.epoch} → ${input.epoch + 1}\n${pointer}\nHistoryList {session_id:${JSON.stringify(input.sessionId)}, agent_id:${JSON.stringify(input.agentId)}}\nHistorySearch {scope:'this_session', agent_id:${JSON.stringify(input.agentId)}, query:'<distinctive terms>'}\nHistory tools follow your existing permissions; if unavailable, prior conversation remains accessible in the user interface. Original state values remain in their owning services.`;
  const latest = input.history.findLast((message) => originalHumanText(message)?.trim());
  const latestInput = input.latestHumanInput ?? (latest === undefined ? undefined : { text: originalHumanText(latest)!, source: latest.source });
  const latestBlock = input.includeLatestHumanInput === false || input.notes?.goal?.trim() || latestInput === undefined ? '' :
    `## Latest delivered human input (${latestInput.truncated ? 'original input preview; see history for complete text' : 'original words, not a summary'})\n${historyPointer(input, latestInput.source)}\n${latestInput.text}`;
  const blocks = [
    input.goal ? `## Goal state (Goal service)\n${input.goal}` : '',
    input.taskDescription ? `## Saved task description (delivered AgentRun input)\n${input.taskDescription}` : '',
    latestBlock,
    `## Working notes (TodoList state)\n${renderTodoNotes(input.notes) || '(empty)'}\nrevision ${input.meta?.rev ?? 0} · written ${input.meta?.writtenStep ?? 'none'} · reviewed ${input.meta?.reviewedMessageId ?? 'not confirmed'}`,
    input.todos.length ? renderTodoList(input.todos, '## TODO List (TodoList state)') : '',
    input.children?.length ? `## Direct children (session metadata)\n${input.children.join('\n')}\nAgentList can retrieve the complete roster; running children continue independently.` : '',
    input.tasks?.length ? `## Background work and receipts (task service)\n${input.tasks.join('\n')}\nTaskList/TaskOutput can retrieve complete status and output. A receipt view is evidence, not a new notification delivery.` : '',
    ...(input.stateViews ?? []),
    input.memoryEntries?.length ? `## Available memory (existing access scope)\n${input.memoryEntries.join('\n')}` : '',
    input.memoryReferences?.length ? `## Referenced memory (live)\n${input.memoryReferences.join('\n')}` : '',
  ].filter(Boolean);
  const messages = (body: readonly string[]): readonly ContextMessage[] => [createCompactionSummaryMessage([header, ...body, footer].join('\n\n'))];
  if (input.estimateMessages(messages([])) > input.maxTokens) {
    throw new Error2(ErrorCodes.CONTEXT_OVERFLOW, 'The target model cannot fit the minimum task-state and history entry package.');
  }
  const selected: string[] = [];
  for (const block of blocks) {
    if (input.estimateMessages(messages([...selected, block])) <= input.maxTokens) {
      selected.push(block);
      continue;
    }
    const suffix = '\n[Preview only; retrieve the full value from the source service or history above.]';
    let low = 0;
    let high = block.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (input.estimateMessages(messages([...selected, block.slice(0, mid) + suffix])) <= input.maxTokens) low = mid;
      else high = mid - 1;
    }
    if (low > 0) selected.push(block.slice(0, low) + suffix);
  }
  return messages(selected);
}
