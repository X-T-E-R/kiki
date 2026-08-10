import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AGENT_COLLABORATION_FLAG_ID = 'agent-collaboration';
export const AGENT_COLLABORATION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AGENT_COLLABORATION';

export const agentCollaborationFlag: FlagDefinitionInput = {
  id: AGENT_COLLABORATION_FLAG_ID,
  title: 'Codex-style agent collaboration adapter',
  description: 'Expose named asynchronous collaboration tools over the existing subagent lifecycle.',
  env: AGENT_COLLABORATION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(agentCollaborationFlag);
