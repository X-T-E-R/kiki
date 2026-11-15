import type { IncomingMessage } from 'node:http';
import { isFileId } from '@kiki/agent-core-v2/app/file/fileService';
import { parseMediaBlobRef } from '@kiki/transcript';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errEnvelope } from '../../envelope';
import { isSessionAccessExchange } from '../../middleware/auth';
import { matchesLocalOwner } from '../auth/localOwner';
import { peerGrant } from '../connections/audience';
import type { SessionAccessStore, SessionAccessToken } from './store';

const requests = new WeakMap<object, { token: SessionAccessToken; signal: AbortSignal }>();
export function sessionAccessToken(request: object): SessionAccessToken | undefined { return requests.get(request)?.token; }
export function sessionAccessSignal(request: object): AbortSignal | undefined { return requests.get(request)?.signal; }
export function isSessionAccessLoopback(request: IncomingMessage, web: WeakSet<IncomingMessage>, peers: WeakSet<IncomingMessage>): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') &&
    !web.has(request) && !peers.has(request) && peerGrant(request.headers) === undefined &&
    request.headers.origin === undefined && fetchSite === undefined;
}

const sessionReadRoutes = new Set([
  '', '/status', '/snapshot', '/messages', '/messages/:message_id', '/transcript', '/transcript/ops',
  '/transcript/detail', '/transcript/details', '/transcript/plan', '/transcript/user-messages',
  '/prompts', '/prompts/:prompt_id', '/approvals', '/questions',
  '/media/:file_id', '/media/:file_id/preview', '/children', '/tasks', '/tasks/:task_id',
  '/agent-tasks', '/goal', '/warnings', '/profile', '/runtime', '/skills',
].map((suffix) => `/api/sessions/:session_id${suffix}`));

function normalizeSessionAccessPath(rawPath: string): string | undefined {
  if (rawPath.includes('\\') || /[\u0000-\u001F\u007F-\u009F]/u.test(rawPath) || /%(?![0-9a-f]{2})/iu.test(rawPath) || /%(?:2f|5c|00)/iu.test(rawPath)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\\') || decoded.includes('%') || /[\u0000-\u001F\u007F-\u009F]/u.test(decoded) ||
      decoded.includes('//') || decoded.endsWith('/') || decoded.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return decoded;
}

function sessionAccessOperation(token: SessionAccessToken, request: FastifyRequest, rawPath: string): boolean {
  const normalizedPath = normalizeSessionAccessPath(rawPath);
  if (normalizedPath === undefined) return false;
  const { method, routeOptions: { url } } = request;
  const params = request.params as { session_id?: string; sessionId?: string; tail?: string; file_id?: string };
  const sessionId = params.session_id ?? params.sessionId;
  if (method === 'GET') {
    if ((url === '/api/sessions/:session_id/media/:file_id' || url === '/api/sessions/:session_id/media/:file_id/preview') &&
        !isFileId(params.file_id!) && parseMediaBlobRef(params.file_id!)?.kind !== 'agent') return false;
    return url !== undefined && (sessionReadRoutes.has(url) || url === '/api/usage/sessions/:sessionId/accounting') && sessionId === token.session_id && token.scopes.includes('read');
  }
  if (method !== 'POST') return false;
  if (url === '/api/klient/session-view/:sessionId/transcript/content') {
    return sessionId === token.session_id && token.scopes.includes('read');
  }
  if (url === '/api/sessions/:session_id/prompts' || url === '/api/sessions/:session_id/prompts::steer' ||
      (url === '/api/sessions/:session_id/prompts/:tail' && /^[^/:]+:cancel$/.test(params.tail ?? ''))) {
    return sessionId === token.session_id && token.scopes.includes('prompt');
  }
  const abort = /^\/api\/sessions\/([^/:]+):abort$/.exec(normalizedPath);
  return abort !== null && abort[1] === token.session_id && token.scopes.includes('abort');
}

export function registerSessionAccessAdmission(app: FastifyInstance, store: SessionAccessStore, owner: string, web: WeakSet<IncomingMessage>, peers: WeakSet<IncomingMessage>): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isSessionAccessExchange(request)) {
      reply.header('cache-control', 'no-store');
      request.headers.authorization = undefined;
      return;
    }
    const path = request.url.split('?', 1)[0]!;
    const bearer = request.headers.authorization?.slice(0, 7) === 'Bearer ' ? request.headers.authorization.slice(7) : undefined;
    if (bearer?.startsWith('ksa_')) {
      request.headers.authorization = '[redacted]';
      const token = store.lookup(bearer);
      if (token === undefined || !store.config().enabled || !isSessionAccessLoopback(request.raw, web, peers)) return reply.code(401).send(errEnvelope(40101, 'Unauthorized', request.id));
      if (!sessionAccessOperation(token, request, path)) return reply.code(403).send(errEnvelope(40101, 'session_access_scope', request.id));
      const controller = new AbortController();
      requests.set(request, { token, signal: controller.signal });
      const detach = store.attach(token, () => { controller.abort(); request.raw.destroy(); reply.raw.destroy(); });
      reply.raw.once('close', () => { if (!reply.raw.writableFinished) controller.abort(); detach(); });
    }
    if (/^\/api\/session-access(?:\/|$)/.test(request.routeOptions.url ?? path)) {
      reply.header('cache-control', 'no-store');
      if (bearer === undefined) return reply.code(401).send(errEnvelope(40101, 'local_owner_required', request.id));
      if (web.has(request.raw) || peers.has(request.raw) || peerGrant(request.headers) !== undefined || !matchesLocalOwner(bearer, owner)) {
        return reply.code(403).send(errEnvelope(40101, 'local_owner_required', request.id));
      }
    }
  });
  app.addHook('preValidation', async (request, reply) => {
    if (sessionAccessToken(request) === undefined || request.method !== 'POST' ||
        !['/api/sessions/:session_id/prompts', '/api/sessions/:session_id/prompts::steer'].includes(request.routeOptions.url ?? '')) return;
    const field = restrictedPromptField(request);
    if (field !== undefined) return reply.send(errEnvelope(40001, `Invalid session access prompt field: ${field}`, request.id));
  });
}

function restrictedPromptField(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body';
  const input = body as Record<string, unknown>;
  for (const field of Object.keys(input)) if (!['content', 'prompt_id', 'metadata', 'agent_id'].includes(field)) return field;
  if (!Array.isArray(input['content'])) return 'content';
  for (let index = 0; index < input['content'].length; index += 1) {
    const block = input['content'][index] as Record<string, unknown> | null;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return `content.${index}.type`;
    if (Object.hasOwn(block, 'presentation')) return `content.${index}.presentation`;
    if (block['type'] !== 'text' && block['type'] !== 'image_url') return `content.${index}.type`;
  }
  return undefined;
}
