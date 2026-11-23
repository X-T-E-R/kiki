import type { SyncFacade } from '../../core/facade/sync.js';
import type { HttpRestTransport } from './rest.js';

const SYNC_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
const SYNC_FILES_WIRE_MAX_BYTES = 96 * 1024 * 1024;

export function createSyncFacade(transport: HttpRestTransport): SyncFacade {
  const id = encodeURIComponent;
  return {
    getDevicePublicKey: () => transport.json('/sync/device-key'),
    sealCredentials: (input) => transport.json('/sync/credentials/seal', { method: 'POST', body: input }),
    mergeCredentials: (input) => transport.json('/sync/credentials/merge', { method: 'POST', body: input }),
    resolveProjectIdentity: (input) => transport.json('/sync/project-identity/resolve', { method: 'POST', body: input }),
    exportPortableConfig: () => transport.json('/sync/config/portable'),
    planSkillsSync: (workDir) => transport.json('/sync/skills/plan', { query: workDir === undefined ? undefined : { work_dir: workDir } }),
    exportBundle: (input) => transport.json('/sync/bundle/export', { method: 'POST', body: input ?? {}, maxResponseBytes: SYNC_BUNDLE_MAX_BYTES }),
    importBundle: (bundle) => transport.json('/sync/bundle/import', { method: 'POST', body: bundle, maxBodyBytes: SYNC_BUNDLE_MAX_BYTES }),
    pushToPeer: (peerId, input, options) => transport.json(`/sync/peers/${id(peerId)}/push`, { timeoutMs: 0, ...options, method: 'POST', body: input ?? {} }),
    pullFromPeer: (peerId, input, options) => transport.json(`/sync/peers/${id(peerId)}/pull`, { timeoutMs: 0, ...options, method: 'POST', body: input ?? {} }),
    exportFiles: (input, options) => transport.json('/sync/files:export', { timeoutMs: 0, ...options, method: 'POST', body: input, maxResponseBytes: SYNC_FILES_WIRE_MAX_BYTES }),
    importFiles: (input, options) => transport.json('/sync/files:import', { timeoutMs: 0, ...options, method: 'POST', body: input, maxBodyBytes: SYNC_FILES_WIRE_MAX_BYTES }),
    pullFilesFromPeer: (peerId, input, options) => transport.json(`/sync/peers/${id(peerId)}/files:pull`, { timeoutMs: 0, ...options, method: 'POST', body: input }),
    pushFilesToPeer: (peerId, input, options) => transport.json(`/sync/peers/${id(peerId)}/files:push`, { timeoutMs: 0, ...options, method: 'POST', body: input }),
  };
}
