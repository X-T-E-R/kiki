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
  EXTERNAL_INTERACTION_NOT_OWNED_CODE,
  ErrorCodes,
  ISessionExternalDelegationService,
  classifyExternalFailureCode,
  externalFailureDescription,
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

const paramsSchema = z.object({ session_id: z.string().min(1) });
const emptySchema = z.object({}).strict();
const dispatchSchema = z
  .object({
    target: z.enum(['main', 'named']),
    task_name: z.string().optional(),
    profile_name: z.string().optional(),
    model_alias: z.string().optional(),
    thinking_effort: z.string().optional(),
    dispatch_key: z.string().trim().min(1).optional(),
    message: z.string().min(1).max(1_000_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.target === 'main' &&
      (value.task_name !== undefined ||
        value.profile_name !== undefined ||
        value.model_alias !== undefined ||
        value.thinking_effort !== undefined)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Named-child fields require target named.' });
    }
  })
  .strict();
const continueSchema = z
  .object({
    dispatch_id: z.string().min(1),
    dispatch_key: z.string().trim().min(1).optional(),
    message: z.string().min(1).max(1_000_000),
  })
  .strict();
const sendSchema = z.object({
  task_name: z.string().regex(/^(?!root$)[a-z0-9_]+$/),
  message: z.string().min(1).max(1_000_000),
  idempotency_key: z.string().trim().min(1),
}).strict();
const interactionsSchema = z.object({ cursor: z.number().int().nonnegative().optional() }).strict();
const approvalResponseSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  scope: z.literal('session').optional(),
  feedback: z.string().optional(),
  selected_label: z.string().optional(),
  selected_option_id: z.string().optional(),
}).strict();
const questionAnswersSchema = z.record(z.string(), z.union([z.string(), z.literal(true)]));
const questionResponseSchema = z.object({
  answers: questionAnswersSchema,
  method: z.enum(['enter', 'space', 'number_key']).optional(),
}).strict();
const respondSchema = z.discriminatedUnion('kind', [
  z.object({
    interaction_id: z.string().min(1),
    kind: z.literal('approval'),
    response: approvalResponseSchema,
  }).strict(),
  z.object({
    interaction_id: z.string().min(1),
    kind: z.literal('question'),
    response: z.union([questionResponseSchema, questionAnswersSchema, z.null()]),
  }).strict(),
]);
const lookupSchema = z.object({ dispatch_id: z.string().min(1) }).strict();
const waitSchema = z
  .object({
    dispatch_id: z.string().min(1).optional(),
    timeout_s: z.number().int().nonnegative().max(600).optional(),
  })
  .strict();
const pageSchema = lookupSchema.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() }).strict();
const resultPageSchema = lookupSchema.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(4).optional() }).strict();
const eventsPageSchema = pageSchema.extend({ detail: z.enum(['lifecycle', 'turn']).optional() }).strict();
const transcriptPageSchema = pageSchema.extend({ detail: z.enum(['text', 'items']).optional() }).strict();

export function registerV2ExternalDelegationRoutes(
  app: ExternalDelegationRouteHost,
  core: Scope,
  authorityConfig: { readonly principalId: string; readonly sessionId: string; readonly token: string },
): void {
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/list', emptySchema, async (service, authority) => service.list(authority));
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/dispatch', dispatchSchema, async (service, authority, body) =>
    service.dispatch({
      authority,
      target: body.target,
      taskName: body.task_name,
      profileName: body.profile_name,
      modelAlias: body.model_alias,
      thinkingEffort: body.thinking_effort,
      dispatchKey: body.dispatch_key,
      message: body.message,
    }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/continue', continueSchema, async (service, authority, body) =>
    service.continue({
      authority,
      dispatchId: body.dispatch_id,
      dispatchKey: body.dispatch_key,
      message: body.message,
    }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/send', sendSchema, async (service, authority, body) =>
    service.send({
      authority,
      taskName: body.task_name,
      message: body.message,
      idempotencyKey: body.idempotency_key,
    }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/interactions', interactionsSchema, async (service, authority, body) =>
    service.interactions({ authority, cursor: body.cursor }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/respond', respondSchema, async (service, authority, body) =>
    body.kind === 'approval'
      ? service.respond({
          authority,
          interactionId: body.interaction_id,
          kind: 'approval',
          response: normalizeApprovalResponse(body.response),
        })
      : service.respond({
          authority,
          interactionId: body.interaction_id,
          kind: 'question',
          response: body.response,
        }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/status', lookupSchema, async (service, authority, body) =>
    service.status({ authority, dispatchId: body.dispatch_id }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/wait', waitSchema, async (service, authority, body) =>
    service.wait({
      authority,
      dispatchId: body.dispatch_id,
      timeoutMs: body.timeout_s === undefined ? undefined : body.timeout_s * 1_000,
    }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/result', resultPageSchema, async (service, authority, body) =>
    service.result({ authority, dispatchId: body.dispatch_id, cursor: body.cursor, limit: body.limit }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/events', eventsPageSchema, async (service, authority, body) =>
    service.events({
      authority,
      dispatchId: body.dispatch_id,
      cursor: body.cursor,
      limit: body.limit,
      detail: body.detail,
    }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/transcript', transcriptPageSchema, async (service, authority, body) =>
    service.transcript({
      authority,
      dispatchId: body.dispatch_id,
      cursor: body.cursor,
      limit: body.limit,
      detail: body.detail,
    }),
  );
  command(app, core, authorityConfig, '/sessions/:session_id/external-delegation/cancel', lookupSchema, async (service, authority, body) =>
    service.cancel({ authority, dispatchId: body.dispatch_id }),
  );
}

function normalizeApprovalResponse(response: z.infer<typeof approvalResponseSchema>) {
  return {
    decision: response.decision,
    scope: response.scope,
    feedback: response.feedback,
    selectedLabel: response.selected_label,
    selectedOptionId: response.selected_option_id,
  };
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
      const failureCode = failureCodeForLog(error);
      const log = {
        request_id: req.id,
        action: path.slice(path.lastIndexOf('/') + 1),
        error_message: error instanceof Error ? error.message : String(error),
        error_stack: error instanceof Error ? error.stack : undefined,
        failure_code: failureCode,
      };
      if (failureCode === undefined) {
        req.log.warn(log, 'external delegation request failed');
      } else {
        req.log.info(log, 'external delegation request failed');
      }
      const redacted = redactedMessage(error);
      reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, redacted.message, req.id), details: redacted.details });
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
    configFingerprint: sha256('config:v2:main+named:immutable-new-child-bindings'),
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

function failureCodeForLog(error: unknown): string | undefined {
  if (!isError2(error)) return undefined;
  const failureCode = error.details?.['failure_code'];
  if (typeof failureCode === 'string') return failureCode;
  return classifyExternalFailureCode(error.code);
}

interface RedactedFailure {
  readonly message: string;
  /** Present only when the failure carries a stable classification. */
  readonly details?: { readonly failure_code: string };
}

function redactedMessage(error: unknown): RedactedFailure {
  if (error instanceof z.ZodError) return { message: 'Invalid external delegation request.' };
  if (isError2(error)) {
    const failureCode = error.details?.['failure_code'];
    if (failureCode === EXTERNAL_INTERACTION_NOT_OWNED_CODE) {
      return { message: error.message, details: { failure_code: failureCode } };
    }
    if (error.code === ErrorCodes.REQUEST_INVALID) return { message: error.message };
    // Already-classified failures pass their category code and the
    // domain-owned description through — never the raw provider text; only
    // unclassified internal failures stay collapsed.
    const category = classifyExternalFailureCode(error.code);
    if (category !== undefined) {
      return {
        message: externalFailureDescription(category),
        details: { failure_code: category },
      };
    }
    return { message: 'External delegation request failed.' };
  }
  return { message: 'External delegation request failed.' };
}
