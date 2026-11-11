import { createServer, request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { HarnessAccountConnection } from '@kiki/protocol';

import type { PluginHarnessAccountLease } from '#/app/plugin/pluginHostService';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const MAX_BUFFERED_REQUEST_BYTES = 16 * 1024 * 1024;

function originForm(value: string | undefined): string | undefined {
  if (value === undefined || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u0020\u007F\\#]/.test(value)) return undefined;
  return value;
}

export interface HarnessAccountBroker {
  readonly connection: HarnessAccountConnection;
  close(): Promise<void>;
}

export async function openHarnessAccountBroker(
  initial: PluginHarnessAccountLease,
  prepare: (signal: AbortSignal) => Promise<PluginHarnessAccountLease>,
  validate: (connection: HarnessAccountConnection) => void,
  onReleaseError: () => void,
): Promise<HarnessAccountBroker | undefined> {
  const endpoint = new URL(initial.connection.baseUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname)) return undefined;
  return new LoopbackHarnessAccountBroker(initial, prepare, validate, onReleaseError).open();
}

class LoopbackHarnessAccountBroker implements HarnessAccountBroker {
  connection: HarnessAccountConnection;
  private readonly server: Server;
  private readonly abort = new AbortController();
  private readonly retired = new Map<PluginHarnessAccountLease, Promise<void>>();
  private readonly inflight = new Map<PluginHarnessAccountLease, Set<Promise<void>>>();
  private readonly upstreams = new Set<ClientRequest>();
  private readonly capability: string;
  private current: PluginHarnessAccountLease;
  private dead = false;
  private closed = false;
  private refreshing?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(
    initial: PluginHarnessAccountLease,
    private readonly prepare: (signal: AbortSignal) => Promise<PluginHarnessAccountLease>,
    private readonly validate: (connection: HarnessAccountConnection) => void,
    private readonly onReleaseError: () => void,
  ) {
    this.current = initial;
    this.capability = initial.connection.apiKey;
    const endpoint = new URL(initial.connection.baseUrl);
    const suffix = initial.connection.baseUrl.slice(endpoint.origin.length);
    this.connection = { ...initial.connection, baseUrl: `http://127.0.0.1:0${suffix}` };
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => { req.socket.destroy(); });
    });
    this.server.requestTimeout = 0;
    this.server.on('clientError', (_error, socket) => { socket.destroy(); });
  }

  async open(): Promise<HarnessAccountBroker> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { reject(error); };
      this.server.once('error', failed);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', failed);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('Harness account broker requires a loopback port');
    const endpoint = new URL(this.current.connection.baseUrl);
    const suffix = this.current.connection.baseUrl.slice(endpoint.origin.length);
    this.connection.baseUrl = `http://127.0.0.1:${address.port}${suffix}`;
    return this;
  }

  close(): Promise<void> {
    return this.closePromise ??= this.finish();
  }

  private async finish(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    for (const upstream of this.upstreams) upstream.destroy();
    this.server.closeAllConnections();
    const closed = new Promise<void>((resolve) => { this.server.close(() => { resolve(); }); });
    await this.refreshing?.catch(() => {});
    await this.retire(this.current);
    await Promise.all(this.retired.values());
    await closed;
  }

  private retire(lease: PluginHarnessAccountLease): Promise<void> {
    let retiring = this.retired.get(lease);
    if (retiring === undefined) {
      retiring = (async () => {
        const active = this.inflight.get(lease);
        if (active !== undefined) await Promise.allSettled(active);
        await lease.release().catch(() => { this.onReleaseError(); });
      })();
      this.retired.set(lease, retiring);
    }
    return retiring;
  }

  private async leaseForRequest(): Promise<PluginHarnessAccountLease> {
    if (this.closed) throw new Error('Harness account broker is closed');
    if (!this.dead) return this.current;
    if (this.refreshing !== undefined) return this.refreshing.then(() => this.current);
    const previous = this.current;
    this.refreshing = (async () => {
      void this.retire(previous);
      if (this.closed) throw new Error('Harness account broker is closed');
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
      let next: PluginHarnessAccountLease | undefined;
      try {
        next = await this.prepare(signal);
        this.validate(next.connection);
        const endpoint = new URL(next.connection.baseUrl);
        if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname)) {
          throw new Error('Harness account replacement left the loopback connection boundary');
        }
        if (this.closed) throw new Error('Harness account broker is closed');
        this.current = next;
        this.dead = false;
      } catch (error) {
        if (next !== undefined) await this.retire(next);
        throw error;
      }
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing.then(() => this.current);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = originForm(req.url);
    if (path === undefined) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Expected an HTTP origin-form request target');
      return;
    }
    const gemini = this.current.connection.protocol === 'gemini-v1beta';
    const queryKey = new URL(path, 'http://127.0.0.1').searchParams.get('key');
    const authorized = gemini
      ? req.headers['x-goog-api-key'] === this.capability || queryKey === this.capability
      : req.headers.authorization === `Bearer ${this.capability}`;
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid scoped account capability');
      return;
    }
    const buffered = await this.bufferIfBounded(req);
    if (buffered === 'aborted' || this.closed || res.destroyed) return;
    let lease = await this.leaseForRequest();
    while (!this.closed && this.current === lease && this.dead) lease = await this.leaseForRequest();
    if (this.closed || res.destroyed) return;
    this.forward(req, res, lease, path, buffered === 'stream' ? undefined : buffered, true);
  }

  private bufferIfBounded(req: IncomingMessage): Promise<Buffer | 'stream' | 'aborted'> {
    const rawLength = req.headers['content-length'];
    if (typeof rawLength === 'string') {
      const parsed = Number(rawLength);
      if (Number.isFinite(parsed) && parsed > MAX_BUFFERED_REQUEST_BYTES) return Promise.resolve('stream');
    }
    if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('aborted', onAbort);
        req.off('error', onAbort);
        req.off('close', onClose);
      };
      const finish = (outcome: Buffer | 'stream' | 'aborted') => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };
      const onData = (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        chunks.push(buf);
        if (total > MAX_BUFFERED_REQUEST_BYTES) {
          req.pause();
          for (let index = chunks.length - 1; index >= 0; index -= 1) req.unshift(chunks[index]!);
          finish('stream');
        }
      };
      const onEnd = () => { finish(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total)); };
      const onAbort = () => { finish('aborted'); };
      const onClose = () => { if (!req.complete) finish('aborted'); };
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('aborted', onAbort);
      req.once('error', onAbort);
      req.once('close', onClose);
    });
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    lease: PluginHarnessAccountLease,
    path: string,
    body: Buffer | undefined,
    allowRefusedRetry: boolean,
  ): void {
    const endpoint = new URL(lease.connection.baseUrl);
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    headers.host = endpoint.host;
    if (body !== undefined && (body.length > 0 || req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined)) {
      headers['content-length'] = String(body.length);
    }
    let upstreamPath = path;
    if (lease.connection.protocol === 'gemini-v1beta') {
      headers['x-goog-api-key'] = lease.connection.apiKey;
      const target = new URL(path, endpoint.origin);
      if (target.searchParams.has('key')) {
        target.searchParams.set('key', lease.connection.apiKey);
        upstreamPath = `${target.pathname}${target.search}`;
      }
    } else headers.authorization = `Bearer ${lease.connection.apiKey}`;
    let clientGone = false;
    let failed = false;
    let responded = false;
    const upstream = request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname === '[::1]' ? '::1' : endpoint.hostname,
      port: endpoint.port,
      path: upstreamPath,
      method: req.method,
      headers,
      agent: false,
    });
    this.upstreams.add(upstream);
    const completion = new Promise<void>((resolve) => { upstream.once('close', resolve); });
    const active = this.inflight.get(lease) ?? new Set<Promise<void>>();
    active.add(completion);
    this.inflight.set(lease, active);
    const detachClient = () => {
      req.off('aborted', abandon);
      res.off('close', onResClose);
    };
    const abandon = () => {
      clientGone = true;
      upstream.destroy();
    };
    const onResClose = () => { if (!res.writableEnded) abandon(); };
    const fail = (error?: unknown) => {
      if (failed) return;
      failed = true;
      detachClient();
      if (!clientGone && !this.closed) this.markDead(lease);
      upstream.destroy();
      const refusedBeforeConnect = !responded && allowRefusedRetry && body !== undefined && !clientGone && !this.closed && !res.destroyed &&
        typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ECONNREFUSED';
      if (refusedBeforeConnect) {
        void (async () => {
          let next = await this.leaseForRequest();
          while (!this.closed && this.current === next && this.dead) next = await this.leaseForRequest();
          if (!this.closed && !res.destroyed && res.socket?.destroyed !== true) this.forward(req, res, next, path, body, false);
        })().catch(() => { if (!res.destroyed) req.socket.destroy(); });
        return;
      }
      if (!clientGone) req.socket.destroy();
    };
    upstream.once('error', fail);
    upstream.on('response', (reply) => {
      responded = true;
      reply.once('aborted', () => fail());
      reply.once('error', fail);
      const replyHeaders = { ...reply.headers };
      for (const name of HOP_BY_HOP) delete replyHeaders[name];
      res.writeHead(reply.statusCode ?? 502, reply.statusMessage, replyHeaders);
      reply.pipe(res);
    });
    upstream.once('close', () => {
      detachClient();
      this.upstreams.delete(upstream);
      active.delete(completion);
      if (active.size === 0) this.inflight.delete(lease);
    });
    req.once('aborted', abandon);
    res.once('close', onResClose);
    if (body !== undefined) upstream.end(body);
    else req.pipe(upstream);
  }

  private markDead(lease: PluginHarnessAccountLease): void {
    if (this.current !== lease || this.dead) return;
    this.dead = true;
    void this.retire(lease);
  }
}
