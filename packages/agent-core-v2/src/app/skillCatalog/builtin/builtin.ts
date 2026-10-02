import type { IFlagService } from '#/app/flag/flag';
import type { SkillDefinition } from '#/app/skillCatalog/types';

import { KIKI_APPEARANCE_SKILL } from './kiki-appearance';
import { KIKI_AS_SUBAGENT_SKILL } from './kiki-as-subagent';
import { KIKI_OPS_SKILL } from './kiki-ops';
import { KIKI_PERSONA_SKILL } from './kiki-persona';
import { KIKI_HOOKS_SKILL } from './kiki-hooks';
import { KIKI_PROFILE_SKILL } from './kiki-profile';
import { TOOL_WORKFLOWS_SKILL } from './tool-workflows';
import { getBuiltinSkillContributions } from './registry';

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  KIKI_OPS_SKILL,
  KIKI_PROFILE_SKILL,
  KIKI_PERSONA_SKILL,
  KIKI_HOOKS_SKILL,
  KIKI_APPEARANCE_SKILL,
  KIKI_AS_SUBAGENT_SKILL,
  TOOL_WORKFLOWS_SKILL,
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

export { KIKI_APPEARANCE_SKILL, KIKI_OPS_SKILL, KIKI_PROFILE_SKILL, KIKI_PERSONA_SKILL, KIKI_HOOKS_SKILL, TOOL_WORKFLOWS_SKILL };
