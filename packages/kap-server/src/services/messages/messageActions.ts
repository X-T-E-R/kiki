import { createHash, randomUUID } from 'node:crypto';

import {
  Error2,
  ErrorCodes,
  IAgentActivityView,
  IAgentBlobService,
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

import { type EditMessageRequest, type RegenerateMessageRequest, type PromptExecutionOverrides, type PromptSubmission } from '@kiki/protocol';
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
  body: EditMessageRequest | RegenerateMessageRequest,
  action: 'edit_resend' | 'regenerate' = 'edit_resend',
): Promise<PromptHandle | undefined> {
  if (body.operation_id === undefined) return undefined;
  const prompt = agent.accessor.get(IAgentPromptService);
  const receipt = await promptRetryFor(prompt).lookup(body.operation_id, actionFingerprint(action, targetMessageId, body));
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
    const original = await locateLiveUser(agent, userEntry);
    const turns = undoCountFrom(agent, original);
    const userMessageId = original.id ?? userEntry.message.id;
    const execution = await prepareExecutionOverrides(agent, body);
    validatePromptRuntimeControls(agent.accessor, execution);
    const nextOrigin = resolvedContent !== undefined &&
      (original.origin?.kind === 'skill_activation' || original.origin?.kind === 'plugin_command')
      ? { kind: 'user' as const }
      : original.origin;
    const replacement: ContextMessage = { ...original, id: userMessageId, origin: nextOrigin, source: undefined,
      content: resolvedContent === undefined ? original.content : [
        ...original.content.slice(0, bundledSkillActivations(nextOrigin).length), ...contentToCoreParts(resolvedContent),
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
    if (!matchesTargetMessage(entry, targetMessageId)) continue;
    if (isForkUserBoundary(entry.contextMessage)) {
      return { turnIndex, throughUserMessage: true };
    }
    if (entry.contextMessage.role !== 'assistant' || entry.contextMessage.toolCalls.length > 0 || entry.contextMessage.partial === true) {
      unavailable('fork', targetMessageId, 'unsupported_message_boundary', entry.contextMessage.role);
    }
    const turnId = entry.contextMessage.source?.turnId;
    let end = entries.length;
    for (let next = index + 1; next < entries.length; next += 1) {
      const message = entries[next]!.contextMessage;
      if (isForkUserBoundary(message) || (turnId !== undefined && message.source?.turnId !== undefined && message.source.turnId !== turnId)) {
        end = next;
        break;
      }
    }
    const finalAssistant = entries
      .slice(0, end)
      .findLast((candidate) =>
        candidate.contextMessage.role === 'assistant' &&
        candidate.contextMessage.toolCalls.length === 0,
      );
    if (finalAssistant !== entry || turnIndex < 0) {
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

function matchesTargetMessage(entry: MessageHistoryEntry, targetMessageId: string): boolean {
  if (entry.message.id === targetMessageId) return true;
  return entry.contextMessage.role === 'assistant' && entry.contextMessage.source?.stepId === targetMessageId;
}

function requireTarget(
  entries: readonly MessageHistoryEntry[],
  sessionId: string,
  targetMessageId: string,
): MessageHistoryEntry {
  const target = entries.findLast((entry) => matchesTargetMessage(entry, targetMessageId));
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
  if (isUndoAnchor(target.contextMessage)) return;
  unavailable(action, targetMessageId, 'unsupported_origin_or_role', target.contextMessage.role);
}

function assertRegeneratableAssistant(
  entries: readonly MessageHistoryEntry[],
  target: MessageHistoryEntry,
  targetMessageId: string,
): MessageHistoryEntry {
  const latestAssistant = entries.findLast((entry) => entry.contextMessage.role === 'assistant' && entry.contextMessage.toolCalls.length === 0);
  const latestInput = entries.findLast((entry) => isUndoAnchor(entry.contextMessage));
  if (
    target.contextMessage.role !== 'assistant' ||
    target.contextMessage.toolCalls.length > 0 ||
    latestAssistant !== target || (latestInput !== undefined && latestInput.index > target.index)
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
    if (candidate === undefined) continue;
    if (candidate.contextMessage.origin?.kind === 'compaction_summary' || candidate.contextMessage.inheritedSeed === true) {
      throw new Error2(
        ErrorCodes.SESSION_UNDO_UNAVAILABLE,
        'Message is behind a compaction or checkpoint boundary',
        { details: { reason: 'compaction_boundary', target_message_id: targetMessageId } },
      );
    }
    const inputTurn = candidate.contextMessage.source?.turnId;
    const replyTurn = target.contextMessage.source?.turnId;
    if (candidate.contextMessage.role === 'user' && inputTurn !== undefined && replyTurn !== undefined && inputTurn !== replyTurn) break;
    if (isUndoAnchor(candidate.contextMessage)) return candidate;
  }
  unavailable(
    'regenerate',
    targetMessageId,
    'assistant_has_no_completed_user_turn',
    target.contextMessage.role,
    latestAssistant?.message.id,
  );
}

function liveUndoBoundaryIndex(history: readonly ContextMessage[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.origin?.kind === 'compaction_summary' || message.inheritedSeed === true) {
      return index + 1;
    }
  }
  return 0;
}

async function locateLiveUser(agent: IAgentScopeHandle, entry: MessageHistoryEntry): Promise<ContextMessage> {
  const history = agent.accessor.get(IAgentContextMemoryService).get();
  const boundary = liveUndoBoundaryIndex(history);
  const undoable = history.slice(boundary).filter(isUndoAnchor);
  const target = entry.contextMessage;
  if (target.id !== undefined) {
    const match = undoable.findLast((message) => message.id === target.id && message.providerMessageId === target.providerMessageId);
    if (match !== undefined) return match;
  } else if (boundary === 0) {
    const indexed = history[entry.index];
    if (indexed !== undefined && indexed.id === undefined && isUndoAnchor(indexed) &&
        JSON.stringify(indexed.origin) === JSON.stringify(target.origin)) {
      const blobs = agent.accessor.get(IAgentBlobService);
      const content = await blobs.loadParts(target.content);
      if (JSON.stringify(await blobs.loadParts(indexed.content)) === JSON.stringify(content)) return indexed;
    }
  }
  throw new Error2(
    ErrorCodes.SESSION_UNDO_UNAVAILABLE,
    'Message is behind a compaction or checkpoint boundary',
    { details: { reason: 'compaction_boundary', target_message_id: entry.message.id } },
  );
}

function undoCountFrom(agent: IAgentScopeHandle, target: ContextMessage): number {
  const history = agent.accessor.get(IAgentContextMemoryService).get();
  const index = history.indexOf(target);
  const count = index === -1 ? 0 : history.slice(index).filter(isUndoAnchor).length;
  if (count <= 0) {
    throw new Error2(ErrorCodes.SESSION_UNDO_UNAVAILABLE, 'Message is no longer undoable', {
      details: { reason: 'checkpoint_lost', target_message_id: target.id },
    });
  }
  return count;
}

export async function prepareExecutionOverrides(
  agent: IAgentScopeHandle,
  overrides: PromptExecutionOverrides,
): Promise<import('@kiki/agent-core-v2').PromptExecutionBinding | undefined> {
  const profile = agent.accessor.get(IAgentProfileService);
  const concreteThinking = typeof overrides.thinking === 'string' ? overrides.thinking : undefined;
  if (overrides.model !== undefined || concreteThinking !== undefined) {
    const binding = profile.data();
    if ((binding.executorId ?? 'native') === 'native') {
      if (binding.modelAlias !== undefined && (overrides.profile === undefined || overrides.profile === binding.profileName)) {
        const prepared = await profile.prepareModelSwitchBinding(overrides.model ?? binding.modelAlias, concreteThinking);
        prepared.assertCurrent();
      }
    } else {
      const validation = profile.validateBinding({ modelAlias: overrides.model, thinkingEffort: concreteThinking });
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
  if (isUndoAnchor(message)) return true;
  return message.role === 'user' &&
    message.inheritedSeed !== true &&
    message.origin?.kind === 'shell_command' &&
    message.origin.phase === 'input';
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
