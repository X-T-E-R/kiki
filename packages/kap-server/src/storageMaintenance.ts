import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import Fastify, { type FastifyInstance } from 'fastify';
import type { MailboxMigrationService } from '@kiki/agent-core-v2/app/threadCommunication/mailboxMigration';
import { HomeRuntimeError } from '@kiki/agent-core-v2/app/runtimeHost/errors';

import type { RunningServer, ServerExitReceipt, ServerStartOptions } from './start';
import type { InstanceRegistration } from './instanceRegistry';
import type { IAuthTokenService } from './services/auth/authTokenService';
import type { CredentialValidator } from './services/auth/credentials';
import { ConnectionAdmission, AdmissionError } from './services/connections/admission';
import { ConnectionAudience, isWebPathAllowed } from './services/connections/audience';
import { RemoteConnectionManager } from './services/connections/manager';
import { WebAccess, setWebPrincipal } from './services/webAccess';
import type { ServerLogger } from './services/pinoLoggerService';
import { ConnectionRegistry } from './transport/ws/connectionRegistry';
import { createAuthHook } from './middleware/auth';
import { createHostCheck, isHostCheckDisabled, parseAllowedHosts } from './middleware/hostnames';
import { createOriginHook, parseCorsOrigins } from './middleware/origin';
import { createSecurityHeadersHook } from './middleware/securityHeaders';
import { registerWebAccessRoutes } from './routes/webAccess';
import { registerWebAssetRoutes } from './routes/webAssets';
import { StorageMigrationController, registerStorageMigrationRoutes } from './routes/storageMigration';
import { installErrorHandler } from './error-handler';
import { okEnvelope, errEnvelope } from './envelope';
import { resolveRequestId } from './request-id';
import { startWebListener } from './webListener';

export interface StorageMaintenanceInput {
  readonly options: ServerStartOptions;
  readonly homeDir: string;
  readonly serverHomeId: string;
  readonly serverVersion: string;
  readonly startedAt: number;
  readonly host: string;
  readonly port: number;
  readonly registration: InstanceRegistration;
  readonly authTokenService: IAuthTokenService;
  readonly validateCredential: CredentialValidator;
  readonly localOwnerToken: string;
  readonly admission: ConnectionAdmission;
  readonly remoteConnections: RemoteConnectionManager;
  readonly logger: ServerLogger;
  readonly service: MailboxMigrationService;
  readonly startNormal: (port: number, registration: InstanceRegistration, releaseListener: () => Promise<void>, signal: AbortSignal) => Promise<RunningServer>;
}

export async function startStorageMaintenance(input: StorageMaintenanceInput): Promise<RunningServer> {
  const { options, homeDir, host, registration, logger } = input;
  const registry = new ConnectionRegistry();
  const audience = new ConnectionAudience(input.admission, input.localOwnerToken, input.validateCredential, () => 'main');
  let normal: RunningServer | undefined;
  let app: FastifyInstance;
  let web: WebAccess;
  let boundPort = input.port;
  let closing = false;
  let closeFlight: Promise<void> | undefined;
  let resolveClosed!: () => void;
  let resolveReceipt!: (receipt: ServerExitReceipt) => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const exitReceipt = new Promise<ServerExitReceipt>((resolve) => { resolveReceipt = resolve; });
  const finish = (receipt: ServerExitReceipt): void => { resolveReceipt(receipt); resolveClosed(); };
  const controller = new StorageMigrationController(input.service, 'maintenance', async (signal) => {
    if (closing) throw new Error('This server is closing');
    const continuation: InstanceRegistration = {
      serverId: registration.serverId, update: (patch) => registration.update(patch),
      release: async () => { if (normal !== undefined || closing) await registration.release(); },
    };
    try {
      normal = await input.startNormal(boundPort, continuation, async () => {
        signal.throwIfAborted();
        await web.close();
        await app.close();
        await input.remoteConnections.close();
        input.admission.closeAll();
      }, signal);
      void normal.exitReceipt.then((receipt) => { if (!closing) finish(receipt); });
    } catch (error) {
      if (!closing && !app.server.listening) await listen();
      throw error;
    }
  });

  async function listen(): Promise<void> {
    app = Fastify({ loggerInstance: logger, disableRequestLogging: true, genReqId: (request) => resolveRequestId(request.headers) }) as unknown as FastifyInstance;
    const webRequests = new WeakSet<IncomingMessage>();
    web = new WebAccess(homeDir, input.serverHomeId, (configuration) => {
      if (options.sshManaged === true || options.disableAuth === true) throw new AdmissionError(403, 'web_access_unavailable');
      return startWebListener(app, configuration, webRequests);
    });
    const hostCheck = createHostCheck({ boundHost: host,
      extra: options.sshManaged === true ? [] : [...parseAllowedHosts(process.env), ...(options.allowedHosts ?? [])],
      disable: options.sshManaged === true ? false : options.disableHostCheck ?? isHostCheckDisabled() });
    const allowedOrigins = options.sshManaged === true ? [] : options.corsOrigins ?? parseCorsOrigins();
    app.server.requestTimeout = 0;
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    installErrorHandler(app);
    app.addHook('onRequest', async (request, reply) => {
      if (webRequests.has(request.raw) && (!web.status().enabled || !web.hostAllowed(request.headers.host))) return reply.code(403).send({ code: 40101, msg: 'web_host_not_allowed' });
      if (!web.hostAllowed(request.headers.host)) return hostCheck.onRequest(request, reply);
    });
    app.addHook('onRequest', createOriginHook({ allowedOrigins }));
    const auth = createAuthHook(input.authTokenService, {
      validateCredential: input.validateCredential,
      authorizeRequest: (token, request, reply) => audience.authorize(token, request, reply),
      authorizeCookie: async (request, reply) => {
        try {
          const principal = web.authenticate(request.raw);
          const path = decodeURIComponent(request.url.split('?', 1)[0]!);
          if (!isWebPathAllowed(request.method, path)) throw new AdmissionError(403, 'local_owner_required');
          setWebPrincipal(request, principal); setWebPrincipal(request.raw, principal);
          reply.header('set-cookie', web.refreshCookie(request.raw));
          return true;
        } catch (error) {
          if (!(error instanceof AdmissionError)) throw error;
          await reply.code(error.status).send({ code: 40101, msg: error.reason }); return false;
        }
      },
    });
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?', 1)[0]!;
      if (request.headers.authorization === undefined && ((path === '/api/web-access/session' && request.method === 'GET') || (['/api/web-access/exchange', '/api/web-access/logout'].includes(path) && request.method === 'POST'))) return;
      return auth(request, reply);
    });
    app.addHook('onSend', async (_request, reply, payload) => { reply.header('cache-control', 'no-store'); reply.header('x-content-type-options', 'nosniff'); return payload; });
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
    registerWebAccessRoutes(app, web);
    registerStorageMigrationRoutes(app, controller);
    app.get('/api/healthz', async () => ({ ok: true }));
    app.get('/api/meta', async (request, reply) => reply.send(okEnvelope({
      server_version: input.serverVersion, build_id: options.buildId ?? process.env['KIKI_BUILD_ID'], build_channel: options.buildChannel ?? process.env['KIKI_BUILD_CHANNEL'],
      server_id: registration.serverId, server_home_id: input.serverHomeId, current_space_id: 'main', started_at: new Date(input.startedAt).toISOString(),
      desktop_managed: process.env['KIKI_DESKTOP_BUNDLED'] === '1', dangerous_bypass_auth: false, backend: 'v2', web_title: options.webTitle,
      capabilities: { websocket: false, file_upload: false, fs_query: false, mcp: false, tasks: false, thread_communication: false },
      external_delegation: { state: 'not_configured' }, experimental_flags: {}, features: [], storage_mode: 'maintenance', storage_status_path: '/api/storage',
    }, request.id)));
    app.get('/api/remote-connections/handshake', async (request, reply) => reply.send(okEnvelope({ identity: input.admission.identity, serverId: registration.serverId, inboundEnabled: input.admission.status().enabled }, request.id)));
    app.get('/api/desktop-lifecycle', async (request, reply) => reply.send(okEnvelope({ server_id: registration.serverId, home_id: 'main', managed: process.env['KIKI_DESKTOP_BUNDLED'] === '1', draining: closing, work_pending: [], impact: 'all-windows-in-this-space' }, request.id)));
    app.post('/api/desktop-lifecycle', async (request, reply) => {
      const body = request.body as { server_id?: unknown } | undefined;
      if (process.env['KIKI_DESKTOP_BUNDLED'] !== '1' || body?.server_id !== registration.serverId) return reply.send(errEnvelope(40001, 'Review the service ownership before stopping it', request.id));
      reply.send(okEnvelope({ ok: true }, request.id)); setImmediate(() => { void close().catch((error: unknown) => logger.error({ err: error }, 'storage maintenance cleanup failed')); });
    });
    app.setNotFoundHandler(async (request, reply) => reply.code(503).send(errEnvelope(50301, 'Complete the mailbox storage upgrade before opening sessions. Read /api/storage for recovery actions.', request.id)));
    if (options.webAssetsDir !== undefined) await registerWebAssetRoutes(app, options.webAssetsDir);
    await app.listen({ host, port: boundPort });
    const address = app.server.address();
    boundPort = typeof address === 'object' && address !== null ? address.port : boundPort;
    await registration.update({ port: boundPort });
    await web.ready();
  }

  function close(): Promise<void> {
    if (closeFlight !== undefined) return closeFlight;
    closing = true;
    closeFlight = (async () => {
      try {
        const errors: unknown[] = [];
        try { await controller.close(); } catch (error) { errors.push(error); }
        const actions = normal === undefined
          ? [() => web?.close(), () => app?.close(), () => input.remoteConnections.close(), () => registration.release()]
          : [() => normal!.close()];
        for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
        input.admission.closeAll();
        if (errors.length > 0) throw new AggregateError(errors, 'Storage maintenance cleanup failed');
        finish({ operationId: randomUUID(), owner: 'backend', exitReason: 'requested', callerOutcome: 'resolved', cleanupOutcome: 'closed', resourcesAfter: 0, settledAt: Date.now() });
      } catch (error) {
        finish({ operationId: randomUUID(), owner: 'backend', exitReason: 'cleanup_failed', callerOutcome: 'rejected', cleanupOutcome: 'cleanup_failed', errorMessage: error instanceof Error ? error.message : String(error), settledAt: Date.now() });
        throw error;
      }
    })();
    return closeFlight;
  }

  try { await listen(); } catch (error) { await close().catch(() => {}); throw error; }
  return {
    get app() { return normal?.app ?? app; },
    get core() { if (normal !== undefined) return normal.core; throw new HomeRuntimeError('mailbox.migration_required', 'The canonical mailbox must be upgraded before starting the engine'); },
    get connectionRegistry() { return normal?.connectionRegistry ?? registry; },
    get authTokenService() { return normal?.authTokenService ?? input.authTokenService; },
    localOwnerToken: input.localOwnerToken,
    get admission() { return normal?.admission ?? input.admission; },
    get remoteConnections() { return normal?.remoteConnections ?? input.remoteConnections; },
    serverId: registration.serverId, host, get port() { return normal?.port ?? boundPort; }, closed, exitReceipt, close,
  };
}
