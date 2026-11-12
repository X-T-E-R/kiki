import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { matchPermissionRule } from '#/agent/permissionRules/matchesRule';
import { isSensitiveFile } from '#/tool/path-access';

import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { fileAccesses } from './path-utils';

function targetBoundKey(context: ResolvedToolExecutionHookContext): string | undefined {
  const targets = fileAccesses(context)
    .filter((access) => access.implicitExternal === true || isSensitiveFile(access.path))
    .map((access) => `${access.operation}:${access.path}`);
  if (targets.length === 0) return undefined;
  return JSON.stringify([context.execution.approvalRule, ...new Set(targets.toSorted())]);
}

/**
 * The key an "approve for this session" answer records for this call. A call that
 * touches a sensitive file or follows a link out of the workspace records a key bound
 * to those exact targets, so the approval never extends to other such targets.
 */
export function sessionApprovalKey(context: ResolvedToolExecutionHookContext): string | undefined {
  return targetBoundKey(context) ??
    (context.toolCall.name === 'Bash' ? context.execution.sessionApprovalRule : context.execution.approvalRule);
}

export class SessionApprovalHistoryPermissionPolicyService implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const bound = targetBoundKey(context);
    if (bound !== undefined) {
      return this.rulesService.sessionApprovalRulePatterns.includes(bound) ? { kind: 'approve' } : undefined;
    }
    if (context.permissionAuthority === 'owner') {
      return this.rulesService.sessionApprovalRulePatterns.includes(context.execution.approvalRule) ? { kind: 'approve' } : undefined;
    }
    if (context.toolCall.name === 'Bash') {
      const key = context.execution.sessionApprovalRule;
      return key !== undefined && this.rulesService.sessionApprovalRulePatterns.includes(key)
        ? { kind: 'approve' }
        : undefined;
    }
    for (const pattern of this.rulesService.sessionApprovalRulePatterns) {
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
