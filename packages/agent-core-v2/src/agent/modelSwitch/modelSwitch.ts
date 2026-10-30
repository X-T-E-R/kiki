import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { PreparedModelSwitchBinding } from '#/agent/profile/profile';
import type { Hooks } from '#/hooks';

export type ModelSwitchMode = 'direct' | 'compact' | 'fresh';

/** With `intent: 'setting'`, direct changes coalesce until a queued message requires ordering and apply at the next native request boundary, or immediately while idle. Omit `intent` for an explicitly ordered switch. */
export interface ModelSwitchInput {
  readonly operationId: string;
  readonly model: string;
  readonly mode: ModelSwitchMode;
  readonly thinking?: string | null;
  readonly selectedFromModel?: string;
  readonly intent?: 'setting';
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
  /**
   * Runs after a fresh or compacted context window is durable and before the switch
   * releases the loop. A direct switch keeps the current context and does not run this.
   * Replaying an old switch during session restore does not run this.
   */
  readonly hooks: Hooks<{
    onDidCommitContextWindow: ModelSwitchReceipt;
  }>;
  execute(input: ModelSwitchInput, options?: ModelSwitchExecuteOptions): Promise<ModelSwitchReceipt>;
  get(operationId: string): ModelSwitchReceipt | undefined;
}

export const IAgentModelSwitchService = createDecorator<IAgentModelSwitchService>('agentModelSwitchService');
