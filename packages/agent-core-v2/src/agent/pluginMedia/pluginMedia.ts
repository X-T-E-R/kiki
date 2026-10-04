import { createDecorator } from '#/_base/di/instantiation';
import type { PluginMediaApi, MediaJob, MediaRequest, MediaInputRef } from '@kiki/protocol';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

export interface IAgentPluginMediaService {
  readonly _serviceBrand: undefined;
  api(requestId: string, admittedRequest?: MediaRequest): PluginMediaApi;
  resolveInput(ref: MediaInputRef): Promise<MediaInputRef>;
  snapshotInput(ref: MediaInputRef, key: string, fs: IHostFileSystem, signal: AbortSignal): Promise<MediaInputRef>;
  cancel(jobId: string): Promise<MediaJob>;
  resume(jobId: string): Promise<MediaJob>;
}
export const IAgentPluginMediaService = createDecorator<IAgentPluginMediaService>('agentPluginMediaService');

export function mediaInputRefs(request: MediaRequest): MediaInputRef[] {
  if (request.kind === 'image') return [...request.images ?? [], ...request.mask === undefined ? [] : [request.mask]];
  if (request.kind === 'video') return request.inputs?.map((item) => item.ref) ?? [];
  return [];
}
