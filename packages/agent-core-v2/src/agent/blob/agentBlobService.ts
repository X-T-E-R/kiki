import type { ContentPart } from '#/kosong/contract/message';

import { createDecorator } from '#/_base/di/instantiation';

export const BLOBREF_PROTOCOL = 'blobref:';
export const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export class CheckpointBlobMissingError extends Error {
  constructor(readonly ref: string) {
    super(`Replay checkpoint blob '${ref}' is missing`);
    this.name = 'CheckpointBlobMissingError';
  }
}

export interface IAgentBlobService {
  readonly _serviceBrand: undefined;

  offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  loadPartsStrict?(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  isBlobRef(url: string): boolean;
}

export const IAgentBlobService = createDecorator<IAgentBlobService>(
  'agentBlobService',
);
