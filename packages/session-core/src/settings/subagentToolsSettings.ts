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
