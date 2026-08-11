/**
 * `GET /meta` route handler.
 *
 * Returns `server_version`, the declared `capabilities` map, a per-process
 * `server_id` (ULID minted at boot), and `started_at`.
 *
 * **Capabilities**: present entries use the literal `true`; an exposure-gated
 * capability is omitted rather than advertised as usable.
 *
 * **No DI for the static fields**: pure server-self info; that part of the
 * payload is frozen at registration time. `experimental_flags` is the
 * exception — flag state flips live when the `[experimental]` config section
 * changes, so it is resolved per request through the injected getter.
 */

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { metaResponseSchema } from '../protocol/rest-meta';
import type { MetaResponse } from '../protocol/rest-meta';

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
  readonly serverId: string;
  readonly startedAt: string;
  /** Whether terminal REST and WebSocket controls are exposed on this bind. */
  readonly enableTerminals: boolean;
  /**
   * Whether the server was started with `--dangerous-bypass-auth`. Surfaced so
   * the web UI can skip the token prompt and connect without a credential.
   */
  readonly dangerousBypassAuth: boolean;
  /**
   * Resolves the effective experimental-flag map (flag id → enabled) at
   * request time. Backed by `IFlagService.snapshot()` in production; tests may
   * stub it. May return a promise — the handler awaits it, so flag state
   * always reflects the fully loaded config (never pre-load defaults).
   */
  readonly getExperimentalFlags: () => Record<string, boolean> | Promise<Record<string, boolean>>;
}

export function registerMetaRoute(app: RouteHost, opts: MetaRouteOptions): void {
  const capabilities = {
    websocket: true as const,
    file_upload: true as const,
    fs_query: true as const,
    mcp: true as const,
    tasks: true as const,
    terminal: opts.enableTerminals ? (true as const) : undefined,
  };
  const staticData = Object.freeze({
    server_version: opts.serverVersion,
    capabilities: Object.freeze(capabilities),
    server_id: opts.serverId,
    started_at: opts.startedAt,
    open_in_apps: [],
    dangerous_bypass_auth: opts.dangerousBypassAuth,
    backend: 'v2' as const,
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
      };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
