import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const EXTERNAL_DELEGATION_FLAG_ID = 'external_delegation_mcp';

/** `externalDelegation` domain — the experimental external-delegation flag. */
export const externalDelegationFlag: FlagDefinitionInput = {
  id: EXTERNAL_DELEGATION_FLAG_ID,
  title: 'External delegation over MCP',
  description: 'Allow an authenticated external principal to own durable session work.',
  env: 'KIKI_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP',
  default: true,
  surface: 'core',
};

registerFlagDefinition(externalDelegationFlag);
