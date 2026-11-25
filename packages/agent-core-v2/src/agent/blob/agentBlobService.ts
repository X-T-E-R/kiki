import type { ContentPart } from '#/kosong/contract/message';
import type { HostPinnedRefRecord } from '#/agent/media/hostPinnedMedia';

import { createDecorator } from '#/_base/di/instantiation';

export const BLOBREF_PROTOCOL = 'blobref:';
export const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export class CheckpointBlobMissingError extends Error {
  constructor(readonly ref: string) {
    super(`Replay checkpoint blob '${ref}' is missing`);
    this.name = 'CheckpointBlobMissingError';
  }
}

export interface AgentBlobOffloadOptions {
  readonly signal?: AbortSignal;
}

export interface AgentHostPinnedInput {
  readonly path: string;
  readonly mimeType: string;
  readonly allowedRoots: readonly string[];
  readonly signal?: AbortSignal;
}

export interface IAgentBlobService {
  readonly _serviceBrand: undefined;

  offloadParts(parts: readonly ContentPart[], options?: AgentBlobOffloadOptions): Promise<readonly ContentPart[]>;
  offloadBytes?(mimeType: string, data: Uint8Array, options?: AgentBlobOffloadOptions): Promise<string>;
  offloadStream?(mimeType: string, source: AsyncIterable<Uint8Array>, options?: AgentBlobOffloadOptions): Promise<string>;
  offloadFile?(mimeType: string, sourcePath: string, options?: AgentBlobOffloadOptions): Promise<string>;
  registerHostPinnedRef?(input: AgentHostPinnedInput): Promise<HostPinnedRefRecord>;
  loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  loadPartsStrict?(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
  isBlobRef(url: string): boolean;
}

export const IAgentBlobService = createDecorator<IAgentBlobService>(
  'agentBlobService',
);
