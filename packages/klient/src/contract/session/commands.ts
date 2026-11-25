import { z } from 'zod';
import { sessionCommandRoutes, type SessionCommandChannel, type SessionCommandName } from './commandRoutes.js';
import {
  approvalResolveRequestSchema, approvalResolveResultSchema,
  cancelTaskQuerySchema, cancelTaskResultSchema, taskAlreadyFinishedDataSchema,
  createSessionBranchRequestSchema, createSessionBranchResponseSchema,
  discardSessionBranchRequestSchema, discardSessionBranchResponseSchema,
  editMessageRequestSchema, regenerateMessageRequestSchema, messageActionResponseSchema,
  foldSessionBranchRequestSchema, foldSessionBranchResponseSchema,
  forkSessionRequestSchema, promoteAgentRequestSchema, sessionSchema,
  promptSubmissionSchema, promptSubmitResultSchema, promptAbortResponseSchema, turnAbortResponseSchema,
  promptMoveRequestSchema, promptMoveResultSchema, promptReplaceRequestSchema,
  promptReplaceResultSchema, promptSteerResultSchema,
  promptTimingRequestSchema, promptTimingResultSchema,
  promptHoldRequestSchema, promptHoldResultSchema,
  questionResolveRequestSchema, questionResolveResultSchema, questionDismissResultSchema,
  setSessionBranchToolsLockRequestSchema, setSessionBranchToolsLockResponseSchema,
  startBtwSessionResponseSchema,
} from '@kiki/protocol';

const target = /* @__PURE__ */ z.string().min(1);
const bodyInput = <T extends z.ZodType>(body: T) => z.object({ body });
const targetInput = /* @__PURE__ */ z.object({ target });
const targetBodyInput = <T extends z.ZodType>(body: T) => z.object({ target, body });
// Prompt actions that address a child agent's own queue carry its id as a query.
const agentTargetInput = /* @__PURE__ */ z.object({ target, query: z.object({ agent_id: z.string().min(1).optional() }).optional() });

export const sessionCommandContract = {
  read: { ...sessionCommandRoutes.read, input: z.object({}), output: sessionSchema },
  submit: { ...sessionCommandRoutes.submit, input: bodyInput(promptSubmissionSchema), output: promptSubmitResultSchema },
  edit: { ...sessionCommandRoutes.edit, input: targetBodyInput(editMessageRequestSchema), output: messageActionResponseSchema },
  regenerate: { ...sessionCommandRoutes.regenerate, input: targetBodyInput(regenerateMessageRequestSchema), output: messageActionResponseSchema },
  fork: { ...sessionCommandRoutes.fork, input: bodyInput(forkSessionRequestSchema), output: sessionSchema },
  btw: { ...sessionCommandRoutes.btw, input: z.object({}), output: startBtwSessionResponseSchema },
  branch: { ...sessionCommandRoutes.branch, input: bodyInput(createSessionBranchRequestSchema), output: createSessionBranchResponseSchema },
  foldBranch: { ...sessionCommandRoutes.foldBranch, input: bodyInput(foldSessionBranchRequestSchema), output: foldSessionBranchResponseSchema },
  discardBranch: { ...sessionCommandRoutes.discardBranch, input: bodyInput(discardSessionBranchRequestSchema), output: discardSessionBranchResponseSchema },
  setBranchToolsLock: { ...sessionCommandRoutes.setBranchToolsLock, input: bodyInput(setSessionBranchToolsLockRequestSchema), output: setSessionBranchToolsLockResponseSchema },
  promoteAgent: { ...sessionCommandRoutes.promoteAgent, input: targetBodyInput(promoteAgentRequestSchema), output: sessionSchema },
  abort: { ...sessionCommandRoutes.abort, input: z.object({ target, query: z.object({ agent_id: z.string().min(1).optional(), queued_only: z.literal('true').optional() }).optional() }), output: promptAbortResponseSchema },
  abortTurn: { ...sessionCommandRoutes.abortTurn, input: targetInput, output: turnAbortResponseSchema },
  move: { ...sessionCommandRoutes.move, input: targetBodyInput(promptMoveRequestSchema), output: promptMoveResultSchema },
  replace: { ...sessionCommandRoutes.replace, input: targetBodyInput(promptReplaceRequestSchema), output: promptReplaceResultSchema },
  timing: { ...sessionCommandRoutes.timing, input: targetBodyInput(promptTimingRequestSchema), output: promptTimingResultSchema },
  hold: { ...sessionCommandRoutes.hold, input: targetBodyInput(promptHoldRequestSchema), output: promptHoldResultSchema },
  steer: { ...sessionCommandRoutes.steer, input: agentTargetInput, output: promptSteerResultSchema },
  approve: { ...sessionCommandRoutes.approve, input: targetBodyInput(approvalResolveRequestSchema), output: approvalResolveResultSchema },
  answer: { ...sessionCommandRoutes.answer, input: targetBodyInput(questionResolveRequestSchema), output: questionResolveResultSchema },
  dismiss: { ...sessionCommandRoutes.dismiss, input: targetInput, output: questionDismissResultSchema },
  cancelTask: { ...sessionCommandRoutes.cancelTask, input: z.object({ target, query: cancelTaskQuerySchema.optional() }), output: z.union([cancelTaskResultSchema, taskAlreadyFinishedDataSchema]) },
} as const;

export type { SessionCommandChannel, SessionCommandName };
