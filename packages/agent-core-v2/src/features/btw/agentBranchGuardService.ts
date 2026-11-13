import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';

import { branchSealedKey, branchToolLockKey } from './branchOps';
import { BRANCH_SEALED_MESSAGE, TOOL_CALL_DISABLED_MESSAGE } from './btw';

export interface IAgentBranchGuardService {
  readonly _serviceBrand: undefined;
}

export const IAgentBranchGuardService = createDecorator<IAgentBranchGuardService>('agentBranchGuardService');

export class AgentBranchGuardService extends Service implements IAgentBranchGuardService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolApprovalService private readonly toolApproval?: IAgentToolApprovalService,
  ) {
    super();
    this.agentState.contributeState(branchToolLockKey);
    this.agentState.contributeState(branchSealedKey);
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (this.agentState.get(branchSealedKey) === true) {
          const reason = this.toolApproval?.formatDenyMessage(BRANCH_SEALED_MESSAGE) ?? BRANCH_SEALED_MESSAGE;
          event.veto(denyToolExecution(reason));
          return;
        }
        if (this.agentState.get(branchToolLockKey) === true && event.toolCall.name !== 'Merge') {
          const reason = this.toolApproval?.formatDenyMessage(TOOL_CALL_DISABLED_MESSAGE) ?? TOOL_CALL_DISABLED_MESSAGE;
          event.veto(denyToolExecution(reason));
        }
      }),
    );
  }
}
