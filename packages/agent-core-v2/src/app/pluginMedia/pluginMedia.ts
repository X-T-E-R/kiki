import { createDecorator } from '#/_base/di/instantiation';
import type { MediaJob, MediaGenerateInput, MediaHandle, MediaOutcome, MediaCapabilityQuery, MediaCapabilities, MediaVoiceQuery, MediaVoicePage, MediaSource, MediaCatalog } from '@kiki/protocol';
import type { PluginMediaProviderRegistration } from '#/app/plugin/pluginHostService';

export interface MediaJobOwner {
  readonly sessionId: string;
  readonly agentId: string;
  readonly mediaScope: string;
  readonly identity?: Omit<import('#/session/requestIdentity/requestIdentityRegistry').RequestIdentitySnapshot, 'setTurnState'>;
  readonly parentAgentId?: string;
}
export interface StoredMediaJob {
  readonly view: MediaJob;
  readonly owner: MediaJobOwner;
  readonly input: MediaGenerateInput;
  readonly fingerprint: string;
  readonly provider: PluginMediaProviderRegistration;
  readonly handle?: MediaHandle;
  readonly outcome?: MediaOutcome;
}
export interface IPluginMediaService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  providers(): Promise<{ provider: string; definition: PluginMediaProviderRegistration['definition'] }[]>;
  capabilities(query: MediaCapabilityQuery): Promise<MediaCapabilities | { providers: { provider: string; definition: PluginMediaProviderRegistration['definition'] }[] }>;
  voices(query: MediaVoiceQuery): Promise<MediaVoicePage>;
  managedSources(): Promise<import('@kiki/protocol').MediaManagedSource[]>;
  sourceSettings(input: { provider: string }): Promise<import('@kiki/protocol').MediaManagedSource>;
  updateSource(input: import('@kiki/protocol').MediaSourceUpdate): Promise<import('@kiki/protocol').MediaManagedSource>;
  addScriptSource(input: import('@kiki/protocol').MediaScriptSourceInput): Promise<import('@kiki/protocol').MediaManagedSource>;
  sources(): Promise<MediaSource[]>;
  setSources(input: { sources: MediaSource[] }): Promise<MediaSource[]>;
  catalog(input: { id: string }): Promise<MediaCatalog>;
  jobs(input?: { session_id?: string; limit?: number; offset?: number }): Promise<MediaJob[]>;
  job(id: string): Promise<MediaJob>;
  stored(id: string): Promise<StoredMediaJob>;
  start(input: MediaGenerateInput, owner: MediaJobOwner): Promise<MediaJob>;
  run(id: string, onProgress?: NonNullable<import('#/app/plugin/pluginHostService').PluginMediaCallContext['onProgress']>): Promise<MediaJob>;
  resume(id: string): Promise<MediaJob>;
  cancel(id: string): Promise<MediaJob>;
  stopLocal(id: string): Promise<MediaJob>;
  bindTask(id: string, taskId: string): Promise<MediaJob>;
  stageInput(key: string, name: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string>;
}
export const IPluginMediaService = createDecorator<IPluginMediaService>('pluginMediaService');
