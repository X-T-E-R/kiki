/**
 * `/api/v2` external delegation edge — authenticated, allowlisted Session commands.
 *
 * Resolves an operator-configured integration identity after validating a
 * dedicated credential and exact Session allowlist, derives immutable
 * authority fingerprints at the edge, and exposes only the bounded delegation
 * facade. Raw scope handles and agent identifiers never cross this route.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  ErrorCodes,
  ISessionExternalDelegationService,
  isError2,
  resumeSessionById,
  type ExternalAuthority,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';
import { ensureMainAgent } from '../../transport/mainAgent';

interface RouteRequest {
  readonly id: string;
  readonly params: unknown;
  readonly body?: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ExternalDelegationRouteHost {
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: RouteRequest, reply: { send(payload: unknown): unknown }) => Promise<void>,
  ): unknown;
}

const paramsSchema = z.object({ session_id: z.string().min(1) });
const emptySchema = z.object({}).strict();
const dispatchSchema = z
  .object({
    target: z.enum(['main', 'named']),
    task_name: z.string().optional(),
    profile_name: z.string().optional(),
    message: z.string().min(1).max(1_000_000),
  })
  .strict();
const continueSchema = z.object({ dispatch_id: z.string().min(1), message: z.string().min(1).max(1_000_000) }).strict();
const lookupSchema = z.object({ dispatch_id: z.string().min(1) }).strict();
const pageSchema = lookupSchema.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict();

export function registerV2ExternalDelegationRoutes(
  app: ExternalDelegationRouteHost,
  core: Scope,
  authorityConfig: { readonly principalId: string; readonly sessionId: string; readonly token: string },
): void {
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/list', emptySchema, async (service, authority) => service.list(authority));
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/dispatch', dispatchSchema, async (service, authority, body) =>
    service.dispatch({ authority, target: body.target, taskName: body.task_name, profileName: body.profile_name, message: body.message }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/continue', continueSchema, async (service, authority, body) =>
    service.continue({ authority, dispatchId: body.dispatch_id, message: body.message }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/status', lookupSchema, async (service, authority, body) =>
    service.status({ authority, dispatchId: body.dispatch_id }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/result', pageSchema, async (service, authority, body) =>
    service.result({ authority, dispatchId: body.dispatch_id, cursor: body.cursor, limit: body.limit }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/events', pageSchema, async (service, authority, body) =>
    service.events({ authority, dispatchId: body.dispatch_id, cursor: body.cursor, limit: body.limit }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/transcript', pageSchema, async (service, authority, body) =>
    service.transcript({ authority, dispatchId: body.dispatch_id, cursor: body.cursor, limit: body.limit }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/cancel', lookupSchema, async (service, authority, body) =>
    service.cancel({ authority, dispatchId: body.dispatch_id }),
  );
}

function command<T extends z.ZodTypeAny>(
  app: ExternalDelegationRouteHost,
  core: Scope,
  authorityConfig: { readonly principalId: string; readonly sessionId: string; readonly token: string },
  path: string,
  schema: T,
  execute: (
    service: ISessionExternalDelegationService,
    authority: ExternalAuthority,
    body: z.infer<T>,
  ) => Promise<unknown>,
): void {
  app.post(path, {}, async (req, reply) => {
    try {
      const { session_id } = paramsSchema.parse(req.params);
      const body = schema.parse(req.body ?? {});
      if (singleHeader(req.headers['x-kiki-principal-id']) !== undefined) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Caller-supplied principal identity is not admitted.', req.id));
        return;
      }
      const presentedToken = singleHeader(req.headers['x-kiki-delegation-token']);
      if (presentedToken !== undefined) req.headers['x-kiki-delegation-token'] = '[redacted]';
      if (!dedicatedTokenMatches(presentedToken, authorityConfig.token)) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'External delegation authority is not admitted.', req.id));
        return;
      }
      if (session_id !== authorityConfig.sessionId) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'External delegation Session is not admitted.', req.id));
        return;
      }
      const session = await resolveSession(core, session_id);
      await ensureMainAgent(session);
      const data = await execute(
        session.accessor.get(ISessionExternalDelegationService),
        authorityFor(authorityConfig.principalId),
        body,
      );
      reply.send(okEnvelope(data, req.id));
    } catch (error) {
      const message = redactedMessage(error);
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
    }
  });
}

async function resolveSession(core: Scope, sessionId: string): Promise<ISessionScopeHandle> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) throw new Error('Session does not exist.');
  return session;
}

function authorityFor(principal: string): ExternalAuthority {
  return {
    principalFingerprint: sha256(`principal:v1:${principal}`),
    authorityFingerprint: sha256(`authority:v1:${principal}:external-delegation`),
    configFingerprint: sha256('config:v1:main+named:no-overrides'),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function dedicatedTokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function redactedMessage(error: unknown): string {
  if (error instanceof z.ZodError) return 'Invalid external delegation request.';
  if (isError2(error)) {
    if (error.code === ErrorCodes.REQUEST_INVALID) return error.message;
    return 'External delegation request failed.';
  }
  return 'External delegation request failed.';
}
