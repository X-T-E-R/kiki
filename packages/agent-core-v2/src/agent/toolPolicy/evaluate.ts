import { isToolActive as isProfileToolActive } from '@kiki/agent-profiles/toolPolicy';
import { isSubagentToolAllowed, type SubagentToolPolicy } from '@kiki/agent-profiles/subagentToolPolicy';

import { isMcpToolName, type ToolSource } from '#/tool/toolContract';
import { allowsResearchTool, type ExecutionRestriction } from '#/agent/profile/executionRestriction';
import { toolGroupForName } from '#/agent/toolRegistry/toolGroups';
import { legacyToolNames } from './toolAliases';
import type { ToolGroupId } from '@kiki/agent-profiles/toolGroups';

export interface ToolActivationPolicy {
  readonly executionRestriction?: ExecutionRestriction;
  readonly tools?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
  readonly disabledToolGroups?: readonly ToolGroupId[];
}

export function isToolActive(
  policy: ToolActivationPolicy,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  if (policy.executionRestriction === 'research-readonly' && !allowsResearchTool(name, source)) {
    return false;
  }
  if (!isProfileToolActive(policy, name, source)) return false;
  if (policy.disabledToolGroups !== undefined && policy.disabledToolGroups.length > 0) {
    const group = toolGroupForName(name);
    if (
      group !== undefined &&
      policy.disabledToolGroups.includes(group) &&
      !(source !== 'mcp' && policy.tools !== undefined &&
        (policy.tools.includes(name) || legacyToolNames(name).some((legacy) => policy.tools!.includes(legacy))))
    ) {
      return false;
    }
  }
  return true;
}

export interface GlobalToolsPolicy {
  readonly enabled?: readonly string[];
  readonly disabled?: readonly string[];
}

export interface ToolPolicyLayers {
  readonly workspaceDisabledTools?: readonly string[];
  readonly profile: ToolActivationPolicy;
  readonly global?: GlobalToolsPolicy;
  readonly sessionDisabledTools?: readonly string[];
  readonly subagent?: SubagentToolPolicy;
  readonly subagentDefault?: 'opt-in';
}

export function isToolActiveComposed(
  layers: ToolPolicyLayers,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  return (
    (layers.subagent === undefined || isSubagentToolAllowed({
      ...layers.subagent,
      allowedTools: layers.subagentDefault === undefined ? layers.subagent.allowedTools
        : [...(layers.subagent.allowedTools ?? []), ...(layers.global?.enabled ?? [])],
    }, name, source, layers.subagentDefault)) &&
    isToolActive({ disallowedTools: layers.workspaceDisabledTools }, name, source) &&
    isToolActive(layers.profile, name, source) &&
    isToolActive(
      {
        tools: layers.global?.enabled?.length ? layers.global.enabled : undefined,
        disallowedTools: layers.global?.disabled,
      },
      name,
      source,
    ) &&
    isToolActive({ disallowedTools: layers.sessionDisabledTools }, name, source)
  );
}

export function resolveActiveToolNames(
  policy: ToolActivationPolicy,
): readonly string[] | undefined {
  const source = policy.tools ?? policy.toolAllowPolicies?.[0];
  if (source === undefined) return undefined;
  return source.filter((name) =>
    isToolActive(policy, name, isMcpToolName(name) ? 'mcp' : 'builtin'),
  );
}

export type InactiveToolPatternKind = 'wildcard-not-mcp' | 'incomplete-mcp-name' | 'unknown-tool';

export interface InactiveToolPattern {
  readonly pattern: string;
  readonly kind: InactiveToolPatternKind;
}

const GLOB_MAGIC = /[*?[\]{}]/;

export function literalToolNames(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => !isMcpToolName(pattern) && !GLOB_MAGIC.test(pattern));
}

export function findInactiveToolPatterns(
  patterns: readonly string[],
  isKnownToolName?: (name: string) => boolean,
): InactiveToolPattern[] {
  const issues: InactiveToolPattern[] = [];
  for (const pattern of patterns) {
    if (isMcpToolName(pattern)) {
      if (!GLOB_MAGIC.test(pattern) && !pattern.slice('mcp__'.length).includes('__')) {
        issues.push({ pattern, kind: 'incomplete-mcp-name' });
      }
      continue;
    }
    if (GLOB_MAGIC.test(pattern)) {
      issues.push({ pattern, kind: 'wildcard-not-mcp' });
      continue;
    }
    if (isKnownToolName !== undefined && !isKnownToolName(pattern)) {
      issues.push({ pattern, kind: 'unknown-tool' });
    }
  }
  return issues;
}
