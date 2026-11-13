import { ulid } from 'ulid';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { BranchBase } from '#/agent/contextMemory/contextEvents';
import { newMessageId } from '#/agent/contextMemory/messageId';
import type { BranchFoldOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { turnKey } from '#/agent/loop/turnOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { BRANCH_CONFIG_SECTION, type BranchConfig } from '#/app/branch/configSection';
import { IConfigService } from '#/app/config/config';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { Error2, ErrorCodes } from '#/errors';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { AUTONOMOUS_RECEIPT_POLICY_LABEL } from '#/session/subagent/autonomousReceipt';
import { readTodoState, todoKey, ToolsUpdateStore } from '#/session/todo/todoOps';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  AgentBranchSealed,
  AgentToolLockChanged,
  branchSealedKey,
  branchToolLockKey,
} from './branchOps';
import {
  type CreateSessionBranchInput,
  type CreateSessionBranchResult,
  type DiscardSessionBranchInput,
  type DiscardSessionBranchResult,
  type FoldSessionBranchInput,
  type FoldSessionBranchResult,
  ISessionBranchService,
  ISessionBtwService,
  type SetSessionBranchToolsLockInput,
  type SetSessionBranchToolsLockResult,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from './btw';
import { buildBranchSeedMessages } from './seedBuilder';

const FOLD_PROMPT_MESSAGE =
  'Summarize the key findings, decisions, and outcomes of this branch, then call the Merge tool with `done: true` so the main conversation receives a clean handoff.';

export class SessionBranchService extends Service implements ISessionBranchService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionContext private readonly session: ISessionContext,
    @IConfigService private readonly configService: IConfigService,
    @IOptionalCapabilityPolicy private readonly capabilities?: IOptionalCapabilityPolicy,
  ) {
    super();
  }

  isBranch(agentId: string): boolean {
    if (agentId === MAIN_AGENT_ID) return false;
    return this.metadata.snapshot().agents?.[agentId]?.labels?.['branch'] === 'true';
  }

  isToolsLocked(agentId: string): boolean {
    const handle = this.lifecycle.get(agentId);
    if (handle !== undefined) {
      return handle.accessor.get(IAgentStateService).get(branchToolLockKey) === true;
    }
    return this.metadata.snapshot().agents?.[agentId]?.labels?.['toolsLocked'] === 'true';
  }

  isSealed(agentId: string): boolean {
    const handle = this.lifecycle.get(agentId);
    if (handle !== undefined) {
      return handle.accessor.get(IAgentStateService).get(branchSealedKey) === true;
    }
    return this.metadata.snapshot().agents?.[agentId]?.labels?.['branchSealed'] === 'true';
  }

  private assertBranchAllowed(initiator: 'user' | 'agent', toolsLocked: boolean, callerAgentId: string): void {
    const branchConfig = this.configService.get<BranchConfig>(BRANCH_CONFIG_SECTION);
    if (initiator === 'agent') {
      if (branchConfig?.enabled === false) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Session branching is disabled in configuration ([branch].enabled = false).');
      }
      if (this.capabilities !== undefined) {
        const admission = this.capabilities.admit('branch', {
          sessionId: this.session.sessionId,
          workspaceId: this.session.workspaceId,
          agentId: callerAgentId,
        });
        if (!admission.admitted) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, `Branch capability is disabled for this session (${admission.reason}).`);
        }
      }
      return;
    }
    if (!toolsLocked && branchConfig?.enabled === false) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Session branching is disabled in configuration ([branch].enabled = false).');
    }
  }

  private async ensureLiveAgent(agentId: string): Promise<IAgentScopeHandle> {
    const live = this.lifecycle.get(agentId);
    if (live !== undefined) return live;
    const sessionMeta = await this.metadata.read();
    const meta = sessionMeta.agents?.[agentId];
    if (agentId !== MAIN_AGENT_ID && meta === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    if (agentId === MAIN_AGENT_ID && meta === undefined) {
      return this.lifecycle.create({
        agentId: MAIN_AGENT_ID,
        binding: { profile: DEFAULT_AGENT_PROFILE_NAME },
      });
    }
    return this.lifecycle.create({
      agentId,
      delegator: meta?.delegator,
      userLabel: meta?.userLabel,
      labels: meta?.labels,
      restoreBinding: meta === undefined || meta.model === undefined && (meta.executor ?? 'native') === 'native'
        ? undefined
        : {
            profileName: meta.labels?.['profileName'] ?? meta.displayName ?? DEFAULT_AGENT_PROFILE_NAME,
            modelAlias: meta.model,
            thinkingEffort: meta.thinkingEffort ?? 'medium',
            thinkingEffortExplicit: meta.thinkingEffortExplicit,
            executorId: meta.executor ?? 'native',
            executorProtocol: meta.executorProtocol ?? 'native',
          },
    });
  }

  async createBranch(input: CreateSessionBranchInput = {}): Promise<CreateSessionBranchResult> {
    const parentAgentId = input.parentAgentId ?? MAIN_AGENT_ID;
    const initiator = input.initiator ?? 'user';
    const toolsLocked = input.toolsLocked === true;
    const seedMode = input.seed ?? (toolsLocked ? 'verbatim' : 'fresh');

    this.assertBranchAllowed(initiator, toolsLocked, parentAgentId);

    const parent = await this.ensureLiveAgent(parentAgentId);
    const parentData = parent.accessor.get(IAgentProfileService).data();
    const parentHistory = parent.accessor.get(IAgentContextMemoryService).get();
    const parentState = parent.accessor.get(IAgentStateService);
    const parentTodoState = readTodoState(parentState.get(todoKey));
    const parentEpoch = parentState.get(contextWindowEpochKey);
    const tokenCounting = parent.accessor.get(IAgentTokenCountingService);

    const builtSeed = await buildBranchSeedMessages({
      mode: seedMode,
      carry: input.carry,
      sourceHistory: parentHistory,
      sourceAgentId: parentAgentId,
      sessionId: this.session.sessionId,
      epoch: parentEpoch,
      notes: parentTodoState.notes,
      meta: parentTodoState.notesMeta,
      todos: parentTodoState.items,
      estimateText: (text) => tokenCounting.estimateText(text),
      summarize: seedMode === 'compact'
        ? async (settled, compactCount) => {
            const slice = settled.slice(0, compactCount);
            const compactor = parent.accessor.get(IAgentFullCompactionService);
            return compactor.prepareModelSwitchSummary(slice, new AbortController().signal);
          }
        : undefined,
    });

    const title = normalizeNonBlank(input.title) ?? (toolsLocked ? 'BTW' : deriveBranchTitle(input.task ?? input.prompt));
    const taskName = normalizeNonBlank(input.name);
    const labels: Record<string, string> = {
      [AUTONOMOUS_RECEIPT_POLICY_LABEL]: 'local',
      branch: 'true',
      branchSeed: seedMode,
      branchInitiator: initiator,
      toolsLocked: toolsLocked ? 'true' : 'false',
      ...(taskName === undefined ? {} : { [COLLABORATION_TASK_NAME_LABEL]: taskName }),
    };

    const parentRoots = parent.accessor.get(IAgentRuntimeService).workspaceRoots?.();
    const workspaceRoots = normalizeNonBlank(input.cwd) === undefined
      ? parentRoots
      : {
          workDir: input.cwd!.trim(),
          additionalDirs: parentRoots?.additionalDirs,
        };

    const overrideBinding = input.executor !== undefined
      ? {
          profile: parentData.profileName ?? DEFAULT_AGENT_PROFILE_NAME,
          model: input.model ?? parentData.modelAlias,
          thinking: input.thinking === undefined ? parentData.thinkingLevel : input.thinking ?? undefined,
          lockedExecutorId: input.executor,
        }
      : {
          model: input.model,
          thinking: input.thinking === undefined ? undefined : input.thinking ?? undefined,
        };

    const child = await this.lifecycle.fork(parentAgentId, {
      binding: overrideBinding,
      labels,
      userLabel: title,
      workspaceRoots,
      skipMessageSeed: true,
      deferCreateEvent: true,
    });

    try {
      const childDispatcher = child.accessor.get(IEventDispatcher);
      const childContext = child.accessor.get(IAgentContextMemoryService);
      if (builtSeed.messages.length > 0) {
        childContext.append(...builtSeed.messages);
      }
      await childDispatcher.dispatch(new BranchBase({
        version: 1,
        parentAgentId,
        seed: seedMode,
        inheritedCount: builtSeed.inheritedCount,
        baseAnchor: builtSeed.baseAnchor,
      }));

      if (parentTodoState.items.length > 0) {
        await childDispatcher.dispatch(new ToolsUpdateStore({
          key: 'todo',
          value: parentTodoState.items,
        }));
      }
      if (parentTodoState.notes !== undefined || parentTodoState.notesMeta !== undefined) {
        await childDispatcher.dispatch(new ToolsUpdateStore({
          key: 'todo_notes',
          value: { notes: parentTodoState.notes, notesMeta: parentTodoState.notesMeta },
        }));
      }

      if (toolsLocked) {
        await childDispatcher.dispatch(new AgentToolLockChanged({ locked: true }));
        child.accessor.get(IAgentSystemReminderService)?.appendSystemReminder(
          SIDE_QUESTION_SYSTEM_REMINDER,
          { kind: 'injection', variant: 'btw' },
        );
      }

      await this.metadata.updateAgent(child.id, (current) => ({
        ...current,
        displayName: title ?? current.displayName,
        userLabel: title ?? current.userLabel,
        labels: {
          ...current.labels,
          ...labels,
        },
      }));

      this.lifecycle.commitCreate(child.id);
    } catch (error) {
      await this.lifecycle.discard(child.id).catch(() => {});
      throw error;
    }

    const initialText = buildInitialBranchPrompt(input.task, input.prompt);
    let started = false;
    if (initialText !== undefined) {
      const promptService = child.accessor.get(IAgentPromptService);
      await promptService.enqueue({
        message: {
          id: newMessageId(),
          role: 'user',
          content: [{ type: 'text', text: initialText }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        waitForLaunch: false,
      });
      started = true;
    }

    return {
      branchId: child.id,
      parentAgentId,
      seed: seedMode,
      title,
      toolsLocked,
      started,
    };
  }

  async foldBranch(input: FoldSessionBranchInput): Promise<FoldSessionBranchResult> {
    const branchId = input.branchId.trim();
    if (branchId.length === 0 || branchId === MAIN_AGENT_ID) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'branchId must identify a non-main branch agent.');
    }
    const sessionMeta = await this.metadata.read();
    const branchMeta = sessionMeta.agents?.[branchId];
    if (branchMeta === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Branch "${branchId}" does not exist`, {
        details: { agentId: branchId },
      });
    }
    const branchHandle = await this.ensureLiveAgent(branchId);
    const branchStates = branchHandle.accessor.get(IAgentStateService);
    const alreadySealed = branchStates.get(branchSealedKey) === true || branchMeta.labels?.['branchSealed'] === 'true';
    const turnState = branchStates.get(turnKey);
    const throughTurnId = Math.max(0, (turnState?.nextTurnId ?? 0) - 1);
    const hasTurns = (turnState?.nextTurnId ?? 0) > 0;

    const authoredBody = normalizeNonBlank(input.context) ?? normalizeNonBlank(input.summary);
    if (authoredBody === undefined) {
      if (input.fromTool === true) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Merge requires a non-empty summary or context.');
      }
      if (alreadySealed) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Branch is already sealed; provide an explicit summary note if you want to fold again.');
      }
      await branchHandle.accessor.get(IAgentPromptService).enqueue({
        message: {
          id: newMessageId(),
          role: 'user',
          content: [{ type: 'text', text: FOLD_PROMPT_MESSAGE }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        waitForLaunch: false,
      });
      return {
        branchId,
        status: 'prompted',
        done: false,
        sealed: false,
        handedBackCount: 0,
        throughTurnId,
      };
    }

    const done = input.done !== false;
    const foldId = `fold_${ulid()}`;
    const branchTitle = branchMeta.userLabel ?? branchMeta.displayName;
    const asks = input.asks?.map((item) => item.trim()).filter((item) => item.length > 0);
    const targetAgentId = branchMeta.parentAgentId ?? MAIN_AGENT_ID;
    const targetHandle = await this.ensureLiveAgent(targetAgentId);

    const foldText = formatBranchFoldText({
      branchId,
      branchTitle,
      body: authoredBody,
      asks,
      throughTurnId,
      hasTurns,
      done,
    });

    const origin: BranchFoldOrigin = {
      kind: 'branch_fold',
      foldId,
      branchId,
      branchTitle,
      asks: asks !== undefined && asks.length > 0 ? asks : undefined,
      throughTurnId,
      done,
    };

    const foldMessage: ContextMessage = {
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: foldText }],
      toolCalls: [],
      origin,
    };

    const targetLoop = targetHandle.accessor.get(IAgentLoopService);
    const targetPrompts = targetHandle.accessor.get(IAgentPromptService);
    const targetRunning =
      targetLoop.status().state !== 'idle' ||
      targetLoop.status().pendingTurnIds.length > 0 ||
      targetPrompts.list().active !== undefined ||
      targetPrompts.list().launching !== undefined;
    const initiator = branchMeta.labels?.['branchInitiator'] === 'agent' ? 'agent' : 'user';

    if (targetRunning) {
      targetLoop.enqueue(new MessageStepRequest(foldMessage, {
        kind: 'branch_fold',
        admission: 'activeOrNextTurn',
        mergeable: false,
        turnScoped: false,
        deliveryOrigin: 'mailbox',
      }));
    } else if (initiator === 'agent') {
      targetLoop.enqueue(new MessageStepRequest(foldMessage, {
        kind: 'branch_fold',
        admission: 'activeOrNewTurn',
        mergeable: false,
        turnScoped: false,
        deliveryOrigin: 'mailbox',
      }));
    } else {
      targetHandle.accessor.get(IAgentContextMemoryService).appendObservable(foldMessage);
    }

    let sealed = alreadySealed;
    let handedBackCount = 0;
    if (done && !alreadySealed) {
      await branchHandle.accessor.get(IEventDispatcher).dispatch(new AgentBranchSealed({
        sealed: true,
        foldId,
      }));
      await this.metadata.updateAgent(branchId, (current) => ({
        ...current,
        labels: {
          ...current.labels,
          branchSealed: 'true',
        },
      }));
      sealed = true;
      handedBackCount = await this.handBackQueuedPrompts(branchHandle, targetHandle);
    }

    return {
      branchId,
      foldId,
      status: 'merged',
      done,
      sealed,
      handedBackCount,
      throughTurnId,
    };
  }

  private async handBackQueuedPrompts(
    branchHandle: IAgentScopeHandle,
    targetHandle: IAgentScopeHandle,
  ): Promise<number> {
    const branchPrompts = branchHandle.accessor.get(IAgentPromptService);
    const snapshot = branchPrompts.list();
    if (snapshot.pending.length === 0) return 0;
    const targetPrompts = targetHandle.accessor.get(IAgentPromptService);
    let count = 0;
    for (const item of snapshot.pending) {
      const aborted = await branchPrompts.abortQueued(item.id);
      if (!aborted) continue;
      if (item.message.origin?.kind !== 'user' && item.message.origin !== undefined) continue;
      await targetPrompts.enqueue({
        message: {
          ...item.message,
          id: newMessageId(),
        },
        appendTiming: item.appendTiming,
        waitForLaunch: false,
      });
      count++;
    }
    return count;
  }

  async discardBranch(input: DiscardSessionBranchInput): Promise<DiscardSessionBranchResult> {
    const branchId = input.branchId.trim();
    if (branchId.length === 0 || branchId === MAIN_AGENT_ID) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Cannot discard main agent.');
    }
    const existing = (await this.metadata.read()).agents?.[branchId];
    if (existing === undefined) {
      return { branchId, discarded: false };
    }
    await this.lifecycle.remove(branchId, 'cancel');
    await this.metadata.unregisterAgent?.(branchId);
    return { branchId, discarded: true };
  }

  async setToolsLocked(input: SetSessionBranchToolsLockInput): Promise<SetSessionBranchToolsLockResult> {
    const branchId = input.branchId.trim();
    if (branchId.length === 0 || branchId === MAIN_AGENT_ID) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'branchId must identify a branch agent.');
    }
    const handle = await this.ensureLiveAgent(branchId);
    await handle.accessor.get(IEventDispatcher).dispatch(new AgentToolLockChanged({ locked: input.locked }));
    await this.metadata.updateAgent(branchId, (current: AgentMeta) => ({
      ...current,
      labels: {
        ...current.labels,
        toolsLocked: input.locked ? 'true' : 'false',
      },
    }));
    return { branchId, toolsLocked: input.locked };
  }
}

export class SessionBtwService extends Service implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionBranchService private readonly branches?: ISessionBranchService,
  ) {
    super();
  }

  async start(): Promise<string> {
    if (this.branches !== undefined) {
      const created = await this.branches.createBranch({
        parentAgentId: MAIN_AGENT_ID,
        initiator: 'user',
        seed: 'verbatim',
        title: 'BTW',
        toolsLocked: true,
      });
      return created.branchId;
    }

    const child = await this.lifecycle.fork(MAIN_AGENT_ID);
    const meta = child.accessor.get(ISessionMetadata);
    await meta?.updateAgent(child.id, (current) => ({
      ...current,
      labels: {
        ...current.labels,
        [AUTONOMOUS_RECEIPT_POLICY_LABEL]: 'local',
        branch: 'true',
        branchSeed: 'verbatim',
        branchInitiator: 'user',
        toolsLocked: 'true',
      },
    }));
    child.accessor.get(IAgentSystemReminderService)?.appendSystemReminder(
      SIDE_QUESTION_SYSTEM_REMINDER,
      { kind: 'injection', variant: 'btw' },
    );
    const executor = child.accessor.get(IAgentToolExecutorService);
    const approval = child.accessor.get(IAgentToolApprovalService);
    if (executor !== undefined) {
      this._register(
        executor.onBeforeExecuteTool((event) => {
          const reason = approval?.formatDenyMessage(TOOL_CALL_DISABLED_MESSAGE) ?? TOOL_CALL_DISABLED_MESSAGE;
          event.veto(denyToolExecution(reason));
        }),
      );
    }
    return child.id;
  }
}

function normalizeNonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function deriveBranchTitle(text: string | undefined): string | undefined {
  const cleaned = normalizeNonBlank(text)?.replaceAll(/\s+/g, ' ');
  if (cleaned === undefined) return undefined;
  return cleaned.length <= 48 ? cleaned : `${cleaned.slice(0, 47).trimEnd()}…`;
}

function buildInitialBranchPrompt(task: string | undefined, prompt: string | undefined): string | undefined {
  const cleanTask = normalizeNonBlank(task);
  const cleanPrompt = normalizeNonBlank(prompt);
  if (cleanTask !== undefined && cleanPrompt !== undefined && cleanTask !== cleanPrompt) {
    return `${cleanTask}\n\n${cleanPrompt}`;
  }
  return cleanPrompt ?? cleanTask;
}

export function formatBranchFoldText(input: {
  readonly branchId: string;
  readonly branchTitle?: string;
  readonly body: string;
  readonly asks?: readonly string[];
  readonly throughTurnId: number;
  readonly hasTurns: boolean;
  readonly done: boolean;
}): string {
  const titleSuffix = input.branchTitle !== undefined && input.branchTitle !== input.branchId
    ? ` (${input.branchTitle})`
    : '';
  const header = input.done
    ? `Merged branch ${input.branchId}${titleSuffix}:`
    : `Interim update from branch ${input.branchId}${titleSuffix}:`;
  const asksBlock = input.asks !== undefined && input.asks.length > 0
    ? `\n\nOpen asks:\n${input.asks.map((ask) => `- ${ask}`).join('\n')}`
    : '';
  const pointer = input.hasTurns
    ? `Branch history: HistoryList({ agent_id: ${JSON.stringify(input.branchId)} }) · HistoryRead({ agent_id: ${JSON.stringify(input.branchId)}, turn: ${input.throughTurnId} })`
    : `Branch history: HistoryList({ agent_id: ${JSON.stringify(input.branchId)} })`;
  return `${header}\n\n${input.body.trim()}${asksBlock}\n\n${pointer}`;
}
