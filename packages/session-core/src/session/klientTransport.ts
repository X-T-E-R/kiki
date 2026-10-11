import { editMessageRequestSchema, regenerateMessageRequestSchema, forkSessionRequestSchema } from '@kiki/protocol';
import { RPCError, type SessionCommandsFacade } from '@kiki/klient/session-view';
import { ApiError, type SessionTransport } from '../transport';

export interface SessionCommandClient {
  session(sessionId: string): { readonly commands: SessionCommandsFacade; resume(): Promise<boolean> };
}

export function createSessionTransport(klient: SessionCommandClient): SessionTransport {
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RPCError) {
        throw new ApiError({ code: error.code, msg: error.message, data: error.data, details: error.details, request_id: error.requestId });
      }
      throw error;
    }
  };
  const commands = (id: string) => klient.session(id).commands;
  const active = <T>(id: string, operation: () => Promise<T>): Promise<T> => run(async () => {
    if (!await klient.session(id).resume()) throw new RPCError(40401, `session ${id} does not exist`);
    return operation();
  });
  return {
    getSession: (id) => run(() => commands(id).read()),
    submitPrompt: (id, body) => active(id, () => commands(id).submit(body)),
    editMessage: (id, target, body) => active(id, () => commands(id).edit(target, editMessageRequestSchema.parse(body))),
    regenerateMessage: (id, target, body) => active(id, () => commands(id).regenerate(target, regenerateMessageRequestSchema.parse(body))),
    forkSession: (id, body) => run(() => commands(id).fork(forkSessionRequestSchema.parse(body))),
    abortPrompt: (id, target, agentId) => run(() => commands(id).abort(target, agentId)),
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
