import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import KIKI_PROFILE_BODY from './kiki-profile.md?raw';

const PSEUDO_PATH = 'builtin://kiki-profile';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/kiki-profile.md',
  skillDirName: 'kiki-profile',
  source: 'builtin',
  text: KIKI_PROFILE_BODY,
});

export const KIKI_PROFILE_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
