import {
  bootstrap,
  drainQueryStoreDisposals,
  drainSessionMetadataWrites,
  drainSessionIndexMirror,
  drainLogCloses,
  ConfigWarning,
  CapabilityChanged,
  IAppendLogStore,
  IConfigService,
  IEventService,
  IMcpOAuthService,
  ISessionIndex,
  ISessionIndexMirror,
  ISessionActivityView,
  ISessionInteractionService,
  ICapabilityService,
  IPluginService,
  IPluginHostService,
  IPluginUsageService,
  resolvePluginMarketplaceSource,
  IHomeRuntimeService,
  ISessionManager,
  ISessionMetadata,
  IWorktreeService,
  IThreadCommunicationService,
  IThreadMailboxStore,
  IWorkspaceService,
  PluginChanged,
  IRoomService,
  logSeed,
  resolveConfigPath,
  resolveKikiHome,
  resolveLoggingConfig,
  type ConfigDiagnostic,
  type Scope,
  type ScopeSeed,
} from '@kiki/agent-core-v2';
import { IFlagService } from '@kiki/agent-core-v2/app/flag/flag';
import { panelBoardSeeds } from './transport/klient/panelBoardSeeds';
import { historyArchiveSeed } from './services/historyArchive';
import { historyDirectorySeed } from './services/history/historyDirectory';
import { HistoryLocatorStore } from './services/history/historyLocatorStore';
import { HistoryNavigationDb } from './services/history/historyNavigationDb';
import './services/historyTools';
import { NotificationService } from './services/notifications/notificationService';
import { EXTERNAL_DELEGATION_FLAG_ID } from '@kiki/agent-core-v2/session/externalDelegation/flag';
import {
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from '@kiki/oauth';
import { createAsyncApiDocument } from './protocol/asyncapi';
import type { ExternalDelegationState } from './protocol/rest-meta';
import Fastify, { type FastifyInstance } from 'fastify';

import { installErrorHandler } from './error-handler';
import { createInstanceRegistry, loadOrCreateServerHomeId, type InstanceRegistration } from './instanceRegistry';
import { transformOpenApiDocument } from './openapi/transforms';
import { registerRequestLogging } from './requestLogging';
import { resolveRequestId } from './request-id';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
import { registerWebAssetRoutes } from './routes/webAssets';
import {
  createServerLogger,
  type ServerLogger,
  type ServerLogLevel,
} from './services/pinoLoggerService';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  KLIENT_EVENTS_PATH,
  registerKlientHttp,
} from './transport/klient/registerKlientHttp';
import {
  ConnectionRegistry,
  type IConnectionRegistry,
} from './transport/ws/connectionRegistry';
import { extractWsBearerToken } from './transport/ws/bearerProtocol';
import { SessionEventBroadcaster } from './transport/ws/v1/sessionEventBroadcaster';
import type { ConfigWarningItem } from './transport/ws/v1/events';
import { FsWatchBridge } from './transport/ws/v1/fsWatchBridge';
import { registerWsV1, WS_PATH as WS_PATH_V1 } from './transport/ws/v1/registerWsV1';
import { getServerVersion } from './version';
import { classify } from './security/bindClassify';
import {
  createHostCheck,
  isHostCheckDisabled,
  parseAllowedHosts,
} from './middleware/hostnames';
import { createOriginHook, isOriginAllowed, parseCorsOrigins } from './middleware/origin';
import { createSecurityHeadersHook } from './middleware/securityHeaders';
import { createKimiDeviceId } from '@kiki/oauth';
import { CONNECTION_PROTOCOL } from '@kiki/protocol';
import { loadOrCreateLocalOwnerToken } from './services/auth/localOwner';
import { ConnectionAdmission, AdmissionError } from './services/connections/admission';
import { ConnectionAudience, peerGrant, isWebPathAllowed } from './services/connections/audience';
import { WebAccess, webPrincipal, setWebPrincipal, type WebPrincipal } from './services/webAccess';
import { startWebListener } from './webListener';
import { registerWebAccessRoutes } from './routes/webAccess';
import { IBootstrapService } from '@kiki/agent-core-v2';
import { registerSpaceThreadBridge, isSpaceThreadBridgeDataRequest, authorizeSpaceThreadBridgeRequest, type SpaceThreadBridge } from './services/threadBridge/bridge';
import { RemoteConnectionManager } from './services/connections/manager';
import { SshRemoteConnector } from './services/sshRemote/connector';
import { registerRemoteConnectionRoutes, CONNECTION_BROKER_WS } from './routes/remoteConnections';
import { SpaceSummaryProjection } from './services/connections/spaceSummary';
import { resolveLocalSpaceTransport } from './services/connections/localSpace';
import { createAuthHook } from './middleware/auth';
import { GuiStoreService } from './services/guiStore/guiStoreService';
import { TranscriptService } from './services/transcript/transcriptService';
import { createAuthFailureLimiter } from './middleware/rateLimit';
import {
  createAuthTokenService,
  type IAuthTokenService,
} from './services/auth/authTokenService';
import { createCredentialValidator } from './services/auth/credentials';
import { resolvePasswordHash } from './services/auth/password';
import { createTokenStore, type TokenStore } from './services/auth/tokenStore';
import { LeaseRegistry } from './services/leaseRegistry';
import {
  ensureExternalDelegationSession,
  externalDelegationAuthorityFromEnv,
  ExternalDelegationBootstrapError,
  type ExternalDelegationAuthorityConfig,
} from './mcp/externalDelegationAuthority';
import { ExternalDelegationSeatManager } from './mcp/externalDelegationSeats';
import { registerKikiMcpHttp } from './mcp/http';
import {
  createCompositeSeatResolver,
  createEnvSeatResolver,
  type SeatResolver,
} from './mcp/seatResolver';
import { ExternalDelegationProcedureHost } from './procedures/externalDelegationHost';
import { registerHarnessMcpBridge } from './mcp/harnessBridge';
import {
  createSeatKlientDelegationAuth,
  registerSeatKlientDelegationRoutes,
} from './procedures/http';
import { registerContextRoutes } from './procedures/contextHttp';

import { drainGlobalSearchDisposals, IGlobalSearchService } from './search/searchService';
import {
  drainModelPricingDisposals,
  IModelPricingService,
} from './pricing/modelPricingService';
import { ExternalClientHost } from './externalClients/host';
import { NativeExternalClientListenerManager } from './externalClients/listenerManager';
import { registerExternalClientRoutes } from './externalClients/routes';
import { EXTERNAL_CLIENT_FLAG_ID } from './externalClients/flag';
import { UsageExportRuntime } from './usage/export/runtime';
import { registerUsageExportRoutes } from './routes/usageExport';

export interface ServerHostIdentity extends KimiHostIdentity {
  /** Fills the `${product_name}` slot in the base system prompt. Defaults render the CLI text. */
  readonly displayName?: string;
  /** Replaces the `${reply_style_guide}` block in the base system prompt. */
  readonly replyStyleGuide?: string;
}

export interface ServerStartOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly sshManaged?: boolean;
  /**
   * Environment bag handed to the engine bootstrap (`IBootstrapService.getEnv`).
   * Defaults to `process.env`; hosts that need to override engine-level env
   * reads (e.g. an embedded server pinning `KIKI_CODE_REGION_MARKER=off`)
   * pass a merged bag here instead of mutating the host process's env, which
   * would leak the override into every child process the host spawns.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Plugin marketplace catalog URL for `GET /api/plugins/marketplace`.
   * Takes precedence over `KIKI_PLUGIN_MARKETPLACE_URL` and
   * `[plugins] marketplace_url` in config.toml. An empty or omitted value
   * means the marketplace is unconfigured and is not fetched.
   */
  readonly pluginMarketplaceUrl?: string;
  readonly browserDriverPath?: string;
  readonly configPath?: string;
  readonly modelAccountHomeDir?: string;
  readonly configReadOnly?: boolean;
  readonly userAgentProfileHomeDir?: string;
  /**
   * Override the instance-registry directory — used in tests that need the
   * registry OUTSIDE `homeDir` (e.g. folder-picker fixtures browsing the home
   * dir). Defaults to `<homeDir>/server/instances`.
   */
  readonly instancesDir?: string;
  readonly logLevel?: ServerLogLevel;
  readonly logger?: ServerLogger;
  readonly debugEndpoints?: boolean;
  readonly bindClass?: 'lan' | 'public';
  readonly allowedHosts?: readonly string[];
  readonly corsOrigins?: readonly string[];
  readonly disableHostCheck?: boolean;
  readonly insecureNoTls?: boolean;
  readonly allowRemoteShutdown?: boolean;
  readonly authTokenService?: IAuthTokenService;
  readonly disableAuth?: boolean;
  readonly sshRemoteConnector?: SshRemoteConnector;
  /**
   * Custom browser tab title for this web UI instance (the CLI's
   * `--web-title`). Surfaced as `web_title` in `GET /api/meta` so the web
   * UI can distinguish multiple instances on different machines. Instance-level
   * and frozen at boot; omit to let the UI fall back to `<workspace dir> | Kiki`.
   */
  readonly webTitle?: string;
  /**
   * Optional *additional* credential accepted on the RPC surface (debug REST +
   * WebSocket) alongside the persistent bearer token. Never required and never
   * the only gate: the persistent token always protects the RPC surface. Leave
   * unset unless a second, distinct RPC credential is genuinely needed.
   */
  readonly rpcToken?: string;
  /** Operator-owned authority for the experimental external-delegation edge. */
  readonly externalDelegation?: ExternalDelegationAuthorityConfig;
  readonly idleExitMs?: number;
  readonly leaseTtlMs?: number;
  readonly mcpSeatResolver?: SeatResolver;
  /** Extra scope seeds applied at bootstrap (e.g. a host-provided `ISessionModelResolver`). */
  readonly seeds?: ScopeSeed;
  /**
   * Identity of the host product embedding the server: feeds the engine's
   * `bootstrap()` client identity, the default outbound request headers
   * (User-Agent + `X-Msh-*` via `createKimiDefaultHeaders`), and the session
   * export manifest. Applied to every agent and request the server hosts —
   * required, so every host states its own product name, version, and
   * platform explicitly.
   */
  readonly hostIdentity: ServerHostIdentity;
  /**
   * Explicit skill directories for this process (v1's SDK `skillDirs`): when
   * non-empty, default user / project skill discovery is skipped and these
   * directories serve as the user skill source for every session. Applied to
   * all sessions the server hosts — for embedding hosts, not per-session use.
   */
  readonly skillDirs?: readonly string[];
  readonly userSkillDir?: string;
  /**
   * Directory of the built Kimi web UI. When set, `GET /` and the
   * `/*` SPA fallback serve these assets (auth-exempt, matching v1). Omit to run
   * the API server without the web UI.
   */
  readonly webAssetsDir?: string;
  /**
   * Engine version, reported as `server_version` (GET /api/meta), in the
   * OpenAPI document, and in the lock / instance registry. Defaults to
   * kap-server's own package version; the host product version travels in
   * `hostIdentity.version` instead.
   */
  readonly serverVersion?: string;
  readonly buildId?: string;
  readonly buildChannel?: string;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly core: Scope;
  readonly connectionRegistry: IConnectionRegistry;
  readonly authTokenService: IAuthTokenService;
  readonly localOwnerToken: string;
  readonly admission: ConnectionAdmission;
  readonly remoteConnections: RemoteConnectionManager;
  readonly serverId: string;
  readonly host: string;
  readonly port: number;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 58627;

export async function startServer(opts: ServerStartOptions): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const homeDir = resolveKikiHome(opts.homeDir);
  if (opts.sshManaged === true && (
    process.platform !== 'linux' || host !== '127.0.0.1' ||
    opts.disableAuth === true || opts.disableHostCheck === true ||
    opts.debugEndpoints === true || opts.authTokenService !== undefined ||
    opts.rpcToken !== undefined || opts.allowRemoteShutdown === true || opts.idleExitMs !== undefined
  )) {
    throw new Error('SSH-managed servers require loopback, persistent bearer authentication, and no debug or idle shutdown');
  }
  const serverHomeId = await loadOrCreateServerHomeId(homeDir, opts.sshManaged === true);
  const localOwnerToken = await loadOrCreateLocalOwnerToken(homeDir);
  const connectionIdentity = { homeId: serverHomeId, hostId: createKimiDeviceId(homeDir), protocol: CONNECTION_PROTOCOL } as const;
  const admission = new ConnectionAdmission(homeDir, connectionIdentity, opts.disableAuth === true ? 'dangerous_auth_bypass' : undefined);
  const serverVersion = opts.serverVersion ?? getServerVersion();
  const sshRemote = opts.sshRemoteConnector ?? new SshRemoteConnector({ serverVersion });
  const remoteConnections = new RemoteConnectionManager(homeDir, connectionIdentity, sshRemote, (spaceId, target, signal) => resolveLocalSpaceTransport(core, spaceId, target, signal));
  await Promise.all([admission.ready(), remoteConnections.ready()]);
  const buildId = opts.buildId ?? process.env['KIKI_BUILD_ID'];
  const buildChannel = opts.buildChannel ?? process.env['KIKI_BUILD_CHANNEL'];
  const startedAt = Date.now();
  const logger = opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });
  const externalDelegation = opts.externalDelegation === undefined
    ? externalDelegationAuthorityFromEnv(process.env)
    : {
        ...opts.externalDelegation,
        sessionOwnership: opts.externalDelegation.sessionOwnership ?? 'dedicated',
      };
  const registry = createInstanceRegistry({
    instancesDir: opts.instancesDir ?? join(homeDir, 'server', 'instances'),
  });
  const registration: InstanceRegistration = await registry.register({
    pid: process.pid,
    host,
    port,
    startedAt,
    serverVersion,
    buildId,
    buildChannel,
  });
  const exposureClass = classify(host, { bindClass: opts.bindClass });
  if (exposureClass !== 'loopback' && opts.insecureNoTls !== true) {
    await registration.release();
    throw new Error(
      `Refusing to bind ${host} (${exposureClass}) without TLS; terminate TLS at a reverse proxy or pass --insecure-no-tls.`,
    );
  }
  const enableShutdown = exposureClass === 'loopback' || opts.allowRemoteShutdown === true;
  const enableTerminals = exposureClass === 'loopback';
  const debugEndpoints = exposureClass === 'loopback' && opts.debugEndpoints === true;
  const authFailureLimiter =
    exposureClass === 'loopback' ? undefined : createAuthFailureLimiter({ logger });

  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const guiStore = new GuiStoreService(homeDir, logger);
  let authTokenService: IAuthTokenService;
  let managedTokenStore: TokenStore | undefined;
  let passwordConfigured = false;
  if (opts.authTokenService !== undefined) {
    authTokenService = opts.authTokenService;
  } else {
    const tokenStore = await createTokenStore(homeDir, { managed: opts.sshManaged === true });
    managedTokenStore = tokenStore;
    const passwordHash = opts.sshManaged === true ? undefined : await resolvePasswordHash();
    passwordConfigured = passwordHash !== undefined;
    authTokenService = createAuthTokenService({ tokenStore, passwordHash });
  }
  const validateCredential = createCredentialValidator(authTokenService, opts.rpcToken);
  const audience = new ConnectionAudience(admission, localOwnerToken, validateCredential, () => core.accessor.get(IBootstrapService).spaceId ?? 'main');
  let threadBridge: SpaceThreadBridge | undefined;
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  const navigationDb = HistoryNavigationDb.lazy(join(homeDir, 'server', 'history-navigation.sqlite'));
  let locator: HistoryLocatorStore | undefined;
  const navigation = (): HistoryLocatorStore => locator ??= new HistoryLocatorStore(
    navigationDb, transcriptService,
  );
  const { app: core } = bootstrap(
    {
      homeDir,
      configPath,
      modelAccountHomeDir: opts.modelAccountHomeDir,
      configReadOnly: opts.configReadOnly,
      userAgentProfileHomeDir: opts.userAgentProfileHomeDir,
      env: opts.env,
      clientIdentity: opts.hostIdentity,
      args: {
        requestHeaders: createKimiDefaultHeaders({
          homeDir: opts.modelAccountHomeDir ?? homeDir,
          ...opts.hostIdentity,
        }),
        skillDirs: opts.skillDirs,
        browserDriverPath: opts.browserDriverPath,
        userSkillDir: opts.userSkillDir,
        displayName: opts.hostIdentity.displayName,
        replyStyleGuide: opts.hostIdentity.replyStyleGuide,
      },
    },
    [...logSeed(logging), ...panelBoardSeeds(() => core),
      ...historyArchiveSeed(() => core, () => transcriptService, navigation),
      ...historyDirectorySeed(() => transcriptService, navigation), ...(opts.seeds ?? [])],
  );

  await core.accessor.get(IPluginHostService).ready.catch(() => {
    logger.warn({ event_type: 'plugin_app_activation_failed' }, 'An App plugin could not start; open its settings to recover');
  });

  if (exposureClass !== 'loopback') {
    logger.warn(
      { host, exposureClass },
      'binding non-loopback host without TLS — use a reverse proxy or tunnel in production',
    );
    if (!passwordConfigured) {
      logger.warn(
        { host, exposureClass },
        'binding non-loopback host with token-only auth (no KIKI_PASSWORD) — the bearer token printed in the startup banner is the only credential protecting this server',
      );
    }
  }
  await core.accessor.get(IConfigService).ready;
  await core.accessor.get(IModelPricingService).ready;
  const usageExport = new UsageExportRuntime(core, homeDir);
  const externalClients = new ExternalClientHost(core);
  const externalClientListener = new NativeExternalClientListenerManager(externalClients);
  if (core.accessor.get(IFlagService).enabled(EXTERNAL_CLIENT_FLAG_ID)) {
    await externalClients.initialize();
    await externalClientListener.initialize();
  }

  const runPostListenWarmup = async (): Promise<void> => {
    try {
      await core.accessor.get(ISessionIndex).prepare();
    } catch (error) {
      if (shutdownController.signal.aborted) return;
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'session index prepare failed; list requests remain unavailable until recovery',
      );
    }
    if (shutdownController.signal.aborted) return;

    try {
      await core.accessor.get(IWorkspaceService).list();
    } catch (error) {
      if (shutdownController.signal.aborted) return;
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'workspace catalog startup sync failed',
      );
    }
  };

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: true,
    genReqId: (req) => resolveRequestId(req.headers),
  }) as unknown as FastifyInstance;
  const webRequests = new WeakSet<IncomingMessage>();
  const web = new WebAccess(homeDir, serverHomeId, (input) => {
    if (opts.sshManaged === true || opts.disableAuth === true) throw new AdmissionError(403, 'web_access_unavailable');
    return startWebListener(app, input, webRequests);
  });
  let seatResolver!: SeatResolver;
  const seatDelegationAuth = exposureClass === 'loopback'
    ? createSeatKlientDelegationAuth(() => seatResolver)
    : undefined;
  if (seatDelegationAuth !== undefined) {
    app.addHook('onRequest', (request, reply) => seatDelegationAuth.onRequest(request, reply));
  }
  app.server.requestTimeout = 0;
  registerRequestLogging(app);
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installErrorHandler(app);
  const hostCheck = createHostCheck({
    boundHost: host,
    extra: opts.sshManaged === true ? [] : [...parseAllowedHosts(process.env), ...(opts.allowedHosts ?? [])],
    disable: opts.sshManaged === true ? false : opts.disableHostCheck ?? isHostCheckDisabled(),
  });
  const allowedOrigins = opts.sshManaged === true ? [] : opts.corsOrigins ?? parseCorsOrigins();
  app.addHook('onRequest', async (request, reply) => {
    if (webRequests.has(request.raw) && (!web.status().enabled || !web.hostAllowed(request.headers.host))) return reply.code(403).send({ code: 40101, msg: 'web_host_not_allowed' });
    if (!web.hostAllowed(request.headers.host)) return hostCheck.onRequest(request, reply);
  });
  app.addHook('onRequest', createOriginHook({ allowedOrigins }));
  const authHook = createAuthHook(authTokenService, {
    bypassSeatDelegation: exposureClass === 'loopback',
    limiter: authFailureLimiter,
    validateCredential,
    authorizeCookie: async (request, reply) => {
      try {
        const principal = web.authenticate(request.raw);
        const path = decodeURIComponent(request.url.split('?', 1)[0]!);
        if (!isWebPathAllowed(request.method, path)) throw new AdmissionError(403, 'local_owner_required');
        setWebPrincipal(request, principal); setWebPrincipal(request.raw, principal);
        reply.header('set-cookie', web.refreshCookie(request.raw));
        const detach = web.attach(principal, () => { request.raw.destroy(); reply.raw.destroy(); });
        reply.raw.once('close', detach);
        return true;
      } catch (error) {
        if (!(error instanceof AdmissionError)) throw error;
        await reply.code(error.status).send({ code: 40101, msg: error.reason }); return false;
      }
    },
    authorizeRequest: async (token, request, reply) => {
      if (isSpaceThreadBridgeDataRequest(request)) {
        if (threadBridge === undefined) { await reply.code(503).send({ code: 40101, msg: 'bridge_unavailable' }); return false; }
        return authorizeSpaceThreadBridgeRequest(threadBridge, token, request, reply);
      }
      return audience.authorize(token, request, reply);
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    let path: string;
    try { path = decodeURIComponent(request.url.split('?', 1)[0]!); } catch { return authHook(request, reply); }
    if (path.startsWith('/api/web-access')) reply.header('cache-control', 'no-store');
    if (request.headers.authorization === undefined && ((path === '/api/web-access/session' && request.method === 'GET') || (['/api/web-access/exchange', '/api/web-access/logout'].includes(path) && request.method === 'POST'))) return;
    if (webRequests.has(request.raw) && (/^\/api\/(?:debug|klient\/delegation)(?:\/|$)/.test(path) || path === '/mcp')) return reply.code(403).send({ code: 40101, msg: 'local_owner_required' });
    const d24 = /^\/api\/(?:web-access|remote-connections|thread-bridges|thread-bridge|usage-export|external-clients)(?:\/|$)/.test(path);
    if (opts.disableAuth !== true || d24 || peerGrant(request.headers) !== undefined) return authHook(request, reply);
  });
  if (opts.disableAuth === true) {
    logger.warn(
      { host, exposureClass },
      'DANGEROUS: legacy REST and WebSocket authentication is disabled; connection management still requires local owner and peer admission is unavailable',
    );
  }
  if (exposureClass !== 'loopback') {
    app.addHook('onSend', createSecurityHeadersHook({ tls: false }));
  }

  app.addHook('onSend', async (request, reply, payload) => {
    if (webPrincipal(request) !== undefined || request.url.startsWith('/api/web-access') || reply.statusCode === 401 || reply.statusCode === 403) reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });
  registerWebAccessRoutes(app, web);
  const shutdownController = new AbortController();
  const unrequestedSockets = new Set<Socket>();
  app.server.on('connection', (socket) => {
    if (shutdownController.signal.aborted) { socket.destroy(); return; }
    unrequestedSockets.add(socket);
    socket.once('close', () => unrequestedSockets.delete(socket));
  });
  const claimSocket = (request: IncomingMessage): void => { unrequestedSockets.delete(request.socket); };
  app.server.on('request', claimSocket);
  app.server.on('upgrade', claimSocket);
  shutdownController.signal.addEventListener('abort', () => {
    for (const socket of unrequestedSockets) socket.destroy();
    unrequestedSockets.clear();
  }, { once: true });
  app.addHook('onResponse', async () => {
    if (shutdownController.signal.aborted) app.server.closeIdleConnections();
  });
  const leaseRegistry = new LeaseRegistry(opts.leaseTtlMs, Date.now, () => {
    logger.warn({ event_type: 'lease_expiry_cleanup_failed' }, 'lease resource expiry cleanup failed');
  });
  let notifications: NotificationService | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let authMonitor: NodeJS.Timeout | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const doClose = async (): Promise<void> => {
    shutdownController.abort();
    if (idleTimer !== undefined) clearInterval(idleTimer);
    if (authMonitor !== undefined) clearInterval(authMonitor);
    const closeErrors: unknown[] = [];
    try { await web.close(); } catch (error) { closeErrors.push(error); }
    try { await externalClientListener.close(); await externalClients.close(); } catch (error) { closeErrors.push(error); }
    try {
      leaseRegistry.dispose();
    } catch (error) {
      closeErrors.push(error);
      logger.warn({ event_type: 'lease_registry_dispose_failed' }, 'lease registry dispose failed; continuing server cleanup');
    }
    let appClosing: Promise<void>;
    try {
      appClosing = app.close().catch((error) => {
        closeErrors.push(error);
        logger.warn({ event_type: 'http_listener_close_failed' }, 'http listener close failed; continuing server cleanup');
      });
    } catch (error) {
      closeErrors.push(error);
      logger.warn({ event_type: 'http_listener_close_failed' }, 'http listener close failed; continuing server cleanup');
      appClosing = Promise.resolve();
    }
    await appClosing;
    try { await notifications?.close(); }
    catch (error) {
      closeErrors.push(error);
      logger.warn({ event_type: 'notifications_close_failed' }, 'notification service close failed');
    }
    try {
      await core.accessor.get(IThreadCommunicationService).shutdown();
    } catch (error) {
      closeErrors.push(error);
      logger.warn({ event_type: 'thread_communication_shutdown_failed' }, 'thread communication shutdown failed; continuing server cleanup');
    }
    const sessionManager = core.accessor.get(ISessionManager);
    for (const session of sessionManager.list()) {
      try {
        const ephemeral = sessionManager.isEphemeral(session.id);
        const worktreeId = ephemeral
          ? (await session.accessor.get(ISessionMetadata).read().catch(() => undefined))?.worktree?.worktreeId
          : undefined;
        await sessionManager.close(session.id);
        if (worktreeId !== undefined) {
          const { outcome } = await core.accessor.get(IWorktreeService).remove(worktreeId);
          if (outcome !== 'removed') logger.warn({ sessionId: session.id, worktreeId, outcome }, 'temporary session worktree retained on shutdown');
        }
      } catch (error) {
        closeErrors.push(error);
        logger.warn({ sessionId: session.id, event_type: 'session_close_failed' }, 'session close failed; continuing server cleanup');
      }
    }
    try {
      await core.accessor.get(IThreadMailboxStore).close();
    } catch (error) {
      closeErrors.push(error);
      logger.warn({ event_type: 'thread_mailbox_close_failed' }, 'thread mailbox close failed; continuing server cleanup');
    }
    try {
      await core.accessor.get(IHomeRuntimeService).close();
    } catch (error) {
      closeErrors.push(error);
      logger.warn({ event_type: 'home_runtime_close_failed' }, 'home runtime close failed; continuing server cleanup');
    }
    roomChangeSubscription.dispose();
    configWarningSubscription.dispose();
    pluginChangeSubscription.dispose();
    pluginUsageChangeSubscription.dispose();
    pluginUsageApplySubscription.dispose();
    capabilityInstallSubscription.dispose();
    authFailureLimiter?.dispose();
    transcriptService.dispose();
    try { await navigationDb.close(); }
    catch (error) {
      closeErrors.push(error);
      logger.warn({ event_type: 'history_navigation_close_failed' }, 'history navigation close failed');
    }
    try {
      await drainSessionMetadataWrites();
      await core.accessor.get(ISessionIndexMirror).drain();
      await core.accessor.get(IMcpOAuthService).shutdown();
      await core.accessor.get(IPluginHostService).stopAll();
      fsWatchBridge.dispose();
      const appendLogStore = core.accessor.get(IAppendLogStore);
      await core.dispose();
      await appendLogStore.drainRetirements();
      await drainSessionIndexMirror();
      await drainModelPricingDisposals();
      await drainGlobalSearchDisposals();
      await drainQueryStoreDisposals();
      await drainSessionMetadataWrites();
      await drainLogCloses();
    } catch (error) {
      closeErrors.push(error);
    } finally {
      try {
        await registration.release();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (closeErrors.length === 1) throw closeErrors[0];
    if (closeErrors.length > 1) throw new AggregateError(closeErrors, 'server close failed');
  };
  let closeFlight: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeFlight === undefined) {
      closeFlight = doClose();
      void closeFlight.then(resolveClosed, resolveClosed);
    }
    return closeFlight;
  };

  const connectionRegistry = new ConnectionRegistry();
  const transcriptService = new TranscriptService({ homeDir, core, logger });
  transcriptService.setHistoryLocatorReader(navigation);
  const broadcaster = new SessionEventBroadcaster({
    eventsDir: join(homeDir, 'server', 'events'),
    core,
    logger,
    transcriptService,
  });
  const roomChangeSubscription = core.accessor.get(IRoomService).onDidChange((change) => {
    broadcaster.publishRoomChanged(change);
  });
  const fsWatchBridge = new FsWatchBridge({ core, logger });

  const configService = core.accessor.get(IConfigService);
  const publishConfigWarnings = (diagnostics: readonly ConfigDiagnostic[]): void => {
    const warnings: ConfigWarningItem[] = diagnostics
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) =>
        diagnostic.domain === undefined
          ? { message: diagnostic.message }
          : { domain: diagnostic.domain, message: diagnostic.message },
      );
    core.accessor.get(IEventService).publish(new ConfigWarning({ payload: { warnings } }));
  };
  const configWarningSubscription = configService.onDidChangeDiagnostics(publishConfigWarnings);

  const pluginService = core.accessor.get(IPluginService);
  const pluginChangeSubscription = pluginService.onDidReload(() => {
    core.accessor.get(IEventService).publish(new PluginChanged({ payload: {} }));
  });
  const pluginUsage = core.accessor.get(IPluginUsageService);
  const pluginUsageChangeSubscription = pluginUsage.onDidChange(() => {
    core.accessor.get(IEventService).publish(new PluginChanged({ payload: {} }));
  });
  const pluginUsageApplySubscription = pluginUsage.onDidApply(() => {
    core.accessor.get(IEventService).publish(new PluginChanged({ payload: {} }));
  });
  const capabilityService = core.accessor.get(ICapabilityService);
  const capabilityInstallSubscription = capabilityService.onDidChangeInstall((change) => {
    core.accessor.get(IEventService).publish(
      new CapabilityChanged({
        payload: { capability_id: change.id, install: change.install },
      }),
    );
  });
  void configService.ready
    .then(() => {
      if (configService.diagnostics().some((diagnostic) => diagnostic.severity === 'warning')) {
        publishConfigWarnings(configService.diagnostics());
      }
    })
    .catch(() => {
    });

  await configService.ready;
  notifications = new NotificationService(core, homeDir,
    (sessionId) => broadcaster.isSessionViewed(sessionId),
    () => logger.warn({ event_type: 'notification_operation_failed' }, 'notification operation failed'));
  await notifications.start();
  const externalDelegationEnabled = core.accessor
    .get(IFlagService)
    .enabled(EXTERNAL_DELEGATION_FLAG_ID);
  let externalDelegationState: ExternalDelegationState = externalDelegationEnabled
    ? { state: 'active' }
    : { state: 'disabled', reason: 'feature_disabled' };
  if (externalDelegationEnabled) {
    try {
      await ensureExternalDelegationSession(core, externalDelegation);
      if (externalDelegation?.sessionBootstrap !== undefined) {
        await registration.update({ workspaces: [externalDelegation.sessionBootstrap.workspacePath] });
      }
    } catch (error) {
      const reason = error instanceof ExternalDelegationBootstrapError
        ? error.reason
        : 'bootstrap_failed';
      const message = error instanceof Error ? error.message : String(error);
      externalDelegationState = { state: 'disabled', reason, message };
      logger.warn(
        { event_type: 'external_delegation_bootstrap_failed', reason },
        'external delegation Session bootstrap failed; disabling the edge and continuing server startup',
      );
    }
  }
  const seatManager = new ExternalDelegationSeatManager(
    core,
    homeDir,
    (workspace) => registration.update({ workspaces: [workspace] }),
  );

  async function registerOpenApi(): Promise<void> {
    const { default: swagger } = await import('@fastify/swagger');
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Kiki Server API',
          description:
            'REST API for the Kiki local server. All JSON responses are wrapped in a uniform envelope `{ code, msg, data, request_id }`.',
          version: serverVersion,
        },
        tags: [
          { name: 'meta', description: 'Server metadata' },
          { name: 'auth', description: 'Auth readiness & login state' },
          { name: 'models', description: 'Configured model aliases' },
          { name: 'providers', description: 'Configured providers' },
          { name: 'sessions', description: 'Session lifecycle' },
          { name: 'v2-sessions', description: 'Domain-grouped advanced session list query' },
          { name: 'workspaces', description: 'Workspace registry + folder picker' },
          { name: 'messages', description: 'Message history' },
          { name: 'search', description: 'Global message search' },
          { name: 'transcript', description: 'Turn-granular session transcript' },
          { name: 'threads', description: 'Host-qualified peer-thread communication' },
          { name: 'prompts', description: 'Prompt submission & abort' },
          { name: 'approvals', description: 'Approval resolution' },
          { name: 'questions', description: 'Question resolution & dismiss' },
          { name: 'tools', description: 'Tool & MCP server management' },
          { name: 'tasks', description: 'Task management' },
          { name: 'terminals', description: 'PTY terminal sessions' },
          { name: 'fs', description: 'Filesystem operations' },
          { name: 'files', description: 'File upload & download' },
        ],
      },
      transformObject: (documentObject) => {
        if (!('openapiObject' in documentObject)) {
          return documentObject.swaggerObject;
        }
        return transformOpenApiDocument(documentObject.openapiObject as Record<string, unknown>);
      },
    });
  }

  await registerOpenApi();
  await app.register(async api => registerExternalClientRoutes(api, externalClients, externalClientListener,
    () => core.accessor.get(IFlagService).enabled(EXTERNAL_CLIENT_FLAG_ID), transcriptService), { prefix: '/api' });

  await registerApiV1Routes(app, core, {
    serverVersion,
    buildId,
    buildChannel,
    serverId: registration.serverId,
    serverHomeId,
    startedAt: new Date(startedAt).toISOString(),
    hostIdentity: opts.hostIdentity,
    debugEndpoints,
    enableShutdown,
    enableTerminals,
    guiStore,
    notifications,
    themesDir: join(homeDir, 'themes'),
    pluginBridgeServerToken: () => authTokenService.getToken(),
    pluginMarketplaceUrl: () =>
      resolvePluginMarketplaceSource({
        optionUrl: opts.pluginMarketplaceUrl,
        envUrl: process.env['KIKI_PLUGIN_MARKETPLACE_URL'],
        configUrl: core.accessor.get(IConfigService).get<{ marketplaceUrl?: string }>('plugins')
          ?.marketplaceUrl,
      }),
    onShutdown: () => {
      void close().catch(() => logger.error({ event_type: 'server_close_failed' }, 'server close failed'));
    },
    shutdownSignal: shutdownController.signal,
    connectionRegistry,
    broadcaster,
    transcriptService,
    leaseRegistry,
    onWorkspaceServed: (workspace) => registration.update({ workspaces: [workspace] }),
    onWorkspaceRemoved: (workspace) => registration.update({ removedWorkspaces: [workspace] }),
    dangerousBypassAuth: opts.disableAuth === true,
    externalDelegation: externalDelegationState,
    apiV2: {
      externalDelegation,
      externalDelegationState,
      seatManager,
    },
    webTitle: opts.webTitle,
  });

  const runtimeSeatResolver: SeatResolver = {
    resolve: async (bearer) => (await seatManager.resolveBearer(bearer)) ?? null,
  };
  const envSeatResolver =
    externalDelegation !== undefined && externalDelegationState.state === 'active'
      ? createEnvSeatResolver({
          seatId: `external:${externalDelegation.sessionId}`,
          principalId: externalDelegation.principalId,
          sessionId: externalDelegation.sessionId,
          delegationToken: externalDelegation.token,
        })
      : undefined;
  seatResolver = createCompositeSeatResolver(
    createCompositeSeatResolver(
      exposureClass === 'loopback' ? registerHarnessMcpBridge(core, app) : undefined,
      createCompositeSeatResolver(runtimeSeatResolver, opts.mcpSeatResolver),
    ),
    envSeatResolver,
  );
  const externalDelegationHost = new ExternalDelegationProcedureHost(core);
  if (exposureClass === 'loopback') {
    registerSeatKlientDelegationRoutes(app, externalDelegationHost, seatDelegationAuth!);
    registerContextRoutes(app, core, seatDelegationAuth!);
    registerKikiMcpHttp(app, {
      seatResolver,
      resolveKlient: async (seat) => {
        const { delegationToken: _delegationToken, ...authoritySeat } = seat;
        return externalDelegationHost.klient({
          ...authoritySeat,
          workspacePath:
            seat.workspacePath ??
            (await resolveSeatWorkspacePath(core, seat.sessionId, externalDelegation)),
        });
      },
    });
  }

  const wssKlient = registerKlientHttp(app, core, {
    enableTerminals,
    sessionViewBroadcaster: broadcaster,
    sessionViewTranscriptService: transcriptService,
  });
  const wssBroker = registerRemoteConnectionRoutes(app, admission, remoteConnections, registration.serverId, () => authTokenService.getToken(), sshRemote);
  threadBridge = await registerSpaceThreadBridge(app, core, admission, remoteConnections, transcriptService, shutdownController.signal);
  registerUsageExportRoutes(app, usageExport.service);
  app.addHook('preClose', () => usageExport.close());
  const spaceSummary = new SpaceSummaryProjection(core);
  app.get('/api/space-summary', async (_request, reply) => reply.send({ code: 0, msg: 'OK', data: spaceSummary.read() }));
  app.addHook('onClose', async () => { spaceSummary.dispose(); await spaceSummary.disposeAsync(); });
  const wssV1 = registerWsV1(core, {
    validateCredential: (token) => audience.authorizeSocket(token, { url: WS_PATH_V1, headers: {} } as IncomingMessage).then(() => true, () => false),
    registry: connectionRegistry,
    broadcaster,
    fsWatchBridge,
    enableTerminals,
    logger,
  });
  const wsAuthGeneration = new WeakMap<object, number>();
  if (managedTokenStore !== undefined) {
    let authGeneration = managedTokenStore.generation();
    authMonitor = setInterval(() => {
      const next = managedTokenStore.generation();
      if (next === authGeneration) return;
      authGeneration = next;
      admission.closeAll();
      for (const socket of [...wssV1.clients, ...wssKlient.clients, ...wssKlient.peerServer.clients, ...wssBroker.clients]) {
        if (wsAuthGeneration.get(socket) !== next) socket.close(4001, 'server authentication changed');
      }
    }, 250);
    authMonitor.unref();
  }

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const url = req.url ?? '';
    const isV1 = url === WS_PATH_V1 || url.startsWith(`${WS_PATH_V1}?`);
    const isKlient = url === KLIENT_EVENTS_PATH || url.startsWith(`${KLIENT_EVENTS_PATH}?`);
    const isBroker = CONNECTION_BROKER_WS.test(url);
    if (!isV1 && !isKlient && !isBroker) {
      socket.destroy();
      return;
    }

    if ((webRequests.has(req) && (!web.status().enabled || !web.hostAllowed(req.headers.host))) || (!web.hostAllowed(req.headers.host) && !hostCheck.isAllowed(req.headers.host))) {
      logger.warn(
        { remoteAddress: req.socket.remoteAddress, path: url, reason: 'host_not_allowed' },
        'ws upgrade rejected',
      );
      (socket as Socket).write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      (socket as Socket).destroy();
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host, allowedOrigins)) {
      logger.warn(
        { remoteAddress: req.socket.remoteAddress, path: url, reason: 'origin_not_allowed' },
        'ws upgrade rejected',
      );
      (socket as Socket).write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      (socket as Socket).destroy();
      return;
    }

    const admittedGeneration = managedTokenStore?.generation();
    let admitted: Awaited<ReturnType<ConnectionAudience['authorizeSocket']>> = 'local';
    let browser: WebPrincipal | undefined;
    if (opts.disableAuth !== true || isBroker || peerGrant(req.headers) !== undefined) {
      const header = req.headers.authorization;
      const protocolToken = extractWsBearerToken(req.headers['sec-websocket-protocol']);
      const hasBearerProtocol = req.headers['sec-websocket-protocol']?.split(',').some((entry) => entry.trim().startsWith('kimi-code.bearer.')) === true;
      const candidate = header === undefined ? hasBearerProtocol ? protocolToken ?? '' : null : header.startsWith('Bearer ') ? header.slice(7) : '';
      try {
        if (header === undefined && !hasBearerProtocol) {
          web.requireOrigin(req); browser = web.authenticate(req); setWebPrincipal(req, browser);
        } else admitted = await audience.authorizeSocket(candidate, req);
        if (isBroker && admitted !== 'local') throw new AdmissionError(403, 'local_owner_required');
        if (admittedGeneration !== undefined && admittedGeneration !== managedTokenStore?.generation()) throw new AdmissionError(401, 'authentication_changed');
      } catch (error) {
        const status = error instanceof AdmissionError ? error.status : 401;
        (socket as Socket).write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
    }
    (socket as Socket).setNoDelay(true);
    const wss = isBroker ? wssBroker : isV1 ? wssV1 : admitted === 'local' ? wssKlient : wssKlient.peerServer;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (admittedGeneration !== undefined) {
        wsAuthGeneration.set(ws, admittedGeneration);
        if (admittedGeneration !== managedTokenStore?.generation()) { ws.close(4001, 'server authentication changed'); return; }
      }
      if (browser !== undefined) {
        const detach = web.attach(browser, () => ws.terminate()); ws.once('close', detach);
        if (ws.readyState !== 1) return;
      }
      if (admitted !== 'local') {
        const detach = admission.attach(admitted.grantId, () => { ws.terminate(); });
        ws.once('close', detach);
        try { admission.authorize((req.headers['x-kiki-connection-grant'] as string | undefined) ?? req.headers['sec-websocket-protocol']?.split(',').find((p) => p.trim().startsWith('kiki.grant.'))?.trim().slice(11)); }
        catch { ws.close(4001, 'connection revoked'); return; }
      }
      wss.emit('connection', ws, req);
    });
  };
  app.server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch(() =>
      logger.error({ event_type: 'ws_upgrade_failed' }, 'ws upgrade handler failed'),
    );
  });

  app.addHook('onClose', async () => {
    connectionRegistry.closeAll('server shutting down');
    wssV1.close();
    await broadcaster.close();
  });

  app.get('/asyncapi.json', async (_req, reply) => {
    return reply
      .type('application/json')
      .send(
        createAsyncApiDocument({
          version: serverVersion,
          serverHost: host,
          enableTerminals,
        }),
      );
  });

  app.get('/openapi.json', async (_req, reply) => {
    const openApiDocument = (app as unknown as { swagger(): unknown }).swagger();
    return reply.type('application/json').send(openApiDocument);
  });

  if (opts.webAssetsDir !== undefined) {
    await registerWebAssetRoutes(app, opts.webAssetsDir);
  }

  try {
    await listenWithPortRetry({
      listen: (h, p) => app.listen({ host: h, port: p }),
      host,
      port,
      logger,
    });
  } catch (error) {
    try {
      await close();
    } catch {
    }
    throw error;
  }

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  await registration.update({ port: boundPort });
  try { await web.ready(); } catch (error) { await close(); throw error; }
  remoteConnections.start();
  usageExport.start();
  try {
    core.accessor.get(IGlobalSearchService).setLiveTranscriptSource(transcriptService);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'global search startup failed; server remains available',
    );
  }
  void runPostListenWarmup().catch((error: unknown) => {
    if (shutdownController.signal.aborted) return;
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'post-listen warmup failed; server remains available',
    );
  });

  if (opts.idleExitMs !== undefined) {
    const idleExitMs = opts.idleExitMs;
    let idleSince = Date.now();
    const intervalMs = Math.min(1_000, Math.max(10, Math.floor(idleExitMs / 4)));
    idleTimer = setInterval(() => {
      const busy = core.accessor
        .get(ISessionManager)
        .list()
        .some((session) => idleExitBlocked(
          session.accessor.get(ISessionActivityView).state(),
          session.accessor.get(ISessionInteractionService).listPending('user_tool').length,
        ));
      if (web.status().enabled || leaseRegistry.activeCount() > 0 || admission.activeCount() > 0 || remoteConnections.activeCount() > 0 || busy) {
        idleSince = Date.now();
        return;
      }
      if (Date.now() - idleSince >= idleExitMs) {
        void close().catch(() => logger.error({ event_type: 'idle_server_close_failed' }, 'idle server close failed'));
      }
    }, intervalMs);
    idleTimer.unref();
  }

  return {
    app,
    core,
    connectionRegistry,
    authTokenService,
    localOwnerToken,
    admission,
    remoteConnections,
    serverId: registration.serverId,
    host,
    port: boundPort,
    closed,
    close,
  };
}

export function idleExitBlocked(activity: { readonly busy: boolean; readonly pendingInteraction: string }, pendingUserTools: number): boolean {
  return activity.busy || activity.pendingInteraction !== 'none' || pendingUserTools > 0;
}

async function resolveSeatWorkspacePath(
  core: Scope,
  sessionId: string,
  authority: ExternalDelegationAuthorityConfig | undefined,
): Promise<string | undefined> {
  if (authority?.sessionId === sessionId && authority.sessionBootstrap !== undefined) {
    return authority.sessionBootstrap.workspacePath;
  }
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  return summary?.cwd;
}

/**
 * Maximum consecutive `EADDRINUSE` retries when the requested port is busy.
 * Caps the `port + 1` walk so a permanently-saturated range cannot loop
 * forever; 100 matches the v1 server's `PORT_RETRY_LIMIT` and the daemon
 * spawner's own scan window.
 */
export const PORT_RETRY_LIMIT = 100;

export interface ListenWithPortRetryOptions {
  /**
   * Bind attempt — typically `app.listen`. Called with `(host, port)` and
   * resolves with the bound address string on success, or rejects with an
   * `EADDRINUSE` `ErrnoException` when the port is held.
   */
  readonly listen: (host: string, port: number) => Promise<string>;
  readonly host: string;
  readonly port: number;
  readonly logger: ServerLogger;
  /** Override the retry cap — used by tests to keep the walk short. */
  readonly maxRetries?: number;
}

/**
 * Bind the listener, retrying on `port + 1` when the port is held.
 *
 * Why this is the right layer: there is no single-instance lock — every
 * kap-server registers itself under `<home>/server/instances/` instead, so a
 * busy port may be a sibling kimi instance. The `port + 1` walk then serves
 * as the multi-instance coexistence mechanism (the second instance lands on
 * the next free port), and a third-party listener gets the same "port busy ⇒
 * +1" policy as v1.
 *
 * Port `0` (OS-assigned ephemeral) is never retried: the kernel already picks a
 * free port, so `EADDRINUSE` cannot arise from a specific-port conflict.
 */
export async function listenWithPortRetry(
  opts: ListenWithPortRetryOptions,
): Promise<{ address: string; port: number }> {
  if (opts.port === 0) {
    const address = await opts.listen(opts.host, 0);
    return { address, port: 0 };
  }

  const maxRetries = opts.maxRetries ?? PORT_RETRY_LIMIT;
  let port = opts.port;
  for (let attempt = 0; ; attempt++) {
    try {
      const address = await opts.listen(opts.host, port);
      if (port !== opts.port) {
        opts.logger.warn(
          { requestedPort: opts.port, port, host: opts.host },
          'requested port was busy; server bound to a higher port',
        );
      }
      return { address, port };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || attempt >= maxRetries || port >= 65535) {
        throw error;
      }
      const next = port + 1;
      opts.logger.warn(
        { host: opts.host, port, next },
        'port in use by another process, trying next port',
      );
      port = next;
    }
  }
}
