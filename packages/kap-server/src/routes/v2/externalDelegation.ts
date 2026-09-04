import { timingSafeEqual } from 'node:crypto';

import type { Scope } from '@moonshot-ai/agent-core-v2';
import {
  delegationProcedureTable,
  type DelegationProcedureName,
} from '@moonshot-ai/klient/procedures';

import type { ExternalDelegationState } from '../../protocol/rest-meta';
import { errEnvelope, okEnvelope } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';
import {
  externalDelegationFailureCode,
  externalDelegationPublicFailure,
} from '../../procedures/errors';
import {
  ExternalDelegationProcedureHost,
  type ExternalDelegationSeatAuthority,
} from '../../procedures/externalDelegationHost';

interface RouteRequest {
  readonly id: string;
  readonly params: unknown;
  readonly body?: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly log: {
    info(bindings: Record<string, unknown>, message: string): void;
    warn(bindings: Record<string, unknown>, message: string): void;
  };
}

interface ExternalDelegationRouteHost {
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: RouteRequest, reply: { send(payload: unknown): unknown }) => Promise<void>,
  ): unknown;
}

interface StaticExternalDelegationRouteConfig {
  readonly principalId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly state: ExternalDelegationState;
}

export type ExternalDelegationAuthorityResolution =
  | { readonly principalId: string; readonly sessionId: string; readonly seatId?: string; readonly workspacePath?: string }
  | { readonly error: 'session_not_admitted' };

export interface ExternalDelegationAuthoritySource {
  readonly state: ExternalDelegationState;
  resolve(
    sessionId: string,
    presentedToken: string,
  ): Promise<ExternalDelegationAuthorityResolution | undefined>;
}

type ExternalDelegationRouteConfig =
  | StaticExternalDelegationRouteConfig
  | ExternalDelegationAuthoritySource;

export function registerV2ExternalDelegationRoutes(
  app: ExternalDelegationRouteHost,
  core: Scope,
  authorityConfig: ExternalDelegationRouteConfig,
): void {
  const host = new ExternalDelegationProcedureHost(core);
  for (const procedure of delegationProcedureTable) {
    if (procedure.name === 'profiles') continue;
    const path = `/sessions/:session_id/external-delegation/${procedure.name}`;
    app.post(path, {}, async (req, reply) => {
      if (authorityConfig.state.state === 'disabled') {
        reply.send(errEnvelope(
          ErrorCode.REQUEST_MALFORMED,
          `External delegation is disabled: ${authorityConfig.state.reason}.`,
          req.id,
        ));
        return;
      }
      try {
        const sessionId = sessionIdFrom(req.params);
        if (singleHeader(req.headers['x-kiki-principal-id']) !== undefined) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Caller-supplied principal identity is not admitted.', req.id));
          return;
        }
        const presentedToken = singleHeader(req.headers['x-kiki-delegation-token']);
        if (presentedToken !== undefined) req.headers['x-kiki-delegation-token'] = '[redacted]';
        const seat = await resolveSeat(authorityConfig, sessionId, presentedToken);
        if (seat === undefined) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'External delegation authority is not admitted.', req.id));
          return;
        }
        if ('error' in seat) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'External delegation Session is not admitted.', req.id));
          return;
        }
        const wireInput = procedure.legacy.input.schema.parse(req.body ?? {});
        const input = procedure.legacy.input.decode(wireInput as never);
        const output = await host.call(
          seat,
          procedure.name as DelegationProcedureName,
          input as never,
        );
        reply.send(okEnvelope(procedure.legacy.encodeOutput(output as never), req.id));
      } catch (error) {
        const failureCode = externalDelegationFailureCode(error);
        const log = {
          request_id: req.id,
          action: procedure.name,
          error_message: error instanceof Error ? error.message : String(error),
          error_stack: error instanceof Error ? error.stack : undefined,
          failure_code: failureCode,
        };
        if (failureCode === undefined) req.log.warn(log, 'external delegation request failed');
        else req.log.info(log, 'external delegation request failed');
        const failure = externalDelegationPublicFailure(error);
        reply.send({
          ...errEnvelope(ErrorCode.VALIDATION_FAILED, failure.message, req.id),
          details: failure.details,
        });
      }
    });
  }
}

async function resolveSeat(
  config: ExternalDelegationRouteConfig,
  sessionId: string,
  presentedToken: string | undefined,
): Promise<ExternalDelegationSeatAuthority | { readonly error: 'session_not_admitted' } | undefined> {
  if ('resolve' in config) {
    if (presentedToken === undefined) return undefined;
    const resolution = await config.resolve(sessionId, presentedToken);
    if (resolution === undefined || 'error' in resolution) return resolution;
    return {
      seatId: resolution.seatId ?? `external:${resolution.sessionId}`,
      principalId: resolution.principalId,
      sessionId: resolution.sessionId,
      workspacePath: resolution.workspacePath,
    };
  }
  if (!tokenMatches(presentedToken, config.token)) return undefined;
  if (sessionId !== config.sessionId) return { error: 'session_not_admitted' };
  return {
    seatId: `external:${config.sessionId}`,
    principalId: config.principalId,
    sessionId: config.sessionId,
  };
}

function sessionIdFrom(params: unknown): string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid Session path.');
  const sessionId = (params as { readonly session_id?: unknown }).session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Invalid Session path.');
  return sessionId;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
