import {
  SYSTEM_PROMPT_FIELD_DEFAULTS,
} from '@kiki/agent-profiles/systemPromptFields';
import { TASK_AGENT_ROLE_PREFIX } from '@kiki/agent-profiles/profileShared';
import { renderPrompt } from '@kiki/agent-profiles/renderPrompt';

import AGENT_DESCRIPTION_BASE from '../../agent/tools/agent/agent.md?raw';
import ASK_USER_DESCRIPTION_BASE from '../../agent/tools/ask-user-question/ask-user.md?raw';
import { MAX_MEDIA_MEGABYTES } from '../../agent/tools/read-media-file/read-media-file';
import READ_MEDIA_DESCRIPTION_BASE from '../../agent/tools/read-media-file/read-media.md?raw';
import WEB_SEARCH_DESCRIPTION_BASE from '../../agent/tools/web-search/web-search.md?raw';
import FETCH_URL_DESCRIPTION_BASE from '../../agent/tools/fetch-url/fetch-url.md?raw';
import INDEPENDENT_NOTICE_DEFAULT from '../../agent/profile/delegation-independent-notice.md?raw';

import { registerPromptField } from './promptFieldContribution';
import type { PromptFieldDefinition, ResolvedPromptFieldOverrides } from './promptFieldRegistry';

const STATIC_TOOL_FIELDS = [
  ['WebSearch', 'agent/tools/web-search/web-search.md'],
  ['Skill', 'agent/tools/skill/skill.md'],
  ['TodoList', 'agent/tools/todo-list/todo-list.md'],
  ['AgentRun', 'agent/tools/agent/agent.md'],
  ['AgentSend', 'agent/tools/agent-send/agent-send.md'],
  ['AgentList', 'agent/tools/agent-list/agent-list.md'],
  ['ReadMediaFile', 'agent/tools/read-media-file/read-media.md'],
  ['AskUserQuestion', 'agent/tools/ask-user-question/ask-user.md'],
  ['TaskList', 'agent/tools/task/task-list/task-list.md'],
  ['CronCreate', 'agent/tools/cron/cron-create/cron-create.md'],
  ['TaskWait', 'agent/tools/task/task-wait/task-wait.md'],
  ['TaskStop', 'agent/tools/task/task-stop/task-stop.md'],
  ['UpdateGoal', 'agent/tools/goal/update-goal/update-goal.md'],
  ['CronList', 'agent/tools/cron/cron-list/cron-list.md'],
  ['CronDelete', 'agent/tools/cron/cron-delete/cron-delete.md'],
  ['TaskOutput', 'agent/tools/task/task-output/task-output.md'],
  ['CreateGoal', 'agent/tools/goal/create-goal/create-goal.md'],
  ['Write', 'agent/tools/os/write/write.md'],
  ['Read', 'agent/tools/os/read/read.md'],
  ['Edit', 'agent/tools/edit/edit.md'],
  ['Grep', 'agent/tools/os/grep/grep.md'],
  ['Glob', 'agent/tools/os/glob/glob.md'],
  ['FetchURL', 'agent/tools/fetch-url/fetch-url.md'],
  ['SetGoalBudget', 'agent/tools/goal/set-goal-budget/set-goal-budget.md'],
  ['GetGoal', 'agent/tools/goal/get-goal/get-goal.md'],
  ['Bash', 'agent/tools/os/bash/bash.md'],
  ['EnterPlanMode', 'features/plan/tools/enter-plan-mode/enter-plan-mode.md'],
  ['ExitPlanMode', 'features/plan/tools/exit-plan-mode/exit-plan-mode.md'],
] as const;

const TOOL_DESCRIPTION_PREFIXES: Readonly<Record<string, string>> = {
  'agent-run': AGENT_DESCRIPTION_BASE,
  'ask-user-question': ASK_USER_DESCRIPTION_BASE,
  'read-media-file': renderPrompt(READ_MEDIA_DESCRIPTION_BASE, { MAX_MEDIA_MEGABYTES }),
  'web-search': WEB_SEARCH_DESCRIPTION_BASE,
  'fetch-url': FETCH_URL_DESCRIPTION_BASE,
};

const systemFields: PromptFieldDefinition[] = SYSTEM_PROMPT_FIELD_DEFAULTS.map((field) => ({
  id: field.id,
  owner: 'systemPrompt',
  defaultTemplate: { kind: 'inline', value: field.value },
  allowedVariables: field.allowedVariables,
  requiredPlaceholders: field.requiredPlaceholders,
  allowEmpty: field.id === 'system.shared',
  readonly: false,
  consumers: ['system'],
  contractVersion: 1,
}));

const delegationFields: PromptFieldDefinition[] = [
  {
    id: 'delegation.sub.notice',
    owner: 'delegation',
    defaultTemplate: { kind: 'inline', value: TASK_AGENT_ROLE_PREFIX },
    allowedVariables: [],
    requiredPlaceholders: [],
    allowEmpty: false,
    readonly: false,
    consumers: ['delegation'],
    appliesTo: { delegationPositions: ['sub'] },
    contractVersion: 1,
  },
  {
    id: 'delegation.independent.notice',
    owner: 'delegation',
    defaultTemplate: { kind: 'inline', value: INDEPENDENT_NOTICE_DEFAULT },
    allowedVariables: [],
    requiredPlaceholders: [],
    allowEmpty: false,
    readonly: false,
    consumers: ['delegation'],
    appliesTo: { delegationPositions: ['independent'] },
    contractVersion: 1,
  },
];

const toolFields: PromptFieldDefinition[] = STATIC_TOOL_FIELDS.flatMap(([name, resource]) => {
  const segment = promptToolFieldSegment(name);
  return [
    {
      id: `tool.${segment}.description`,
      owner: `tool.${segment}`,
      defaultTemplate: { kind: 'resource' as const, value: resource },
      allowedVariables: [],
      requiredPlaceholders: [],
      allowEmpty: false,
      readonly: false,
      consumers: [`tool:${name}`],
      contractVersion: 1,
    },
    {
      id: `tool.${segment}.guidance`,
      owner: `tool.${segment}`,
      defaultTemplate: { kind: 'inline' as const, value: '' },
      allowedVariables: [],
      requiredPlaceholders: [],
      allowEmpty: true,
      readonly: false,
      consumers: [`tool:${name}`],
      contractVersion: 1,
    },
  ];
});

export const BUILTIN_PROMPT_FIELD_DEFINITIONS: readonly PromptFieldDefinition[] = [
  ...systemFields,
  ...delegationFields,
  ...toolFields,
];

for (const definition of BUILTIN_PROMPT_FIELD_DEFINITIONS) registerPromptField(definition);

export function promptToolFieldSegment(name: string): string {
  return name.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function applyToolPromptFields(
  name: string,
  description: string,
  snapshot: ResolvedPromptFieldOverrides,
  variables: Readonly<Record<string, string>> = {},
): string {
  const segment = promptToolFieldSegment(name);
  const replacement = snapshot.values[`tool.${segment}.description`];
  const renderedReplacement = replacement === undefined ? undefined : renderPrompt(replacement, variables);
  const prefix = TOOL_DESCRIPTION_PREFIXES[segment];
  const base = renderedReplacement === undefined
    ? description
    : prefix !== undefined && description.startsWith(prefix)
      ? `${renderedReplacement}${description.slice(prefix.length)}`
      : renderedReplacement;
  const guidance = snapshot.values[`tool.${segment}.guidance`];
  const renderedGuidance = guidance === undefined ? undefined : renderPrompt(guidance, variables);
  return renderedGuidance === undefined || renderedGuidance.length === 0
    ? base
    : `${base}\n\nUser-configured guidance:\n${renderedGuidance}`;
}

export function appendSharedPromptField(
  base: string,
  snapshot: ResolvedPromptFieldOverrides,
  variables: Readonly<Record<string, string>> = {},
): string {
  const shared = snapshot.values['system.shared'];
  const rendered = shared === undefined ? undefined : renderPrompt(shared, variables);
  return rendered === undefined || rendered.length === 0 ? base : `${base}\n\n${rendered}`;
}
