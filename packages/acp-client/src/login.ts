import { get } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

import { AcpProtocolError } from '#/errors';
import type { HostProcessLike, HostProcessServiceLike } from '#/types';

const AUTH_MARKER = 'Open the following link to authenticate the ACP server: ';

export interface AcpLoginLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

export type AcpLoginStart = { readonly alreadySignedIn: true } | {
  readonly alreadySignedIn: false;
  readonly authUrl: string;
  readonly redirectUri: string;
};

export class AcpLoginHelper {
  private child: HostProcessLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
  private urlPromise: Promise<string>;
  private resolveUrl!: (url: string) => void;
  private authenticate: Promise<unknown> | undefined;
  private initialize: Record<string, unknown> | undefined;
  private closed = false;

  constructor(private readonly processes: HostProcessServiceLike, private readonly launch: AcpLoginLaunch) {
    this.urlPromise = new Promise((resolve) => { this.resolveUrl = resolve; });
  }

  async start(methodId: string): Promise<AcpLoginStart> {
    await this.connect();
    const auth = this.request('authenticate', { methodId });
    this.authenticate = auth;
    void auth.catch(() => undefined);
    const result = await deadline(Promise.race([
      auth.then(() => ({ alreadySignedIn: true as const })),
      this.urlPromise.then((authUrl) => ({ alreadySignedIn: false as const, authUrl, redirectUri: extractLoopbackRedirect(authUrl) })),
    ]), 90_000);
    return result;
  }

  async finish(authUrl: string, pastedUrl: string): Promise<void> {
    const redirect = rebuildLoopbackRedirect(authUrl, pastedUrl);
    await new Promise<void>((resolve, reject) => {
      const request = get(redirect, { timeout: 20_000 }, (response) => {
        response.resume();
        if (response.statusCode !== 200) reject(new Error(`Login callback returned HTTP ${response.statusCode}`));
        else resolve();
      });
      request.once('timeout', () => request.destroy(new Error('Login callback timed out')));
      request.once('error', reject);
    });
    if (this.authenticate === undefined) throw new AcpProtocolError('Login was not started');
    await deadline(this.authenticate, 180_000);
  }

  async logout(): Promise<void> {
    await this.connect();
    const capabilities = record(this.initialize?.['agentCapabilities']);
    const logout = record(capabilities?.['auth'])?.['logout'];
    if (logout !== true && record(logout) === undefined) throw new AcpProtocolError('ACP agent does not advertise logout');
    await deadline(this.request('logout', {}), 60_000);
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new AcpProtocolError('ACP login helper is closed');
    if (this.child !== undefined) return;
    const child = await this.processes.spawn(this.launch.command, this.launch.args, {
      shell: false, windowsHide: true, env: { ...this.launch.env, PYTHONUNBUFFERED: '1' },
    });
    if (this.closed) {
      await child.kill('SIGKILL').catch(() => undefined);
      await child.dispose();
      throw new AcpProtocolError('ACP login helper is closed');
    }
    this.child = child;
    this.readLines(child.stdout, true);
    this.readLines(child.stderr, false);
    void child.wait().then(() => { this.fail(new Error('ACP login helper exited')); }, (error) => { this.fail(error); });
    this.initialize = record(await deadline(this.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'kiki-login', version: '1' },
    }), 60_000));
    if (this.initialize?.['protocolVersion'] !== 1) throw new AcpProtocolError('Unsupported ACP login protocol');
  }

  private readLines(stream: HostProcessLike['stdout'], rpc: boolean): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 1024 * 1024) { this.fail(new AcpProtocolError('ACP login stream exceeded the frame limit')); void this.close(); return; }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const marker = line.indexOf(AUTH_MARKER);
        if (marker >= 0) {
          const url = line.slice(marker + AUTH_MARKER.length).trim().split(/\s/)[0];
          if (url !== undefined) this.resolveUrl(url);
        }
        if (rpc) {
          const start = line.indexOf('{');
          if (start >= 0) {
            try {
              const message = record(JSON.parse(line.slice(start)));
              const id = message?.['id'];
              if (typeof id === 'number') {
                const request = this.pending.get(id);
                this.pending.delete(id);
                if (message?.['error'] !== undefined) request?.reject(new AcpProtocolError('ACP authentication was rejected by the agent'));
                else request?.resolve(message?.['result']);
              }
            } catch { }
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    stream.once('error', (error) => { this.fail(error); });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.child === undefined) return Promise.reject(new Error('ACP login helper is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error !== null && error !== undefined) { this.pending.delete(id); reject(error); }
      });
    });
  }

  private fail(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('ACP login was closed'));
    const child = this.child;
    if (child === undefined) return;
    child.stdin.end();
    try {
      await deadline(child.wait(), 1500);
    } catch {
      await child.kill('SIGTERM').catch(() => undefined);
      try { await deadline(child.wait(), 2000); }
      catch { await child.kill('SIGKILL').catch(() => undefined); }
    } finally {
      await child.dispose();
    }
  }
}

export function extractLoopbackRedirect(authUrl: string): string {
  const auth = new URL(authUrl);
  if (auth.protocol !== 'https:' || !['accounts.google.com', 'accounts.google.com:443'].includes(auth.host)) throw new AcpProtocolError('ACP login returned an unexpected authorization origin');
  const target = auth.searchParams.get('redirect_uri');
  if (target === null) throw new AcpProtocolError('ACP login URL is missing redirect_uri');
  const url = new URL(target);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.pathname !== '/' ||
      url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new AcpProtocolError('ACP login redirect must be an IPv4 loopback callback');
  return url.href;
}

export function rebuildLoopbackRedirect(authUrl: string, pastedUrl: string): URL {
  const expected = new URL(extractLoopbackRedirect(authUrl));
  const auth = new URL(authUrl);
  const pasted = new URL(pastedUrl);
  if (pasted.origin !== expected.origin || pasted.pathname !== '/' || pasted.username !== '' || pasted.password !== '' ||
      pasted.hash !== '' || pasted.searchParams.get('state') !== auth.searchParams.get('state') ||
      !pasted.searchParams.get('state') || (!pasted.searchParams.get('code') && !pasted.searchParams.get('error'))) {
    throw new AcpProtocolError('The pasted login callback does not match the pending sign-in');
  }
  for (const key of ['code', 'state', 'error']) {
    const value = pasted.searchParams.get(key);
    if (value !== null) expected.searchParams.set(key, value);
  }
  return expected;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function deadline<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('ACP login timed out')); }, timeout); })]);
  } finally { clearTimeout(timer); }
}
