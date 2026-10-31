import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import type { TurnSeed } from '#/agent/loop/stepRequest';

export interface ExecutionResumePoint {
  readonly turnId: number;
  readonly completedSteps: number;
  readonly seed: TurnSeed;
  readonly binding: ProfileBindingSnapshot;
}

export interface ExecutionPauseAgent {
  readonly agentId: string;
  readonly state: 'settling' | 'paused' | 'idle' | 'unknown';
  readonly turnId?: number;
  readonly resumable: boolean;
  readonly detail?: string;
}

export interface ExecutionControlState {
  readonly phase: 'running' | 'pausing' | 'paused' | 'resuming' | 'failed';
  readonly pauseOperationId?: string;
  readonly resumeOperationId?: string;
  readonly requestedAt?: string;
  readonly pausedAt?: string;
  readonly resumedAt?: string;
  readonly agents: readonly ExecutionPauseAgent[];
  readonly error?: string;
}

export interface ExecutionPauseParticipant {
  pause(): Promise<ExecutionResumePoint | undefined>;
  resume(point?: ExecutionResumePoint): Promise<void>;
}

export interface ISessionExecutionControl {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<ExecutionControlState>;
  read(): Promise<ExecutionControlState>;
  pause(input: { readonly operationId: string }): Promise<ExecutionControlState>;
  resume(input: { readonly operationId: string; readonly pauseOperationId: string }): Promise<ExecutionControlState>;
  register(agentId: string, participant: ExecutionPauseParticipant): IDisposable;
  ready(): Promise<void>;
  isHeld(): boolean;
}

export const ISessionExecutionControl = createDecorator<ISessionExecutionControl>('sessionExecutionControl');
