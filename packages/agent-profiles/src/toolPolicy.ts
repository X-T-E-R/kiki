import picomatch from 'picomatch';
import { canonicalToolName, legacyToolNames } from './toolAliases';

export type ToolSource = 'builtin' | 'user' | 'mcp' | 'plugin';

export interface ToolReference {
  readonly name: string;
  readonly source: ToolSource;
}

export interface ToolActivationPolicy {
  readonly tools?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__');
}

export function isToolExplicitlyNamed(tools: readonly string[] | undefined, name: string): boolean {
  return tools !== undefined && (tools.includes(name) ||
    (canonicalToolName(name) !== undefined && tools.includes(canonicalToolName(name)!)) ||
    legacyToolNames(name).some((legacy) => tools.includes(legacy)));
}

export function isToolActive(
  policy: ToolActivationPolicy,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  const allowPolicies = [policy.tools, ...(policy.toolAllowPolicies ?? [])].filter(
    (candidate): candidate is readonly string[] => candidate !== undefined,
  );
  for (const allowPolicy of allowPolicies) {
    const allowed = allowPolicy.includes('*') || (source !== 'mcp'
      ? isToolExplicitlyNamed(allowPolicy, name)
      : allowPolicy.filter((pattern) => isMcpToolName(pattern)).some((pattern) => picomatch.isMatch(name, pattern)));
    if (!allowed) return false;
  }
  if (policy.disallowedTools === undefined) return true;
  if (source !== 'mcp') {
    return !(policy.disallowedTools.includes(name) ||
      (canonicalToolName(name) !== undefined && policy.disallowedTools.includes(canonicalToolName(name)!)) ||
      (legacyToolNames(name).length > 0 &&
        legacyToolNames(name).every((legacy) => policy.disallowedTools!.includes(legacy))));
  }
  return !policy.disallowedTools
    .filter((pattern) => isMcpToolName(pattern))
    .some((pattern) => picomatch.isMatch(name, pattern));
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

const GLOB_MAGIC = /[*?[\]{}]/;

export function literalToolNames(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => !isMcpToolName(pattern) && !GLOB_MAGIC.test(pattern));
}
