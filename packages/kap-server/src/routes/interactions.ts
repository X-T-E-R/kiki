import {
  getLiveSessionById,
  ISessionIndex,
  ISessionInteractionService,
  type ExecutableToolOutput,
  type Interaction,
  type Scope,
} from '@kiki/agent-core-v2';
import {
  ErrorCode,
  interactionRespondRequestSchema,
  interactionRespondResultSchema,
  type MessageContent,
  type PendingUserTool,
} from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { contentToCoreParts } from '../lib/promptMedia';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface InteractionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

interface UserToolInteractionPayload {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly args?: unknown;
}

const tailParamsSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

/** Project an in-process `user_tool` interaction onto its protocol wire shape. */
export function toWirePendingUserTool(interaction: Interaction, sessionId: string): PendingUserTool {
  const payload = (interaction.payload ?? {}) as UserToolInteractionPayload;
  return {
    interaction_id: interaction.id,
    session_id: sessionId,
    agent_id: interaction.origin.agentId ?? 'main',
    ...(payload.turnId === undefined ? {} : { turn_id: payload.turnId }),
    tool_call_id: payload.toolCallId ?? interaction.id,
    name: payload.name ?? '',
    args: payload.args,
    created_at: new Date(interaction.createdAt).toISOString(),
  };
}

function toExecutableOutput(result: string | MessageContent[]): ExecutableToolOutput {
  if (typeof result === 'string') return result;
  return contentToCoreParts(result);
}

/** Register stateless `POST /sessions/{session_id}/interactions/{interaction_id}:respond` route. */
export function registerInteractionsRoutes(app: InteractionRouteHost, core: Scope): void {
  const respondRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/interactions/{tail}',
      params: tailParamsSchema,
      success: { data: interactionRespondResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_ALREADY_RESOLVED]: {},
      },
      description: 'Statelessly answer a pending user_tool interaction',
      tags: ['interactions'],
      operationId: 'respondInteraction',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['respond'] as const,
        defaultAction: 'respond',
        resourceLabel: 'interaction',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      const interactionId = parsed.id;

      if (getLiveSessionById(core.accessor, session_id) === undefined) {
        const summary = await core.accessor.get(ISessionIndex).get(session_id);
        if (getLiveSessionById(core.accessor, session_id) === undefined) {
          reply.send(
            summary === undefined
              ? errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id)
              : errEnvelope(ErrorCode.APPROVAL_NOT_FOUND, `interaction ${interactionId} not found`, req.id),
          );
          return;
        }
      }

      const bodyParse = interactionRespondRequestSchema.safeParse(req.body);
      if (!bodyParse.success) {
        const details = bodyParse.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }));
        reply.send({
          code: ErrorCode.VALIDATION_FAILED,
          msg: details[0]?.message ?? 'validation failed',
          data: null,
          request_id: req.id,
          details,
        });
        return;
      }

      await withSessionOperation(core, session_id, async (handle) => {
        if (handle === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
          return;
        }
        const interaction = handle.accessor.get(ISessionInteractionService);
        const pending = interaction
          .listPending('user_tool')
          .find((item) => item.id === interactionId);
        if (pending === undefined) {
          if (interaction.isRecentlyResolved(interactionId)) {
            reply.send(
              errEnvelope(
                ErrorCode.APPROVAL_ALREADY_RESOLVED,
                `interaction ${interactionId} already resolved`,
                req.id,
              ),
            );
            return;
          }
          reply.send(
            errEnvelope(ErrorCode.APPROVAL_NOT_FOUND, `interaction ${interactionId} not found`, req.id),
          );
          return;
        }

        const payload = bodyParse.data;
        const response = 'error' in payload
          ? { output: payload.error, isError: true as const }
          : { output: toExecutableOutput(payload.result), isError: payload.is_error === true };
        interaction.respond(interactionId, response);
        reply.send(
          okEnvelope(
            {
              resolved: true as const,
              interaction_id: interactionId,
              resolved_at: new Date().toISOString(),
            },
            req.id,
          ),
        );
      });
    },
  );
  app.post(
    respondRoute.path,
    respondRoute.options,
    respondRoute.handler as Parameters<InteractionRouteHost['post']>[2],
  );
}
