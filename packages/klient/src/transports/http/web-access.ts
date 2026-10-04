import { webAccessStatusSchema, webAccessLinkSchema, webAccessSessionSchema, webAccessEnableInputSchema, webAccessExchangeInputSchema } from '@kiki/protocol';
import type { WebAccessFacade } from '../../core/facade/web-access.js';
import type { HttpRestTransport } from './rest.js';

export function createWebAccessFacade(transport: HttpRestTransport): WebAccessFacade {
  const prefix = '/web-access';
  return {
    status: async () => webAccessStatusSchema.parse(await transport.json(prefix)),
    enable: async (input) => webAccessStatusSchema.parse(await transport.json(prefix, { method: 'PUT', body: webAccessEnableInputSchema.parse(input) })),
    disable: async () => webAccessStatusSchema.parse(await transport.json(prefix, { method: 'DELETE' })),
    issueLink: async () => webAccessLinkSchema.parse(await transport.json(prefix + '/links', { method: 'POST', body: {} })),
    revoke: async (sessionId) => webAccessStatusSchema.parse(await transport.json(prefix + '/revoke', { method: 'POST', body: { sessionId } })),
    current: async () => webAccessSessionSchema.parse(await transport.json(prefix + '/session', { skipAuth: true })),
    exchange: async (input) => webAccessSessionSchema.parse(await transport.json(prefix + '/exchange', { method: 'POST', body: webAccessExchangeInputSchema.parse(input), skipAuth: true })),
    logout: async () => webAccessSessionSchema.parse(await transport.json(prefix + '/logout', { method: 'POST', body: {}, skipAuth: true })),
  };
}
