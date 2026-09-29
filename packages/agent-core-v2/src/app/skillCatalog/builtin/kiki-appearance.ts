import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import KIKI_APPEARANCE_BODY from './kiki-appearance.md?raw';

const PSEUDO_PATH = 'builtin://kiki-appearance';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/kiki-appearance.md',
  skillDirName: 'kiki-appearance',
  source: 'builtin',
  text: KIKI_APPEARANCE_BODY,
});

export const KIKI_APPEARANCE_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
