/**
 * `agentProfileCatalog` domain — experimental named profile-route flag.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AGENT_PROFILE_ROUTES_FLAG_ID = 'agent-profile-routes';

export const agentProfileRoutesFlag: FlagDefinitionInput = {
  id: AGENT_PROFILE_ROUTES_FLAG_ID,
  title: 'Agent profile routes',
  description: 'Load and dispatch named specializations of existing agent profiles.',
  env: 'KIKI_EXPERIMENTAL_AGENT_PROFILE_ROUTES',
  default: false,
  surface: 'core',
};

registerFlagDefinition(agentProfileRoutesFlag);
