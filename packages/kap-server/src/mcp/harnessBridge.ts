import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isSea } from 'node:sea';
import { resolveKikiCliLaunch } from '@kiki/agent-core-v2/os/backends/node-local/kikiCliPath';

import { IHarnessMcpService, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance } from 'fastify';

import type { McpSeat, SeatResolver } from './seatResolver';
import { createHarnessHooks } from './harnessHooks';
import { ContextProcedureHost } from '../procedures/contextHost';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { withSessionOperation } from '../lib/sessionOperationLease';

export function registerHarnessMcpBridge(core: Scope, app: FastifyInstance): SeatResolver {
  const seats = new Map<string, McpSeat>();
  const cleanups = new Set<() => Promise<void>>();
  const context = new ContextProcedureHost(core);
  const configured = core.accessor.get(IHarnessMcpService).configure(async (request) => {
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Harness MCP requires a listening HTTP server');
    const launch = await resolveKikiCliLaunch({ isSea, execPath: process.execPath, argv: process.argv,
      isFile: async (path) => { try { return (await stat(path)).isFile(); } catch { return false; } } });
    const command = launch?.kind === 'executable' ? launch.executable : launch?.kind === 'node' ? launch.nodePath : 'kiki';
    const prefix = launch?.kind === 'node' ? [launch.entryPath] : [];
    const harnessAgentInstance = request.nativeTools === true ? await withSessionOperation(core, request.sessionId, async (session) => {
      const agent = session?.accessor.get(IAgentLifecycleService).get(request.agentId);
      if (agent === undefined) throw new Error('Harness agent is not available');
      return agent;
    }) : undefined;
    const token = randomBytes(32).toString('hex');
    const seat: McpSeat = {
      seatId: `harness:${request.sessionId}:${request.agentId}`,
      principalId: `harness:${request.sessionId}:${request.agentId}`,
      sessionId: request.sessionId,
      delegationToken: token,
      workspacePath: request.workspacePath,
      harnessAgentId: request.agentId,
      nativeTools: request.nativeTools,
      harnessAgentInstance,
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
        command,
        args: [...prefix, 'mcp', '--workspace', request.workspacePath, '--attached'],
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
