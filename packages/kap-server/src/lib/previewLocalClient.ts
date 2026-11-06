import type { FastifyRequest } from 'fastify';

import { stripPort } from '../middleware/hostnames';

export function isLoopbackPreviewClient(req: Pick<FastifyRequest, 'ip' | 'headers'>): boolean {
  const host = stripPort(req.headers.host ?? '');
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip) && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}
