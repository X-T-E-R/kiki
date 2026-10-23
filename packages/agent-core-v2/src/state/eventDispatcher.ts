import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event2 } from '#/app/event/event2';
import type { Hooks } from '#/hooks';

import type { PatchEntry, ReplayableStateKey } from './state';

export type EventDispatcherHooks = {
  readonly onDidRestore: Record<string, never>;
};

export interface IEventDispatcher {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<EventDispatcherHooks>;

  dispatch(event: Event2<any>): Promise<void>;
  dispatchDurably(event: Event2<any>): Promise<void>;
  history<S>(key: ReplayableStateKey<S>): readonly PatchEntry[];
  checkpointDepth(key: ReplayableStateKey<any>): number;
  undo<S>(key: ReplayableStateKey<S>, patchId: number): void;
  restore(): Promise<void>;
  /** Save an optional derived checkpoint. False means skipped; persistence/encoding failures reject with their phase and cause. */
  saveReplayCheckpoint?(): Promise<boolean>;
  /** Reason for the last skipped save, cleared when a new save starts. */
  replayCheckpointSkipReason?(): string | undefined;
  flush(): Promise<void>;
}

export const IEventDispatcher: ServiceIdentifier<IEventDispatcher> =
  createDecorator<IEventDispatcher>('eventDispatcher');
