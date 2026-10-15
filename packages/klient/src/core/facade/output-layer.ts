import type { OutputLayerConfiguration, OutputLayerEvent, OutputLayerRequest } from '@kiki/protocol';
import type { HttpRestRequestOptions } from './http-rest.js';

export interface OutputLayerFacade {
  configuration(options?: HttpRestRequestOptions & { sessionId?: string }): Promise<OutputLayerConfiguration>;
  configure(input: Pick<OutputLayerConfiguration, 'presets' | 'settings'>, options?: HttpRestRequestOptions): Promise<OutputLayerConfiguration>;
  stream(input: OutputLayerRequest, onEvent: (event: OutputLayerEvent) => void, options?: HttpRestRequestOptions): Promise<void>;
}
