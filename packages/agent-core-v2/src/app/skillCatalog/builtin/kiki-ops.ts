import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import CONFIG_BODY from './kiki-ops/config.md?raw';
import DOCS_BODY from './kiki-ops/docs.md?raw';
import GOAL_BODY from './kiki-ops/goal.md?raw';
import IMPORT_BODY from './kiki-ops/import.md?raw';
import MCP_BODY from './kiki-ops/mcp.md?raw';
import PROFILE_BODY from './kiki-ops/profile.md?raw';
import THEME_BODY from './kiki-ops/theme.md?raw';
import KIKI_OPS_BODY from './kiki-ops.md?raw';

function makeKikiOpsSkill(
  body: string,
  name: string,
  skillMdPath: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
): SkillDefinition {
  const parsed = parseSkillText({
    skillMdPath,
    skillDirName: name,
    source: 'builtin',
    text: body,
  });
  return {
    ...parsed,
    name,
    path: pseudoPath,
    dir: pseudoPath,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      ...extraMetadata,
    },
    productSpecific: true,
  };
}

export const KIKI_OPS_SKILL = makeKikiOpsSkill(
  KIKI_OPS_BODY,
  'kiki-ops',
  '/builtin/skills/kiki-ops.md',
  'builtin://kiki-ops',
);

export const KIKI_OPS_CONFIG_SKILL = makeKikiOpsSkill(
  CONFIG_BODY,
  'kiki-ops.config',
  '/builtin/skills/kiki-ops/config.md',
  'builtin://kiki-ops/config',
  { isSubSkill: true },
);

export const KIKI_OPS_THEME_SKILL = makeKikiOpsSkill(
  THEME_BODY,
  'kiki-ops.theme',
  '/builtin/skills/kiki-ops/theme.md',
  'builtin://kiki-ops/theme',
  { isSubSkill: true },
);

export const KIKI_OPS_MCP_SKILL = makeKikiOpsSkill(
  MCP_BODY,
  'kiki-ops.mcp',
  '/builtin/skills/kiki-ops/mcp.md',
  'builtin://kiki-ops/mcp',
  { isSubSkill: true },
);

export const KIKI_OPS_IMPORT_SKILL = makeKikiOpsSkill(
  IMPORT_BODY,
  'kiki-ops.import',
  '/builtin/skills/kiki-ops/import.md',
  'builtin://kiki-ops/import',
  { isSubSkill: true },
);

export const KIKI_OPS_PROFILE_SKILL = makeKikiOpsSkill(
  PROFILE_BODY,
  'kiki-ops.profile',
  '/builtin/skills/kiki-ops/profile.md',
  'builtin://kiki-ops/profile',
  { isSubSkill: true },
);

export const KIKI_OPS_GOAL_SKILL = makeKikiOpsSkill(
  GOAL_BODY,
  'kiki-ops.goal',
  '/builtin/skills/kiki-ops/goal.md',
  'builtin://kiki-ops/goal',
  { isSubSkill: true },
);

export const KIKI_OPS_DOCS_SKILL = makeKikiOpsSkill(
  DOCS_BODY,
  'kiki-ops.docs',
  '/builtin/skills/kiki-ops/docs.md',
  'builtin://kiki-ops/docs',
  { isSubSkill: true },
);
