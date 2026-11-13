import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  BRANCH_CONFIG_SECTION,
  type BranchConfig,
  type BranchUsagePreference,
} from '#/app/branch/configSection';
import { IConfigService } from '#/app/config/config';
import { ISessionBranchService } from '#/features/btw/btw';
import {
  SessionSeedCarrySchema,
  SessionSeedModeSchema,
} from '#/features/btw/seedBuilder';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

export const BranchInputSchema = z.object({
  task: z.string().trim().min(1).max(16_000).describe('Self-contained objective or side question for the branch.'),
  prompt: z.string().trim().min(1).max(32_000).optional().describe('Optional opening prompt or detailed context to enqueue on the branch immediately.'),
  seed: SessionSeedModeSchema.optional().describe('Context seed mode: fresh (default — carried recent user turns + live relay without raw wire copy), compact (model summary + recent turns), or verbatim (full settled prefix).'),
  carry: SessionSeedCarrySchema.optional().describe('Optional recent-turn carry window when seed is fresh or compact.'),
  title: z.string().trim().min(1).max(120).optional().describe('Short label shown in the session branch switcher.'),
  name: z.string().regex(/^[a-z0-9_]+$/u).refine((value) => value !== 'root').optional().describe('Optional stable snake_case alias for addressing the branch with AgentSend or HistoryList/HistoryRead.'),
  model: z.string().trim().min(1).optional().describe('Optional model alias override for the branch.'),
  thinking: z.string().trim().min(1).nullable().optional().describe('Optional thinking effort override for the branch.'),
  executor: z.string().trim().min(1).optional().describe('Optional executor ID override for the branch.'),
  cwd: z.string().trim().min(1).optional().describe('Optional working directory override for the branch.'),
}).strict();

export type BranchInput = z.infer<typeof BranchInputSchema>;

export const IBranchTool = createDecorator<AgentTool<BranchInput>>('branchTool');

const BASE_BRANCH_DESCRIPTION = [
  'Open an in-session conversation branch rooted at main.',
  'Unlike AgentRun subagents, a branch is a full peer conversation inside the same session: the user can switch to it directly, and the branch folds a concise authored outcome back into main with Merge.',
  'Branch returns immediately with { branch_id, name, seed, title, started } without blocking your current turn. You can steer an open branch with AgentSend({ target: branch_id, message }) and inspect its full transcript on demand with HistoryList({ agent_id: branch_id }) or HistoryRead({ agent_id: branch_id, turn }).',
].join(' ');

export function branchToolDescription(preference: BranchUsagePreference = 'balanced'): string {
  const guidance = preference === 'conservative'
    ? 'Branching preference (conservative): Only open a branch when the user asks or when an independent side investigation would clearly pollute or derail the main conversation; keep ordinary checks and sequential steps inline.'
    : preference === 'proactive'
      ? 'Branching preference (proactive): Proactively spin off side questions, parallel checks, independent sub-problems, and tangential requests into branches so the main conversation stays clean and responsive, folding concise conclusions back via Merge.'
      : 'Branching preference (balanced): Open a branch for bounded side investigations, parallel topic detours, or exploratory trials whose intermediate steps do not belong in the main thread, while keeping short direct work inline.';
  return `${BASE_BRANCH_DESCRIPTION}\n\n${guidance}`;
}

export class BranchTool implements AgentTool<BranchInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Branch' as const;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BranchInputSchema);

  constructor(
    @ISessionBranchService private readonly branches: ISessionBranchService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IConfigService private readonly config: IConfigService,
  ) {}

  get description(): string {
    const preference = this.config.get<BranchConfig>(BRANCH_CONFIG_SECTION)?.usagePreference ?? 'balanced';
    return branchToolDescription(preference);
  }

  resolveExecution(input: BranchInput): ToolExecution {
    return {
      description: input.title === undefined ? 'Opening session branch' : `Opening branch: ${input.title}`,
      approvalRule: this.name,
      accesses: ToolAccesses.none(),
      execute: async () => {
        if (this.scope.isBranch === true || this.scope.agentId !== MAIN_AGENT_ID) {
          return {
            isError: true,
            output: 'Branch can only be called from the main conversation.',
          };
        }
        const created = await this.branches.createBranch({
          parentAgentId: MAIN_AGENT_ID,
          initiator: 'agent',
          task: input.task,
          prompt: input.prompt,
          seed: input.seed ?? 'fresh',
          carry: input.carry,
          title: input.title,
          name: input.name,
          model: input.model,
          thinking: input.thinking,
          executor: input.executor,
          cwd: input.cwd,
          toolsLocked: false,
        });
        return {
          output: JSON.stringify({
            branch_id: created.branchId,
            name: input.name,
            parent_agent_id: created.parentAgentId,
            seed: created.seed,
            title: created.title,
            started: created.started,
          }),
        };
      },
    };
  }
}
