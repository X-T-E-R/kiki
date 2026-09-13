import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { metaResponseSchema } from '../protocol/rest-meta';
import type {
  ExternalDelegationState,
  MetaFeature,
  MetaResponse,
} from '../protocol/rest-meta';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export interface MetaRouteOptions {
  readonly serverVersion: string;
  readonly buildId?: string;
  readonly buildChannel?: string;
  readonly serverId: string;
  readonly startedAt: string;
  /** Whether terminal REST and WebSocket controls are exposed on this bind. */
  readonly enableTerminals: boolean;
  /**
   * Whether the server was started with `--dangerous-bypass-auth`. Surfaced so
   * the web UI can skip the token prompt and connect without a credential.
   */
  readonly dangerousBypassAuth: boolean;
  readonly externalDelegation: ExternalDelegationState;
  /**
   * Custom browser tab title for this instance (the CLI's `--web-title`).
   * Surfaced as `web_title` in the `/meta` payload; instance-level and frozen
   * at boot, so it joins the frozen static fields. Omitted when unset.
   */
  readonly webTitle?: string;
  /**
   * Resolves the effective experimental-flag map (flag id → enabled) at
   * request time. Backed by `IFlagService.snapshot()` in production; tests may
   * stub it. May return a promise — the handler awaits it, so flag state
   * always reflects the fully loaded config (never pre-load defaults).
   */
  readonly getExperimentalFlags: () => Record<string, boolean> | Promise<Record<string, boolean>>;
  /**
   * Resolves the engine's current feature list at request time. Backed by
   * `IFeatureManager.units()` in production, so runtime retraction or a failed
   * assembly is reflected in the very next response.
   */
  readonly getFeatures: () => MetaFeature[] | Promise<MetaFeature[]>;
}

export function registerMetaRoute(app: RouteHost, opts: MetaRouteOptions): void {
  const capabilities = {
    websocket: true as const,
    file_upload: true as const,
    fs_query: true as const,
    mcp: true as const,
    tasks: true as const,
    terminal: opts.enableTerminals ? (true as const) : undefined,
    thread_communication: true as const,
    transcript: true as const,
  };
  const staticData = Object.freeze({
    server_version: opts.serverVersion,
    build_id: opts.buildId,
    build_channel: opts.buildChannel,
    capabilities: Object.freeze(capabilities),
    server_id: opts.serverId,
    started_at: opts.startedAt,
    open_in_apps: [],
    dangerous_bypass_auth: opts.dangerousBypassAuth,
    external_delegation: Object.freeze(opts.externalDelegation),
    backend: 'v2' as const,
    web_title: opts.webTitle,
  });

  const route = defineRoute(
    {
      method: 'GET',
      path: '/meta',
      success: { data: metaResponseSchema },
      description: 'Get server metadata',
      tags: ['meta'],
    },
    async (req, reply) => {
      const data: MetaResponse = {
        ...staticData,
        experimental_flags: await opts.getExperimentalFlags(),
        features: await opts.getFeatures(),
      };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
