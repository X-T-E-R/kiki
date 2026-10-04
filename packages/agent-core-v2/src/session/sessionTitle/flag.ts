import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AUTO_SESSION_TITLE_FLAG_ID = 'auto_session_title';
export const AUTO_SESSION_TITLE_FLAG_ENV = 'KIKI_EXPERIMENTAL_AUTO_SESSION_TITLE';

export const sessionTitleFlag: FlagDefinitionInput = {
  id: AUTO_SESSION_TITLE_FLAG_ID,
  title: 'AI session titles',
  description:
    'Generate concise session titles with an explicitly selected [session_title] model. Automatic generation runs on the selected session_title.triggers; by default, after the first completed reply. No model selection means no AI title requests.',
  env: AUTO_SESSION_TITLE_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(sessionTitleFlag);
