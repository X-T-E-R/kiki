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

export function isPluginToolName(name: string): boolean {
  return name.startsWith('plugin__');
}

export function isBrowserOperationToolName(name: string): boolean {
  return /^browser__(?:agent_browser_[a-z0-9_]+|codex_[a-z0-9_]+)$/.test(name);
}

export function isEgoHostScriptToolName(name: string): boolean {
  return name === 'browser__ego_run';
}

export function browserWildcardDenies(patterns: readonly string[] | undefined, name: string): boolean {
  return patterns !== undefined && patterns.includes('browser__*')
    && (isBrowserOperationToolName(name) || isEgoHostScriptToolName(name));
}

export function isToolExplicitlyNamed(tools: readonly string[] | undefined, name: string, source: ToolSource = 'builtin'): boolean {
  return tools !== undefined && ((source === 'builtin' && tools.includes('browser__*') && isBrowserOperationToolName(name)) || tools.includes(name) ||
    (canonicalToolName(name) !== undefined && tools.includes(canonicalToolName(name)!)) ||
    legacyToolNames(name).some((legacy) => tools.includes(legacy)));
}

function nonMcpDenied(patterns: readonly string[], name: string): boolean {
  return browserWildcardDenies(patterns, name) || patterns.includes(name)
    || (canonicalToolName(name) !== undefined && patterns.includes(canonicalToolName(name)!))
    || (legacyToolNames(name).length > 0 && legacyToolNames(name).every((legacy) => patterns.includes(legacy)));
}

function allowListsPass(policy: ToolActivationPolicy, name: string, source: ToolSource): boolean {
  const allowPolicies = [policy.tools, ...(policy.toolAllowPolicies ?? [])].filter(
    (candidate): candidate is readonly string[] => candidate !== undefined,
  );
  for (const allowPolicy of allowPolicies) {
    const allowed = allowPolicy.includes('*') || (source === 'mcp'
      ? allowPolicy.filter((pattern) => isMcpToolName(pattern)).some((pattern) => picomatch.isMatch(name, pattern))
      : source === 'plugin'
        ? allowPolicy.filter((pattern) => isPluginToolName(pattern)).some((pattern) => picomatch.isMatch(name, pattern)) ||
          isToolExplicitlyNamed(allowPolicy, name, source)
        : isToolExplicitlyNamed(allowPolicy, name, source));
    if (!allowed) return false;
  }
  return true;
}

export function egoHostScriptDenied(patterns: readonly string[] | undefined): boolean {
  return patterns !== undefined && nonMcpDenied(patterns, 'browser__ego_run');
}

export function egoHostScriptExplicitlyGranted(policy: ToolActivationPolicy): boolean {
  const lists = [policy.tools, ...(policy.toolAllowPolicies ?? [])].filter(
    (candidate): candidate is readonly string[] => candidate !== undefined,
  );
  if (!lists.some((list) => list.includes('browser__ego_run'))) return false;
  return lists.every((list) => list.includes('*') || list.includes('browser__ego_run'));
}

export function isToolActive(
  policy: ToolActivationPolicy,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  if (source === 'builtin' && isEgoHostScriptToolName(name)) {
    if (egoHostScriptDenied(policy.disallowedTools)) return false;
    if (egoHostScriptExplicitlyGranted(policy)) return true;
    return isToolActive(policy, 'Bash', 'builtin');
  }
  if (!allowListsPass(policy, name, source)) return false;
  if (policy.disallowedTools === undefined) return true;
  if (source !== 'mcp' && source !== 'plugin') return !nonMcpDenied(policy.disallowedTools, name);
  const patterns = source === 'mcp'
    ? policy.disallowedTools.filter((pattern) => isMcpToolName(pattern))
    : policy.disallowedTools.filter((pattern) => isPluginToolName(pattern));
  return !patterns.some((pattern) => picomatch.isMatch(name, pattern)) &&
    (source !== 'plugin' || !nonMcpDenied(policy.disallowedTools, name));
}

export function resolveActiveToolNames(
  policy: ToolActivationPolicy,
): readonly string[] | undefined {
  const source = policy.tools ?? policy.toolAllowPolicies?.[0];
  if (source === undefined) return undefined;
  return source.filter((name) =>
    isToolActive(policy, name, isMcpToolName(name) ? 'mcp' : isPluginToolName(name) ? 'plugin' : 'builtin'),
  );
}

const GLOB_MAGIC = /[*?[\]{}]/;

export function literalToolNames(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => !isMcpToolName(pattern) && !GLOB_MAGIC.test(pattern));
}
