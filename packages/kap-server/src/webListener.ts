import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { WebAccessEnableInput } from '@kiki/protocol';
import { networkInterfaces } from 'node:os';
import { isLoopback, type WebListener } from './services/webAccess';
import { AdmissionError } from './services/connections/admission';

export async function startWebListener(app: FastifyInstance, input: WebAccessEnableInput, isWebRequest: WeakSet<IncomingMessage>): Promise<WebListener> {
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Daemon HTTP listener is not ready');
  const host = input.host ?? '127.0.0.1';
  const port = input.port ?? (isLoopback(host) ? address.port : 0);
  let publicUrl: URL | undefined;
  if (input.publicUrl !== undefined) {
    publicUrl = new URL(input.publicUrl);
    if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username !== '' || publicUrl.password !== '' || publicUrl.pathname !== '/' || publicUrl.search !== '' || publicUrl.hash !== '') throw new AdmissionError(400, 'invalid_web_public_url');
  }
  if (!isLoopback(host) && input.insecureNoTls !== true && publicUrl?.protocol !== 'https:') throw new AdmissionError(400, 'web_tls_or_insecure_option_required');
  if (publicUrl?.protocol === 'http:' && !isLoopback(publicUrl.hostname) && input.insecureNoTls !== true) throw new AdmissionError(400, 'web_tls_or_insecure_option_required');
  if (isLoopback(host) && port === address.port) {
    const url = publicUrl?.origin ?? `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
    return { host, port, url, close: async () => {} };
  }
  const server = createServer((req, res) => { isWebRequest.add(req); app.server.emit('request', req, res); });
  server.requestTimeout = 0;
  server.on('upgrade', (req, socket, head) => { isWebRequest.add(req); app.server.emit('upgrade', req, socket, head); });
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('Web listener has no address');
  const advertisedHost = host === '0.0.0.0' || host === '::'
    ? Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address ?? '127.0.0.1'
    : host;
  const url = publicUrl?.origin ?? `http://${advertisedHost.includes(':') ? '[' + advertisedHost + ']' : advertisedHost}:${bound.port}`;
  return { host, port: bound.port, url, close: async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    for (const socket of sockets) socket.destroy(); await closed;
  } };
}
