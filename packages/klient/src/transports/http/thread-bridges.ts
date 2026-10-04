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
    revoke: (direction, id, options) => transport.json(path(direction, id) + '/revoke', { ...options, method: 'POST', body: {} }),
    receipts: (query, options) => transport.json(prefix + '/receipts', { ...options, query }),
    retry: (options) => transport.json(prefix + '/retry', { ...options, method: 'POST', body: {} }),
  };
}
