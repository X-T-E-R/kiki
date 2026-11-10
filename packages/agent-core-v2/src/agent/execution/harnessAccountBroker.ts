import { createServer, request, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { HarnessAccountConnection } from '@kiki/protocol';

import type { PluginHarnessAccountLease } from '#/app/plugin/pluginHostService';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

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
      retiring = lease.release().catch(() => { this.onReleaseError(); });
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
      await this.retire(previous);
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
    const gemini = this.current.connection.protocol === 'gemini-v1beta';
    const queryKey = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('key');
    const authorized = gemini
      ? req.headers['x-goog-api-key'] === this.capability || queryKey === this.capability
      : req.headers.authorization === `Bearer ${this.capability}`;
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid scoped account capability');
      return;
    }
    const lease = await this.leaseForRequest();
    if (!this.closed && !res.destroyed) this.forward(req, res, lease);
  }

  private forward(req: IncomingMessage, res: ServerResponse, lease: PluginHarnessAccountLease): void {
    const target = new URL(req.url ?? '/', lease.connection.baseUrl);
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    headers.host = target.host;
    if (lease.connection.protocol === 'gemini-v1beta') headers['x-goog-api-key'] = lease.connection.apiKey;
    else headers.authorization = `Bearer ${lease.connection.apiKey}`;
    if (target.searchParams.has('key')) target.searchParams.set('key', lease.connection.apiKey);
    let clientGone = false;
    let failed = false;
    const upstream = request(target, { method: req.method, headers, agent: false });
    this.upstreams.add(upstream);
    const abandon = () => {
      clientGone = true;
      upstream.destroy();
    };
    const fail = () => {
      if (failed) return;
      failed = true;
      if (!clientGone && !this.closed) this.markDead(lease);
      upstream.destroy();
      if (!clientGone) req.socket.destroy();
    };
    upstream.once('error', fail);
    upstream.on('response', (reply) => {
      reply.once('aborted', fail);
      reply.once('error', fail);
      const replyHeaders = { ...reply.headers };
      for (const name of HOP_BY_HOP) delete replyHeaders[name];
      res.writeHead(reply.statusCode ?? 502, reply.statusMessage, replyHeaders);
      reply.pipe(res);
    });
    upstream.once('close', () => { this.upstreams.delete(upstream); });
    req.once('aborted', abandon);
    res.once('close', () => { if (!res.writableEnded) abandon(); });
    req.pipe(upstream);
  }

  private markDead(lease: PluginHarnessAccountLease): void {
    if (this.current !== lease || this.dead) return;
    this.dead = true;
    void this.retire(lease);
  }
}
