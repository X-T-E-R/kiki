/**
 * `sessionApprovalService` — session-scope approval broker. Mirrors
 * `agent-core-v2/session/approval/approval.ts`. `ApprovalRequest.display` is
 * the protocol `ToolInputDisplay` union (huge); it crosses the wire
 * uninspected, so it is `z.unknown()` here.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const approvalRequestSchema = /* @__PURE__ */ z.object({
  id: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  turnId: z.number().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string(),
  action: z.string(),
  /** Protocol `ToolInputDisplay` — mirrored as `unknown` (see file header). */
  display: z.unknown(),
  approvalRule: z.string().optional(),
});

export const approvalResponseSchema = /* @__PURE__ */ z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  scope: z.literal('session').optional(),
  feedback: z.string().optional(),
  selectedLabel: z.string().optional(),
  selectedOptionId: z.string().optional(),
});

export const sessionApprovalContract = {
  listPending: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.array(approvalRequestSchema) }), 'input', 'output'),
  decide: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string(), approvalResponseSchema]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;
