import { matchConnectionOperation, type ConnectionBrokerInput } from '@kiki/protocol';
import { RPCError } from '../../core/errors.js';
import type { KlientOptions } from '../../core/klient.js';
import type { HttpChannelOptions } from './channel.js';

import type { ConnectionsFacade } from '../../core/facade/connections.js';
import type { HttpRestTransport } from './rest.js';

type ConnectionHttpOptions = KlientOptions & HttpChannelOptions & { connectionId: string };

export function createConnectionsFacade(transport: HttpRestTransport): ConnectionsFacade {
  const prefix = '/remote-connections'; const id = encodeURIComponent;
  return {
    list: () => transport.json(prefix),
    inbound: () => transport.json(prefix + '/inbound'),
    setInbound: (enabled) => transport.json(prefix + '/inbound', { method: 'PUT', body: { enabled } }),
    invite: (input) => transport.json(prefix + '/inbound/invitations', { method: 'POST', body: input }),
    revoke: (grantId) => transport.json(prefix + '/inbound/grants/' + id(grantId) + '/revoke', { method: 'POST', body: {} }),
    add: (input) => transport.json(prefix, { method: 'POST', body: input }),
    remove: (connectionId) => transport.json(prefix + '/' + id(connectionId), { method: 'DELETE' }),
    setEnabled: (connectionId, enabled) => transport.json(prefix + '/' + id(connectionId) + '/enabled', { method: 'PUT', body: { enabled } }),
    retry: (connectionId) => transport.json(prefix + '/' + id(connectionId) + '/retry', { method: 'POST', body: {} }),
    summary: (connectionId, options) => transport.json(prefix + '/' + id(connectionId) + '/call', { ...options, method: 'POST', body: { operation: 'spaceSummary' } }),
    handshake: () => transport.json(prefix + '/handshake'),
    sshPlan: (profile, options) => transport.json(prefix + '/ssh/plan', { ...options, method: 'POST', body: profile }),
    sshExecute: (planId, input, options) => transport.json(prefix + '/ssh/plans/' + id(planId) + '/execute', { ...options, method: 'POST', body: input }),
    sshRegister: (input, options) => transport.json(prefix + '/ssh/register', { ...options, method: 'POST', body: input }),
    sshStatus: () => transport.json(prefix + '/ssh/status'),
  };
}
/** A fixed connection transport for adapters that also consume typed REST. */
export function createConnectionTransport(options: ConnectionHttpOptions): { fetch: typeof fetch; eventsUrl: string } {
  if (!/^[0-9a-f-]{36}$/.test(options.connectionId)) throw new Error('Invalid connectionId');
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const prefix = endpoint + '/api/remote-connections/' + encodeURIComponent(options.connectionId);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const brokerFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? (input instanceof Request ? input.method : 'GET');
    if ((method === 'POST' && url.pathname === '/api/fs:html-preview') || (method === 'DELETE' && /^\/api\/fs:html-preview\/[^/]+$/.test(url.pathname))) {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
      const target = method === 'POST' ? prefix + '/html-preview' : endpoint + url.pathname;
      return fetchImpl(target, { ...init, headers, method, redirect: 'error', credentials: 'same-origin' });
    }
    const matched = matchConnectionOperation(method, url.pathname);
    if (matched === undefined) throw new RPCError(40301, 'Operation is not available to a remote space');
    const query: Record<string, string | string[]> = {};
    for (const [key, value] of url.searchParams) { const old = query[key]; query[key] = old === undefined ? value : Array.isArray(old) ? [...old, value] : [old, value]; }
    const binary = ['media', 'mediaPreview', 'file', 'appearanceAsset', 'personaAvatar'].includes(matched.operation);
    const incomingHeaders = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (matched.operation === 'fileUpload') {
      incomingHeaders.delete('authorization');
      if (options.token !== undefined) incomingHeaders.set('authorization', `Bearer ${options.token}`);
      return fetchImpl(prefix + '/upload', { ...init, headers: incomingHeaders, method: 'POST', redirect: 'error' });
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const call: ConnectionBrokerInput = { operation: matched.operation, params: matched.params, query, body,
      headers: { ifNoneMatch: incomingHeaders.get('if-none-match') ?? undefined, range: incomingHeaders.get('range') ?? undefined } };
    const headers = new Headers({ 'content-type': 'application/json' });
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    return fetchImpl(prefix + (binary ? '/download' : '/call'), { method: 'POST', headers, body: JSON.stringify(call), signal: init.signal, redirect: 'error', credentials: 'same-origin' });
  };
  const ws = new URL(prefix + '/events'); ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  return { fetch: brokerFetch, eventsUrl: ws.toString() };
}
