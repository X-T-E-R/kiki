import SYSTEM_PROMPT_TEMPLATE from './system.md?raw';

export const SYSTEM_PROMPT_FIELD_IDS = {
  identity: 'system.identity',
  language: 'system.language',
  intentToolUse: 'system.intent_tool_use',
  replyStyle: 'system.reply_style',
  replyQuality: 'system.reply_quality',
  judgmentWorkflow: 'system.judgment_workflow',
  coding: 'system.coding',
  delegationBriefHygiene: 'system.delegation_brief_hygiene',
  research: 'system.research',
  publicArtifacts: 'system.public_artifacts',
  context: 'system.context',
  environment: 'system.environment',
  project: 'system.project',
  ultimateReminders: 'system.ultimate_reminders',
  shared: 'system.shared',
} as const;

export interface SystemPromptFieldDefault {
  readonly id: string;
  readonly value: string;
  readonly allowedVariables: readonly string[];
  readonly requiredPlaceholders: readonly string[];
}

const SECTION_MARKERS = [
  [SYSTEM_PROMPT_FIELD_IDS.identity, 'You are ${product_name}', '# Language'],
  [SYSTEM_PROMPT_FIELD_IDS.language, '# Language', '# Intent, Continuity, and Tool Use'],
  [SYSTEM_PROMPT_FIELD_IDS.intentToolUse, '# Intent, Continuity, and Tool Use', '# Reply Quality'],
  [SYSTEM_PROMPT_FIELD_IDS.replyQuality, '# Reply Quality', '# Judgment And Workflow'],
  [SYSTEM_PROMPT_FIELD_IDS.judgmentWorkflow, '# Judgment And Workflow', '# General Guidelines for Coding'],
  [SYSTEM_PROMPT_FIELD_IDS.coding, '# General Guidelines for Coding', '# Delegation Brief Hygiene'],
  [SYSTEM_PROMPT_FIELD_IDS.delegationBriefHygiene, '# Delegation Brief Hygiene', '# General Guidelines for Research and Data Processing'],
  [SYSTEM_PROMPT_FIELD_IDS.research, '# General Guidelines for Research and Data Processing', '# Public-Facing Artifacts'],
  [SYSTEM_PROMPT_FIELD_IDS.publicArtifacts, '# Public-Facing Artifacts', '# Context Management'],
  [SYSTEM_PROMPT_FIELD_IDS.context, '# Context Management', '# Working Environment'],
  [SYSTEM_PROMPT_FIELD_IDS.environment, '# Working Environment', '# Project Information'],
  [SYSTEM_PROMPT_FIELD_IDS.project, '# Project Information', '# Ultimate Reminders'],
  [SYSTEM_PROMPT_FIELD_IDS.ultimateReminders, '# Ultimate Reminders', undefined],
] as const;

const REQUIRED_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  [SYSTEM_PROMPT_FIELD_IDS.identity]: ['product_name', 'role_additional'],
  [SYSTEM_PROMPT_FIELD_IDS.replyStyle]: ['reply_style_guide'],
  [SYSTEM_PROMPT_FIELD_IDS.environment]: ['os', 'windows_notes', 'shell', 'now', 'cwd', 'cwd_listing', 'additional_dirs_section'],
  [SYSTEM_PROMPT_FIELD_IDS.project]: ['agents_md', 'skills_section', 'plugin_sections'],
};

const sectionDefaults = SECTION_MARKERS.map(([id, start, end]) => {
  const startIndex = SYSTEM_PROMPT_TEMPLATE.indexOf(start);
  const endIndex = end === undefined ? SYSTEM_PROMPT_TEMPLATE.length : SYSTEM_PROMPT_TEMPLATE.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) throw new Error(`System prompt field boundary is missing for ${id}`);
  const value = SYSTEM_PROMPT_TEMPLATE.slice(startIndex, endIndex).trimEnd();
  const allowedVariables = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
  return {
    id,
    value,
    allowedVariables: [...new Set(allowedVariables)],
    requiredPlaceholders: REQUIRED_VARIABLES[id] ?? [],
  };
});

export const SYSTEM_PROMPT_FIELD_DEFAULTS: readonly SystemPromptFieldDefault[] = [
  ...sectionDefaults,
  {
    id: SYSTEM_PROMPT_FIELD_IDS.replyStyle,
    value: '${reply_style_guide}',
    allowedVariables: ['reply_style_guide'],
    requiredPlaceholders: REQUIRED_VARIABLES[SYSTEM_PROMPT_FIELD_IDS.replyStyle]!,
  },
  {
    id: SYSTEM_PROMPT_FIELD_IDS.shared,
    value: '',
    allowedVariables: [],
    requiredPlaceholders: [],
  },
];

export function applySystemPromptFields(fields: Readonly<Record<string, string>> | undefined): string {
  let template = SYSTEM_PROMPT_TEMPLATE;
  for (const field of sectionDefaults) {
    const override = fields?.[field.id];
    if (override !== undefined) template = template.replace(field.value, () => override);
  }
  const replyStyle = fields?.[SYSTEM_PROMPT_FIELD_IDS.replyStyle];
  if (replyStyle !== undefined) template = template.replace('${reply_style_guide}', () => replyStyle);
  return template;
}
