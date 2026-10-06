import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  isActiveExternalClientGrant,
  type ExternalClientTransportHost,
} from './host';
import { createExternalClientMcpServer } from './mcpServer';
import {
  ExternalClientOAuthService,
  type ExternalClientOAuthOptions,
} from './oauth';

export const EXTERNAL_CLIENT_MCP_PATH = '/mcp';
export const EXTERNAL_CLIENT_HEALTH_PATH = '/health';

export interface ExternalClientListenerOptions {
  readonly host: ExternalClientTransportHost;
  readonly bindHost?: string;
  readonly port?: number;
  readonly issuerUrl?: URL | string;
  readonly resourceServerUrl?: URL | string;
  readonly publicUrl?: URL | string;
  readonly oauth?: ExternalClientOAuthService;
  readonly oauthOptions?: Omit<ExternalClientOAuthOptions, 'host' | 'issuerUrl' | 'resourceServerUrl'>;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxRequestsPerWindow?: number;
  readonly requestWindowMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface ExternalClientListener {
  readonly oauth: ExternalClientOAuthService | undefined;
  start(): Promise<void>;
  close(): Promise<void>;
  address(): { readonly host: string; readonly port: number; readonly origin: string } | undefined;
}

interface ExternalClientTransportSession {
  readonly grantId: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Awaited<ReturnType<typeof createExternalClientMcpServer>>;
  closePromise?: Promise<void>;
}

interface ExpressRequest extends Readable {
  readonly method: string;
  readonly url: string;
  readonly originalUrl: string;
  readonly headers: IncomingMessage['headers'];
  readonly body?: unknown;
  readonly query?: Record<string, string | string[]>;
  readonly path?: string;
  readonly protocol?: string;
  readonly secure?: boolean;
  readonly hostname?: string;
  readonly ip?: string;
  res?: ExpressResponse;
  get(name: string): string | undefined;
  header(name: string): string | undefined;
}

type ExternalClientAuthRouter = (request: ExpressRequest, response: ExpressResponse, next: (error?: unknown) => void) => unknown;

interface ExpressResponse {
  readonly locals: Record<string, unknown>;
  status(code: number): ExpressResponse;
  json(value: unknown): ExpressResponse;
  send(value: unknown): ExpressResponse;
  redirect(status: number | string, url?: string): ExpressResponse;
  set(field: string | Record<string, string>, value?: string): ExpressResponse;
  header(field: string, value: string): ExpressResponse;
  type(value: string): ExpressResponse;
  setHeader(name: string, value: number | string | readonly string[]): ExpressResponse;
  getHeader(name: string): number | string | string[] | undefined;
  removeHeader(name: string): void;
  end(chunk?: string | Uint8Array): ExpressResponse;
  readonly headersSent: boolean;
}

export function createExternalClientListener(options: ExternalClientListenerOptions): ExternalClientListener {
  const bindHost = options.bindHost ?? '127.0.0.1';
  const port = options.port ?? 0;
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? 1_048_576);
  const maxConcurrentRequests = Math.max(1, options.maxConcurrentRequests ?? 64);
  const maxRequestsPerWindow = Math.max(1, options.maxRequestsPerWindow ?? 120);
  const requestWindowMs = Math.max(1_000, options.requestWindowMs ?? 60_000);
  const sessions = new Map<string, ExternalClientTransportSession>();
  const ownedSessions = new Set<ExternalClientTransportSession>();
  const requestCounters = new Map<string, { count: number; resetAt: number }>();
  const server = createServer((request, response) => {
    void dispatchRequest(request, response).catch((error: unknown) => {
      options.onError?.(error);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, { error: 'internal_server_error' });
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  let activeRequests = 0;
  let started = false;
  let closing: Promise<void> | undefined;
  let authRouter: ExternalClientAuthRouter | undefined;
  let oauth: ExternalClientOAuthService | undefined = options.oauth;
  let resolvedIssuer: URL | undefined;
  let resolvedResource: URL | undefined;
  let resolvedAddress: { readonly host: string; readonly port: number; readonly origin: string } | undefined;

  const listener: ExternalClientListener = {
    get oauth() {
      return oauth;
    },
    async start() {
      if (started) return;
      await listen(server, bindHost, port);
      const actualPort = addressPort(server);
      resolvedAddress = {
        host: bindHost,
        port: actualPort,
        origin: resolveOrigin(options, bindHost, actualPort),
      };
      resolvedIssuer = resolveUrl(options.issuerUrl, resolvedAddress.origin);
      resolvedResource = resolveUrl(options.resourceServerUrl, `${resolvedIssuer.origin}${EXTERNAL_CLIENT_MCP_PATH}`);
      validatePublicUrl(options.publicUrl);
      if (oauth === undefined) {
        const oauthOptions = options.oauthOptions;
        if (oauthOptions === undefined) throw new Error('External client OAuth options are required.');
        oauth = new ExternalClientOAuthService({
          ...oauthOptions,
          host: options.host,
          issuerUrl: resolvedIssuer,
          resourceServerUrl: resolvedResource,
          store: oauthOptions.store ?? options.host.oauthStore,
          storeScope: oauthOptions.storeScope ?? options.host.oauthStoreScope,
        });
      }
      authRouter = mcpAuthRouter({
        provider: oauth.provider,
        issuerUrl: resolvedIssuer,
        baseUrl: resolvedIssuer,
        resourceServerUrl: resolvedResource,
        scopesSupported: [...oauth.scopes],
        resourceName: 'Kiki external client MCP',
        clientRegistrationOptions: { rateLimit: false },
        authorizationOptions: { rateLimit: false },
        tokenOptions: { rateLimit: false },
        revocationOptions: { rateLimit: false },
      }) as unknown as ExternalClientAuthRouter;
      started = true;
    },
    async close() {
      closing ??= closeAll();
      await closing;
    },
    address() {
      return resolvedAddress;
    },
  };

  async function dispatchRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!started || resolvedIssuer === undefined || resolvedResource === undefined || authRouter === undefined) {
      sendJson(response, 503, { error: 'listener_not_ready' });
      return;
    }
    const url = requestUrl(request, bindHost);
    if (url.pathname === EXTERNAL_CLIENT_HEALTH_PATH && request.method === 'GET') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (!checkHostAndOrigin(request, options, resolvedIssuer, resolvedResource)) {
      sendJson(response, 421, { error: 'invalid_host_or_origin' });
      return;
    }
    if (!takeRateSlot(request, requestCounters, maxRequestsPerWindow, requestWindowMs)) {
      sendJson(response, 429, { error: 'rate_limited' });
      return;
    }
    if (activeRequests >= maxConcurrentRequests) {
      sendJson(response, 503, { error: 'concurrency_limit' });
      return;
    }
    activeRequests += 1;
    try {
      const body = await readBody(request, maxBodyBytes);
      if (await dispatchAuth(authRouter, request, response, body)) return;
      if (url.pathname !== EXTERNAL_CLIENT_MCP_PATH) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }
      await dispatchMcp(request, response, body);
    } finally {
      activeRequests -= 1;
    }
  }

  async function dispatchMcp(request: IncomingMessage, response: ServerResponse, body: Buffer): Promise<void> {
    const auth = await authenticate(request, options.host, oauth!, resolvedResource!);
    if (auth === null) {
      sendUnauthorized(response, resolvedResource!);
      return;
    }
    const sessionId = header(request, 'mcp-session-id');
    const grantId = grantIdFromAuth(auth);
    if (grantId === undefined) {
      sendUnauthorized(response, resolvedResource!);
      return;
    }
    let session: ExternalClientTransportSession | undefined;
    if (sessionId !== undefined) {
      session = sessions.get(sessionId);
      if (session === undefined) {
        sendJson(response, 404, { error: 'session_not_found' });
        return;
      }
      if (session.grantId !== grantId) {
        sendUnauthorized(response, resolvedResource!);
        return;
      }
    } else {
      let created!: ExternalClientTransportSession;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, created); },
        onsessionclosed: (id) => {
          const closed = sessions.get(id);
          if (closed !== undefined) {
            sessions.delete(id);
            void closeSession(closed, false);
          }
        },
      });
      const mcpServer = await createExternalClientMcpServer(options.host, {
        grantId,
        transportSessionId: () => transport.sessionId,
      });
      created = { grantId, transport, server: mcpServer };
      session = created;
      ownedSessions.add(created);
      await mcpServer.connect(transport);
    }
    const incoming = request as IncomingMessage & { auth?: AuthInfo };
    incoming.auth = auth;
    try {
      await session.transport.handleRequest(incoming, response, parseJsonBody(request, body));
    } catch (error) {
      options.onError?.(error);
      if (!response.headersSent) sendJson(response, 500, { error: 'mcp_transport_failed' });
      else response.destroy(error instanceof Error ? error : undefined);
    }
    if (session.transport.sessionId === undefined && !response.writableEnded) await closeSession(session, true);
  }

  async function dispatchAuth(
    router: ExternalClientAuthRouter,
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ): Promise<boolean> {
    const url = requestUrl(request, bindHost);
    if (!isAuthPath(url.pathname)) return false;
    const expressRequest = createExpressRequest(request, body, bindHost);
    const expressResponse = createExpressResponse(response);
    return invokeExpressRouter(router, expressRequest, expressResponse);
  }

  async function closeSession(session: ExternalClientTransportSession, closeTransport: boolean): Promise<void> {
    session.closePromise ??= (async () => {
      ownedSessions.delete(session);
      try {
        await session.server.close();
      } finally {
        if (closeTransport) await session.transport.close();
      }
    })();
    await session.closePromise;
  }

  async function closeAll(): Promise<void> {
    for (const sessionId of sessions.keys()) sessions.delete(sessionId);
    await Promise.all([...ownedSessions].map((session) => closeSession(session, true)));
    if (!started && !server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    started = false;
  }

  return listener;
}

async function authenticate(
  request: IncomingMessage,
  host: ExternalClientTransportHost,
  oauth: ExternalClientOAuthService,
  resource: URL,
): Promise<AuthInfo | null> {
  const token = bearer(request);
  if (token === undefined) return null;
  try {
    const auth = await oauth.verifyAccessToken(token);
    if (auth.resource?.href !== resource.href) return null;
    const grant = await host.resolveGrant(grantIdFromAuth(auth) ?? '');
    if (!isActiveExternalClientGrant(grant)) return null;
    return auth;
  } catch {
    const grant = await host.resolveBearer(token, { resource: resource.href, audience: resource.href });
    if (!isActiveExternalClientGrant(grant)) return null;
    if (grant.resource !== resource.href || grant.audience !== resource.href) return null;
    return {
      token,
      clientId: `local:${grant.id}`,
      scopes: [...grant.scopes],
      resource: resource,
      extra: { grantId: grant.id, audience: grant.audience },
    };
  }
}

function grantIdFromAuth(auth: AuthInfo): string | undefined {
  const value = auth.extra?.['grantId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bearer(request: IncomingMessage): string | undefined {
  const value = header(request, 'authorization');
  if (value === undefined || !value.startsWith('Bearer ')) return undefined;
  const token = value.slice('Bearer '.length).trim();
  return token.length === 0 ? undefined : token;
}

function sendUnauthorized(response: ServerResponse, resource: URL): void {
  const metadata = new URL(`/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`, resource.origin).href;
  response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`);
  sendJson(response, 401, { error: 'unauthorized' });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', body.byteLength);
  response.end(body);
}

function requestUrl(request: IncomingMessage, fallbackHost: string): URL {
  return new URL(request.url ?? '/', `http://${fallbackHost}`);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function addressPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('External client listener address is unavailable.');
  return address.port;
}

function resolveOrigin(options: ExternalClientListenerOptions, bindHost: string, port: number): string {
  if (options.publicUrl !== undefined) return new URL(String(options.publicUrl)).origin;
  if (options.issuerUrl !== undefined) {
    const issuer = new URL(String(options.issuerUrl));
    if (issuer.port === '0') issuer.port = String(port);
    return issuer.origin;
  }
  const host = bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost;
  return `http://${host}:${port}`;
}

function resolveUrl(input: URL | string | undefined, fallback: string): URL {
  const value = input === undefined ? fallback : String(input);
  const url = new URL(value);
  if (url.port === '0') {
    const fallbackUrl = new URL(fallback);
    url.port = fallbackUrl.port;
  }
  if (url.search || url.hash) throw new Error('External client URL must not contain query or fragment.');
  return url;
}

function validatePublicUrl(publicUrl: URL | string | undefined): void {
  if (publicUrl === undefined) return;
  const url = new URL(String(publicUrl));
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && new Set(['localhost', '127.0.0.1', '[::1]']).has(url.hostname)) return;
  throw new Error('External client publicUrl must use HTTPS except for loopback fixtures.');
}

function checkHostAndOrigin(
  request: IncomingMessage,
  options: ExternalClientListenerOptions,
  issuer: URL,
  resource: URL,
): boolean {
  const hostValue = header(request, 'host');
  if (hostValue === undefined) return false;
  const host = (hostValue.startsWith('[') ? hostValue.slice(1, hostValue.indexOf(']')) : hostValue.split(':')[0]) ?? '';
  const allowedHosts = options.allowedHosts ?? [issuer.hostname, resource.hostname, options.bindHost ?? '127.0.0.1', 'localhost', '127.0.0.1', '[::1]'];
  if (!allowedHosts.some((allowed) => allowed !== undefined && allowed.toLocaleLowerCase() === host.toLocaleLowerCase())) return false;
  const origin = header(request, 'origin');
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const allowedOrigins = options.allowedOrigins ?? [issuer.origin, resource.origin];
  return allowedOrigins.some((allowed) => allowed === parsed.origin);
}

function takeRateSlot(
  request: IncomingMessage,
  counters: Map<string, { count: number; resetAt: number }>,
  max: number,
  windowMs: number,
): boolean {
  const key = request.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const current = counters.get(key);
  if (current === undefined || current.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= max) return false;
  current.count += 1;
  return true;
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = header(request, 'content-length');
  if (contentLength !== undefined && Number(contentLength) > maxBytes) {
    request.destroy();
    return Promise.reject(new Error('request_body_too_large'));
  }
  if (request.method === 'GET' || request.method === 'DELETE' || request.method === 'HEAD') return Promise.resolve(Buffer.alloc(0));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const abort = () => {
      reject(new Error('request_aborted'));
    };
    request.on('aborted', abort);
    request.on('error', reject);
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) {
        request.destroy();
        reject(new Error('request_body_too_large'));
        return;
      }
      chunks.push(bytes);
    });
    request.on('end', () => {
      request.off('aborted', abort);
      resolve(Buffer.concat(chunks));
    });
  });
}

function parseJsonBody(request: IncomingMessage, body: Buffer): unknown {
  if (body.byteLength === 0) return undefined;
  const contentType = header(request, 'content-type') ?? '';
  if (!contentType.toLocaleLowerCase().includes('application/json')) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function isAuthPath(pathname: string): boolean {
  return pathname === '/authorize' || pathname === '/token' || pathname === '/register' || pathname === '/revoke'
    || pathname === '/.well-known/oauth-authorization-server'
    || pathname.startsWith('/.well-known/oauth-protected-resource');
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function createExpressRequest(request: IncomingMessage, body: Buffer, fallbackHost: string): ExpressRequest {
  const stream = Readable.from(body.byteLength === 0 ? [] : [body]) as ExpressRequest;
  const url = requestUrl(request, fallbackHost);
  Object.assign(stream, {
    method: request.method ?? 'GET',
    url: request.url ?? '/',
    originalUrl: request.url ?? '/',
    headers: request.headers,
    query: Object.fromEntries(url.searchParams.entries()),
    path: url.pathname,
    protocol: 'http',
    secure: false,
    hostname: url.hostname,
    ip: request.socket.remoteAddress,
    get(name: string) { return header(request, name); },
    header(name: string) { return header(request, name); },
  });
  return stream;
}

function createExpressResponse(response: ServerResponse): ExpressResponse {
  const expressResponse = {
    locals: {},
    status(code: number) {
      response.statusCode = code;
      return expressResponse;
    },
    json(value: unknown) {
      const body = Buffer.from(JSON.stringify(value));
      response.setHeader('content-type', 'application/json');
      response.setHeader('content-length', body.byteLength);
      response.end(body);
      return expressResponse;
    },
    send(value: unknown) {
      const body = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
      response.end(body);
      return expressResponse;
    },
    redirect(status: number | string, url?: string) {
      const code = typeof status === 'number' ? status : 302;
      const location = typeof status === 'string' ? status : url;
      response.statusCode = code;
      if (location !== undefined) response.setHeader('location', location);
      response.end();
      return expressResponse;
    },
    set(field: string | Record<string, string>, value?: string) {
      if (typeof field === 'string') response.setHeader(field, value ?? '');
      else for (const [key, headerValue] of Object.entries(field)) response.setHeader(key, headerValue);
      return expressResponse;
    },
    header(field: string, value: string) {
      response.setHeader(field, value);
      return expressResponse;
    },
    type(value: string) {
      response.setHeader('content-type', value.includes('/') ? value : `text/${value}`);
      return expressResponse;
    },
    setHeader(name: string, value: number | string | readonly string[]) {
      response.setHeader(name, value);
      return expressResponse;
    },
    getHeader(name: string) {
      return response.getHeader(name);
    },
    removeHeader(name: string) {
      response.removeHeader(name);
    },
    end(chunk?: string | Uint8Array) {
      response.end(chunk);
      return expressResponse;
    },
    get headersSent() {
      return response.headersSent;
    },
  } as ExpressResponse;
  return expressResponse;
}

function invokeExpressRouter(
  router: ExternalClientAuthRouter,
  request: ExpressRequest,
  response: ExpressResponse,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (handled: boolean) => {
      if (settled) return;
      settled = true;
      resolve(handled);
    };
    const next = (error?: unknown) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      finish(response.headersSent);
    };
    request.res = response;
    try {
      router(request as never, response as never, next);
      if (response.headersSent) finish(true);
    } catch (error) {
      reject(error);
    }
  });
}
