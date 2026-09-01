/**
 * `externalDelegation` domain — registers the experimental external-delegation flag.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const EXTERNAL_DELEGATION_FLAG_ID = 'external_delegation_mcp';

export const externalDelegationFlag: FlagDefinitionInput = {
  id: EXTERNAL_DELEGATION_FLAG_ID,
  title: 'External delegation over MCP',
  description: 'Allow an authenticated external principal to own durable session work.',
  env: 'KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP',
  default: true,
  surface: 'core',
};

registerFlagDefinition(externalDelegationFlag);
