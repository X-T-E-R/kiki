import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { matchPermissionRule } from '#/agent/permissionRules/matchesRule';
import { isSensitiveFile } from '#/tool/path-access';

import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IGitService } from '#/app/git/git';
import type { ToolFileAccess } from '#/tool/toolContract';
import { fileAccesses, gitControlFileAccesses } from './path-utils';

function targetBoundKey(context: ResolvedToolExecutionHookContext, gitTargets: readonly ToolFileAccess[]): string | undefined {
  const targets = [
    ...fileAccesses(context)
      .filter((access) => access.implicitExternal === true || isSensitiveFile(access.path)),
    ...gitTargets,
  ].map((access) => `${access.operation}:${access.path}`);
  const rule = context.toolCall.name === 'Bash' ? context.execution.sessionApprovalRule : context.execution.approvalRule;
  if (targets.length === 0 || rule === undefined) return undefined;
  return JSON.stringify([rule, ...new Set(targets.toSorted())]);
}

/**
 * The key an "approve for this session" answer records for this call. A call that
 * touches a sensitive file, a Git control path, or a link out of the workspace records
 * a key bound to those exact targets. Pass every classified Git control access.
 */
export function sessionApprovalKey(context: ResolvedToolExecutionHookContext, gitTargets: readonly ToolFileAccess[]): string | undefined {
  return targetBoundKey(context, gitTargets) ??
    (context.toolCall.name === 'Bash' ? context.execution.sessionApprovalRule : context.execution.approvalRule);
}

export class SessionApprovalHistoryPermissionPolicyService implements PermissionPolicy {
  readonly name = 'session-approval-history';

  constructor(
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IGitService private readonly git: IGitService,
  ) {}

  async evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined> {
    const gitTargets = context.permissionAuthority === 'owner' ? [] : await gitControlFileAccesses(context, this.runtime, this.workspace, this.git);
    const bound = targetBoundKey(context, gitTargets);
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
