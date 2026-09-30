import { randomBytes } from 'node:crypto';

import { IHarnessMcpService, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance } from 'fastify';

import type { McpSeat, SeatResolver } from './seatResolver';

export function registerHarnessMcpBridge(core: Scope, app: FastifyInstance): SeatResolver {
  const seats = new Map<string, McpSeat>();
  const configured = core.accessor.get(IHarnessMcpService).configure(async (request) => {
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Harness MCP requires a listening HTTP server');
    const token = randomBytes(32).toString('hex');
    const seat: McpSeat = {
      seatId: `harness:${request.sessionId}`,
      principalId: `harness:${request.sessionId}`,
      sessionId: request.sessionId,
      delegationToken: token,
      workspacePath: request.workspacePath,
      harnessAgentId: request.agentId,
    };
    seats.set(token, seat);
    return {
      server: {
        name: 'kiki-harness',
        command: 'kiki',
        args: ['mcp', '--workspace', request.workspacePath, '--attached'],
        env: [
          { name: 'KIKI_KAP_ENDPOINT', value: `http://127.0.0.1:${address.port}` },
          { name: 'KIKI_DELEGATION_TOKEN', value: token },
          { name: 'KIKI_SESSION_ID', value: request.sessionId },
          { name: 'KIKI_WORKSPACE_PATH', value: request.workspacePath },
        ],
      },
      dispose: () => { seats.delete(token); },
    };
  });
  app.addHook('onClose', () => {
    configured.dispose();
    seats.clear();
  });
  return { resolve: async (bearer) => seats.get(bearer) ?? null };
}
