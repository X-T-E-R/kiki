import type { Scope } from '@moonshot-ai/agent-core-v2';
import { IConfigService } from '@moonshot-ai/agent-core-v2';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { EXTERNAL_DELEGATION_FLAG_ID } from '@moonshot-ai/agent-core-v2/session/externalDelegation/flag';

import { registerV2McpRoutes } from './v2/mcp';
import { registerV2SessionsRoutes } from './v2/sessions';
import { registerV2ExternalDelegationRoutes } from './v2/externalDelegation';

interface ApiV2AppHost {
  register(
    plugin: (apiV2: unknown) => Promise<void> | void,
    opts: { prefix: string },
  ): unknown;
}

export interface RegisterApiV2RoutesOptions {
  readonly externalDelegation?: {
    readonly principalId: string;
    readonly sessionId: string;
    readonly token: string;
  };
}

export async function registerApiV2Routes(
  app: ApiV2AppHost,
  core: Scope,
  opts: RegisterApiV2RoutesOptions = {},
): Promise<void> {
  await core.accessor.get(IConfigService).ready;
  const externalDelegationEnabled = core.accessor.get(IFlagService).enabled(EXTERNAL_DELEGATION_FLAG_ID);
  const externalDelegation = normalizeExternalDelegationAuthority(opts.externalDelegation);
  await app.register(
    async (apiV2) => {
      registerV2SessionsRoutes(apiV2 as Parameters<typeof registerV2SessionsRoutes>[0], core);
      registerV2McpRoutes(apiV2 as Parameters<typeof registerV2McpRoutes>[0], core);
      if (externalDelegationEnabled && externalDelegation !== undefined) {
        registerV2ExternalDelegationRoutes(
          apiV2 as Parameters<typeof registerV2ExternalDelegationRoutes>[0],
          core,
          externalDelegation,
        );
      }
    },
    { prefix: '/api/v2' },
  );
}

function normalizeExternalDelegationAuthority(
  input: RegisterApiV2RoutesOptions['externalDelegation'],
): RegisterApiV2RoutesOptions['externalDelegation'] {
  if (input === undefined) return undefined;
  const principalId = input.principalId.trim();
  const sessionId = input.sessionId.trim();
  const token = input.token.trim();
  if (principalId.length === 0 || sessionId.length === 0 || token.length === 0) return undefined;
  return { principalId, sessionId, token };
}
