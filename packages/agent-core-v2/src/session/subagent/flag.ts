import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SUBAGENT_RELEASE_IDLE_FLAG = 'subagent_release_idle';

export const subagentReleaseIdleFlag: FlagDefinitionInput = {
  id: SUBAGENT_RELEASE_IDLE_FLAG,
  title: 'release idle subagents',
  description:
    'Release the in-memory scope of a subagent once its run has completed and it has stayed idle; the agent remains listed and is restored from its persisted history when resumed or messaged.',
  env: 'KIKI_EXPERIMENTAL_SUBAGENT_RELEASE_IDLE',
  default: true,
  surface: 'core',
};

registerFlagDefinition(subagentReleaseIdleFlag);
