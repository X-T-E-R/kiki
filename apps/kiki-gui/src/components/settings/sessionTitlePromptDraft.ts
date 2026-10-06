/**
 * What the title-prompt field shows, and when it is dirty.
 *
 * The server is the authority for both facts and this module only projects
 * them: `prompt_source` says which body is in force, `prompt` is the custom
 * one when it is, and `default_prompt` is the built-in body. An older server
 * sends neither metadata field, so `source` falls back to whether a custom
 * body is present — which is the same answer, derived from less.
 */

export type SessionTitlePromptSource = 'default' | 'custom';

export interface SessionTitlePromptState {
  readonly source: SessionTitlePromptSource;
  /** The built-in body, when this server sends it. */
  readonly defaultPrompt: string | undefined;
  /** The saved custom body, when there is one. */
  readonly customPrompt: string | undefined;
}

export function sessionTitlePromptState(
  stored: {
    readonly prompt?: string;
    readonly default_prompt?: string;
    readonly prompt_source?: SessionTitlePromptSource;
  } | undefined,
): SessionTitlePromptState {
  const custom = stored?.prompt;
  return {
    source: stored?.prompt_source ?? (custom === undefined || custom === '' ? 'default' : 'custom'),
    defaultPrompt: stored?.default_prompt,
    customPrompt: custom === undefined || custom === '' ? undefined : custom,
  };
}

/**
 * Whether the draft differs from what is stored. An absent body and an empty
 * one are the same state — the built-in body is in force either way — so the
 * comparison is against the stored body and nothing else.
 */
export function titlePromptDraftDirty(draft: string, saved: string | undefined): boolean {
  return draft !== (saved ?? '');
}