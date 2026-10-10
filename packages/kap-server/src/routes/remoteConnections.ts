import { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { connectionAddInputSchema, connectionBrokerInputSchema, connectionClaimInputSchema, connectionInviteInputSchema, connectionProvisionInputSchema, sshConnectionRegisterInputSchema, sshRemoteExecuteSchema, sshRemoteProfileSchema } from '@kiki/protocol';
import type { SshRemoteConnector } from '../services/sshRemote/connector';
import { readBoundedJsonBody, SESSION_READ_BODY_BYTES } from '@kiki/klient/transports/http/bounded-body';
import { decodeJsonFrame } from '@kiki/klient/host';
import { okEnvelope, errEnvelope } from '../envelope';
import { AdmissionError, ConnectionAdmission, sameIdentity } from '../services/connections/admission';
import { isPeerFrameAllowed } from '../services/connections/audience';
import { BROKER_BODY_BYTES, BROKER_WS_BUFFER_BYTES, BROKER_WS_MESSAGE_BYTES, RemoteConnectionManager } from '../services/connections/manager';

export const CONNECTION_BROKER_WS = /^\/api\/remote-connections\/([0-9a-f-]{36})\/events(?:\?.*)?$/;
export function registerRemoteConnectionRoutes(app: FastifyInstance, admission: ConnectionAdmission, manager: RemoteConnectionManager, serverId: string, getOwnerToken: () => string, ssh?: SshRemoteConnector): WebSocketServer {
  const respond = async <T>(requestId: string, reply: { code(status: number): unknown; send(value: unknown): unknown }, work: () => Promise<T>) => {
    try { return reply.send(okEnvelope(await work(), requestId)); }
    catch (error) { if (!(error instanceof AdmissionError)) throw error; reply.code(error.status); return reply.send(errEnvelope(40101, error.reason, requestId)); }
  };
  app.get('/api/remote-connections/handshake', async (req, reply) => reply.send(okEnvelope({ identity: admission.identity, serverId, inboundEnabled: admission.status().enabled }, req.id)));
  app.post('/api/remote-connections/claim', { bodyLimit: 8192 }, async (req, reply) => respond(req.id, reply, async () => { const input = connectionClaimInputSchema.parse(req.body); return admission.claim(input.invitation, input.source); }));
  app.post('/api/remote-connections/provision', { bodyLimit: 8192 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return respond(req.id, reply, async () => {
      const input = connectionProvisionInputSchema.parse(req.body);
      if (admission.unavailableReason !== undefined) throw new AdmissionError(403, admission.unavailableReason);
      if (!sameIdentity(input.target, admission.identity) || sameIdentity(input.source, input.target)) throw new AdmissionError(409, 'identity_changed');
      if (input.enableInbound) await admission.setEnabled(true);
      const invitation = await admission.invite(input.source, input.label);
      try { return { ownerToken: getOwnerToken(), ...await admission.claim(invitation.invitation, input.source) }; }
      catch (error) { await admission.revoke(invitation.grant.id); throw error; }
    });
  });
  if (ssh !== undefined) {
    app.get('/api/remote-connections/ssh/status', async (req, reply) => reply.send(okEnvelope(manager.list().filter((record) => record.transport?.kind === 'ssh').map((record) => ssh.status(record.id)), req.id)));
    app.post('/api/remote-connections/ssh/plan', { bodyLimit: 16384 }, async (req, reply) => {
      const controller = new AbortController(); const stop = () => controller.abort(); reply.raw.once('close', stop);
      try { return await respond(req.id, reply, () => ssh.plan(sshRemoteProfileSchema.parse(req.body), controller.signal)); }
      finally { reply.raw.off('close', stop); }
    });
    app.post('/api/remote-connections/ssh/plans/:planId/execute', { bodyLimit: 8192 }, async (req, reply) => {
      const controller = new AbortController(); const stop = () => controller.abort(); reply.raw.once('close', stop);
      try { return await respond(req.id, reply, () => ssh.execute((req.params as { planId: string }).planId, sshRemoteExecuteSchema.parse(req.body), controller.signal)); }
      finally { reply.raw.off('close', stop); }
    });
    app.post('/api/remote-connections/ssh/register', { bodyLimit: 8192 }, async (req, reply) => {
      const controller = new AbortController(); const stop = () => controller.abort(); reply.raw.once('close', stop);
      try { return await respond(req.id, reply, () => manager.registerSsh(sshConnectionRegisterInputSchema.parse(req.body), controller.signal)); }
      finally { reply.raw.off('close', stop); }
    });
  }
  app.get('/api/remote-connections/inbound', async (req, reply) => reply.send(okEnvelope(admission.status(), req.id)));
  app.put('/api/remote-connections/inbound', async (req, reply) => respond(req.id, reply, async () => {
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== 'boolean') throw new AdmissionError(400, 'invalid_inbound_setting'); return admission.setEnabled(enabled);
  }));
  app.post('/api/remote-connections/inbound/invitations', async (req, reply) => respond(req.id, reply, async () => { const input = connectionInviteInputSchema.parse(req.body); return admission.invite(input.source, input.label, input.expiresInMs); }));
  app.post('/api/remote-connections/inbound/grants/:grantId/revoke', async (req, reply) => respond(req.id, reply, () => admission.revoke((req.params as { grantId: string }).grantId)));
  app.get('/api/remote-connections', async (req, reply) => reply.send(okEnvelope(manager.list(), req.id)));
  app.post('/api/remote-connections', { bodyLimit: 16384 }, async (req, reply) => respond(req.id, reply, () => manager.add(connectionAddInputSchema.parse(req.body))));
  app.delete('/api/remote-connections/:connectionId', async (req, reply) => respond(req.id, reply, () => manager.remove((req.params as { connectionId: string }).connectionId)));
  app.put('/api/remote-connections/:connectionId/enabled', async (req, reply) => respond(req.id, reply, async () => {
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== 'boolean') throw new AdmissionError(400, 'invalid_connection_setting'); return manager.enable((req.params as { connectionId: string }).connectionId, enabled);
  }));
  app.post('/api/remote-connections/:connectionId/retry', async (req, reply) => respond(req.id, reply, () => manager.retry((req.params as { connectionId: string }).connectionId)));
  app.post('/api/remote-connections/:connectionId/call', { bodyLimit: BROKER_BODY_BYTES }, async (req, reply) => {
    const id = (req.params as { connectionId: string }).connectionId;
    const input = connectionBrokerInputSchema.parse(req.body);
    if (['media', 'file', 'fileUpload', 'appearanceAsset', 'personaAvatar', 'mediaPreview', 'htmlPreviewResource'].includes(input.operation)) return reply.code(400).send(errEnvelope(40001, 'use_explicit_attachment_stream', req.id));
    const controller = new AbortController(); const stop = () => controller.abort(); let release = () => {};
    reply.raw.once('close', stop);
    try {
      const lease = manager.lease(id, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])); release = () => lease.release();
      const response = await manager.forward(id, input, lease.signal);
      const cap = ['snapshot', 'transcript', 'content', 'catchUp', 'transcriptPage', 'transcriptDetail', 'transcriptDetails', 'transcriptOps'].includes(input.operation) ? SESSION_READ_BODY_BYTES : BROKER_BODY_BYTES;
      const body = await readBoundedJsonBody(response, cap);
      return await reply.code(response.status).send(body);
    } catch (error) { if (error instanceof AdmissionError) return await reply.code(error.status).send(errEnvelope(40101, error.reason, req.id)); throw error; }
    finally { reply.raw.off('close', stop); release(); }
  });
  app.register(async (uploads) => {
    await uploads.register(multipart, { limits: { fileSize: Number.MAX_SAFE_INTEGER, files: 1 } });
    uploads.post('/api/remote-connections/:connectionId/upload', async (req, reply) => {
      const id = (req.params as { connectionId: string }).connectionId;
      const controller = new AbortController(); const stop = () => controller.abort(); let release = () => {};
      reply.raw.once('close', stop);
      try {
        const lease = manager.lease(id, controller.signal); release = () => lease.release();
        const chunks = req.raw[Symbol.asyncIterator]();
        const upload = Readable.from((async function* () {
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([chunks.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdmissionError(504, 'upload_stalled')); }, 30000); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
            if (next.done) break; yield next.value;
          }
        })());
        const response = await manager.forward(id, { operation: 'fileUpload' }, lease.signal, upload as unknown as NonNullable<RequestInit['body']>, req.headers['content-type']);
        return await reply.code(response.status).send(await readBoundedJsonBody(response, 8192));
      } catch (error) { if (error instanceof AdmissionError) return await reply.code(error.status).send(errEnvelope(40101, error.reason, req.id)); throw error; }
      finally { reply.raw.off('close', stop); release(); }
    });
  });
  app.post('/api/remote-connections/:connectionId/download', { bodyLimit: 8192 }, async (req, reply) => {
    const id = (req.params as { connectionId: string }).connectionId; const input = connectionBrokerInputSchema.parse(req.body);
    if (!['media', 'mediaPreview', 'file', 'appearanceAsset', 'personaAvatar'].includes(input.operation)) return reply.code(400).send(errEnvelope(40001, 'invalid_download_operation', req.id));
    const controller = new AbortController(); const stop = () => controller.abort(); let release = () => {};
    const cleanup = () => { release(); reply.raw.off('close', stop); };
    reply.raw.once('close', stop);
    try {
      const lease = manager.lease(id, controller.signal); release = () => lease.release();
      const response = await manager.forward(id, input, lease.signal);
      for (const name of ['etag', 'content-range', 'accept-ranges', 'content-disposition', 'cache-control']) { const value = response.headers.get(name); if (value !== null) reply.header(name, value); }
      if (response.status === 304 || response.status === 204) { cleanup(); return await reply.code(response.status).send(); }
      if (response.body === null) throw new AdmissionError(502, 'empty_download');
      const reader = response.body.getReader();
      const stream = Readable.from((async function* () {
        try {
          let total = 0;
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdmissionError(504, 'download_stalled')); }, 30000); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
            if (next.done) break;
            total += next.value.byteLength;
            if (input.operation === 'mediaPreview' && total > 64 * 1024) throw new AdmissionError(413, 'preview_budget_exceeded');
            yield next.value;
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); cleanup(); }
      })());
      stream.once('close', cleanup);
      return await reply.code(response.status).type(response.headers.get('content-type') ?? 'application/octet-stream').send(stream);
    } catch (error) { cleanup(); if (error instanceof AdmissionError) return reply.code(error.status).send(errEnvelope(40101, error.reason, req.id)); throw error; }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: BROKER_WS_MESSAGE_BYTES });
  wss.on('connection', (socket, request) => { void brokerSocket(socket, request, manager).catch(() => socket.close(4001, 'connection unavailable')); });
  app.addHook('preClose', async () => { admission.closeAll(); for (const socket of wss.clients) socket.terminate(); wss.close(); await manager.close(); });
  return wss;
}
async function brokerSocket(local: WebSocket, request: IncomingMessage, manager: RemoteConnectionManager): Promise<void> {
  const id = CONNECTION_BROKER_WS.exec(request.url ?? '')?.[1]; if (id === undefined) { local.close(1008); return; }
  const lease = manager.lease(id); let remote: WebSocket | undefined;
  const stop = () => { remote?.terminate(); local.close(4001, 'connection stopped'); lease.release(); };
  lease.signal.addEventListener('abort', stop, { once: true }); local.once('close', stop); local.once('error', stop);
  local.pause();
  try {
    const { transport, credential } = await manager.connect(id, lease.signal);
    if (local.readyState !== WebSocket.OPEN || lease.signal.aborted) return;
    const url = new URL('/api/klient/events', transport.endpoint); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    remote = new WebSocket(url, [`kimi-code.bearer.${credential.ownerToken}`], { headers: { 'x-kiki-connection-grant': credential.grant }, maxPayload: BROKER_WS_MESSAGE_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 15000 });
    const target = remote;
    const send = (to: WebSocket, data: RawData) => {
      const bytes = Array.isArray(data) ? data.reduce((size, chunk) => size + chunk.byteLength, 0) : data.byteLength;
      if (to.readyState !== WebSocket.OPEN || to.bufferedAmount + bytes > BROKER_WS_BUFFER_BYTES) { local.close(4008, 'slow consumer; reload current window'); target.terminate(); lease.release(); return; }
      to.send(data, { binary: false });
    };
    target.once('open', () => local.resume());
    local.on('message', (data) => {
      const frame = decodeJsonFrame((Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString());
      if (frame === undefined || !isPeerFrameAllowed(frame)) { local.close(1008, 'operation not allowed'); target.terminate(); return; }
      send(target, data);
    });
    target.on('message', (data) => send(local, data));
    target.on('unexpected-response', (_request, response) => { response.resume(); manager.failed(id, new AdmissionError(response.statusCode ?? 502, 'connection_not_approved')); stop(); });
    target.on('close', (code, reason) => { if (code === 4001) manager.failed(id, new AdmissionError(401, 'connection_not_approved')); local.close(code === 1006 ? 1011 : code, reason.toString().slice(0, 100)); lease.release(); });
    target.on('error', () => { manager.failed(id, new AdmissionError(502, 'event_transport_failed')); stop(); });
  } catch (error) { manager.failed(id, error); stop(); }
}
