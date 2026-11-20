import type { SyncFacade } from '../../core/facade/sync.js';
import type { HttpRestTransport } from './rest.js';

export function createSyncFacade(transport: HttpRestTransport): SyncFacade {
  const id = encodeURIComponent;
  return {
    getDevicePublicKey: () => transport.json('/sync/device-key'),
    sealCredentials: (input) => transport.json('/sync/credentials/seal', { method: 'POST', body: input }),
    mergeCredentials: (input) => transport.json('/sync/credentials/merge', { method: 'POST', body: input }),
    resolveProjectIdentity: (input) => transport.json('/sync/project-identity/resolve', { method: 'POST', body: input }),
    exportPortableConfig: () => transport.json('/sync/config/portable'),
    planSkillsSync: (workDir) => transport.json('/sync/skills/plan', { query: workDir === undefined ? undefined : { work_dir: workDir } }),
    exportBundle: (input) => transport.json('/sync/bundle/export', { method: 'POST', body: input ?? {} }),
    importBundle: (bundle) => transport.json('/sync/bundle/import', { method: 'POST', body: bundle }),
    pushToPeer: (peerId, input, options) => transport.json(`/sync/peers/${id(peerId)}/push`, { ...options, method: 'POST', body: input ?? {} }),
    pullFromPeer: (peerId, input, options) => transport.json(`/sync/peers/${id(peerId)}/pull`, { ...options, method: 'POST', body: input ?? {} }),
  };
}
