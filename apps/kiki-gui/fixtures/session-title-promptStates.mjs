/**
 * session-title-prompt — shared state for the automatic session titles card
 * with the title prompt under it: which body is in force, the built-in body on
 * request, and the editor for a custom one.
 *
 * The variants below are one fixture server each, because the card's state is
 * the thing worth looking at:
 *
 *   - "default"        no override: the built-in body is in force and the
 *                      custom editor opens empty and the built-in body is a
 *                      read-only reference;
 *   - "custom"         an override is stored, so the card says "Your version"
 *                      and offers the restore action;
 *   - "no-metadata"    an older server that sends neither field: still usable,
 *                      only the preview is missing.
 *
 * The built-in body below is fixture text standing in for the server's own
 * answer. It is what the fixture reports; the component never carries a copy.
 */

export const DEFAULT_PROMPT =
  'You name conversations. Answer with the title only: one line, at most 8 words, '
  + 'no quotes, no trailing punctuation, in the language of the conversation.';

export const CUSTOM_PROMPT =
  'Name this conversation after what it is actually for.\n'
  + 'Prefer the user\'s own words over a summary of the first request.';

const base = {
  default_provider: 'fixture',
  default_model: 'fixture/opus-5-5',
  default_permission_mode: 'manual',
  default_plan_mode: false,
  fast_model: '',
  models: {},
  permission: {},
  plugins: { marketplace_url: '' },
  experimental: { auto_session_title: true },
};

const title = (extra) => ({
  model: 'fixture/opus-5-5',
  triggers: ['first_turn_completed'],
  default_prompt: DEFAULT_PROMPT,
  ...extra,
});

export const titlePromptConfig = {
  default: { ...base, session_title: title({ prompt_source: 'default' }) },
  custom: { ...base, session_title: title({ prompt: CUSTOM_PROMPT, prompt_source: 'custom' }) },
  'no-metadata': { ...base, session_title: { model: 'fixture/opus-5-5', triggers: ['first_turn_completed'] } },
};