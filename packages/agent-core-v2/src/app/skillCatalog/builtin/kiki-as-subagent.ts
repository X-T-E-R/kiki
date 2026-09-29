import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import KIKI_AS_SUBAGENT_BODY from './kiki-as-subagent.md?raw';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/kiki-as-subagent.md',
  skillDirName: 'kiki-as-subagent',
  source: 'builtin',
  text: KIKI_AS_SUBAGENT_BODY,
});

export const KIKI_AS_SUBAGENT_SKILL: SkillDefinition = {
  ...parsed,
  path: 'builtin://kiki-as-subagent',
  dir: 'builtin://kiki-as-subagent',
  metadata: { ...parsed.metadata, type: parsed.metadata.type ?? 'inline' },
  productSpecific: true,
};
