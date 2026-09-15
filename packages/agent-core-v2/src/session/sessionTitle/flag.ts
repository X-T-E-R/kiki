import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AUTO_SESSION_TITLE_FLAG_ID = 'auto_session_title';
export const AUTO_SESSION_TITLE_FLAG_ENV = 'KIKI_EXPERIMENTAL_AUTO_SESSION_TITLE';

export const sessionTitleFlag: FlagDefinitionInput = {
  id: AUTO_SESSION_TITLE_FLAG_ID,
  title: 'AI session titles',
  description:
    'Generate concise session titles from the conversation: through the managed chat_title tool by default, or through the model pinned in [session_title] model. Clients auto-generate once the first turn completes and offer on-demand regeneration in the rename field.',
  env: AUTO_SESSION_TITLE_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(sessionTitleFlag);
