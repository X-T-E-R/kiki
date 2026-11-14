import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { PANEL_CSP } from '@kiki/agent-core-v2/app/plugin/panelDocument';

import { isLoopbackPreviewClient } from '../lib/previewLocalClient';
import { stripPort } from '../middleware/hostnames';
import { peerAudience } from '../services/connections/audience';
import { webPrincipal } from '../services/webAccess';

const TTL_MS = 10 * 60_000;
const MAX_GRANTS = 128;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const DOCUMENT_CSP = `sandbox allow-scripts; ${PANEL_CSP}`;

export type MintPluginPanelDocument = (html: string, request: FastifyRequest) => Promise<string>;

export function registerPluginPanelDocuments(app: FastifyInstance): MintPluginPanelDocument {
  const grants = new Map<string, { bytes: Buffer; expiresAt: number; loopback: boolean }>();
  let retainedBytes = 0;
  let listener: FastifyInstance | undefined;
  let listening: Promise<string> | undefined;
  const remove = (id: string): void => {
    const grant = grants.get(id);
    if (grant !== undefined) retainedBytes -= grant.bytes.byteLength;
    grants.delete(id);
  };
  const sweep = (): void => {
    for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) remove(id);
  };
  const serve = async (req: FastifyRequest, reply: FastifyReply, loopback: boolean) => {
    sweep();
    const { grantId } = req.params as { grantId: string };
    const grant = grants.get(grantId);
    if (grant === undefined || grant.loopback !== loopback ||
      (loopback && stripPort(req.headers.host ?? '') !== `${grantId.slice(0, 32)}.kiki-document.localhost`)) return reply.code(404).send();
    const destination = req.headers['sec-fetch-dest'];
    if (destination !== undefined && destination !== 'iframe') return reply.code(403).send();
    grants.delete(grantId);
    grants.set(grantId, grant);
    return reply.header('content-security-policy', DOCUMENT_CSP)
      .header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff').type('text/html; charset=utf-8').send(grant.bytes);
  };
  app.get('/plugin-panel/:grantId', { config: { htmlPreviewResource: true } }, (req, reply) => serve(req, reply, false));
  const documentOrigin = (): Promise<string> => {
    if (listening !== undefined) return listening;
    listener = Fastify({ forceCloseConnections: true });
    listener.get('/plugin-panel/:grantId', (req, reply) => serve(req, reply, true));
    listening = listener.listen({ host: '127.0.0.1', port: 0 });
    return listening;
  };
  app.addHook('onClose', async () => {
    grants.clear();
    retainedBytes = 0;
    await listener?.close();
  });
  return async (html, req) => {
    sweep();
    const bytes = Buffer.from(html);
    if (bytes.byteLength > MAX_RETAINED_BYTES) throw new RangeError('Plugin panel document exceeds 64 MiB');
    const loopback = peerAudience(req) === undefined && webPrincipal(req) === undefined && isLoopbackPreviewClient(req);
    const origin = loopback ? new URL(await documentOrigin()) : undefined;
    const id = randomBytes(32).toString('hex');
    while (grants.size >= MAX_GRANTS || retainedBytes + bytes.byteLength > MAX_RETAINED_BYTES) remove(grants.keys().next().value!);
    grants.set(id, { bytes, expiresAt: Date.now() + TTL_MS, loopback });
    retainedBytes += bytes.byteLength;
    const path = `/plugin-panel/${id}`;
    return origin === undefined ? path : `http://${id.slice(0, 32)}.kiki-document.localhost:${origin.port}${path}`;
  };
}
