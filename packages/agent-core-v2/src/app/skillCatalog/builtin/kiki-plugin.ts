import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import KIKI_PLUGIN_BODY from './kiki-plugin/SKILL.md?raw';
import KIKI_PLUGIN_REFERENCE from './kiki-plugin/references/authoring.md?raw';

const PSEUDO_PATH = 'builtin://kiki-plugin';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/kiki-plugin/SKILL.md',
  skillDirName: 'kiki-plugin',
  source: 'builtin',
  text: KIKI_PLUGIN_BODY,
});

export const KIKI_PLUGIN_SKILL: SkillDefinition = {
  ...parsed,
  content: `${parsed.content}\n\n## references/authoring.md\n\n${KIKI_PLUGIN_REFERENCE}`,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
