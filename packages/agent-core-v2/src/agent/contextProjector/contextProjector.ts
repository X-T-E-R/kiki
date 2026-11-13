import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export interface ProjectionPolicy {
  readonly structure?: 'strict';
  readonly media?: 'degraded' | { readonly strip: MediaStripSnapshot };
  readonly audio?: 'omit_unsupported';
  readonly toolResultAppendix?: 'host_auto_injections' | 'trailing_user_text';
  readonly toolResultAppendixHistory?: {
    readonly canonical: readonly ContextMessage[];
    readonly sourceIndexes: readonly number[];
  };
  readonly onToolResultAppendix?: (stats: {
    readonly projectedBatches: number;
    readonly projectedMessages: number;
  }) => void;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
  ): readonly Message[];
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
