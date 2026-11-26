import { createDecorator, ref, type LiveRef } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextAppendObservableMessage,
  ContextClear,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '#/agent/loop/turnOps';
import {
  PromptEnqueued,
  PromptQueued,
  PromptSteerAccepted,
  PromptSteered,
} from '#/agent/prompt/promptService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentCollaborationMessageStore } from '#/session/agentCollaboration/messageMailbox';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  AgentBranchSealed,
  branchCoverageKey,
  branchSealedKey,
  branchToolLockKey,
  isBranchConsumedLoopEvent,
  isBranchConsumedMessage,
} from './branchOps';
import { TOOL_CALL_DISABLED_MESSAGE } from './btw';

export interface IAgentBranchGuardService {
  readonly _serviceBrand: undefined;
  /** Resolves once an in-flight post-merge revival of this branch is durable. */
  revived(): Promise<void>;
}

export const IAgentBranchGuardService = createDecorator<IAgentBranchGuardService>('agentBranchGuardService');

export class AgentBranchGuardService extends Service implements IAgentBranchGuardService {
  declare readonly _serviceBrand: undefined;
  private reviving: Promise<void> | undefined;
  private revivalError: unknown;

  constructor(
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IEventBus bus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentToolApprovalService private readonly toolApproval?: IAgentToolApprovalService,
    @ILogService private readonly log?: ILogService,
    @ref(ISessionContext) private readonly sessionRef?: LiveRef<ISessionContext>,
    @ref(IAgentCollaborationMessageStore) private readonly mailboxRef?: LiveRef<IAgentCollaborationMessageStore>,
  ) {
    super();
    this.agentState.contributeState(branchToolLockKey);
    this.agentState.contributeState(branchSealedKey);
    this.agentState.contributeState(branchCoverageKey);
    const reviveIfSealed = () => {
      if (this.agentState.get(branchSealedKey) === true) this.revive();
    };
    this._register(bus.subscribe(TurnPrompt, reviveIfSealed));
    this._register(bus.subscribe(TurnStarted, reviveIfSealed));
    this._register(bus.subscribe(PromptQueued, reviveIfSealed));
    this._register(bus.subscribe(PromptEnqueued, reviveIfSealed));
    this._register(bus.subscribe(PromptSteerAccepted, reviveIfSealed));
    this._register(bus.subscribe(PromptSteered, reviveIfSealed));
    this._register(bus.subscribe(ContextUndo, reviveIfSealed));
    this._register(bus.subscribe(ContextClear, reviveIfSealed));
    this._register(bus.subscribe(ContextAppendMessage, ({ message }) => {
      if (isBranchConsumedMessage(message)) reviveIfSealed();
    }));
    this._register(bus.subscribe(ContextAppendObservableMessage, ({ message }) => {
      if (isBranchConsumedMessage(message)) reviveIfSealed();
    }));
    this._register(bus.subscribe(ContextAppendLoopEvent, ({ event }) => {
      if (isBranchConsumedLoopEvent(event)) reviveIfSealed();
    }));
    this._register(bus.subscribe(TurnEnded, (event) => {
      if (event.reason === 'failed' || event.reason === 'cancelled') reviveIfSealed();
    }));
    this.bindMailboxSubscription();
    if (this.mailboxRef !== undefined) {
      this._register(this.mailboxRef.onDidChange(() => { this.bindMailboxSubscription(); }));
    }
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        const denyReason = (): string | undefined => {
          if (this.agentState.get(branchToolLockKey) === true && event.toolCall.name !== 'Merge') {
            return this.toolApproval?.formatDenyMessage(TOOL_CALL_DISABLED_MESSAGE) ?? TOOL_CALL_DISABLED_MESSAGE;
          }
          return undefined;
        };
        if (this.reviving !== undefined) {
          const pending = this.reviving;
          event.waitUntil(async () => {
            await pending;
            const reason = denyReason();
            return reason === undefined ? undefined : { veto: denyToolExecution(reason) };
          });
          return;
        }
        const reason = denyReason();
        if (reason !== undefined) {
          event.veto(denyToolExecution(reason));
        }
      }),
    );
  }

  private mailboxSubscriptionDisposer: (() => void) | undefined;

  private bindMailboxSubscription(): void {
    this.mailboxSubscriptionDisposer?.();
    this.mailboxSubscriptionDisposer = undefined;
    const mailbox = this.mailboxRef?.current;
    if (mailbox?.onDidChangePending === undefined) return;
    const sub = mailbox.onDidChangePending((event) => {
      const sessionId = this.sessionRef?.current?.sessionId;
      if (sessionId !== undefined && event.sessionId !== sessionId) return;
      if (event.agentId !== this.scopeContext.agentId) return;
      if (this.agentState.get(branchSealedKey) !== true) return;
      if (sessionId === undefined) {
        this.revive();
        return;
      }
      void mailbox.listPendingAgents(sessionId).then((agents) => {
        if (agents.includes(this.scopeContext.agentId) && this.agentState.get(branchSealedKey) === true) {
          this.revive();
        }
      }, () => {});
    });
    this.mailboxSubscriptionDisposer = () => sub.dispose();
    this._register({ dispose: () => {
      this.mailboxSubscriptionDisposer?.();
      this.mailboxSubscriptionDisposer = undefined;
    } });
  }

  revived(): Promise<void> {
    if (this.reviving !== undefined) return this.reviving;
    if (this.revivalError !== undefined && this.agentState.get(branchSealedKey) === true) {
      return Promise.reject(this.revivalError);
    }
    return Promise.resolve();
  }

  private revive(): void {
    if (this.reviving !== undefined) return;
    this.revivalError = undefined;
    const agentId = this.scopeContext.agentId;
    const reviving = (async () => {
      try {
        await this.metadata.updateAgent(agentId, (current) => {
          const { branchSealed: _sealed, ...labels } = current.labels ?? {};
          return {
            ...current,
            status: undefined,
            completedAt: undefined,
            resultSummary: undefined,
            error: undefined,
            labels,
          };
        });
        await this.dispatcher.dispatchDurably(new AgentBranchSealed({ sealed: false }));
        this.revivalError = undefined;
      } catch (error) {
        this.revivalError = error;
        this.log?.error('failed to revive merged branch', { agentId, error });
        throw error;
      }
    })().finally(() => {
      if (this.reviving === reviving) this.reviving = undefined;
    });
    void reviving.catch(() => {});
    this.reviving = reviving;
  }
}
