/**
 * The model editor's edit scope.
 *
 * A model is one object: its id, provider, account and capabilities are the
 * same whoever is talking to it. What an identity may change is the small set
 * of values the schema already gives a per-identity layer — usage, and the two
 * prompt objects. So the page carries one scope selector and the groups that
 * have an identity layer read through it; the shared groups simply ignore it.
 *
 * The rule that keeps this honest: a scope never owns a form. It re-points the
 * rows that already exist, so there is one place to read a value, one place to
 * write it, and one save. A second copy of the same form for the main agent is
 * exactly what this replaces.
 */

import type { I18nKey } from '@kiki/session-core/i18n';

/** Who the rows on screen are editing. `sub` reads the shared layer directly. */
export type EditScope = 'shared' | 'main' | 'independent';

export const EDIT_SCOPES: readonly EditScope[] = ['shared', 'main', 'independent'] as const;

export const SCOPE_LABEL: Readonly<Record<EditScope, I18nKey>> = {
  shared: 'st.modelScope.all',
  main: 'st.modelScope.main',
  independent: 'st.modelScope.independent',
};

/**
 * The identity an `EditScope` addresses on the wire. The shared layer has no
 * `usage.shared` key and no `cognition.shared`: shared values live at the
 * model root, which is why this mapping exists rather than reusing the scope.
 */
export type UsagePosition = 'main' | 'independent';

export function usagePositionFor(scope: EditScope): UsagePosition | undefined {
  return scope === 'shared' ? undefined : scope;
}

/**
 * How one prompt object answers for a single identity.
 *
 * The three states are the schema's, not the UI's: the same branch either
 * inherits the common content, replaces it wholesale, or is switched off. An
 * absent branch means "not declared", which is not the same as "off" — a UI
 * that renders those identically would claim a switch the source never made.
 */
export type PromptGroupMode = 'inherit' | 'custom' | 'off';


/** Read one identity's mode off a stored prompt object. */
export function promptGroupMode(branch: unknown, hasCommon: boolean): PromptGroupMode {
  if (branch === 'off') return 'off';
  if (branch === undefined) return hasCommon ? 'inherit' : 'custom';
  if (typeof branch === 'object' && branch !== null) return 'custom';
  return hasCommon ? 'inherit' : 'custom';
}

/**
 * The wire value for one identity branch.
 *
 * `inherit` writes the literal `same` only when the source already said so;
 * leaving an untouched branch untouched is what keeps a no-edit round trip a
 * no-write. `custom` writes the content object whole, because the branch
 * replaces the common group rather than merging into it field by field.
 */
export function promptBranchValue(mode: PromptGroupMode, content: Record<string, unknown> | undefined): string | Record<string, unknown> {
  if (mode === 'off') return 'off';
  if (mode === 'inherit') return 'same';
  return content ?? {};
}

/** The prompt positions that can carry their own group. */
export const PROMPT_POSITIONS: readonly UsagePosition[] = ['main', 'independent'] as const;

export function promptPositionFor(scope: EditScope): UsagePosition | undefined {
  return scope === 'shared' ? undefined : scope;
}
