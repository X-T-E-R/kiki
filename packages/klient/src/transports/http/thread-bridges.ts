import type { ThreadBridgesFacade } from '../../core/facade/thread-bridges.js';
import type { HttpRestTransport } from './rest.js';
export function createThreadBridgesFacade(transport: HttpRestTransport): ThreadBridgesFacade {
  const prefix = '/thread-bridges';
  const path = (direction: 'inbound' | 'outbound', id: string) => prefix + '/' + direction + '/' + encodeURIComponent(id);
  return {
    status: (options) => transport.json(prefix, options),
    approve: (input, options) => transport.json(prefix + '/inbound', { ...options, method: 'POST', body: input }),
    registerTarget: (input, options) => transport.json(prefix + '/targets', { ...options, method: 'POST', body: input }),
    provisionLocal: (input, options) => transport.json(prefix + '/local', { ...options, method: 'POST', body: input }),
    install: (input, options) => transport.json(prefix + '/outbound', { ...options, method: 'POST', body: input }),
    setEnabled: (direction, id, enabled, options) => transport.json(path(direction, id) + '/enabled', { ...options, method: 'PUT', body: { enabled } }),
    setOperations: (id, operations, options) => transport.json(path('inbound', id) + '/operations', { ...options, method: 'PUT', body: { operations } }),
    setBorrowTools: (id, borrowTools, options) => transport.json(path('outbound', id) + '/borrow-tools', { ...options, method: 'PUT', body: { borrowTools } }),
    syncConnection: (connectionId, input, options) => transport.json(prefix + '/sync/' + encodeURIComponent(connectionId), { ...options, method: 'POST', body: input ?? {} }),
    revoke: (direction, id, options) => transport.json(path(direction, id) + '/revoke', { ...options, method: 'POST', body: {} }),
    receipts: (query, options) => transport.json(prefix + '/receipts', { ...options, query }),
    retry: (options) => transport.json(prefix + '/retry', { ...options, method: 'POST', body: {} }),
  };
}
