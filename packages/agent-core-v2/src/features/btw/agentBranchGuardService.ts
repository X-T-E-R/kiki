import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { AgentBranchSealed, branchSealedKey, branchToolLockKey } from './branchOps';
import { BRANCH_SEALED_MESSAGE, TOOL_CALL_DISABLED_MESSAGE } from './btw';

export interface IAgentBranchGuardService {
  readonly _serviceBrand: undefined;
  /** Resolves once an in-flight post-merge revival of this branch is durable. */
  revived(): Promise<void>;
}

export const IAgentBranchGuardService = createDecorator<IAgentBranchGuardService>('agentBranchGuardService');

export class AgentBranchGuardService extends Service implements IAgentBranchGuardService {
  declare readonly _serviceBrand: undefined;
  private reviving: Promise<void> | undefined;

  constructor(
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IEventBus bus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentToolApprovalService private readonly toolApproval?: IAgentToolApprovalService,
    @ILogService private readonly log?: ILogService,
  ) {
    super();
    this.agentState.contributeState(branchToolLockKey);
    this.agentState.contributeState(branchSealedKey);
    this._register(bus.subscribe(TurnStarted, () => {
      if (this.agentState.get(branchSealedKey) === true) this.revive();
    }));
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        const denyReason = (): string | undefined => {
          if (this.agentState.get(branchSealedKey) === true) {
            return this.toolApproval?.formatDenyMessage(BRANCH_SEALED_MESSAGE) ?? BRANCH_SEALED_MESSAGE;
          }
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

  revived(): Promise<void> {
    return this.reviving ?? Promise.resolve();
  }

  private revive(): void {
    if (this.reviving !== undefined) return;
    const agentId = this.scopeContext.agentId;
    const reviving = (async () => {
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
    })().catch((error: unknown) => {
      this.log?.error('failed to revive merged branch', { agentId, error });
    }).finally(() => {
      if (this.reviving === reviving) this.reviving = undefined;
    });
    this.reviving = reviving;
  }
}
