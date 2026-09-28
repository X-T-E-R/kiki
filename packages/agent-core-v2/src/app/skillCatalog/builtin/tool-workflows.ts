import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import TOOL_WORKFLOWS_BODY from './tool-workflows.md?raw';

const PSEUDO_PATH = 'builtin://tool-workflows';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/tool-workflows.md',
  skillDirName: 'tool-workflows',
  source: 'builtin',
  text: TOOL_WORKFLOWS_BODY,
});

export const TOOL_WORKFLOWS_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: { ...parsed.metadata, type: parsed.metadata.type ?? 'inline' },
  productSpecific: true,
};
