import type { IFlagService } from '#/app/flag/flag';
import type { SkillDefinition } from '#/app/skillCatalog/types';

import { KIKI_OPS_SKILL } from './kiki-ops';
import { KIKI_PROFILE_SKILL } from './kiki-profile';
import { getBuiltinSkillContributions } from './registry';

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  KIKI_OPS_SKILL,
  KIKI_PROFILE_SKILL,
];

export function visibleBuiltinSkills(
  productSkillsEnabled: boolean,
  flags?: IFlagService,
): readonly SkillDefinition[] {
  const all = [...BUILTIN_SKILLS, ...getBuiltinSkillContributions()];
  const visible = productSkillsEnabled
    ? all
    : all.filter((skill) => skill.productSpecific !== true);
  if (flags === undefined) return visible;
  return visible.filter(
    (skill) => skill.experimentalFlag === undefined || flags.enabled(skill.experimentalFlag),
  );
}

export { KIKI_OPS_SKILL, KIKI_PROFILE_SKILL };
