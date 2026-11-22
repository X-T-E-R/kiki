import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';
import type { ModelRequester } from '#/kosong/model/modelRequester';

export interface IAgentMediaResolverService {
  readonly _serviceBrand: undefined;

  resolve(
    messages: readonly Message[],
    requester: ModelRequester,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<readonly Message[]>;

  markMediaPoisoned?(urlsOrKeys: Iterable<string>): void;
}

export const IAgentMediaResolverService = createDecorator<IAgentMediaResolverService>(
  'agentVideoResolverService',
);
