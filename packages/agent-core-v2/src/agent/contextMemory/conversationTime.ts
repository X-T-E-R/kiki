import { registerUndoableProtocol } from '#/state/state';
import { AgentModelSwitch } from '#/agent/modelSwitch/modelSwitchEvent';

import {
  BranchBase,
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
  ContextUndo,
} from './contextEvents';
import { findProviderMessageIndex } from './loopEventFold';
import type { ContextMessage } from './types';

export function isUndoAnchorOrigin(origin: ContextMessage['origin']): boolean {
  if (origin?.kind === 'merged') return origin.origins.some(isUndoAnchorOrigin);
  if (origin?.kind === 'external_thread' || origin?.kind === 'unknown') return true;
  if (
    origin === undefined ||
    origin.kind === 'user' ||
    origin.kind === 'peer_thread' ||
    origin.kind === 'bridged_peer' ||
    origin.kind === 'agent_message' ||
    origin.kind === 'branch_fold' ||
    (origin.kind === 'system_trigger' && origin.name === 'thread_create') ||
    (origin.kind === 'room_message' && origin.targeted)
  ) return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export function isUndoAnchor(message: ContextMessage): boolean {
  if (message.role !== 'user' || message.inheritedSeed === true) return false;
  return isUndoAnchorOrigin(message.origin);
}

export function isPromptOwnedInjection(
  message: ContextMessage,
  prompt: ContextMessage,
): boolean {
  const origin = message.origin;
  return (
    origin?.kind === 'injection' &&
    origin.ownerPromptId !== undefined &&
    origin.ownerPromptId === prompt.id
  );
}

export function isValidUndoCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}

registerUndoableProtocol({
  events: {
    appendMessage: ContextAppendMessage,
    applyCompaction: ContextApplyCompaction,
    clear: ContextClear,
    undo: ContextUndo,
  },
  checkpointBoundaries: [
    { event: AgentModelSwitch, shouldClear: (event) => (event as AgentModelSwitch).context !== undefined },
    { event: BranchBase, shouldClear: () => true },
  ],
  anchorStateName: 'contextMemory',
  undoDepth: (state) => {
    const messages = state as readonly ContextMessage[];
    let depth = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.origin?.kind === 'compaction_summary' || message.inheritedSeed === true) break;
      if (isUndoAnchor(message)) depth++;
    }
    return depth;
  },
  isUndoAnchor: (message, previous) => isUndoAnchor(message as ContextMessage) &&
    (previous === undefined || findProviderMessageIndex(previous as readonly ContextMessage[], message as ContextMessage, (entry) => entry) < 0),
  isValidUndoCount,
});
