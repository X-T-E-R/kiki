import { IMcpManagementService, type Scope } from '@kiki/agent-core-v2';
import {
  registerInstalledWindowsMcpEnvironment,
  windowsMcpEnvironmentPlan,
} from '@kiki/agent-core-v2/app/capability/entries/kikiWindowsMcp';
import {
  WINDOWS_MCP_COMPUTER_CONNECTION,
  windowsMcpEnvironmentResponseSchema,
  windowsMcpRegisterRequestSchema,
  windowsMcpRegisterResponseSchema,
} from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface ComputerExecutorRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: { python: string; configPath: string; version: '0.8.8' } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerComputerExecutorRoutes(app: ComputerExecutorRouteHost, core: Scope): void {
  const describeRoute = defineRoute(
    {
      method: 'GET',
      path: '/computer/windows-mcp',
      success: { data: windowsMcpEnvironmentResponseSchema },
      errors: {},
      description: 'Describe the external Windows-MCP 0.8.8 computer executor. This does not download, install, or start it.',
      tags: ['computer'],
      operationId: 'describeWindowsMcp',
    },
    async (req, reply) => {
      const plan = windowsMcpEnvironmentPlan();
      reply.send(okEnvelope({
        ...plan,
        bundled: false,
        autoStart: false,
        connection: WINDOWS_MCP_COMPUTER_CONNECTION,
      }, req.id));
    },
  );
  app.get(describeRoute.path, describeRoute.options, describeRoute.handler as Parameters<ComputerExecutorRouteHost['get']>[2]);

  const registerRoute = defineRoute(
    {
      method: 'POST',
      path: '/computer/windows-mcp/register',
      body: windowsMcpRegisterRequestSchema,
      success: { data: windowsMcpRegisterResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'Record an already installed Windows-MCP 0.8.8 interpreter. Does not copy an environment into the Kiki home, start the server, or select the computer connection.',
      tags: ['computer'],
      operationId: 'registerWindowsMcp',
    },
    async (req, reply) => {
      try {
        const mcp = core.accessor.get(IMcpManagementService);
        const result = await registerInstalledWindowsMcpEnvironment({
          listServers: async () => (await mcp.listServers()).map((server) => ({
            name: server.name,
            config: {
              transport: server.config.transport,
              command: 'command' in server.config && typeof server.config.command === 'string' ? server.config.command : undefined,
              args: 'args' in server.config && Array.isArray(server.config.args) ? server.config.args.filter((item): item is string => typeof item === 'string') : undefined,
            },
          })),
          addServer: (server) => mcp.addServer(server),
        }, process.platform, req.body.python, req.body.configPath, req.body.version);
        reply.send(okEnvelope({
          result,
          name: WINDOWS_MCP_COMPUTER_CONNECTION,
          connection: WINDOWS_MCP_COMPUTER_CONNECTION,
          started: false,
          bundled: false,
        }, req.id));
      } catch (error) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error instanceof Error ? error.message : String(error), req.id));
      }
    },
  );
  app.post(registerRoute.path, registerRoute.options, registerRoute.handler as Parameters<ComputerExecutorRouteHost['post']>[2]);
}
