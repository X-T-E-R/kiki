import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createKikiMcpServer, type KikiMcpConfig, type KikiMcpServerOptions } from './server';
import type { McpSeat, SeatResolver } from './seatResolver';

export const KIKI_MCP_HTTP_PATH = '/mcp';

export interface RegisterKikiMcpHttpOptions {
  readonly seatResolver: SeatResolver;
  readonly resolveConfig: (seat: McpSeat) => KikiMcpConfig;
  readonly serverOptions?: KikiMcpServerOptions;
}

export interface KikiMcpHttpHandle {
  close(): Promise<void>;
}

interface McpHttpSession {
  readonly seat: McpSeat;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: ReturnType<typeof createKikiMcpServer>;
}

const UNAUTHORIZED = { code: 'unauthorized', msg: 'MCP seat authentication failed.' };
const SESSION_NOT_FOUND = { code: 'session_not_found', msg: 'MCP session was not found.' };

export function registerKikiMcpHttp(
  app: FastifyInstance,
  options: RegisterKikiMcpHttpOptions,
): KikiMcpHttpHandle {
  const sessions = new Map<string, McpHttpSession>();

  const drop = (sessionId: string): McpHttpSession | undefined => {
    const session = sessions.get(sessionId);
    if (session === undefined) return undefined;
    sessions.delete(sessionId);
    return session;
  };

  const closeAll = async (): Promise<void> => {
    const closing = [...sessions.entries()].map(async ([sessionId, session]) => {
      sessions.delete(sessionId);
      await session.server.close();
      await session.transport.close();
    });
    await Promise.all(closing);
  };

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: KIKI_MCP_HTTP_PATH,
    schema: { hide: true },
    handler: async (req, reply) => {
      const bearer = readBearer(req.headers.authorization);
      const seat = bearer === undefined ? null : options.seatResolver.resolve(bearer);
      if (seat === null) {
        return reply.code(401).send(UNAUTHORIZED);
      }

      const sessionHeader = headerValue(req.headers['mcp-session-id']);
      if (sessionHeader !== undefined) {
        const existing = sessions.get(sessionHeader);
        if (existing === undefined) {
          return reply.code(404).send(SESSION_NOT_FOUND);
        }
        if (existing.seat.delegationToken !== seat.delegationToken) {
          return reply.code(401).send(UNAUTHORIZED);
        }
        return dispatch(existing.transport, req, reply);
      }

      let session!: McpHttpSession;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, session);
        },
        onsessionclosed: (sessionId) => {
          const closed = drop(sessionId);
          if (closed === undefined) return;
          void closed.server.close();
        },
      });
      const server = createKikiMcpServer(options.resolveConfig(seat), options.serverOptions);
      session = { seat, transport, server };
      await server.connect(transport);
      await dispatch(transport, req, reply);
      if (transport.sessionId === undefined) {
        await server.close();
        await transport.close();
        return;
      }
      sessions.set(transport.sessionId, session);
    },
  });

  app.addHook('onClose', closeAll);
  return { close: closeAll };
}

async function dispatch(
  transport: StreamableHTTPServerTransport,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.hijack();
  try {
    await transport.handleRequest(
      req.raw as IncomingMessage,
      reply.raw as ServerResponse,
      req.method === 'POST' ? req.body : undefined,
    );
  } catch (error) {
    if (!reply.raw.headersSent) {
      reply.raw.statusCode = 500;
      reply.raw.setHeader('content-type', 'application/json');
      reply.raw.end(JSON.stringify({ code: 'internal', msg: 'MCP transport failed.' }));
      return;
    }
    reply.raw.destroy(error instanceof Error ? error : undefined);
  }
}

function readBearer(authorization: string | string[] | undefined): string | undefined {
  const header = headerValue(authorization);
  if (header === undefined || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return token.length === 0 ? undefined : token;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined || raw.length === 0 ? undefined : raw;
}
