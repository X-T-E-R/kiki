import { createDecorator } from '#/_base/di/instantiation';
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmCompleteStreamEvent,
  OutputLayerConfiguration,
  OutputLayerEvent,
  OutputLayerRequest,
} from '@kiki/protocol';

import type { ContextMessage } from '#/agent/contextMemory/types';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface LlmCompleteUsageCallback {
  (record: { readonly model: string; readonly usage: TokenUsage }): void;
}

export interface LlmCompleteRunOptions {
  readonly onUsage?: LlmCompleteUsageCallback;
  readonly preloadedContextMessages?: readonly ContextMessage[];
}

export interface IOutputLayerService {
  readonly _serviceBrand: undefined;
  configuration(sessionId?: string): Promise<OutputLayerConfiguration>;
  configure(input: Pick<OutputLayerConfiguration, 'presets' | 'settings'>): Promise<OutputLayerConfiguration>;
  /** Emits one started event; transient zero-output failures share the configured retry budget without rebuilding history or the cycle. Observed model output prevents replay, and cancellation interrupts backoff. */
  stream(input: OutputLayerRequest, signal: AbortSignal): AsyncIterable<OutputLayerEvent>;
  /** Sessionless governed LLM completion stream with optional read-only context projection and retained usage accounting. */
  completeStream(input: LlmCompleteRequest, signal: AbortSignal, options?: LlmCompleteUsageCallback | LlmCompleteRunOptions): AsyncIterable<LlmCompleteStreamEvent>;
  /** Sessionless governed LLM single-shot completion. */
  complete(input: LlmCompleteRequest, signal: AbortSignal, options?: LlmCompleteUsageCallback | LlmCompleteRunOptions): Promise<LlmCompleteResponse>;
}

export const IOutputLayerService = createDecorator<IOutputLayerService>('outputLayerService');
