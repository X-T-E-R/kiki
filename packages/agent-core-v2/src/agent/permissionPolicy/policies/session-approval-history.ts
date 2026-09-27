import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { matchPermissionRule } from '#/agent/permissionRules/matchesRule';
import { literalRulePattern } from '#/tool/rule-match';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class SessionApprovalHistoryPermissionPolicyService implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const command = (context.args as { command?: unknown } | null)?.command;
    for (const pattern of this.rulesService.sessionApprovalRulePatterns) {
      if (context.toolCall.name === 'Bash' &&
        (typeof command !== 'string' || pattern !== literalRulePattern('Bash', command))) continue;
      const match = matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) {
        return {
          kind: 'approve',
          reason: {
            has_rule_args: match.hasRuleArgs,
            match_strategy: match.strategy,
          },
        };
      }
    }
    return undefined;
  }
}
