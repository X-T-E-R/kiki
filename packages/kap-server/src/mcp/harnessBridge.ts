import { randomBytes } from 'node:crypto';

import { IHarnessMcpService, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance } from 'fastify';

import type { McpSeat, SeatResolver } from './seatResolver';
import { createHarnessHooks } from './harnessHooks';
import { ContextProcedureHost } from '../procedures/contextHost';

export function registerHarnessMcpBridge(core: Scope, app: FastifyInstance): SeatResolver {
  const seats = new Map<string, McpSeat>();
  const cleanups = new Set<() => Promise<void>>();
  const context = new ContextProcedureHost(core);
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
    const hooks = request.hooks ? await createHarnessHooks(request.executorId ?? '') : undefined;
    let cleanup: Promise<void> | undefined;
    const release = () => cleanup ??= (async () => {
      seats.delete(token);
      await hooks?.dispose();
      cleanups.delete(release);
    })();
    cleanups.add(release);
    seats.set(token, seat);
    return {
      processArgs: hooks?.processArgs,
      processEnv: hooks?.processEnv,
      sessionMeta: hooks?.sessionMeta,
      contextHook: request.hooks && request.executorId === 'grok-acp' ? async (event) => {
        if (!seats.has(token)) throw new Error('Harness context lease is closed');
        return (await context.hook(seat, { harness: 'grok', event })).content;
      } : undefined,
      server: {
        name: 'kiki-harness',
        command: 'kiki',
        args: ['mcp', '--workspace', request.workspacePath, '--attached'],
        env: [
          { name: 'KIKI_KAP_ENDPOINT', value: `http://127.0.0.1:${address.port}` },
          { name: 'KIKI_DELEGATION_TOKEN', value: token },
          { name: 'KIKI_SESSION_ID', value: request.sessionId },
          { name: 'KIKI_CONTEXT_MCP', value: 'true' },
          { name: 'KIKI_WORKSPACE_PATH', value: request.workspacePath },
        ],
      },
      dispose: () => { void release().catch((error: unknown) => { app.log.warn({ err: error }, 'Harness hook cleanup failed'); }); },
    };
  });
  app.addHook('onClose', async () => {
    configured.dispose();
    seats.clear();
    await Promise.allSettled([...cleanups].map((release) => release()));
  });
  return { resolve: async (bearer) => seats.get(bearer) ?? null };
}
