import { PromptConfigSchema } from '@kiki/agent-profiles/promptConfig';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export { PromptConfigSchema, PromptConfigPatchSchema, type PromptConfig } from '@kiki/agent-profiles/promptConfig';
export const PROMPT_SECTION = 'prompt';

registerConfigSection(PROMPT_SECTION, PromptConfigSchema, {
  defaultValue: {},
  fromToml: (value) => value,
  toToml: (value) => value,
});
