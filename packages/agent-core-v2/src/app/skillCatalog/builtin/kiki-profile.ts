import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import { EXAMPLE_AGENT_PROFILE_TEMPLATES } from '#/app/shippedAgentProfiles/examples/exampleAgentProfiles';
import KIKI_PROFILE_BODY from './kiki-profile.md?raw';

const EXAMPLE_FILES = EXAMPLE_AGENT_PROFILE_TEMPLATES.map(
  ({ fileName, text }) => `### ${fileName}\n\n\`\`\`markdown\n${text}\`\`\``,
).join('\n\n');

const PSEUDO_PATH = 'builtin://kiki-profile';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/kiki-profile.md',
  skillDirName: 'kiki-profile',
  source: 'builtin',
  text: KIKI_PROFILE_BODY,
});

export const KIKI_PROFILE_SKILL: SkillDefinition = {
  ...parsed,
  content: `${parsed.content}\n\n${EXAMPLE_FILES}`,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
