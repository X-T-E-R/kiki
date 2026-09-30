import type { I18nKey } from '@kiki/session-core/i18n';

import type { NamedAgentProfile } from '../../lib/client';

/**
 * A profile's own `subagent_policy`, as the list and editors show it. An
 * absent field is its own state — the profile follows the server's dispatch
 * policy defaults — never "unknown" and never silently advisory. Writing
 * `inherit` sends `null`, which removes the key from the frontmatter.
 */
export type SubagentPolicyChoice = 'inherit' | 'advisory' | 'strict';

export const SUBAGENT_POLICY_CHOICES: readonly SubagentPolicyChoice[] = ['inherit', 'advisory', 'strict'];

export function subagentPolicyChoice(policy: NamedAgentProfile['subagent_policy']): SubagentPolicyChoice {
  return policy ?? 'inherit';
}

export function subagentPolicyLabelKey(choice: SubagentPolicyChoice): I18nKey {
  return choice === 'inherit' ? 'st.profiles.policyInherit' : `agentPanel.subagentPolicy.${choice}`;
}

/** PATCH value: `null` clears the key so the profile falls back to the defaults. */
export function subagentPolicyBody(choice: SubagentPolicyChoice): 'advisory' | 'strict' | null {
  return choice === 'inherit' ? null : choice;
}
