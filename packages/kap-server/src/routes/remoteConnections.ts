import { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { MEDIA_PREVIEW_MAX_BYTES, connectionAddInputSchema, connectionBrokerInputSchema, connectionClaimInputSchema, connectionIdentitySchema, connectionInviteInputSchema, connectionPairInputSchema, connectionProvisionInputSchema, pairClaimInputSchema, pairCodeCreateInputSchema, sshConnectionConnectInputSchema, sshConnectionRegisterInputSchema, sshRemoteExecuteSchema, sshRemoteProfileSchema, bridgeGrantSchema } from '@kiki/protocol';
import type { SshRemoteConnector } from '../services/sshRemote/connector';
import { readBoundedJsonBody, SESSION_READ_BODY_BYTES } from '@kiki/klient/transports/http/bounded-body';
import { decodeJsonFrame } from '@kiki/klient/host';
import { okEnvelope, errEnvelope } from '../envelope';
import { AdmissionError, ConnectionAdmission, sameIdentity } from '../services/connections/admission';
import { isPeerFrameAllowed, peerAudience } from '../services/connections/audience';
import { BROKER_BODY_BYTES, BROKER_WS_BUFFER_BYTES, BROKER_WS_MESSAGE_BYTES, RemoteConnectionManager } from '../services/connections/manager';
import { directEndpoints, machineLabel, pairOutbound, PairingRateLimit, type PairingHooks } from '../services/connections/pairing';
import { webPrincipal, type WebAccess } from '../services/webAccess';

export const CONNECTION_BROKER_WS = /^\/api\/remote-connections\/([0-9a-f-]{36})\/events(?:\?.*)?$/;
function isWebSharedRecord(record: { id: string; enabled: boolean; state: string; purposes: readonly string[] }, web: WebAccess | undefined): boolean {
  return web !== undefined && web.isConnectionShared(record.id) && record.enabled && !['disabled', 'authentication_required', 'identity_changed'].includes(record.state) && record.purposes.includes('gui');
}
function attachWebSharedConnection(request: object, id: string, manager: RemoteConnectionManager, web: WebAccess | undefined, close: () => void): () => void {
  if (webPrincipal(request) === undefined) return () => {};
  let record: ReturnType<RemoteConnectionManager['get']>;
  try { record = manager.get(id); } catch { throw new AdmissionError(403, 'connection_not_shared'); }
  if (!isWebSharedRecord(record, web)) throw new AdmissionError(403, 'connection_not_shared');
  return web!.attachConnection(id, close);
}
export function registerRemoteConnectionRoutes(app: FastifyInstance, admission: ConnectionAdmission, manager: RemoteConnectionManager, serverId: string, getOwnerToken: () => string, ssh?: SshRemoteConnector, hooks: { current?: PairingHooks } = {}, web?: WebAccess): WebSocketServer {
  const pairingLimit = new PairingRateLimit();
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
  app.post('/api/remote-connections/inbound/pair-code', { bodyLimit: 8192 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return respond(req.id, reply, async () => {
      const created = await admission.createPairCode(pairCodeCreateInputSchema.parse(req.body ?? {}));
      const extras = hooks.current === undefined ? [] : await hooks.current.endpoints();
      return { code: created.code, expiresAt: created.expiresAt, target: admission.identity, suggestedEndpoints: directEndpoints({ host: req.socket.localAddress ?? '127.0.0.1', port: req.socket.localPort ?? 0 }, extras) };
    });
  });
  app.post('/api/remote-connections/pair/claim', { bodyLimit: 8192 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return respond(req.id, reply, async () => {
      if (!pairingLimit.allow(req.ip)) throw new AdmissionError(429, 'pairing_rate_limited');
      const input = pairClaimInputSchema.parse(req.body);
      const claimed = await admission.claimPair(input.code, input.source, input.sourceLabel);
      try {
        const bridge = claimed.allowBridge && input.requestBridge !== false && hooks.current !== undefined ? await hooks.current.issueBridges({ grantId: claimed.grantId, source: input.source, sourceLabel: input.sourceLabel, sourceWorkspaces: input.sourceWorkspaces ?? [] }) : [];
        return { target: claimed.target, targetLabel: machineLabel(), grantId: claimed.grantId, revision: claimed.revision, peerToken: claimed.peerToken, ...bridge.length > 0 ? { bridge } : {} };
      } catch (error) { await admission.revoke(claimed.grantId).catch(() => undefined); throw error; }
    });
  });
  app.post('/api/remote-connections/pair/cancel', { bodyLimit: 8192 }, async (req, reply) => respond(req.id, reply, async () => {
    const body = z.object({ grantId: z.string().uuid(), bridgeGrantIds: z.array(z.string().uuid()).max(64).optional() }).strict().parse(req.body);
    if (peerAudience(req)?.grantId !== body.grantId) throw new AdmissionError(403, 'connection_not_approved');
    await admission.revoke(body.grantId);
    return { revoked: true };
  }));
  app.post('/api/remote-connections/inbound/peer-grant', { bodyLimit: 16384 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return respond(req.id, reply, async () => {
      const input = z.object({ source: connectionIdentitySchema, label: z.string().min(1).max(128), sourceWorkspaces: z.array(z.string().min(1).max(512)).max(64).optional(), requestBridge: z.boolean().optional() }).strict().parse(req.body);
      if (admission.unavailableReason !== undefined) throw new AdmissionError(403, admission.unavailableReason);
      await admission.setEnabled(true);
      const claimed = await admission.approvePeer(input.source, input.label);
      try {
        const bridge = input.requestBridge !== false && hooks.current !== undefined ? await hooks.current.issueBridges({ grantId: claimed.grantId, source: input.source, sourceLabel: input.label, sourceWorkspaces: input.sourceWorkspaces ?? [] }) : [];
        return { peerToken: claimed.peerToken, grantId: claimed.grantId, revision: claimed.revision, target: claimed.target, targetLabel: machineLabel(), ...bridge.length > 0 ? { bridge } : {} };
      } catch (error) { await admission.revoke(claimed.grantId).catch(() => undefined); throw error; }
    });
  });
  app.post('/api/remote-connections/pair', { bodyLimit: 8192 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return respond(req.id, reply, () => pairOutbound(manager, connectionPairInputSchema.parse(req.body), hooks.current));
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
    app.post('/api/remote-connections/ssh/connect', { bodyLimit: 16384 }, async (req, reply) => {
      const controller = new AbortController(); const stop = () => controller.abort(); reply.raw.once('close', stop);
      try { return await respond(req.id, reply, async () => {
        const input = sshConnectionConnectInputSchema.parse(req.body);
        const plan = await ssh.plan(input.profile, controller.signal);
        const ready = await ssh.execute(plan.id, { ensure: plan.state !== 'attach' }, controller.signal);
        const workspaces = hooks.current === undefined ? [] : await hooks.current.workspaces();
        return manager.registerSsh({ purpose: 'gui', planId: ready.id, label: input.label?.trim() || input.profile.label, enableInbound: true, backgroundSummary: input.backgroundSummary }, controller.signal, hooks.current === undefined ? undefined : {
          sourceWorkspaces: workspaces,
          install: async (connectionId, bundle) => {
            await hooks.current?.enableThreads().catch(() => undefined);
            await hooks.current?.installBridge(connectionId, bridgeGrantSchema.parse(bundle.grant), bundle.credential);
          },
        });
      }); }
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
  app.get('/api/remote-connections', async (req, reply) => {
    const records = manager.list();
    return reply.send(okEnvelope(webPrincipal(req) === undefined ? records : records.filter((record) => isWebSharedRecord(record, web)), req.id));
  });
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
    const controller = new AbortController(); const stop = () => controller.abort(); let release = () => {}; let detachWeb = () => {};
    reply.raw.once('close', stop);
    try {
      detachWeb = attachWebSharedConnection(req, id, manager, web, () => controller.abort(new AdmissionError(403, 'connection_not_shared')));
      const reading = ['snapshot', 'transcript', 'content', 'catchUp', 'transcriptPage', 'transcriptDetail', 'transcriptDetails', 'transcriptOps'].includes(input.operation);
      const lease = manager.lease(id, reading ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])); release = () => lease.release();
      const response = await manager.forward(id, input, lease.signal);
      const cap = reading ? SESSION_READ_BODY_BYTES : BROKER_BODY_BYTES;
      const body = await readBoundedJsonBody(response, cap, lease.signal);
      return await reply.code(response.status).send(body);
    } catch (error) {
      const reason = controller.signal.reason;
      if (reason instanceof AdmissionError) return await reply.code(reason.status).send(errEnvelope(40101, reason.reason, req.id));
      if (error instanceof AdmissionError) return await reply.code(error.status).send(errEnvelope(40101, error.reason, req.id));
      throw error;
    }
    finally { detachWeb(); reply.raw.off('close', stop); release(); }
  });
  app.register(async (uploads) => {
    await uploads.register(multipart, { limits: { fileSize: Number.MAX_SAFE_INTEGER, files: 1 } });
    uploads.post('/api/remote-connections/:connectionId/upload', async (req, reply) => {
      const id = (req.params as { connectionId: string }).connectionId;
      const controller = new AbortController(); const stop = () => controller.abort(); let release = () => {}; let detachWeb = () => {};
      reply.raw.once('close', stop);
      try {
        detachWeb = attachWebSharedConnection(req, id, manager, web, () => controller.abort(new AdmissionError(403, 'connection_not_shared')));
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
      } catch (error) {
        const reason = controller.signal.reason;
        if (reason instanceof AdmissionError) return await reply.code(reason.status).send(errEnvelope(40101, reason.reason, req.id));
        if (error instanceof AdmissionError) return await reply.code(error.status).send(errEnvelope(40101, error.reason, req.id));
        throw error;
      }
      finally { detachWeb(); reply.raw.off('close', stop); release(); }
    });
  });
  app.post('/api/remote-connections/:connectionId/download', { bodyLimit: 8192 }, async (req, reply) => {
    const id = (req.params as { connectionId: string }).connectionId; const input = connectionBrokerInputSchema.parse(req.body);
    if (!['media', 'mediaPreview', 'file', 'appearanceAsset', 'personaAvatar'].includes(input.operation)) return reply.code(400).send(errEnvelope(40001, 'invalid_download_operation', req.id));
    const controller = new AbortController(); const stop = () => controller.abort(); let release = () => {}; let detachWeb = () => {};
    let stream: Readable | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cleanup = () => { detachWeb(); release(); reply.raw.off('close', stop); };
    reply.raw.once('close', stop);
    try {
      detachWeb = attachWebSharedConnection(req, id, manager, web, () => {
        const err = new AdmissionError(403, 'connection_not_shared');
        controller.abort(err);
        void reader?.cancel(err).catch(() => {});
        stream?.destroy(err);
        reply.raw.destroy();
      });
      const lease = manager.lease(id, controller.signal); release = () => lease.release();
      const response = await manager.forward(id, input, lease.signal);
      for (const name of ['etag', 'content-range', 'accept-ranges', 'content-disposition', 'cache-control']) { const value = response.headers.get(name); if (value !== null) reply.header(name, value); }
      if (response.status === 304 || response.status === 204) { cleanup(); return await reply.code(response.status).send(); }
      if (response.body === null) throw new AdmissionError(502, 'empty_download');
      reader = response.body.getReader();
      const bodyReader = reader;
      stream = Readable.from((async function* () {
        try {
          let total = 0;
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const next = await Promise.race([bodyReader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdmissionError(504, 'download_stalled')); }, 30000); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
            if (next.done) break;
            total += next.value.byteLength;
            if (input.operation === 'mediaPreview' && total > MEDIA_PREVIEW_MAX_BYTES) throw new AdmissionError(413, 'preview_budget_exceeded');
            yield next.value;
          }
        } finally { await bodyReader.cancel().catch(() => {}); bodyReader.releaseLock(); cleanup(); }
      })());
      stream.once('close', cleanup);
      return await reply.code(response.status).type(response.headers.get('content-type') ?? 'application/octet-stream').send(stream);
    } catch (error) {
      cleanup();
      const reason = controller.signal.reason;
      if (reason instanceof AdmissionError) return reply.code(reason.status).send(errEnvelope(40101, reason.reason, req.id));
      if (error instanceof AdmissionError) return reply.code(error.status).send(errEnvelope(40101, error.reason, req.id));
      throw error;
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: BROKER_WS_MESSAGE_BYTES });
  wss.on('connection', (socket, request) => { void brokerSocket(socket, request, manager, web).catch(() => socket.close(4001, 'connection unavailable')); });
  app.addHook('preClose', async () => { admission.closeAll(); for (const socket of wss.clients) socket.terminate(); wss.close(); await manager.close(); });
  return wss;
}
async function brokerSocket(local: WebSocket, request: IncomingMessage, manager: RemoteConnectionManager, web?: WebAccess): Promise<void> {
  const id = CONNECTION_BROKER_WS.exec(request.url ?? '')?.[1]; if (id === undefined) { local.close(1008); return; }
  if (webPrincipal(request) !== undefined) {
    let record: ReturnType<RemoteConnectionManager['get']> | undefined;
    try { record = manager.get(id); } catch { record = undefined; }
    if (record === undefined || !isWebSharedRecord(record, web)) { local.close(1008, 'connection not shared'); return; }
  }
  const lease = manager.lease(id); let remote: WebSocket | undefined; let detachWeb = () => {};
  const stop = () => { detachWeb(); remote?.terminate(); local.close(4001, 'connection stopped'); lease.release(); };
  if (webPrincipal(request) !== undefined) detachWeb = web!.attachConnection(id, stop);
  lease.signal.addEventListener('abort', stop, { once: true }); local.once('close', stop); local.once('error', stop);
  local.pause();
  try {
    const { transport, credential } = await manager.connect(id, lease.signal);
    if (local.readyState !== WebSocket.OPEN || lease.signal.aborted) return;
    const url = new URL('/api/klient/events', transport.endpoint); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    remote = new WebSocket(url, [`kimi-code.bearer.${credential.ownerToken}`], { headers: { 'x-kiki-connection-grant': credential.grant }, maxPayload: 0, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 15000 });
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
    let pendingResponses = 0;
    target.on('message', (data) => {
      if (local.readyState !== WebSocket.OPEN || lease.signal.aborted) return;
      pendingResponses += 1;
      target.pause();
      local.send(data, { binary: false }, (error) => {
        pendingResponses -= 1;
        if (error) { stop(); return; }
        if (pendingResponses === 0 && !lease.signal.aborted && target.readyState === WebSocket.OPEN) target.resume();
      });
    });
    target.on('unexpected-response', (_request, response) => { response.resume(); manager.failed(id, new AdmissionError(response.statusCode ?? 502, response.statusCode === 401 ? 'connection_not_approved' : 'event_transport_rejected')); stop(); });
    target.on('close', (code, reason) => { if (code === 4001) manager.failed(id, new AdmissionError(401, 'connection_not_approved')); local.close(code === 1006 ? 1011 : code, reason.toString().slice(0, 100)); lease.release(); });
    target.on('error', () => { manager.failed(id, new AdmissionError(502, 'event_transport_failed')); stop(); });
  } catch (error) { manager.failed(id, error); stop(); }
}
