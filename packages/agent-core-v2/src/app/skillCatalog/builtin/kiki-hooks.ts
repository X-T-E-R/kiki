import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import KIKI_HOOKS_BODY from './kiki-hooks/SKILL.md?raw';
import KIKI_HOOKS_REFERENCE from './kiki-hooks/references/authoring.md?raw';

const PSEUDO_PATH = 'builtin://kiki-hooks';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/kiki-hooks/SKILL.md',
  skillDirName: 'kiki-hooks',
  source: 'builtin',
  text: KIKI_HOOKS_BODY,
});

export const KIKI_HOOKS_SKILL: SkillDefinition = {
  ...parsed,
  content: `${parsed.content}\n\n## references/authoring.md\n\n${KIKI_HOOKS_REFERENCE}`,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
