import { normalizeAgentProfile, type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { renderSystemPromptResult } from '#/app/agentProfileCatalog/profile-shared';

import GENERIC_SUBAGENT_ROLE from './generic-subagent.md?raw';

export const GENERIC_SUBAGENT_PROFILE_NAME = 'general';

export const GENERIC_SUBAGENT_PROFILE: AgentProfile = normalizeAgentProfile({
  name: GENERIC_SUBAGENT_PROFILE_NAME,
  description: 'General-purpose subagent',
  tools: [
    'Read',
    'ReadMediaFile',
    'Glob',
    'Grep',
    'Bash',
    'Edit',
    'Write',
    'WebSearch',
    'FetchURL',
    'Skill',
    'TodoList',
    'TaskList',
    'TaskOutput',
    'TaskStop',
  ],
  subagentPolicy: 'strict',
  subagentDeclaration: { kind: 'set', names: [] },
  subagents: [],
  renderSystemPrompt: (context) =>
    renderSystemPromptResult(GENERIC_SUBAGENT_ROLE, context, { skillActive: true }),
});
