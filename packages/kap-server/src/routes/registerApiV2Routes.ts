import { timingSafeEqual } from 'node:crypto';

import { IConfigService, type Scope } from '@kiki/agent-core-v2';
import { IFlagService } from '@kiki/agent-core-v2/app/flag/flag';
import { EXTERNAL_DELEGATION_FLAG_ID } from '@kiki/agent-core-v2/session/externalDelegation/flag';

import type { ExternalDelegationSeatManager } from '../mcp/externalDelegationSeats';
import type { ExternalDelegationState } from '../protocol/rest-meta';
import { registerV2ExternalDelegationRoutes } from './v2/externalDelegation';
import { registerV2ExternalDelegationSeatRoutes } from './v2/externalDelegationSeats';
import { registerV2McpRoutes } from './v2/mcp';
import { registerV2SessionsRoutes } from './v2/sessions';
import { registerV2UsageRoutes } from './v2/usage';

export interface RegisterApiV2RoutesOptions {
  readonly externalDelegation?: {
    readonly principalId: string;
    readonly sessionId: string;
    readonly token: string;
  };
  readonly externalDelegationState?: ExternalDelegationState;
  readonly seatManager?: ExternalDelegationSeatManager;
}

export async function registerApiV2RouteSet(
  api: unknown,
  core: Scope,
  opts: RegisterApiV2RoutesOptions = {},
): Promise<void> {
  const externalDelegation = normalizeExternalDelegationAuthority(opts.externalDelegation);
  const seatManager = opts.seatManager;
  const state = opts.externalDelegationState;
  const legacyEnabled = seatManager === undefined || state === undefined
    ? await legacyExternalDelegationEnabled(core)
    : false;
  registerV2SessionsRoutes(api as Parameters<typeof registerV2SessionsRoutes>[0], core);
  registerV2McpRoutes(api as Parameters<typeof registerV2McpRoutes>[0], core);
  registerV2UsageRoutes(api as Parameters<typeof registerV2UsageRoutes>[0], core);
  if (seatManager !== undefined && state !== undefined) {
    registerV2ExternalDelegationSeatRoutes(
      api as Parameters<typeof registerV2ExternalDelegationSeatRoutes>[0],
      seatManager,
      state,
    );
    registerV2ExternalDelegationRoutes(
      api as Parameters<typeof registerV2ExternalDelegationRoutes>[0],
      core,
      {
        state,
        resolve: async (sessionId, presentedToken) => {
          const seat = await seatManager.resolve(sessionId, presentedToken);
          if (seat !== undefined) return seat;
          if (
            externalDelegation === undefined ||
            !tokenMatches(presentedToken, externalDelegation.token)
          ) {
            return undefined;
          }
          if (sessionId !== externalDelegation.sessionId) {
            return { error: 'session_not_admitted' };
          }
          return {
            principalId: externalDelegation.principalId,
            sessionId: externalDelegation.sessionId,
          };
        },
      },
    );
  } else if (legacyEnabled && externalDelegation !== undefined) {
    registerV2ExternalDelegationRoutes(
      api as Parameters<typeof registerV2ExternalDelegationRoutes>[0],
      core,
      { ...externalDelegation, state: { state: 'active' } },
    );
  }
}

async function legacyExternalDelegationEnabled(core: Scope): Promise<boolean> {
  await core.accessor.get(IConfigService).ready;
  return core.accessor.get(IFlagService).enabled(EXTERNAL_DELEGATION_FLAG_ID);
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

function tokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
