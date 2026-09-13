import { IConfigService, type Scope } from '@kiki/agent-core-v2';
import { FiberState } from '@kiki/agent-core-v2/_base/di/fiber';
import { IFeatureManager } from '@kiki/agent-core-v2/app/feature/featureManager';
import { IFlagService } from '@kiki/agent-core-v2/app/flag/flag';
import type { KimiHostIdentity } from '@kiki/oauth';

import { okEnvelope } from '../envelope';
import type { ExternalDelegationState, MetaFeature } from '../protocol/rest-meta';
import { type IConnectionRegistry } from '../transport/ws/connectionRegistry';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import type { TranscriptService } from '../services/transcript/transcriptService';
import type { LeaseRegistry } from '../services/leaseRegistry';
import { registerAgentProfilesRoute } from './agentProfiles';
import { registerLeaseRoutes } from './leases';
import { registerApprovalsRoutes } from './approvals';
import { registerAuthRoute } from './auth';
import { registerCapabilitiesRoutes } from './capabilities';
import { registerConfigRoutes } from './config';
import { registerConnectionsRoutes } from './connections';
import { registerFilesRoutes } from './files';
import { registerFsRoutes } from './fs';
import { registerGuiStoreRoutes } from './guiStore';
import { registerMessagesRoutes } from './messages';
import type { IGuiStoreService } from '../services/guiStore/guiStore';
import { registerDebugRoutes } from '../transport/registerDebugRoutes';
import { registerMetaRoute } from './meta';
import { registerModelCatalogRoutes } from './modelCatalog';
import { registerNbSearchRoutes } from './nbSearch';
import { registerOAuthRoutes } from './oauth';
import { registerPluginsRoutes } from './plugins';
import { registerPromptsRoutes } from './prompts';
import { registerQuestionsRoutes } from './questions';
import { registerRuntimeRoutes } from './runtime';
import { registerSearchRoutes } from './search';
import { registerSessionMediaRoutes } from './sessionMedia';
import { registerSessionExportRoute } from './sessionExport';
import { registerSessionsRoutes } from './sessions';
import { registerShutdownRoutes } from './shutdown';
import { registerSnapshotRoutes } from './snapshot';
import { registerSkillsRoutes } from './skills';
import { registerTasksRoutes } from './tasks';
import { registerTerminalsRoutes } from './terminals';
import { registerToolsRoutes } from './tools';
import { registerTranscriptRoutes } from './transcript';
import { registerThreadsRoutes } from './threads';
import { registerWorkspaceFsRoutes } from './workspaceFs';
import { registerWorkspacesRoutes } from './workspaces';

interface ApiV1AppHost {
  register(
    plugin: (apiV1: ApiV1RouteHost) => Promise<void> | void,
    opts: { prefix: string },
  ): unknown;
}

interface ApiV1RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string }, reply: { send(payload: unknown): unknown }) => unknown,
  ): unknown;
}

export interface RegisterApiV1RoutesOptions {
  readonly serverVersion: string;
  readonly serverId: string;
  readonly startedAt: string;
  readonly hostIdentity: KimiHostIdentity;
  readonly debugEndpoints?: boolean;
  readonly enableShutdown?: boolean;
  readonly enableTerminals?: boolean;
  readonly guiStore: IGuiStoreService;
  readonly onShutdown: () => void;
  readonly shutdownSignal?: AbortSignal;
  readonly connectionRegistry: IConnectionRegistry;
  readonly broadcaster: SessionEventBroadcaster;
  readonly transcriptService: TranscriptService;
  readonly leaseRegistry: LeaseRegistry;
  readonly onWorkspaceServed: (workspace: string) => void | Promise<void>;
  /**
   * Catalog URL resolver for the `/plugins/marketplace` route. `undefined`
   * means no marketplace is configured (option, env, and config.toml all
   * empty) and the route reports `{ configured: false }` without fetching.
   */
  readonly pluginMarketplaceUrl: () => string | undefined;
  /**
   * Surface `dangerous_bypass_auth` in the `/meta` payload. Set by `start.ts`
   * from the `disableAuth` server option (the `--dangerous-bypass-auth` CLI
   * flag).
   */
  readonly dangerousBypassAuth?: boolean;
  readonly externalDelegation: ExternalDelegationState;
  /**
   * Custom browser tab title for this instance, surfaced as `web_title` in the
   * `/meta` payload. Set by `start.ts` from the `webTitle` server option (the
   * CLI's `--web-title` flag).
   */
  readonly webTitle?: string;
}

export async function registerApiV1Routes(
  app: ApiV1AppHost,
  core: Scope,
  opts: RegisterApiV1RoutesOptions,
): Promise<void> {
  await app.register(
    async (apiV1) => {
      registerHealthRoute(apiV1);

      if (opts.debugEndpoints === true) {
        registerDebugRoutes(apiV1 as unknown as Parameters<typeof registerDebugRoutes>[0], core);
      }

      registerMetaRoute(apiV1, {
        serverVersion: opts.serverVersion,
        serverId: opts.serverId,
        startedAt: opts.startedAt,
        enableTerminals: opts.enableTerminals !== false,
        dangerousBypassAuth: opts.dangerousBypassAuth === true,
        externalDelegation: opts.externalDelegation,
        webTitle: opts.webTitle,
        getExperimentalFlags: async () => {
          await core.accessor.get(IConfigService).ready;
          return core.accessor.get(IFlagService).snapshot();
        },
        getFeatures: () =>
          core.accessor
            .get(IFeatureManager)
            .units()
            .map((unit) => ({
              name: unit.name,
              state: FiberState[unit.state] as MetaFeature['state'],
              meta: unit.meta,
            })),
      });

      registerAuthRoute(apiV1 as unknown as Parameters<typeof registerAuthRoute>[0], core);
      registerLeaseRoutes(apiV1 as unknown as Parameters<typeof registerLeaseRoutes>[0], opts.leaseRegistry);
      registerAgentProfilesRoute(
        apiV1 as unknown as Parameters<typeof registerAgentProfilesRoute>[0],
        core,
      );
      registerOAuthRoutes(apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0], core);
      registerConfigRoutes(apiV1 as unknown as Parameters<typeof registerConfigRoutes>[0], core);
      registerNbSearchRoutes(apiV1 as unknown as Parameters<typeof registerNbSearchRoutes>[0], core);
      registerModelCatalogRoutes(
        apiV1 as unknown as Parameters<typeof registerModelCatalogRoutes>[0],
        core,
      );
      registerSessionsRoutes(
        apiV1 as unknown as Parameters<typeof registerSessionsRoutes>[0],
        core,
        opts.broadcaster,
        opts.onWorkspaceServed,
        opts.leaseRegistry,
      );
      registerRuntimeRoutes(apiV1 as unknown as Parameters<typeof registerRuntimeRoutes>[0], core);
      registerSessionExportRoute(
        apiV1 as unknown as Parameters<typeof registerSessionExportRoute>[0],
        core,
        { hostIdentity: opts.hostIdentity },
      );
      registerSkillsRoutes(apiV1 as unknown as Parameters<typeof registerSkillsRoutes>[0], core);
      registerCapabilitiesRoutes(
        apiV1 as unknown as Parameters<typeof registerCapabilitiesRoutes>[0],
        core,
      );
      registerPluginsRoutes(apiV1 as unknown as Parameters<typeof registerPluginsRoutes>[0], core, {
        marketplaceUrl: opts.pluginMarketplaceUrl,
      });
      registerMessagesRoutes(
        apiV1 as unknown as Parameters<typeof registerMessagesRoutes>[0],
        {
          core,
          broadcaster: opts.broadcaster,
          transcriptService: opts.transcriptService,
        },
      );
      registerSearchRoutes(apiV1 as unknown as Parameters<typeof registerSearchRoutes>[0], core);
      registerTasksRoutes(apiV1 as unknown as Parameters<typeof registerTasksRoutes>[0], core);
      registerApprovalsRoutes(
        apiV1 as unknown as Parameters<typeof registerApprovalsRoutes>[0],
        core,
      );
      registerQuestionsRoutes(
        apiV1 as unknown as Parameters<typeof registerQuestionsRoutes>[0],
        core,
      );
      registerPromptsRoutes(
        apiV1 as unknown as Parameters<typeof registerPromptsRoutes>[0],
        core,
      );
      registerWorkspacesRoutes(
        apiV1 as unknown as Parameters<typeof registerWorkspacesRoutes>[0],
        core,
      );
      registerWorkspaceFsRoutes(
        apiV1 as unknown as Parameters<typeof registerWorkspaceFsRoutes>[0],
        core,
      );
      registerFilesRoutes(apiV1 as unknown as Parameters<typeof registerFilesRoutes>[0], core);
      registerSessionMediaRoutes(
        apiV1 as unknown as Parameters<typeof registerSessionMediaRoutes>[0],
        core,
      );
      registerFsRoutes(apiV1 as unknown as Parameters<typeof registerFsRoutes>[0], core);
      registerGuiStoreRoutes(apiV1 as unknown as Parameters<typeof registerGuiStoreRoutes>[0], opts.guiStore);
      registerToolsRoutes(apiV1 as unknown as Parameters<typeof registerToolsRoutes>[0], core);
      if (opts.enableTerminals !== false) {
        registerTerminalsRoutes(
          apiV1 as unknown as Parameters<typeof registerTerminalsRoutes>[0],
          core,
        );
      }
      registerConnectionsRoutes(
        apiV1 as unknown as Parameters<typeof registerConnectionsRoutes>[0],
        opts.connectionRegistry,
      );
      registerSnapshotRoutes(apiV1 as unknown as Parameters<typeof registerSnapshotRoutes>[0], {
        core,
        broadcaster: opts.broadcaster,
      });
      registerTranscriptRoutes(apiV1 as unknown as Parameters<typeof registerTranscriptRoutes>[0], {
        core,
        transcriptService: opts.transcriptService,
      });
      registerThreadsRoutes(
        apiV1 as unknown as Parameters<typeof registerThreadsRoutes>[0],
        core,
        opts.shutdownSignal,
      );
      if (opts.enableShutdown !== false) {
        registerShutdownRoutes(apiV1 as unknown as Parameters<typeof registerShutdownRoutes>[0], {
          onShutdown: opts.onShutdown,
        });
      }
    },
    { prefix: '/api/v1' },
  );
}

function registerHealthRoute(apiV1: ApiV1RouteHost): void {
  apiV1.get(
    '/healthz',
    {
      schema: {
        description: 'Health check',
        response: {
          200: {
            type: 'object',
            properties: {
              code: { type: 'number' },
              msg: { type: 'string' },
              data: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
              },
              request_id: { type: 'string' },
            },
          },
        },
      },
    },
    async (req, reply) => {
      return reply.send(okEnvelope({ ok: true }, req.id));
    },
  );
}
