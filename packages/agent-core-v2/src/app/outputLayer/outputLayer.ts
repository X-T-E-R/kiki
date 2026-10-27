import { createDecorator } from '#/_base/di/instantiation';
import type { OutputLayerConfiguration, OutputLayerEvent, OutputLayerRequest } from '@kiki/protocol';

export interface IOutputLayerService {
  readonly _serviceBrand: undefined;
  configuration(sessionId?: string): Promise<OutputLayerConfiguration>;
  configure(input: Pick<OutputLayerConfiguration, 'presets' | 'settings'>): Promise<OutputLayerConfiguration>;
  /** Emits one started event; transient zero-output failures share the configured retry budget without rebuilding history or the cycle. Observed model output prevents replay, and cancellation interrupts backoff. */
  stream(input: OutputLayerRequest, signal: AbortSignal): AsyncIterable<OutputLayerEvent>;
}

export const IOutputLayerService = createDecorator<IOutputLayerService>('outputLayerService');
