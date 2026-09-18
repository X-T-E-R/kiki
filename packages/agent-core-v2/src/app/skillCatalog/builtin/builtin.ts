import type { IFlagService } from '#/app/flag/flag';
import type { SkillDefinition } from '#/app/skillCatalog/types';

import {
  KIKI_OPS_CONFIG_SKILL,
  KIKI_OPS_DOCS_SKILL,
  KIKI_OPS_IMPORT_SKILL,
  KIKI_OPS_MCP_SKILL,
  KIKI_OPS_PROFILE_SKILL,
  KIKI_OPS_SKILL,
  KIKI_OPS_THEME_SKILL,
} from './kiki-ops';
import { getBuiltinSkillContributions } from './registry';
import {
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
} from './sub-skill';

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  KIKI_OPS_SKILL,
  KIKI_OPS_CONFIG_SKILL,
  KIKI_OPS_THEME_SKILL,
  KIKI_OPS_MCP_SKILL,
  KIKI_OPS_IMPORT_SKILL,
  KIKI_OPS_PROFILE_SKILL,
  KIKI_OPS_DOCS_SKILL,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  SUB_SKILL_CONSOLIDATE,
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

export {
  KIKI_OPS_CONFIG_SKILL,
  KIKI_OPS_DOCS_SKILL,
  KIKI_OPS_IMPORT_SKILL,
  KIKI_OPS_MCP_SKILL,
  KIKI_OPS_PROFILE_SKILL,
  KIKI_OPS_SKILL,
  KIKI_OPS_THEME_SKILL,
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
};
