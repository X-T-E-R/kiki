import { IInstantiationService } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { AutoModeApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/auto-mode-ask-user-question-deny';
import { DangerousBashPermissionPolicyService } from '#/agent/permissionPolicy/policies/dangerous-bash';
import { DefaultToolApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/default-tool-approve';
import { FallbackAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/fallback-ask';
import { GitControlPathAccessAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/git-control-path-access-ask';
import { GitCwdWriteApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/git-cwd-write-approve';
import { SensitiveFileAccessAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/sensitive-file-access-ask';
import { SessionApprovalHistoryPermissionPolicyService } from '#/agent/permissionPolicy/policies/session-approval-history';
import { UserConfiguredAllowPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-allow';
import { UserConfiguredAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-ask';
import { UserConfiguredDenyPermissionPolicyService } from '#/agent/permissionPolicy/policies/user-configured-deny';
import { YoloModeApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/yolo-mode-approve';
import {
  IAgentPermissionPolicyService,
  PermissionPolicyAllowlistContribution,
  type PermissionPolicyAllowlistView,
  type PermissionPolicyEvaluation,
} from './permissionPolicy';
import type { PermissionPolicy } from './types';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

export class AgentPermissionPolicyService
  extends Service
  implements IAgentPermissionPolicyService
{
  declare readonly _serviceBrand: undefined;

  private readonly adjudicationPolicies: readonly PermissionPolicy[];
  private readonly allowlistPolicies: readonly PermissionPolicy[];
  private readonly fallbackPolicy: PermissionPolicy;
  private readonly dangerousBashPolicy: DangerousBashPermissionPolicyService;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @PermissionPolicyAllowlistContribution
    private readonly allowlistContributions: PermissionPolicyAllowlistView,
  ) {
    super();
    this.adjudicationPolicies = [
      this.instantiation.createInstance(AutoModeAskUserQuestionDenyPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredDenyPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAskPermissionPolicyService),
      this.instantiation.createInstance(SensitiveFileAccessAskPermissionPolicyService),
      this.instantiation.createInstance(GitControlPathAccessAskPermissionPolicyService),
      this.instantiation.createInstance(AutoModeApprovePermissionPolicyService),
      this.instantiation.createInstance(YoloModeApprovePermissionPolicyService),
    ];
    this.allowlistPolicies = [
      this.instantiation.createInstance(SessionApprovalHistoryPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAllowPermissionPolicyService),
      this.instantiation.createInstance(DefaultToolApprovePermissionPolicyService),
      this.instantiation.createInstance(GitCwdWriteApprovePermissionPolicyService),
    ];
    this.fallbackPolicy = this.instantiation.createInstance(FallbackAskPermissionPolicyService);
    this.dangerousBashPolicy = this.instantiation.createInstance(
      DangerousBashPermissionPolicyService,
    );
  }

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const adjudication = await evaluatePolicies(this.adjudicationPolicies, context);
    if (adjudication !== undefined) {
      return this.dangerousBashPolicy.upgradeApprove(adjudication, context);
    }

    const allowlist = await evaluatePolicies(this.allowlistPolicies, context);
    if (allowlist !== undefined) {
      return this.dangerousBashPolicy.upgradeApprove(allowlist, context);
    }

    for (const id of this.allowlistContributions.items) {
      const policy = this.instantiation.invokeFunction((accessor) => accessor.get(id));
      const result = await policy.evaluate(context);
      if (result !== undefined) {
        return this.dangerousBashPolicy.upgradeApprove(
          { policyName: policy.name, result },
          context,
        );
      }
    }

    return evaluatePolicies([this.fallbackPolicy], context);
  }
}

async function evaluatePolicies(
  policies: readonly PermissionPolicy[],
  context: ResolvedToolExecutionHookContext,
): Promise<PermissionPolicyEvaluation | undefined> {
  for (const policy of policies) {
    const result = await policy.evaluate(context);
    if (result !== undefined) return { policyName: policy.name, result };
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionPolicyService,
  AgentPermissionPolicyService,
  ScopeActivation.OnScopeCreated,
  'permissionPolicy',
);
