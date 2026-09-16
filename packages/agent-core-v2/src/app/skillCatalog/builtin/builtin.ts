import type { IFlagService } from '#/app/flag/flag';
import type { SkillDefinition } from '#/app/skillCatalog/types';

import { CHECK_KIKI_DOCS_SKILL } from './check-kiki-docs';
import { CUSTOM_THEME_SKILL } from './custom-theme';
import { IMPORT_FROM_CC_CODEX_SKILL } from './import-from-cc-codex';
import { KIKI_PROFILE_SKILL } from './kiki-profile';
import { MCP_CONFIG_SKILL } from './mcp-config';
import { getBuiltinSkillContributions } from './registry';
import {
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
} from './sub-skill';
import { UPDATE_CONFIG_SKILL } from './update-config';
import { WRITE_GOAL_SKILL } from './write-goal';

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  MCP_CONFIG_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  UPDATE_CONFIG_SKILL,
  CUSTOM_THEME_SKILL,
  WRITE_GOAL_SKILL,
  CHECK_KIKI_DOCS_SKILL,
  KIKI_PROFILE_SKILL,
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
  CHECK_KIKI_DOCS_SKILL,
  CUSTOM_THEME_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  KIKI_PROFILE_SKILL,
  MCP_CONFIG_SKILL,
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  UPDATE_CONFIG_SKILL,
  WRITE_GOAL_SKILL,
};
