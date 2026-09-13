import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IFlagService } from '#/app/flag/flag';
import { TASK_BOARD_FLAG_ID } from '#/app/taskBoard/flag';
import {
  BoardReadSchema,
  BoardWriteSchema,
  ITaskBoardService,
  type BoardReadInput,
  type BoardWriteInput,
} from '#/app/taskBoard/taskBoard';
import { IAgentPlanService } from '#/features/plan/plan';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ExecutableToolErrorResult, type ToolExecution } from '#/tool/toolContract';

export interface IBoardReadTool extends AgentTool<BoardReadInput> {}
export interface IBoardWriteTool extends AgentTool<BoardWriteInput> {}
export const IBoardReadTool = createDecorator<IBoardReadTool>('boardReadTool');
export const IBoardWriteTool = createDecorator<IBoardWriteTool>('boardWriteTool');

function denied(message: string): ExecutableToolErrorResult {
  return { isError: true, output: JSON.stringify({ ok: false, error: { code: 'BOARD_ACCESS_DENIED', message } }) };
}

function enabledMain(scope: IAgentScopeContext, flags: IFlagService): boolean {
  return scope.agentId === 'main' && scope.parentAgentId === undefined && flags.enabled(TASK_BOARD_FLAG_ID);
}

export class BoardReadTool implements IBoardReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'BoardRead';
  readonly description = 'Read persistent Own Work requirements in the current workspace, optionally filtered by active, in_progress, paused, done, cancelled, or superseded status. Overview requires explicit authorized workspace IDs. These cards are not agent runs or TodoList entries.';
  readonly parameters = toInputJsonSchema(BoardReadSchema);

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
    @IFlagService private readonly flags: IFlagService,
    @ITaskBoardService private readonly board: ITaskBoardService,
  ) {}

  resolveExecution(input: BoardReadInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Reading Own Work requirements',
      accesses: ToolAccesses.all(),
      execute: async () => {
        if (!enabledMain(this.scope, this.flags) || !this.policy.isToolActive(this.name)) {
          return denied('BoardRead is available only to the enabled main agent under its active tool policy.');
        }
        const result = await this.board.read(input.action === 'overview'
          ? input
          : { ...input, workspaceId: input.workspaceId ?? this.session.workspaceId });
        return result.ok
          ? { output: JSON.stringify(result) }
          : { isError: true, output: JSON.stringify(result) };
      },
    };
  }
}

export class BoardWriteTool implements IBoardWriteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'BoardWrite';
  readonly description = 'Create or update a persistent Own Work requirement without starting a session or execution. Creation always starts an active card and keeps its existing requestKey/idempotency semantics; do not pass status to create. Use a stable requestKey and a BoardRead preview target for creation retries. Updates require the card’s original storage address and expectedRevision; read again on conflict. Update status to active, in_progress, paused, done, cancelled, or superseded explicitly; session/execution IDs are associations, not a runner. Never automatically complete requirements after runs. Terminal statuses cannot reopen. BoardWrite is unavailable in plan mode.';
  readonly parameters = toInputJsonSchema(BoardWriteSchema);

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentPlanService private readonly plan: IAgentPlanService,
    @ITaskBoardService private readonly board: ITaskBoardService,
  ) {}

  resolveExecution(input: BoardWriteInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Updating Own Work requirements',
      accesses: ToolAccesses.all(),
      execute: async () => {
        if (!enabledMain(this.scope, this.flags) || !this.policy.isToolActive(this.name)) {
          return denied('BoardWrite is available only to the enabled main agent under its active tool policy.');
        }
        if (await this.plan.status() !== null) {
          return denied('Requirements cannot be changed in plan mode.');
        }
        const result = await this.board.write({ ...input, workspaceId: input.workspaceId ?? this.session.workspaceId });
        return result.ok
          ? { output: JSON.stringify(result) }
          : { isError: true, output: JSON.stringify(result) };
      },
    };
  }
}

const mainOnly = (accessor: ServicesAccessor): boolean =>
  enabledMain(accessor.get(IAgentScopeContext), accessor.get(IFlagService));

export const BOARD_TOOL_CONTRIBUTIONS = [
  { id: IBoardReadTool, ctor: BoardReadTool, options: { name: 'BoardRead', domain: 'taskBoard', when: mainOnly } },
  { id: IBoardWriteTool, ctor: BoardWriteTool, options: { name: 'BoardWrite', domain: 'taskBoard', when: mainOnly } },
] as const;
