import {
  ISessionApprovalService,
  ISessionInteractionService,
  ISessionIndex,
  getLiveSessionById,
  type SessionApprovalRequest as ApprovalRequest,
  type SessionApprovalResponse as ApprovalResponse,
  type Interaction,
  type Scope,
} from '@kiki/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  approvalAlreadyResolvedDataSchema,
  approvalResolveRequestSchema,
  approvalResolveResultSchema,
  listPendingApprovalsQuerySchema,
  listPendingApprovalsResponseSchema,
} from '../protocol/rest-approval';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';

interface ApprovalRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const approvalParamsSchema = z.object({
  session_id: z.string().min(1),
  approval_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function registerApprovalsRoutes(app: ApprovalRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/approvals',
      params: sessionIdParamSchema,
      querystring: listPendingApprovalsQuerySchema,
      success: { data: listPendingApprovalsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List pending approval requests for a session',
      tags: ['approvals'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      if (getLiveSessionById(core.accessor, session_id) === undefined) {
        const summary = await core.accessor.get(ISessionIndex).get(session_id);
        if (getLiveSessionById(core.accessor, session_id) === undefined) {
          reply.send(summary === undefined
            ? errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id)
            : okEnvelope({ items: [] }, req.id));
          return;
        }
      }
      await withSessionOperation(core, session_id, async (handle) => {
        if (handle === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
          return;
        }
        const pending = handle.accessor.get(ISessionInteractionService).listPending('approval');
        const items = pending.map((i) => toWireApproval(i, session_id));
        reply.send(okEnvelope({ items }, req.id));
      });
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<ApprovalRouteHost['get']>[2]);

  const resolveRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/approvals/{approval_id}',
      params: approvalParamsSchema,
      body: approvalResolveRequestSchema,
      success: { data: approvalResolveResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_ALREADY_RESOLVED]: {
          dataSchema: approvalAlreadyResolvedDataSchema,
        },
      },
      description: 'Resolve an approval request',
      tags: ['approvals'],
    },
    async (req, reply) => {
      const { session_id, approval_id } = req.params;
      if (getLiveSessionById(core.accessor, session_id) === undefined) {
        const summary = await core.accessor.get(ISessionIndex).get(session_id);
        if (getLiveSessionById(core.accessor, session_id) === undefined) {
          reply.send(summary === undefined
            ? errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id)
            : errEnvelope(ErrorCode.APPROVAL_NOT_FOUND, `approval ${approval_id} not found`, req.id));
          return;
        }
      }
      await withSessionOperation(core, session_id, async (handle) => {
        if (handle === undefined) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
          return;
        }
        const interaction = handle.accessor.get(ISessionInteractionService);
        const pendingApproval = interaction.listPending('approval').find((i) => i.id === approval_id);
        if (pendingApproval?.payload && (pendingApproval.payload as ApprovalRequest).ssh !== undefined) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Use the SSH-specific approval endpoint', req.id));
          return;
        }

        if (pendingApproval === undefined) {
          if (interaction.isRecentlyResolved(approval_id)) {
            reply.send({
              code: ErrorCode.APPROVAL_ALREADY_RESOLVED,
              msg: `approval ${approval_id} already resolved`,
              data: { resolved: false as const },
              request_id: req.id,
            });
            return;
          }
          reply.send(
            errEnvelope(ErrorCode.APPROVAL_NOT_FOUND, `approval ${approval_id} not found`, req.id),
          );
          return;
        }

        const body = req.body;
        const response: ApprovalResponse = {
          decision: body.decision,
          scope: body.scope,
          feedback: body.feedback,
          selectedLabel: body.selected_label,
          selectedOptionId: body.selected_option_id,
        };
        handle.accessor.get(ISessionApprovalService).decide(approval_id, response);
        requestLog(req)?.info(
          { session_id, approval_id, decision: response.decision, scope: response.scope },
          'approval decided',
        );
        reply.send(
          okEnvelope({ resolved: true as const, resolved_at: new Date().toISOString() }, req.id),
        );
      });
    },
  );
  app.post(
    resolveRoute.path,
    resolveRoute.options,
    resolveRoute.handler as Parameters<ApprovalRouteHost['post']>[2],
  );
}

export function toWireApproval(interaction: Interaction, sessionId: string): {
  approval_id: string;
  session_id: string;
  agent_id?: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  approval_rule?: string;
  ssh?: Omit<NonNullable<ApprovalRequest['ssh']>, 'prompts'> & { prompts?: { prompt: string; echo: boolean }[] };
  created_at: string;
  expires_at: string;
} {
  const p = interaction.payload as ApprovalRequest;
  return {
    approval_id: interaction.id,
    session_id: sessionId,
    agent_id: interaction.origin.agentId,
    turn_id: interaction.origin.turnId,
    tool_call_id: p.toolCallId ?? interaction.id,
    tool_name: p.toolName,
    action: p.action,
    tool_input_display: p.display,
    approval_rule: p.approvalRule === undefined || p.approvalRule === '' ? undefined : p.approvalRule,
    ssh: p.ssh === undefined ? undefined : { ...p.ssh,
      prompts: p.ssh.prompts?.map((item) => ({ prompt: item.prompt, echo: item.echo })) },
    created_at: new Date(interaction.createdAt).toISOString(),
    expires_at: new Date(interaction.createdAt + APPROVAL_EXPIRY_MS).toISOString(),
  };
}
