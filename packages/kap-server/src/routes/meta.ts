import type { IncomingMessage } from 'node:http';
import { okEnvelope } from '../envelope';
import { peerAudience } from '../services/connections/audience';
import { defineRoute } from '../middleware/defineRoute';
import { metaResponseSchema, type ExternalDelegationState, type MetaFeature, type MetaResponse } from '@kiki/protocol';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; raw: IncomingMessage },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export interface MetaRouteOptions {
  readonly serverVersion: string;
  readonly buildId?: string;
  readonly buildChannel?: string;
  readonly serverId: string;
  readonly desktopManaged?: boolean;
  readonly serverHomeId?: string;
  readonly currentSpaceId: string;
  readonly startedAt: string;
  /** Whether terminal REST and WebSocket controls are exposed on this bind. */
  readonly enableTerminals: boolean;
  readonly terminalTransportAllowed: (request: IncomingMessage) => boolean;
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
  const capabilities = Object.freeze({
    websocket: true as const,
    file_upload: true as const,
    fs_query: true as const,
    mcp: true as const,
    tasks: true as const,
    thread_communication: true as const,
    transcript: true as const,
  });
  const staticData = Object.freeze({
    server_version: opts.serverVersion,
    build_id: opts.buildId,
    build_channel: opts.buildChannel,
    server_id: opts.serverId,
    desktop_managed: opts.desktopManaged,
    server_home_id: opts.serverHomeId,
    current_space_id: opts.currentSpaceId,
    started_at: opts.startedAt,
    open_in_apps: [],
    dangerous_bypass_auth: opts.dangerousBypassAuth,
    external_delegation: Object.freeze(opts.externalDelegation),
    backend: 'v2' as const,
    web_title: opts.webTitle,
    storage_mode: 'normal' as const,
    storage_status_path: '/api/storage' as const,
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
      const experimentalFlags = await opts.getExperimentalFlags();
      const features = await opts.getFeatures();
      const peer = peerAudience(req);
      const { raw } = req as typeof req & { raw: IncomingMessage };
      const terminal = opts.enableTerminals && opts.terminalTransportAllowed(raw) &&
        (peer === undefined || peer.meshCapabilities?.includes('execute') === true);
      const data: MetaResponse = {
        ...staticData,
        capabilities: terminal ? { ...capabilities, terminal: true } : capabilities,
        experimental_flags: experimentalFlags,
        features,
      };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as unknown as Parameters<RouteHost['get']>[2]);
}
