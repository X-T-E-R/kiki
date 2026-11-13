import { Agent, request } from 'node:https';
import { connect, type ConnectionOptions } from 'node:tls';
import { Readable } from 'node:stream';
import { AdmissionError } from './admission';
import { spkiFingerprint } from './tlsIdentity';

export function requirePinnedTls(endpoint: string | URL, fingerprint?: string): void {
  if (fingerprint !== undefined && !['https:', 'wss:'].includes(new URL(endpoint).protocol)) throw new AdmissionError(409, 'connection_requires_tls');
}
export function pinnedAgent(fingerprint?: string, observed?: (fingerprint: string) => void, signal?: AbortSignal): Agent {
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  agent.createConnection = (options, callback) => {
    const socket = connect({ ...options, rejectUnauthorized: false } as ConnectionOptions);
    const deadline = AbortSignal.any([AbortSignal.timeout(15000), ...signal === undefined ? [] : [signal]]);
    const abort = () => socket.destroy(deadline.reason instanceof Error ? deadline.reason : new Error('TLS handshake cancelled'));
    const closed = () => fail(new Error('TLS handshake closed'));
    const cleanup = () => {
      deadline.removeEventListener('abort', abort);
      socket.off('close', closed);
    };
    const fail = (error: Error): void => { cleanup(); callback!(error, socket); };
    socket.once('error', fail);
    socket.once('close', closed);
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) abort();
    socket.once('secureConnect', () => {
      if (deadline.aborted) return;
      const certificate = socket.getPeerX509Certificate();
      const actual = certificate === undefined ? undefined : spkiFingerprint(certificate.publicKey);
      if (actual === undefined || (fingerprint !== undefined && actual !== fingerprint)) {
        socket.destroy(new AdmissionError(409, 'identity_changed')); return;
      }
      cleanup(); socket.off('error', fail);
      observed?.(actual);
      callback!(null, socket);
    });
    return undefined;
  };
  return agent;
}
export async function peerFetch(url: string | URL, init: RequestInit = {}, fingerprint?: string, observed?: (fingerprint: string) => void): Promise<Response> {
  requirePinnedTls(url, fingerprint);
  if (fingerprint === undefined && observed === undefined) return fetch(url, { ...init, redirect: 'error' });
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init.method, headers: Object.fromEntries(new Headers(init.headers)), agent: pinnedAgent(fingerprint, observed, init.signal ?? undefined), signal: init.signal ?? undefined }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
      resolve(new Response([204, 205, 304].includes(res.statusCode!) || init.method === 'HEAD' ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode, statusText: res.statusMessage, headers }));
    });
    req.once('error', reject);
    if (init.body === undefined || init.body === null) req.end();
    else if (typeof init.body === 'string' || Buffer.isBuffer(init.body) || init.body instanceof Uint8Array) req.end(init.body);
    else {
      const body = init.body instanceof Readable ? init.body : Readable.from(init.body as AsyncIterable<Uint8Array>);
      body.once('error', (error) => req.destroy(error));
      req.once('close', () => body.destroy());
      body.pipe(req);
    }
  });
}
export function isLegacyTlsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return ['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'ERR_SSL_RECORD_LAYER_FAILURE'].includes(code ?? '')
    || code === 'EPROTO' && /wrong version number|packet length too long|record layer failure|unknown protocol/i.test(error.message);
}
