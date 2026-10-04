import type { BoundProfile } from './boundProfile';
import type { ProfileToolPolicyBase, ToolBindingOverride } from './profile';
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

function sameTools(left: readonly string[], right: readonly string[] | undefined): boolean {
  return right !== undefined && left.length === right.length && left.every((name) => right.includes(name));
}
