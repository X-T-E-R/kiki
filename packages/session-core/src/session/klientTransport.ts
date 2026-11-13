import {
  createSessionBranchRequestSchema,
  discardSessionBranchRequestSchema,
  editMessageRequestSchema,
  foldSessionBranchRequestSchema,
  forkSessionRequestSchema,
  promoteAgentRequestSchema,
  regenerateMessageRequestSchema,
  setSessionBranchToolsLockRequestSchema,
} from '@kiki/protocol';
import { RPCError, type SessionCommandsFacade } from '@kiki/klient/session-view';
import { ApiError, type SessionTransport } from '../transport';

export interface SessionCommandClient {
  captureOperation?(): () => void;
  session(sessionId: string): { readonly commands: SessionCommandsFacade; resume(): Promise<boolean> };
}

export function createSessionTransport(klient: SessionCommandClient): SessionTransport {
  const run = async <T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> => {
    try {
      const assertCurrent = klient.captureOperation?.() ?? (() => {});
      assertCurrent();
      const result = await operation(assertCurrent);
      assertCurrent();
      return result;
    } catch (error) {
      if (error instanceof RPCError) {
        throw new ApiError({
          code: error.code,
          msg: error.message,
          data: error.data,
          details: error.details,
          request_id: error.requestId,
          source: error.source,
          reason: error.reason,
        });
      }
      throw error;
    }
  };
  const commands = (id: string) => klient.session(id).commands;
  const active = <T>(id: string, operation: () => Promise<T>): Promise<T> => run(async (assertCurrent) => {
    const resumed = await klient.session(id).resume();
    assertCurrent();
    if (!resumed) throw new RPCError(40401, `session ${id} does not exist`);
    return operation();
  });
  return {
    getSession: (id) => run(() => commands(id).read()),
    // Prompt submission is the durable enqueue boundary. It must not wait for
    // the view/history resume gate: a slow snapshot or a reconnecting ordered
    // view must not turn a typed message into a permanently disabled send.
    submitPrompt: (id, body) => run(() => commands(id).submit(body)),

    editMessage: (id, target, body) => active(id, () => commands(id).edit(target, editMessageRequestSchema.parse(body))),
    regenerateMessage: (id, target, body) => active(id, () => commands(id).regenerate(target, regenerateMessageRequestSchema.parse(body))),
    forkSession: (id, body) => run(() => commands(id).fork(forkSessionRequestSchema.parse(body))),
    createBranch: (id, body) => run(() => commands(id).branch(createSessionBranchRequestSchema.parse(body))),
    foldBranch: (id, body) => run(() => commands(id).foldBranch(foldSessionBranchRequestSchema.parse(body))),
    discardBranch: (id, body) => run(() => commands(id).discardBranch(discardSessionBranchRequestSchema.parse(body))),
    setBranchToolsLock: (id, body) => run(() => commands(id).setBranchToolsLock(setSessionBranchToolsLockRequestSchema.parse(body))),
    promoteAgent: (id, agentId, body = {}) => run(() => commands(id).promoteAgent(agentId, promoteAgentRequestSchema.parse(body))),
    abortPrompt: (id, target, agentId, queuedOnly) => run(() => commands(id).abort(target, agentId, queuedOnly)),
    abortTurn: (id, target) => run(() => commands(id).abortTurn(target)),
    movePrompt: (id, target, body) => run(() => commands(id).move(target, body)),
    replacePrompt: (id, target, body) => run(() => commands(id).replace(target, body)),
    timingPrompt: (id, target, body) => run(() => commands(id).timing(target, body)),
    holdPrompt: (id, target, body) => run(() => commands(id).hold(target, body)),
    steerPrompt: (id, target, agentId) => active(id, () => commands(id).steer(target, agentId)),
    resolveApproval: (id, target, body) => active(id, () => commands(id).approve(target, body)),
    resolveQuestion: (id, target, body) => active(id, () => commands(id).answer(target, body)),
    dismissQuestion: (id, target) => active(id, () => commands(id).dismiss(target)),
    cancelTask: (id, target, query) => active(id, () => commands(id).cancelTask(target, query)),
  };
}
