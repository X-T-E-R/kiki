/**
 * MCP JSON management REST routes.
 *
 * Lists and mutates the editable user/project MCP server entries through the
 * addressed workspace's validated core writer, returning its authoritative
 * post-reload file projection.
 */

import {
  ErrorCodes,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  McpJsonWriteErrors,
  isError2,
  type IMcpJsonWriter,
  type McpJsonServerList,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  listMcpJsonServersQuerySchema,
  listMcpJsonServersResponseSchema,
  mcpJsonServerNameParamsSchema,
  removeMcpJsonServerQuerySchema,
  upsertMcpJsonServerRequestSchema,
} from '../protocol/rest-mcpConfig';

interface McpConfigRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerMcpConfigRoutes(app: McpConfigRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/config/servers',
      querystring: listMcpJsonServersQuerySchema,
      success: { data: listMcpJsonServersResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List editable MCP JSON server entries for a workspace',
      tags: ['tools'],
      operationId: 'listMcpJsonServers',
    },
    async (req, reply) => {
      const result = await withWriter(core, req.query.workspace_id, req.id, reply, (writer) =>
        writer.list()
      );
      if (result !== undefined) reply.send(okEnvelope(result, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<McpConfigRouteHost['get']>[2],
  );

  const upsertRoute = defineRoute(
    {
      method: 'PUT',
      path: '/mcp/servers/{name}',
      params: mcpJsonServerNameParamsSchema,
      body: upsertMcpJsonServerRequestSchema,
      success: { data: listMcpJsonServersResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Create or replace an editable MCP JSON server entry',
      tags: ['tools'],
      operationId: 'upsertMcpJsonServer',
    },
    async (req, reply) => {
      const result = await withWriter(core, req.body.workspace_id, req.id, reply, (writer) =>
        writer.upsert({
          name: req.params.name,
          scope: req.body.scope,
          config: req.body.config,
        })
      );
      if (result !== undefined) reply.send(okEnvelope(result, req.id));
    },
  );
  app.put(
    upsertRoute.path,
    upsertRoute.options,
    upsertRoute.handler as Parameters<McpConfigRouteHost['put']>[2],
  );

  const removeRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/mcp/servers/{name}',
      params: mcpJsonServerNameParamsSchema,
      querystring: removeMcpJsonServerQuerySchema,
      success: { data: listMcpJsonServersResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.MCP_SERVER_NOT_FOUND]: {},
        [ErrorCode.MCP_SERVER_READ_ONLY]: {},
      },
      description: 'Delete an editable MCP JSON server entry',
      tags: ['tools'],
      operationId: 'removeMcpJsonServer',
    },
    async (req, reply) => {
      const result = await withWriter(core, req.query.workspace_id, req.id, reply, (writer) =>
        writer.remove({ name: req.params.name, scope: req.query.scope })
      );
      if (result !== undefined) reply.send(okEnvelope(result, req.id));
    },
  );
  app.delete(
    removeRoute.path,
    removeRoute.options,
    removeRoute.handler as Parameters<McpConfigRouteHost['delete']>[2],
  );
}

async function withWriter(
  core: Scope,
  workspaceId: string,
  requestId: string,
  reply: { send(payload: unknown): unknown },
  work: (writer: IMcpJsonWriter) => Promise<McpJsonServerList>,
): Promise<McpJsonServerList | undefined> {
  const workspace = await core.accessor.get(IWorkspaceService).get(workspaceId);
  if (workspace === undefined) {
    reply.send(errEnvelope(
      ErrorCode.WORKSPACE_NOT_FOUND,
      `workspace ${workspaceId} does not exist`,
      requestId,
    ));
    return undefined;
  }

  const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire({ workspaceId });
  try {
    await lease.instance.program.ready;
    return await work(lease.instance.program.mcpJsonWriter);
  } catch (error) {
    sendMappedError(reply, requestId, error);
    return undefined;
  } finally {
    lease.dispose();
  }
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  error: unknown,
): void {
  if (isError2(error) && error.code === ErrorCodes.VALIDATION_FAILED) {
    const issues = Array.isArray(error.details?.['issues'])
      ? error.details['issues']
      : [{ path: '', message: error.message }];
    reply.send({
      ...errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, requestId),
      details: issues,
    });
    return;
  }
  if (isError2(error) && error.code === McpJsonWriteErrors.codes.MCP_WRITE_NOT_FOUND) {
    reply.send(errEnvelope(ErrorCode.MCP_SERVER_NOT_FOUND, error.message, requestId));
    return;
  }
  if (isError2(error) && error.code === McpJsonWriteErrors.codes.MCP_WRITE_READ_ONLY) {
    reply.send(errEnvelope(ErrorCode.MCP_SERVER_READ_ONLY, error.message, requestId));
    return;
  }
  throw error;
}
