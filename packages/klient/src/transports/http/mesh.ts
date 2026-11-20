import type { MeshFacade } from '../../core/facade/mesh.js';
import type { HttpRestTransport } from './rest.js';

export function createMeshFacade(transport: HttpRestTransport): MeshFacade {
  const id = encodeURIComponent;
  return {
    getSessionLease: (sessionId) => transport.json(`/mesh/sessions/${id(sessionId)}/leases`),
    pinResource: (sessionId, input) => transport.json(`/mesh/sessions/${id(sessionId)}/leases/pin`, { method: 'POST', body: input }),
    unpinResource: (sessionId, input) => transport.json(`/mesh/sessions/${id(sessionId)}/leases/unpin`, { method: 'POST', body: input }),
    renewSessionLease: (sessionId, input) => transport.json(`/mesh/sessions/${id(sessionId)}/leases/renew`, { method: 'POST', body: input ?? {} }),
    listWorkspaceCopies: () => transport.json('/mesh/workspace-copies'),
    createWorkspaceCopy: (input) => transport.json('/mesh/workspace-copies', { method: 'POST', body: input }),
    workspaceCopyStatus: (copyId) => transport.json(`/mesh/workspace-copies/${id(copyId)}/status`),
    workspaceCopyDiff: (copyId) => transport.json(`/mesh/workspace-copies/${id(copyId)}/diff`),
    workspaceCopySnapshot: (copyId, label) => transport.json(`/mesh/workspace-copies/${id(copyId)}/snapshot`, { method: 'POST', body: label === undefined ? {} : { label } }),
    exportWorkspaceCopyDelta: (copyId) => transport.json(`/mesh/workspace-copies/${id(copyId)}/delta/export`, { method: 'POST', body: {} }),
    applyWorkspaceCopyDelta: (copyId, input) => transport.json(`/mesh/workspace-copies/${id(copyId)}/delta/apply`, { method: 'POST', body: input }),
    applyWorkspaceCopy: (copyId, input) => transport.json(`/mesh/workspace-copies/${id(copyId)}/apply`, { method: 'POST', body: input ?? {} }),
    removeWorkspaceCopy: (copyId) => transport.json(`/mesh/workspace-copies/${id(copyId)}`, { method: 'DELETE' }),
    listTunnels: () => transport.json('/mesh/tunnels'),
    openTunnel: (input) => transport.json('/mesh/tunnels', { method: 'POST', body: input }),
    closeTunnel: (tunnelId) => transport.json(`/mesh/tunnels/${id(tunnelId)}`, { method: 'DELETE' }),
    inspectTakeover: (targetId) => transport.json(`/mesh/takeover/${id(targetId)}`),
    acquireTakeover: (targetId, input) => transport.json(`/mesh/takeover/${id(targetId)}/acquire`, { method: 'POST', body: input }),
    renewTakeover: (targetId, input) => transport.json(`/mesh/takeover/${id(targetId)}/renew`, { method: 'POST', body: input }),
    releaseTakeover: (targetId, input) => transport.json(`/mesh/takeover/${id(targetId)}/release`, { method: 'POST', body: input ?? {} }),
    dispatchTargetAction: (targetId, input, options) => transport.json(`/mesh/targets/${id(targetId)}/dispatch`, { ...options, method: 'POST', body: input }),
    resolveQuestion: (targetId, input, options) => transport.json(`/mesh/targets/${id(targetId)}/resolve-question`, { ...options, method: 'POST', body: input }),
  };
}
