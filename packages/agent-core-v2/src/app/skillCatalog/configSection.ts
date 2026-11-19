import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import {
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import { normalizeSkillName } from './types';

export const EXTRA_SKILL_DIRS_SECTION = 'extraSkillDirs';
export const ExtraSkillDirsConfigSchema = z.array(z.string()).optional();
export type ExtraSkillDirsConfig = z.infer<typeof ExtraSkillDirsConfigSchema>;

registerConfigSection(EXTRA_SKILL_DIRS_SECTION, ExtraSkillDirsConfigSchema, {
  defaultValue: [],
  layerMerge: 'union',
});

export const DISABLED_SKILLS_SECTION = 'disabledSkills';
export const DisabledSkillsConfigSchema = z.array(z.string()).optional();
export type DisabledSkillsConfig = z.infer<typeof DisabledSkillsConfigSchema>;

registerConfigSection(DISABLED_SKILLS_SECTION, DisabledSkillsConfigSchema, {
  defaultValue: [],
});

export function disabledSkillNames(config: IConfigService | undefined): ReadonlySet<string> {
  const list = config?.get<DisabledSkillsConfig>(DISABLED_SKILLS_SECTION) ?? [];
  const out = new Set<string>();
  for (const entry of list) {
    const trimmed = entry.trim();
    if (trimmed !== '') out.add(normalizeSkillName(trimmed));
  }
  return out;
}

export const MERGE_ALL_AVAILABLE_SKILLS_SECTION = 'mergeAllAvailableSkills';
export const MergeAllAvailableSkillsConfigSchema = z.boolean().optional();
export type MergeAllAvailableSkillsConfig = z.infer<typeof MergeAllAvailableSkillsConfigSchema>;

registerConfigSection(MERGE_ALL_AVAILABLE_SKILLS_SECTION, MergeAllAvailableSkillsConfigSchema, {
  defaultValue: true,
});

export const BUILTIN_PRODUCT_SKILLS_SECTION = 'builtinProductSkills';
export const BuiltinProductSkillsConfigSchema = z.boolean().optional();
export type BuiltinProductSkillsConfig = z.infer<typeof BuiltinProductSkillsConfigSchema>;

export const BUILTIN_PRODUCT_SKILLS_ENV = 'KIKI_BUILTIN_PRODUCT_SKILLS';

export const builtinProductSkillsEnvBindings: EnvBindings<BuiltinProductSkillsConfig> =
  envBindings(BuiltinProductSkillsConfigSchema, {
    env: BUILTIN_PRODUCT_SKILLS_ENV,
    parse: parseBooleanEnv,
  });

export const stripBuiltinProductSkillsEnv: ConfigStripEnv<BuiltinProductSkillsConfig> = (
  value,
  raw,
  getEnv,
) => {
  if (getEnv === undefined) return value;
  if (parseBooleanEnv(getEnv(BUILTIN_PRODUCT_SKILLS_ENV)) === undefined) return value;
  return typeof raw === 'boolean' ? raw : undefined;
};

registerConfigSection(BUILTIN_PRODUCT_SKILLS_SECTION, BuiltinProductSkillsConfigSchema, {
  defaultValue: true,
  env: builtinProductSkillsEnvBindings,
  stripEnv: stripBuiltinProductSkillsEnv,
});

export function builtinProductSkillsEnabled(config: IConfigService): boolean {
  return config.get<BuiltinProductSkillsConfig>(BUILTIN_PRODUCT_SKILLS_SECTION) !== false;
}
