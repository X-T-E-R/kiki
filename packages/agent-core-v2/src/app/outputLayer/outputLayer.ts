import { createDecorator } from '#/_base/di/instantiation';
import type { OutputLayerConfiguration, OutputLayerEvent, OutputLayerRequest } from '@kiki/protocol';

export interface IOutputLayerService {
  readonly _serviceBrand: undefined;
  configuration(sessionId?: string): Promise<OutputLayerConfiguration>;
  configure(input: Pick<OutputLayerConfiguration, 'presets' | 'settings'>): Promise<OutputLayerConfiguration>;
  stream(input: OutputLayerRequest, signal: AbortSignal): AsyncIterable<OutputLayerEvent>;
}

export const IOutputLayerService = createDecorator<IOutputLayerService>('outputLayerService');
