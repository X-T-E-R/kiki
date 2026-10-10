import type { BoundProfile } from './boundProfile';
import type { ProfileData, ProfileToolPolicyBase, ToolBindingOverride } from './profile';
import type { ToolActivationPolicy } from '@kiki/agent-profiles/toolPolicy';
import { Error2, ErrorCodes } from '#/errors';

export function mergeToolBindingOverride(previous: ToolBindingOverride | undefined, input: ToolBindingOverride | undefined): ToolBindingOverride | undefined {
  if (input === undefined || (input.tools === undefined && input.disallowedTools === undefined)) return previous;
  return {
    tools: input.tools === undefined ? previous?.tools : [...input.tools],
    disallowedTools: input.disallowedTools === undefined ? previous?.disallowedTools : [...input.disallowedTools],
  };
}

export function assertNativeToolOverride(executor: string | undefined, override: ToolBindingOverride | undefined): void {
  if ((executor ?? 'native') !== 'native' && (override?.tools !== undefined || override?.disallowedTools !== undefined)) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, `Executor "${executor}" does not support AgentRun tools or disallowed_tools overrides. No child run or binding change was started.`);
  }
}

export function effectiveToolBinding(base: ProfileToolPolicyBase, override: ToolBindingOverride | undefined, boundProfile?: Pick<BoundProfile, 'fileSources' | 'routeDefinition'>): ProfileToolPolicyBase {
  const ceiling = boundProfile?.fileSources?.callerCeiling;
  const baselinePolicies = base.toolAllowPolicies ?? [];
  const routeSelectionPolicy = boundProfile?.routeDefinition !== undefined && boundProfile.routeDefinition.tools === undefined
    && baselinePolicies[0] !== undefined && sameTools(baselinePolicies[0], base.tools);
  const policies = override?.tools === undefined ? base.toolAllowPolicies : [
    ...(routeSelectionPolicy ? baselinePolicies.slice(1) : baselinePolicies),
    ...(ceiling?.toolAllowPolicies ?? []),
    ...(ceiling?.activeToolNames === undefined ? [] : [ceiling.activeToolNames]),
  ];
  return {
    tools: override?.tools ?? base.tools,
    toolAllowPolicies: policies,
    disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...(override?.disallowedTools ?? [])])],
  };
}

export function declaredExternalToolPolicy(binding: Pick<ProfileData, 'boundProfile' | 'appliedLease' | 'toolOverride' | 'disallowedTools'>): ToolActivationPolicy {
  const profile = binding.boundProfile;
  const lease = binding.appliedLease;
  const tools = binding.toolOverride?.tools ?? (lease?.tools !== undefined ? lease.tools ?? undefined
    : profile?.fileDefinition?.tools ?? ((profile?.executor ?? 'native') === 'native' ? undefined : profile?.tools));
  const routeTools = lease?.tools !== undefined || binding.toolOverride?.tools !== undefined ? undefined : profile?.routeDefinition?.tools;
  return { tools, toolAllowPolicies: [
    ...(routeTools === undefined ? [] : [routeTools]),
    ...(profile?.fileSources?.callerCeiling?.externalToolAllowPolicies ?? []),
  ], disallowedTools: binding.disallowedTools };
}

function sameTools(left: readonly string[], right: readonly string[] | undefined): boolean {
  return right !== undefined && left.length === right.length && left.every((name) => right.includes(name));
}
