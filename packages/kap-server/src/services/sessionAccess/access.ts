import type { IncomingMessage } from 'node:http';
import { isFileId } from '@kiki/agent-core-v2/app/file/fileService';
import { parseMediaBlobRef } from '@kiki/transcript';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errEnvelope } from '../../envelope';
import { isSessionAccessExchange } from '../../middleware/auth';
import { matchesLocalOwner } from '../auth/localOwner';
import { peerGrant } from '../connections/audience';
import type { SessionAccessStore, SessionAccessToken } from './store';

const requests = new WeakMap<object, { token: SessionAccessToken; signal: AbortSignal; store: SessionAccessStore }>();
export function sessionAccessToken(request: object): SessionAccessToken | undefined { return requests.get(request)?.token; }
export function sessionAccessSignal(request: object): AbortSignal | undefined { return requests.get(request)?.signal; }
export function sessionAccessStore(request: object): SessionAccessStore | undefined { return requests.get(request)?.store; }
export function isSessionAccessLoopback(request: IncomingMessage, web: WeakSet<IncomingMessage>, peers: WeakSet<IncomingMessage>): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') &&
    !web.has(request) && !peers.has(request) && peerGrant(request.headers) === undefined &&
    request.headers.origin === undefined && fetchSite === undefined;
}

const sessionReadRoutes = new Set([
  '', '/status', '/snapshot', '/events', '/messages', '/messages/:message_id', '/transcript', '/transcript/ops',
  '/transcript/detail', '/transcript/details', '/transcript/plan', '/transcript/user-messages',
  '/prompts', '/prompts/:prompt_id', '/approvals', '/questions',
  '/media/:file_id', '/media/:file_id/preview', '/children', '/tasks', '/tasks/:task_id',
  '/agent-tasks', '/goal', '/warnings', '/profile', '/runtime', '/skills', '/models',
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
  const sessionMatches = (target: string | undefined): boolean =>
    token.session_id !== undefined && target === token.session_id;
  if (method === 'GET') {
    if (url === '/api/events') {
      return token.session_id !== undefined && token.scopes.includes('read');
    }
    if (url === '/api/sessions/:session_id/agents/:agent_id/model-switches' ||
        url === '/api/sessions/:session_id/agents/:agent_id/model-switches/:operation_id') {
      return sessionMatches(sessionId) && (token.scopes.includes('read') || token.scopes.includes('control'));
    }
    if ((url === '/api/sessions/:session_id/media/:file_id' || url === '/api/sessions/:session_id/media/:file_id/preview') &&
        !isFileId(params.file_id!) && parseMediaBlobRef(params.file_id!)?.kind !== 'agent') return false;
    return url !== undefined && (sessionReadRoutes.has(url) || url === '/api/usage/sessions/:sessionId/accounting') && sessionMatches(sessionId) && token.scopes.includes('read');
  }
  if (method !== 'POST') return false;
  if (url === '/api/llm::complete' || normalizedPath === '/api/llm:complete') {
    return token.scopes.includes('llm') || token.scopes.includes('prompt');
  }
  if (url === '/api/sessions/:session_id/interactions/:tail' && /^[^/:]+:respond$/.test(params.tail ?? '')) {
    return sessionMatches(sessionId) && (token.scopes.includes('interact') || token.scopes.includes('prompt'));
  }
  if (url === '/api/sessions/:session_id/approvals/:approval_id') {
    return sessionMatches(sessionId) && token.scopes.includes('interact');
  }
  if (url === '/api/sessions/:session_id/questions/:tail' && (params.tail ?? '').length > 0) {
    return sessionMatches(sessionId) && token.scopes.includes('interact');
  }
  if (url === '/api/klient/session-view/:sessionId/transcript/content') {
    return sessionMatches(sessionId) && token.scopes.includes('read');
  }
  if (url === '/api/sessions/:session_id/prompts' || url === '/api/sessions/:session_id/prompts::steer' ||
      (url === '/api/sessions/:session_id/prompts/:tail' && /^[^/:]+:cancel$/.test(params.tail ?? ''))) {
    return sessionMatches(sessionId) && token.scopes.includes('prompt');
  }
  if (url === '/api/sessions/:session_id/profile' || url === '/api/sessions/:session_id/agents/:agent_id/model-switches') {
    return sessionMatches(sessionId) && token.scopes.includes('control');
  }
  const action = /^\/api\/sessions\/([^/:]+):(abort|compact|undo)$/.exec(normalizedPath);
  if (action !== null) {
    if (!sessionMatches(action[1])) return false;
    return action[2] === 'abort' ? token.scopes.includes('abort') : token.scopes.includes('control');
  }
  return false;
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
      await store.ready;
      const token = store.lookup(bearer);
      if (token === undefined || !store.config().enabled || !isSessionAccessLoopback(request.raw, web, peers)) return reply.code(401).send(errEnvelope(40101, 'Unauthorized', request.id));
      if (!sessionAccessOperation(token, request, path)) return reply.code(403).send(errEnvelope(40101, 'session_access_scope', request.id));
      const controller = new AbortController();
      requests.set(request, { token, signal: controller.signal, store });
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
    if (sessionAccessToken(request) === undefined || request.method !== 'POST') return;
    const url = request.routeOptions.url ?? '';
    if (url === '/api/sessions/:session_id/prompts' || url === '/api/sessions/:session_id/prompts::steer') {
      const field = restrictedPromptField(request);
      if (field !== undefined) return reply.send(errEnvelope(40001, `Invalid session access prompt field: ${field}`, request.id));
      return;
    }
    if (url === '/api/sessions/:session_id/profile') {
      const field = restrictedProfileField(request);
      if (field !== undefined) return reply.send(errEnvelope(40001, `Invalid session access profile field: ${field}`, request.id));
      return;
    }
    if (url === '/api/sessions/:session_id/agents/:agent_id/model-switches') {
      const field = restrictedModelSwitchField(request);
      if (field !== undefined) return reply.send(errEnvelope(40001, `Invalid session access model-switch field: ${field}`, request.id));
      return;
    }
    const rawPath = request.url.split('?', 1)[0]!;
    const normalizedPath = normalizeSessionAccessPath(rawPath);
    if (normalizedPath !== undefined) {
      const action = /^\/api\/sessions\/[^/:]+:(compact|undo)$/.exec(normalizedPath);
      if (action !== null) {
        const allowed = action[1] === 'compact' ? ['instruction', 'strategy'] : ['count', 'page_size'];
        const field = restrictedOptionalObjectField(request.body, allowed);
        if (field !== undefined) return reply.send(errEnvelope(40001, `Invalid session access ${action[1]} field: ${field}`, request.id));
      }
    }
  });
}

function restrictedProfileField(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body';
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  for (const field of keys) if (field !== 'agent_config') return field;
  if (!Object.hasOwn(input, 'agent_config')) return 'agent_config';
  const agentConfig = input['agent_config'];
  if (agentConfig === null || typeof agentConfig !== 'object' || Array.isArray(agentConfig)) return 'agent_config';
  const configInput = agentConfig as Record<string, unknown>;
  const configKeys = Object.keys(configInput);
  if (configKeys.length === 0) return 'agent_config';
  for (const field of configKeys) {
    if (!['model', 'thinking', 'thinking_effort', 'permission_mode', 'plan_mode'].includes(field)) {
      return `agent_config.${field}`;
    }
  }
  return undefined;
}

function restrictedModelSwitchField(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body';
  const input = body as Record<string, unknown>;
  for (const field of Object.keys(input)) {
    if (!['operationId', 'model', 'mode', 'thinking', 'selectedFromModel'].includes(field)) return field;
  }
  return undefined;
}

function restrictedOptionalObjectField(body: unknown, allowed: readonly string[]): string | undefined {
  if (body === undefined) return undefined;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body';
  const input = body as Record<string, unknown>;
  for (const field of Object.keys(input)) {
    if (!allowed.includes(field)) return field;
  }
  return undefined;
}

function restrictedPromptField(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body';
  const input = body as Record<string, unknown>;
  for (const field of Object.keys(input)) if (!['content', 'prompt_id', 'metadata', 'agent_id', 'wait', 'output_schema', 'include_thinking'].includes(field)) return field;
  if (!Array.isArray(input['content'])) return 'content';
  for (let index = 0; index < input['content'].length; index += 1) {
    const block = input['content'][index] as Record<string, unknown> | null;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return `content.${index}.type`;
    if (Object.hasOwn(block, 'presentation')) return `content.${index}.presentation`;
    if (block['type'] !== 'text' && block['type'] !== 'image_url') return `content.${index}.type`;
  }
  return undefined;
}
