import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import CHECK_KIKI_DOCS_BODY from './check-kiki-docs.md?raw';

const PSEUDO_PATH = 'builtin://check-kiki-docs';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/check-kiki-docs.md',
  skillDirName: 'check-kiki-docs',
  source: 'builtin',
  text: CHECK_KIKI_DOCS_BODY,
});

export const CHECK_KIKI_DOCS_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
