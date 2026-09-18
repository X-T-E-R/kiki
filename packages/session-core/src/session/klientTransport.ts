import { editMessageRequestSchema, regenerateMessageRequestSchema, forkSessionRequestSchema } from '@kiki/protocol';
import { RPCError, type SessionCommandsFacade } from '@kiki/klient/session-view';
import { ApiError, type SessionTransport } from '../transport';

export interface SessionCommandClient {
  session(sessionId: string): { readonly commands: SessionCommandsFacade };
}

export function createSessionTransport(klient: SessionCommandClient): SessionTransport {
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RPCError) {
        throw new ApiError({ code: error.code, msg: error.message, data: error.data, request_id: error.requestId });
      }
      throw error;
    }
  };
  const commands = (id: string) => klient.session(id).commands;
  return {
    getSession: (id) => run(() => commands(id).read()),
    submitPrompt: (id, body) => run(() => commands(id).submit(body)),
    editMessage: (id, target, body) => run(() => commands(id).edit(target, editMessageRequestSchema.parse(body))),
    regenerateMessage: (id, target, body) => run(() => commands(id).regenerate(target, regenerateMessageRequestSchema.parse(body))),
    forkSession: (id, body) => run(() => commands(id).fork(forkSessionRequestSchema.parse(body))),
    abortPrompt: (id, target) => run(() => commands(id).abort(target)),
    movePrompt: (id, target, body) => run(() => commands(id).move(target, body)),
    replacePrompt: (id, target, body) => run(() => commands(id).replace(target, body)),
    steerPrompt: (id, target) => run(() => commands(id).steer(target)),
    resolveApproval: (id, target, body) => run(() => commands(id).approve(target, body)),
    resolveQuestion: (id, target, body) => run(() => commands(id).answer(target, body)),
    dismissQuestion: (id, target) => run(() => commands(id).dismiss(target)),
    cancelTask: (id, target, query) => run(() => commands(id).cancelTask(target, query)),
  };
}
