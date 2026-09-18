import { ISessionManager, IWorkspaceInstanceManager, type Scope } from '@kiki/agent-core-v2';

import { okEnvelope } from '../protocol/envelope';
import { messageHistoryCacheReport } from '../services/messages/messageHistory';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { registerBusinessSnapshotRoutes } from './businessSnapshotRoutes';
import { describeAllChannels, resolveAnyScopedServiceId } from './channelRegistry';
import { type RouteHost, registerServiceDispatcherRoutes } from './serviceDispatcherRoutes';

export function registerDebugRoutes(
  app: RouteHost,
  core: Scope,
  transcriptService: TranscriptService,
): void {
  registerServiceDispatcherRoutes(app, core, '/debug', {
    lookup: (name) => resolveAnyScopedServiceId(core, name),
    describe: describeAllChannels,
  });
  registerBusinessSnapshotRoutes(app, core, '/debug');
  app.get('/debug/memory', async (req, reply) => {
    const memory = process.memoryUsage();
    const sessions = core.accessor.get(ISessionManager);
    const workspaces = core.accessor.get(IWorkspaceInstanceManager);
    return reply.send(okEnvelope({
      process: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      residency: {
        ...(sessions.residencyReport?.() ?? {
          liveSessions: sessions.list().length,
          pinnedSessions: 0,
          idleSessions: 0,
          pendingRestores: 0,
          lifecycleOperations: 0,
          evictionAttempts: 0,
          evictionSuccesses: 0,
          evictionFailures: 0,
        }),
        workspaces: workspaces.list().length,
        workspaceReferences: workspaces.list().reduce(
          (total, workspace) => total + workspaces.referenceCount(workspace.id),
          0,
        ),
      },
      transcript: transcriptService.memoryReport(),
      messageHistory: messageHistoryCacheReport(core),
    }, req.id));
  });
}
