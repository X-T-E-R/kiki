import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { PreparedModelSwitchBinding } from '#/agent/profile/profile';

export type ModelSwitchMode = 'direct' | 'compact' | 'fresh';

export interface ModelSwitchInput {
  readonly operationId: string;
  readonly model: string;
  readonly mode: ModelSwitchMode;
  readonly thinking?: string;
  readonly selectedFromModel?: string;
}

export interface ModelSwitchReceipt {
  readonly operationId: string;
  readonly agentId: string;
  readonly state: 'pending' | 'preparing' | 'completed' | 'failed' | 'cancelled';
  readonly fromModel: string;
  readonly toModel: string;
  readonly mode: ModelSwitchMode;
  readonly binding?: { readonly model: string; readonly thinking: string };
  readonly windowEpoch?: number;
  readonly summaryGenerated?: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ModelSwitchExecuteOptions {
  readonly binding?: PreparedModelSwitchBinding;
  /** Acquires a shared caller reservation, retained during uncertain commit recovery. */
  readonly quiescence?: () => import('#/_base/di/lifecycle').IDisposable;
  readonly signal?: AbortSignal;
  readonly boundary?: import('#/agent/loop/loop').StepBoundary;
}

export interface IAgentModelSwitchService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<ModelSwitchReceipt>;
  execute(input: ModelSwitchInput, options?: ModelSwitchExecuteOptions): Promise<ModelSwitchReceipt>;
  get(operationId: string): ModelSwitchReceipt | undefined;
}

export const IAgentModelSwitchService = createDecorator<IAgentModelSwitchService>('agentModelSwitchService');
