/**
 * Message history actions for edit-resend and regenerate.
 *
 * Performs media/auth/control preflight before taking the Session-scoped core
 * mutation lease, then validates cursor + complete-idle state, commits the
 * undo cut and replacement user message, flushes wire state, invalidates the
 * live transcript, emits the durable rewrite fact, and only then admits the
 * replacement turn. This version provides process-local linearization rather
 * than crash-atomic history/event transactions. Search-index deletion for the
 * removed suffix is intentionally deferred; the next index sync may retain
 * stale hits until a rebuild.
 */

import {
  Error2,
  ErrorCodes,
  IAgentActivityView,
  IAgentContextMemoryService,
  IAgentConversationUndoService,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentSwarmService,
  IAgentToolPolicyService,
  IEventService,
  ISessionActivityView,
  ISessionHistoryMutationService,
  ISessionInteractionService,
  ISessionMetadata,
  IWireService,
  ProfileError,
  applyPromptMetadataUpdate,
  isUndoAnchor,
  promptMetadataTextFromContentParts,
  type ContextMessage,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type PromptHandle,
  type Scope,
} from '@kiki/agent-core-v2';

import type {
  EditMessageRequest,
  RegenerateMessageRequest,
} from '../../protocol/rest-message';
import type {
  PromptExecutionOverrides,
  PromptSubmission,
} from '../../protocol/rest-prompt';
import { contentToCoreParts } from '../../lib/promptMedia';
import { ensurePromptAuthReady } from '../../lib/promptAuth';
import type { TranscriptService } from '../transcript/transcriptService';
import type { SessionEventBroadcaster } from '../../transport/ws/v1/sessionEventBroadcaster';
import { loadMessageHistoryEntries, type MessageHistoryEntry } from './messageHistory';

export interface MessageActionDeps {
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
  readonly transcriptService: TranscriptService;
}

export async function editAndResendMessage(
  deps: MessageActionDeps,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  targetMessageId: string,
  body: EditMessageRequest,
  resolvedContent: PromptSubmission['content'],
): Promise<PromptHandle> {
  await ensurePromptAuthReady(session, agent.accessor, body);
  const gate = session.accessor.get(ISessionHistoryMutationService);
  const lease = await gate.acquire();
  try {
    await assertCursor(deps.broadcaster, session.id, body.expected_cursor);
    assertSessionIdle(session);
    const entries = await loadMessageHistoryEntries(deps.core, session.id);
    const target = requireTarget(entries, session.id, targetMessageId);
    assertEditableUser(target, 'edit_resend', targetMessageId);
    const original = locateLiveUser(agent, target);
    const turns = undoCountFrom(agent, original);
    await applyExecutionOverrides(agent, body);
    const replacement: ContextMessage = {
      role: 'user',
      content: contentToCoreParts(resolvedContent),
      toolCalls: [],
      origin: original.origin,
      id: targetMessageId,
    };
    await agent.accessor.get(IAgentConversationUndoService).undo(turns, lease);
    agent.accessor.get(IAgentContextMemoryService).append(replacement);
    await agent.accessor.get(IWireService).flush();
    await updateLastPrompt(deps.core, session, replacement);
    await deps.transcriptService.reconcileAfterRewrite(session.id);
    deps.broadcaster.refreshTranscriptAfterHistoryRewrite(session.id);
    const cursor = await deps.broadcaster.publishHistoryRewritten(
      session.id,
      'edit_resend',
      targetMessageId,
    );
    deps.broadcaster.broadcastHistoryResync(session.id, cursor);
    return await agent.accessor.get(IAgentPromptService).enqueue({
      id: targetMessageId,
      message: replacement,
      historyMutationLease: lease,
      alreadyMaterialized: true,
    });
  } finally {
    lease.dispose();
  }
}

export async function regenerateMessage(
  deps: MessageActionDeps,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  targetMessageId: string,
  body: RegenerateMessageRequest,
): Promise<PromptHandle> {
  await ensurePromptAuthReady(session, agent.accessor, body);
  const gate = session.accessor.get(ISessionHistoryMutationService);
  const lease = await gate.acquire();
  try {
    await assertCursor(deps.broadcaster, session.id, body.expected_cursor);
    assertSessionIdle(session);
    const entries = await loadMessageHistoryEntries(deps.core, session.id);
    const target = requireTarget(entries, session.id, targetMessageId);
    const userEntry = assertRegeneratableAssistant(entries, target, targetMessageId);
    const original = locateLiveUser(agent, userEntry);
    const turns = undoCountFrom(agent, original);
    await applyExecutionOverrides(agent, body);
    const id = original.id ?? userEntry.message.id;
    const replacement = { ...original, id };
    await agent.accessor.get(IAgentConversationUndoService).undo(turns, lease);
    agent.accessor.get(IAgentContextMemoryService).append(replacement);
    await agent.accessor.get(IWireService).flush();
    await updateLastPrompt(deps.core, session, replacement);
    await deps.transcriptService.reconcileAfterRewrite(session.id);
    deps.broadcaster.refreshTranscriptAfterHistoryRewrite(session.id);
    const cursor = await deps.broadcaster.publishHistoryRewritten(
      session.id,
      'regenerate',
      targetMessageId,
    );
    deps.broadcaster.broadcastHistoryResync(session.id, cursor);
    return await agent.accessor.get(IAgentPromptService).enqueue({
      id,
      message: replacement,
      historyMutationLease: lease,
      alreadyMaterialized: true,
    });
  } finally {
    lease.dispose();
  }
}

export function assertSessionIdle(session: ISessionScopeHandle): void {
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  for (const agent of lifecycle.list()) {
    const activity = agent.accessor.get(IAgentActivityView).state();
    if (activity.turn !== undefined) throw busy('active_turn');
    const prompts = agent.accessor.get(IAgentPromptService).list();
    if (prompts.active !== undefined || prompts.pending.length > 0) throw busy('queued_prompt');
    if (agent.accessor.get(IAgentFullCompactionService).compacting !== null) throw busy('compaction');
    if (activity.background.length > 0) throw busy('background_work');
  }
  const activity = session.accessor.get(ISessionActivityView).state();
  if (
    activity.pendingInteraction !== 'none' ||
    session.accessor.get(ISessionInteractionService).listPending().length > 0
  ) {
    throw busy('pending_interaction');
  }
  if (activity.busy) throw busy('background_work');
}

export function resolveForkMessageBoundary(
  entries: readonly MessageHistoryEntry[],
  targetMessageId: string,
): { turnIndex: number; throughUserMessage: boolean } {
  let turnIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (isForkUserBoundary(entry.contextMessage)) turnIndex += 1;
    if (entry.message.id !== targetMessageId) continue;
    if (isForkUserBoundary(entry.contextMessage)) {
      return { turnIndex, throughUserMessage: true };
    }
    if (entry.contextMessage.role !== 'assistant' || entry.contextMessage.toolCalls.length > 0) {
      unavailable('fork', targetMessageId, 'unsupported_message_boundary', entry.contextMessage.role);
    }
    let end = entries.length;
    for (let next = index + 1; next < entries.length; next += 1) {
      if (isForkUserBoundary(entries[next]!.contextMessage)) {
        end = next;
        break;
      }
    }
    const finalAssistant = entries
      .slice(0, end)
      .reverse()
      .find((candidate) =>
        candidate.contextMessage.role === 'assistant' &&
        candidate.contextMessage.toolCalls.length === 0,
      );
    if (finalAssistant?.message.id !== targetMessageId || turnIndex < 0) {
      unavailable(
        'fork',
        targetMessageId,
        'not_final_assistant_boundary',
        entry.contextMessage.role,
        finalAssistant?.message.id,
      );
    }
    return { turnIndex, throughUserMessage: false };
  }
  unavailable('fork', targetMessageId, 'target_not_found', 'unknown');
}

export async function assertCursor(
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  expected: { seq: number; epoch: string },
): Promise<void> {
  const current = await broadcaster.getCursor(sessionId);
  if (expected.seq === current.seq && expected.epoch === current.epoch) return;
  throw new Error2(ErrorCodes.SESSION_CURSOR_MISMATCH, 'Session cursor no longer matches', {
    details: { expected, current },
  });
}

function requireTarget(
  entries: readonly MessageHistoryEntry[],
  sessionId: string,
  targetMessageId: string,
): MessageHistoryEntry {
  const target = entries.find((entry) => entry.message.id === targetMessageId);
  if (target !== undefined) return target;
  throw new Error2(ErrorCodes.MESSAGE_ACTION_UNAVAILABLE, 'Target message is unavailable', {
    details: {
      action: 'locate',
      target_message_id: targetMessageId,
      reason: `message_not_found_in_session:${sessionId}`,
    },
  });
}

function assertEditableUser(
  target: MessageHistoryEntry,
  action: 'edit_resend',
  targetMessageId: string,
): void {
  const origin = target.contextMessage.origin;
  if (target.contextMessage.role === 'user' && (origin === undefined || origin.kind === 'user')) return;
  unavailable(action, targetMessageId, 'unsupported_origin_or_role', target.contextMessage.role);
}

function assertRegeneratableAssistant(
  entries: readonly MessageHistoryEntry[],
  target: MessageHistoryEntry,
  targetMessageId: string,
): MessageHistoryEntry {
  const latestAssistant = [...entries]
    .reverse()
    .find((entry) => entry.contextMessage.role === 'assistant' && entry.contextMessage.toolCalls.length === 0);
  if (
    target.contextMessage.role !== 'assistant' ||
    target.contextMessage.toolCalls.length > 0 ||
    latestAssistant?.message.id !== targetMessageId
  ) {
    unavailable(
      'regenerate',
      targetMessageId,
      'not_latest_final_assistant',
      target.contextMessage.role,
      latestAssistant?.message.id,
    );
  }
  for (let index = target.index - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (candidate === undefined || candidate.contextMessage.role !== 'user') continue;
    const origin = candidate.contextMessage.origin;
    if (origin === undefined || origin.kind === 'user') return candidate;
    break;
  }
  unavailable(
    'regenerate',
    targetMessageId,
    'assistant_has_no_completed_user_turn',
    target.contextMessage.role,
    latestAssistant?.message.id,
  );
}

function locateLiveUser(
  agent: IAgentScopeHandle,
  entry: MessageHistoryEntry,
): ContextMessage {
  const history = agent.accessor.get(IAgentContextMemoryService).get();
  const indexed = history[entry.index];
  const found = indexed !== undefined && sameContextMessage(indexed, entry.contextMessage)
    ? indexed
    : history.find((message) => message.id === entry.message.id) ??
      history.find((message) => sameContextMessage(message, entry.contextMessage));
  if (found !== undefined) return found;
  throw new Error2(
    ErrorCodes.SESSION_UNDO_UNAVAILABLE,
    'Message is behind a compaction or checkpoint boundary',
    { details: { reason: 'compaction_boundary', target_message_id: entry.message.id } },
  );
}

function sameContextMessage(left: ContextMessage, right: ContextMessage): boolean {
  return left.role === right.role &&
    JSON.stringify(left.content) === JSON.stringify(right.content) &&
    JSON.stringify(left.toolCalls) === JSON.stringify(right.toolCalls) &&
    JSON.stringify(left.origin) === JSON.stringify(right.origin);
}

function undoCountFrom(agent: IAgentScopeHandle, target: ContextMessage): number {
  const history = agent.accessor.get(IAgentContextMemoryService).get();
  const index = history.indexOf(target);
  if (index < 0) {
    throw new Error2(ErrorCodes.SESSION_UNDO_UNAVAILABLE, 'Message is no longer undoable', {
      details: { reason: 'checkpoint_lost', target_message_id: target.id },
    });
  }
  return history.slice(index).filter(isUndoAnchor).length;
}

async function applyExecutionOverrides(
  agent: IAgentScopeHandle,
  overrides: PromptExecutionOverrides,
): Promise<void> {
  const profile = agent.accessor.get(IAgentProfileService);
  let thinkingConsumed = false;
  if (overrides.profile !== undefined && profile.data().profileName !== overrides.profile) {
    try {
      await profile.bind({
        profile: overrides.profile,
        model: overrides.model,
        thinking: overrides.thinking,
        strictThinking: overrides.thinking !== undefined,
      });
      thinkingConsumed = overrides.thinking !== undefined;
    } catch (error) {
      if (error instanceof ProfileError) throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
      throw error;
    }
  }
  if (overrides.model !== undefined) await profile.setModel(overrides.model);
  if (overrides.thinking !== undefined && !thinkingConsumed) profile.setThinking(overrides.thinking);
  if (overrides.permission_mode !== undefined) {
    agent.accessor.get(IAgentPermissionModeService).setMode(overrides.permission_mode);
  }
  if (overrides.plan_gate !== undefined) {
    agent.accessor.get(IAgentPlanService).setGate(overrides.plan_gate);
  }
  if (overrides.disabled_tools !== undefined) {
    try {
      await agent.accessor
        .get(IAgentToolPolicyService)
        .setSessionDisabledTools(overrides.disabled_tools);
    } catch (error) {
      if (error instanceof ProfileError) throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
      throw error;
    }
  }
  if (overrides.plan_mode !== undefined) {
    const plan = agent.accessor.get(IAgentPlanService);
    const active = (await plan.status()) !== null;
    if (active !== overrides.plan_mode) {
      if (overrides.plan_mode) await plan.enter();
      else plan.exit();
    }
  }
  if (overrides.swarm_mode !== undefined) {
    const swarm = agent.accessor.get(IAgentSwarmService);
    if (swarm.isActive !== overrides.swarm_mode) {
      if (overrides.swarm_mode) swarm.enter('manual');
      else swarm.exit();
    }
  }
}

async function updateLastPrompt(
  core: Scope,
  session: ISessionScopeHandle,
  message: ContextMessage,
): Promise<void> {
  await applyPromptMetadataUpdate(
    {
      metadata: session.accessor.get(ISessionMetadata),
      eventService: core.accessor.get(IEventService),
      sessionId: session.id,
    },
    promptMetadataTextFromContentParts(message.content),
  );
}

function busy(reason: string): Error2 {
  return new Error2(ErrorCodes.SESSION_BUSY, 'Session must be completely idle', {
    details: { reason },
  });
}

function isForkUserBoundary(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') {
    return origin.trigger === 'user-slash';
  }
  return origin.kind === 'shell_command' && origin.phase === 'input';
}

function unavailable(
  action: 'edit_resend' | 'regenerate' | 'fork',
  targetMessageId: string,
  reason: string,
  targetRole: string,
  latestAssistantMessageId?: string,
): never {
  throw new Error2(ErrorCodes.MESSAGE_ACTION_UNAVAILABLE, 'Message action is unavailable', {
    details: {
      action,
      target_message_id: targetMessageId,
      reason,
      target_role: targetRole,
      latest_assistant_message_id: latestAssistantMessageId,
    },
  });
}
