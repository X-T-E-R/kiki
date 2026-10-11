import { createHash, randomUUID } from 'node:crypto';

import {
  Error2,
  ErrorCodes,
  IAgentActivityView,
  IAgentContextMemoryService,
  IAgentConversationUndoService,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentPromptService,
  IEventService,
  ISessionActivityView,
  ISessionHistoryMutationService,
  ISessionInteractionService,
  ISessionMetadata,
  applyPromptMetadataUpdate,
  bundledSkillActivations,
  isUndoAnchor,
  promptMetadataTextFromContentParts,
  promptRetryFor,
  type PromptRetryReceipt,
  type ContextMessage,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type PromptHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import { validatePromptRuntimeControls } from '@kiki/agent-core-v2/agent/prompt/runtimeControls';

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
  return rewriteMessage(deps, session, agent, targetMessageId, body, resolvedContent);
}

export async function regenerateMessage(
  deps: MessageActionDeps,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  targetMessageId: string,
  body: RegenerateMessageRequest,
): Promise<PromptHandle> {
  return rewriteMessage(deps, session, agent, targetMessageId, body);
}

export async function replayMessageOperation(
  agent: IAgentScopeHandle,
  targetMessageId: string,
  body: EditMessageRequest,
): Promise<PromptHandle | undefined> {
  if (body.operation_id === undefined) return undefined;
  const prompt = agent.accessor.get(IAgentPromptService);
  const receipt = await promptRetryFor(prompt).lookup(body.operation_id, actionFingerprint('edit_resend', targetMessageId, body));
  return receipt === undefined ? undefined : replayHandle(prompt, body.operation_id, receipt);
}

async function rewriteMessage(
  deps: MessageActionDeps,
  session: ISessionScopeHandle,
  agent: IAgentScopeHandle,
  targetMessageId: string,
  body: EditMessageRequest | RegenerateMessageRequest,
  resolvedContent?: PromptSubmission['content'],
): Promise<PromptHandle> {
  const action = resolvedContent === undefined ? 'regenerate' : 'edit_resend';
  const id = body.operation_id ?? randomUUID();
  const fingerprint = actionFingerprint(action, targetMessageId, body);
  const prompt = agent.accessor.get(IAgentPromptService);
  const lease = await session.accessor.get(ISessionHistoryMutationService).acquire();
  try {
    const receipt = await promptRetryFor(prompt).lookup(id, fingerprint);
    if (receipt !== undefined) return await replayHandle(prompt, id, receipt);
    if (prompt.lookup(id) !== undefined) throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, 'This operation ID is already in use.');
    await ensurePromptAuthReady(session, agent.accessor, body);
    await assertCursor(deps.broadcaster, session.id, body.expected_cursor);
    assertSessionIdle(session);
    const entries = await loadMessageHistoryEntries(deps.core, session.id);
    const target = requireTarget(entries, session.id, targetMessageId);
    let userEntry = target;
    if (action === 'regenerate') userEntry = assertRegeneratableAssistant(entries, target, targetMessageId);
    else assertEditableUser(target, 'edit_resend', targetMessageId);
    const original = locateLiveUser(agent, userEntry);
    const turns = undoCountFrom(agent, original);
    const userMessageId = original.id ?? userEntry.message.id;
    const execution = await prepareExecutionOverrides(agent, body);
    validatePromptRuntimeControls(agent.accessor, execution);
    const replacement: ContextMessage = { ...original, id: userMessageId,
      content: resolvedContent === undefined ? original.content : [
        ...original.content.slice(0, bundledSkillActivations(original.origin).length), ...contentToCoreParts(resolvedContent),
      ] };
    await prompt.enqueue({
      id, userMessageId, message: replacement, retryFingerprint: fingerprint,
      execution, deferredDisabledTools: body.disabled_tools,
      historyMutationLease: lease, alreadyMaterialized: true,
      commitHistoryRewrite: async (record) => {
        await agent.accessor.get(IAgentConversationUndoService).undo(turns, lease, record);
        await updateLastPrompt(deps.core, session, replacement);
        await deps.transcriptService.reconcileAfterRewrite(session.id);
        deps.broadcaster.refreshTranscriptAfterHistoryRewrite(session.id);
        const cursor = await deps.broadcaster.publishHistoryRewritten(session.id, action, targetMessageId);
        deps.broadcaster.broadcastHistoryResync(session.id, cursor);
      },
    });
    const accepted = await promptRetryFor(prompt).lookup(id, fingerprint);
    if (accepted === undefined) throw new Error2(ErrorCodes.INTERNAL, 'History rewrite receipt is missing.');
    return await replayHandle(prompt, id, accepted);
  } finally {
    lease.dispose();
  }
}

async function replayHandle(prompt: IAgentPromptService, id: string, receipt: PromptRetryReceipt): Promise<PromptHandle> {
  if (receipt.message === undefined || receipt.userMessageId === undefined) throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, 'This operation ID belongs to a different request.');
  const handle = await prompt.enqueue({ id, userMessageId: receipt.userMessageId, message: receipt.message,
    execution: receipt.execution, deferredDisabledTools: receipt.deferredDisabledTools,
    appendTiming: receipt.appendTiming, alreadyMaterialized: true });
  return { ...handle, state: 'pending', createdAt: receipt.createdAt, appendTiming: receipt.appendTiming, revision: receipt.revision };
}

function actionFingerprint(action: string, target: string, body: EditMessageRequest | RegenerateMessageRequest): string {
  const canonical = JSON.stringify({ action, target, body }, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value);
  return createHash('sha256').update(canonical).digest('hex');
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
    if (candidate === undefined || !isUndoAnchor(candidate.contextMessage)) continue;
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

async function prepareExecutionOverrides(
  agent: IAgentScopeHandle,
  overrides: PromptExecutionOverrides,
): Promise<import('@kiki/agent-core-v2').PromptExecutionBinding | undefined> {
  const profile = agent.accessor.get(IAgentProfileService);
  if (overrides.model !== undefined || overrides.thinking !== undefined) {
    const binding = profile.data();
    if ((binding.executorId ?? 'native') === 'native') {
      if (binding.modelAlias !== undefined && (overrides.profile === undefined || overrides.profile === binding.profileName)) {
        const prepared = await profile.prepareModelSwitchBinding(overrides.model ?? binding.modelAlias, overrides.thinking);
        prepared.assertCurrent();
      }
    } else {
      const validation = profile.validateBinding({ modelAlias: overrides.model, thinkingEffort: overrides.thinking });
      if (!validation.ok) throw new Error2(ErrorCodes.REQUEST_INVALID, validation.diagnostic);
    }
  }
  const execution = {
    execution: overrides.execution, profile: overrides.profile, model: overrides.model, thinking: overrides.thinking,
    permissionMode: overrides.permission_mode, planGate: overrides.plan_gate, planMode: overrides.plan_mode,
    personaGreetingReply: overrides.persona_greeting_reply,
  };
  return Object.values(execution).every((value) => value === undefined) ? undefined : execution;
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
