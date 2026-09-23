import type { KikiConfigPatch } from '../transport';
import { configObjectOrEmpty, normalizeConfigStringList } from './settings';

/** The subagent tool-access draft: only the server override list this card edits. */
export interface SubagentToolsDraft {
  serverAllowedTools: string[];
}

/**
 * `[subagent].allowedTools` as the GUI reads it (GET camel projection).
 * A missing section means the server default — no extra allows.
 */
export function subagentToolsDraftFromConfig(value: unknown): SubagentToolsDraft {
  const subagent = configObjectOrEmpty(configObjectOrEmpty(value)['subagent']);
  return {
    serverAllowedTools: normalizeConfigStringList(subagent['allowedTools']),
  };
}

/** Updates only the server opt-ins, preserving all other subagent settings. */
export function subagentToolsPatch(allowedTools: string[]): KikiConfigPatch {
  return {
    subagent: { allowed_tools: normalizeConfigStringList(allowedTools) },
  };
}

/** `[subagent].main_dispatch_policy` / `[subagent].subagent_dispatch_policy` values. */
export type SubagentDispatchPolicy = 'advisory' | 'strict';

export function isSubagentDispatchPolicy(value: unknown): value is SubagentDispatchPolicy {
  return value === 'advisory' || value === 'strict';
}

/** Server-wide fallbacks when a profile declares no `subagent_policy`. */
export const DEFAULT_MAIN_DISPATCH_POLICY: SubagentDispatchPolicy = 'advisory';
export const DEFAULT_SUBAGENT_DISPATCH_POLICY: SubagentDispatchPolicy = 'strict';

export interface SubagentDispatchPoliciesDraft {
  mainDispatchPolicy: SubagentDispatchPolicy;
  subagentDispatchPolicy: SubagentDispatchPolicy;
}

/**
 * The two dispatch-policy defaults as the GUI reads them (GET camel
 * projection). A missing or malformed key means the engine default: advisory
 * for main agents, strict for subagent profiles with a declared
 * recommendation list (an undeclared list stays advisory regardless).
 */
export function subagentDispatchPoliciesDraftFromConfig(value: unknown): SubagentDispatchPoliciesDraft {
  const subagent = configObjectOrEmpty(configObjectOrEmpty(value)['subagent']);
  return {
    mainDispatchPolicy: isSubagentDispatchPolicy(subagent['mainDispatchPolicy'])
      ? subagent['mainDispatchPolicy']
      : DEFAULT_MAIN_DISPATCH_POLICY,
    subagentDispatchPolicy: isSubagentDispatchPolicy(subagent['subagentDispatchPolicy'])
      ? subagent['subagentDispatchPolicy']
      : DEFAULT_SUBAGENT_DISPATCH_POLICY,
  };
}

/**
 * Narrow patch for the two policy defaults: unchanged keys are omitted so a
 * save never rewrites the other subagent fields edited on other leaves.
 */
export function subagentDispatchPoliciesPatch(
  draft: SubagentDispatchPoliciesDraft,
  baseline: SubagentDispatchPoliciesDraft = subagentDispatchPoliciesDraftFromConfig(null),
): KikiConfigPatch {
  const main = draft.mainDispatchPolicy !== baseline.mainDispatchPolicy ? draft.mainDispatchPolicy : undefined;
  const sub = draft.subagentDispatchPolicy !== baseline.subagentDispatchPolicy ? draft.subagentDispatchPolicy : undefined;
  return {
    subagent: main === undefined && sub === undefined
      ? undefined
      : { main_dispatch_policy: main, subagent_dispatch_policy: sub },
  };
}
