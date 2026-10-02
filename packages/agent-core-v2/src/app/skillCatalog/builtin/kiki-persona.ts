import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import KIKI_PERSONA_BODY from './kiki-persona/SKILL.md?raw';
import KIKI_PERSONA_REFERENCE from './kiki-persona/references/authoring.md?raw';

const PSEUDO_PATH = 'builtin://kiki-persona';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/kiki-persona/SKILL.md',
  skillDirName: 'kiki-persona',
  source: 'builtin',
  text: KIKI_PERSONA_BODY,
});

export const KIKI_PERSONA_SKILL: SkillDefinition = {
  ...parsed,
  content: `${parsed.content}\n\n## references/authoring.md\n\n${KIKI_PERSONA_REFERENCE}`,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
