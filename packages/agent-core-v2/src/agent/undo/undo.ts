import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SessionHistoryMutationLease } from '#/session/historyMutation/historyMutation';

export interface UndoAvailability {
  readonly maxTurns: number;
  readonly stoppedAtCompaction: boolean;
}

export interface IAgentConversationUndoService {
  readonly _serviceBrand: undefined;

  availability(): UndoAvailability;
  undo(turns: number, historyMutationLease?: SessionHistoryMutationLease): Promise<number>;
}

export const IAgentConversationUndoService: ServiceIdentifier<IAgentConversationUndoService> =
  createDecorator<IAgentConversationUndoService>('agentConversationUndoService');
