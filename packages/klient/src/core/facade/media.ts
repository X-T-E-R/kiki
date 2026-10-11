import type { MediaSource, MediaCatalog, MediaProviderDefinition, MediaCapabilityQuery, MediaCapabilities, MediaVoiceQuery, MediaVoicePage, MediaJob } from '@kiki/protocol';
import type { Caller } from './global.js';

export interface GlobalMediaFacade {
  managedSources(): Promise<import('@kiki/protocol').MediaManagedSource[]>;
  sourceSettings(input: { provider: string }): Promise<import('@kiki/protocol').MediaManagedSource>;
  updateSource(input: import('@kiki/protocol').MediaSourceUpdate): Promise<import('@kiki/protocol').MediaManagedSource>;
  addScriptSource(input: import('@kiki/protocol').MediaScriptSourceInput): Promise<import('@kiki/protocol').MediaManagedSource>;
  sources(): Promise<MediaSource[]>;
  setSources(input: { sources: MediaSource[] }): Promise<MediaSource[]>;
  catalog(input: { id: string }): Promise<MediaCatalog>;
  providers(): Promise<{ provider: string; definition: MediaProviderDefinition }[]>;
  capabilities(query: MediaCapabilityQuery): Promise<MediaCapabilities | { providers: { provider: string; definition: MediaProviderDefinition }[] }>;
  voices(query: MediaVoiceQuery): Promise<MediaVoicePage>;
  jobs(input?: { session_id?: string; limit?: number; offset?: number }): Promise<MediaJob[]>;
  job(id: string): Promise<MediaJob>;
}
export interface AgentMediaFacade {
  cancel(id: string): Promise<MediaJob>;
  resume(id: string): Promise<MediaJob>;
}
export function createGlobalMedia(call: Caller): GlobalMediaFacade {
  return {
    managedSources: () => call('pluginMediaService', 'managedSources', []) as ReturnType<GlobalMediaFacade['managedSources']>,
    sourceSettings: (input) => call('pluginMediaService', 'sourceSettings', [input]) as ReturnType<GlobalMediaFacade['sourceSettings']>,
    updateSource: (input) => call('pluginMediaService', 'updateSource', [input]) as ReturnType<GlobalMediaFacade['updateSource']>,
    addScriptSource: (input) => call('pluginMediaService', 'addScriptSource', [input]) as ReturnType<GlobalMediaFacade['addScriptSource']>,
    sources: () => call('pluginMediaService', 'sources', []) as Promise<MediaSource[]>,
    setSources: (input) => call('pluginMediaService', 'setSources', [input]) as Promise<MediaSource[]>,
    catalog: (input) => call('pluginMediaService', 'catalog', [input]) as Promise<MediaCatalog>,
    providers: () => call('pluginMediaService', 'providers', []) as ReturnType<GlobalMediaFacade['providers']>,
    capabilities: (input) => call('pluginMediaService', 'capabilities', [input]) as ReturnType<GlobalMediaFacade['capabilities']>,
    voices: (input) => call('pluginMediaService', 'voices', [input]) as Promise<MediaVoicePage>,
    jobs: (input) => call('pluginMediaService', 'jobs', [input]) as Promise<MediaJob[]>,
    job: (id) => call('pluginMediaService', 'job', [id]) as Promise<MediaJob>,
  };
}
export function createAgentMedia(call: Caller): AgentMediaFacade {
  return {
    cancel: (id) => call('agentPluginMediaService', 'cancel', [id]) as Promise<MediaJob>,
    resume: (id) => call('agentPluginMediaService', 'resume', [id]) as Promise<MediaJob>,
  };
}
