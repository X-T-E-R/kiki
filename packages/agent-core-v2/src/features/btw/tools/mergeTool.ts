import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionBranchService } from '#/features/btw/btw';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

export const MergeInputSchema = z.object({
  summary: z.string().trim().min(1).max(32_000).optional().describe('Concise, self-contained handoff authored directly for the main conversation: key conclusion, decisions, changed paths, verification, and remaining risks. Alias of context.'),
  context: z.string().trim().min(1).max(32_000).optional().describe('Alias of summary: model-authored context block inserted into the main conversation.'),
  asks: z.array(z.string().trim().min(1).max(2_000)).max(20).optional().describe('Optional open questions or decisions that main or the user still needs to resolve.'),
  done: z.boolean().default(true).describe('When true (default), seals this branch after delivering the merge and hands any unconsumed queued user prompts back to main. Set false for an interim checkpoint while keeping the branch open.'),
}).strict().refine((value) => value.summary !== undefined || value.context !== undefined, {
  message: 'Provide summary or context.',
});

export type MergeInput = z.infer<typeof MergeInputSchema>;

export const IMergeTool = createDecorator<AgentTool<MergeInput>>('mergeTool');

const MERGE_DESCRIPTION = [
  'Fold this branch’s authored conclusion back into the main conversation.',
  'Write a crisp, high-signal summary/context with the outcome, decisive reasons, and concrete artifacts; do not paste raw logs or exhaustive command transcripts — main automatically receives a one-line HistoryList/HistoryRead pointer with this branch’s agent_id for on-demand inspection.',
  'Pass done=true (default) when this branch’s objective is complete to seal the branch cleanly, or done=false to send an interim update while continuing work here.',
].join(' ');

export class MergeTool implements AgentTool<MergeInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Merge' as const;
  readonly description: string = MERGE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MergeInputSchema, (schema) => {
    schema['anyOf'] = [{ required: ['summary'] }, { required: ['context'] }];
  });

  constructor(
    @ISessionBranchService private readonly branches: ISessionBranchService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {}

  resolveExecution(input: MergeInput): ToolExecution {
    return {
      description: input.done === false ? 'Sending interim branch update to main' : 'Merging branch into main',
      approvalRule: this.name,
      stopBatchAfterThis: input.done !== false,
      accesses: ToolAccesses.none(),
      execute: async () => {
        if (this.scope.isBranch !== true) {
          return {
            isError: true,
            output: 'Merge can only be called inside a session branch.',
          };
        }
        const folded = await this.branches.foldBranch({
          branchId: this.scope.agentId,
          summary: input.summary,
          context: input.context,
          asks: input.asks,
          done: input.done,
          fromTool: true,
        });
        return {
          output: JSON.stringify({
            branch_id: folded.branchId,
            fold_id: folded.foldId,
            status: folded.status,
            done: folded.done,
            sealed: folded.sealed,
            handed_back_prompts: folded.handedBackCount,
            through_turn: folded.throughTurnId,
          }),
        };
      },
    };
  }
}
