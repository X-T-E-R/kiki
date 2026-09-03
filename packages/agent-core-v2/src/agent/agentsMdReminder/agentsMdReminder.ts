import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentAgentsMdReminderService {
  readonly _serviceBrand: undefined;

  seedInjected(paths: readonly string[], cwd: string): void;
  flushStepHead(): Promise<void>;
}

export const IAgentAgentsMdReminderService: ServiceIdentifier<IAgentAgentsMdReminderService> =
  createDecorator<IAgentAgentsMdReminderService>('agentAgentsMdReminderService');
