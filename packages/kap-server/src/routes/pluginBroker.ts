import {
  Error2,
  ErrorCodes as DomainErrorCodes,
  IBootstrapService,
  IInstantiationService,
  IPluginExtensionPortRegistry,
  IPluginService,
  IPluginUsageService,
  ISessionContext,
  ISessionIndex,
  SyncDescriptor,
  isError2,
  getLiveSessionById,
  ref,
  type LiveRef,
  type PluginHttpRouteHandlerContext,
  type PluginHttpRouteResult,
  type Scope,
} from '@kiki/agent-core-v2';
import {
  pluginHttpRouteDescriptorSchema,
  type PluginGuiSlotContribution,
  type PluginHttpRouteDescriptor,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { ErrorCode } from '../protocol/error-codes';
import {
  listPluginGuiSlotsResponseSchema,
  pluginBrokerRouteParamsSchema,
  pluginGuiSlotsQuerySchema,
  type PluginExtensionBrokerHostPort,
  type PluginGuiSlotsQuery,
} from '../protocol/rest-plugin-broker';
import { resolvePluginUsageWorkspace } from './pluginUsage';

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENCODED_SLASH_OR_NULL_PATTERN = /%(?:2f|5c|00)/i;
const DEFAULT_MAX_BODY_BYTES = 262_144;
const MAX_ALLOWED_BODY_BYTES = 4 * 1024 * 1024;
const RESERVED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'settings',
  'panels',
  'commands',
  'navigation',
  'marketplace',
  'models',
  'usage',
  'gui-slots',
  'routes',
]);

class OptionalExtensionRegistryReader {
  constructor(
    @ref(IPluginExtensionPortRegistry)
    readonly portRef: LiveRef<IPluginExtensionPortRegistry>,
  ) {}
}

/** Safely reads the optional `IPluginExtensionPortRegistry` from a `Scope` without throwing when Track D is unregistered. */
export function resolvePluginExtensionBrokerPort(
  core: Scope,
): PluginExtensionBrokerHostPort | undefined {
  try {
    const instantiation = core.accessor.get(IInstantiationService);
    if (instantiation !== undefined && typeof instantiation.createInstance === 'function') {
      const reader = instantiation.createInstance<OptionalExtensionRegistryReader>(
        new SyncDescriptor(OptionalExtensionRegistryReader),
      );
      return reader.portRef.current;
    }
  } catch {
  }
  try {
    return core.accessor.get(IPluginExtensionPortRegistry);
  } catch {
    return undefined;
  }
}

interface PluginBrokerRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown>; bodyLimit?: number },
    handler: (...args: never[]) => unknown,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown>; bodyLimit?: number },
    handler: (...args: never[]) => unknown,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown>; bodyLimit?: number },
    handler: (...args: never[]) => unknown,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown>; bodyLimit?: number },
    handler: (...args: never[]) => unknown,
  ): unknown;
}

interface BrokerFastifyRequest {
  readonly id: string;
  readonly raw?: { readonly url?: string };
  readonly params: { readonly pluginId: string; readonly '*': string };
  readonly query?: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
  readonly body?: unknown;
}

function readHeaderValue(headers: Record<string, unknown>, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
}

function sanitizeHeaders(headers: Record<string, unknown>): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'x-kiki-csrf') continue;
    if (typeof value === 'string') out[lower] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[lower] = value[0];
  }
  return out;
}

function sanitizeQuery(query: Record<string, unknown> | undefined): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  if (query === undefined) return out;
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return out;
}

function validateAndNormalizeSubpath(
  wildcard: string,
  rawUrl: string | undefined,
): { readonly ok: true; readonly subpath: string } | { readonly ok: false; readonly code: ErrorCode; readonly reason: string } {
  const rawPathname = rawUrl === undefined ? '' : (rawUrl.split('?')[0] ?? '');
  if (ENCODED_SLASH_OR_NULL_PATTERN.test(rawPathname) || ENCODED_SLASH_OR_NULL_PATTERN.test(wildcard)) {
    return { ok: false, code: ErrorCode.FS_PATH_ESCAPES_SESSION, reason: 'encoded path separator or null byte is not allowed' };
  }
  if (wildcard.includes('\\') || wildcard.includes('\0')) {
    return { ok: false, code: ErrorCode.FS_PATH_ESCAPES_SESSION, reason: 'invalid path separator in plugin route' };
  }
  const trimmed = wildcard.replace(/^\/+/, '');
  if (trimmed.length === 0) {
    return { ok: false, code: ErrorCode.VALIDATION_FAILED, reason: 'plugin route subpath is empty' };
  }
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, code: ErrorCode.FS_PATH_ESCAPES_SESSION, reason: 'dot segments and empty segments are not allowed in plugin routes' };
    }
  }
  const firstSegment = segments[0]!.toLowerCase();
  if (RESERVED_FIRST_SEGMENTS.has(firstSegment)) {
    return { ok: false, code: ErrorCode.VALIDATION_FAILED, reason: `reserved plugin management segment: ${firstSegment}` };
  }
  const subpath = `/${segments.join('/')}`;
  const checked = pluginHttpRouteDescriptorSchema.shape.subpath.safeParse(subpath);
  if (!checked.success) {
    return { ok: false, code: ErrorCode.VALIDATION_FAILED, reason: 'invalid plugin route subpath' };
  }
  return { ok: true, subpath };
}

function estimateBodyBytes(body: unknown, headers: Record<string, unknown>): number {
  const contentLength = readHeaderValue(headers, 'content-length');
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (Buffer.isBuffer(body)) return body.byteLength;
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

async function resolveSessionWorkspaceId(core: Scope, sessionId: string): Promise<string | undefined> {
  const live = getLiveSessionById(core.accessor, sessionId);
  if (live !== undefined) {
    try {
      const ctx = live.accessor.get(ISessionContext);
      if (ctx?.workspaceId !== undefined) return ctx.workspaceId;
    } catch {
    }
  }
  const indexed = await core.accessor.get(ISessionIndex)?.get(sessionId);
  return indexed?.workspaceId;
}

async function isPluginActiveAndAllowed(
  core: Scope,
  pluginId: string,
  workspaceId: string | undefined,
  sessionId: string | undefined,
): Promise<{ readonly exists: boolean; readonly allowed: boolean }> {
  const pluginService = core.accessor.get(IPluginService);
  if (pluginService !== undefined) {
    const list = await pluginService.listPlugins();
    const record = list.find((entry) => entry.id.toLowerCase() === pluginId.toLowerCase());
    if (record === undefined) {
      return { exists: false, allowed: false };
    }
    if (!record.enabled || record.state !== 'ok') {
      return { exists: true, allowed: false };
    }
  }
  const usage = core.accessor.get(IPluginUsageService);
  if (usage !== undefined) {
    const allowed = await usage.allows(workspaceId, pluginId, sessionId);
    return { exists: true, allowed };
  }
  return { exists: true, allowed: true };
}

function mapPluginRouteStatusToErrorCode(status: PluginHttpRouteResult['status']): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_FAILED;
    case 403:
      return ErrorCode.FS_PERMISSION_DENIED;
    case 404:
      return ErrorCode.PLUGIN_NOT_FOUND;
    case 409:
      return ErrorCode.SESSION_BUSY;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}

async function resolveGuiSlotsWorkspace(
  core: Scope,
  query: PluginGuiSlotsQuery,
): Promise<{ readonly workspaceId?: string; readonly sessionId?: string }> {
  if (query.workspace_id !== undefined) {
    const workspace = await resolvePluginUsageWorkspace(core, { workspace_id: query.workspace_id });
    if (workspace === undefined) {
      throw new Error2(DomainErrorCodes.REQUEST_INVALID, 'Workspace was not found');
    }
    return { workspaceId: workspace.id };
  }
  if (query.session_id !== undefined) {
    const workspaceId = await resolveSessionWorkspaceId(core, query.session_id);
    if (workspaceId === undefined) {
      throw new Error2(DomainErrorCodes.REQUEST_INVALID, 'Session was not found');
    }
    return { workspaceId, sessionId: query.session_id };
  }
  return {};
}

async function filterAllowedGuiSlots(
  core: Scope,
  slots: readonly PluginGuiSlotContribution[],
  workspaceId: string | undefined,
  sessionId: string | undefined,
): Promise<PluginGuiSlotContribution[]> {
  if (slots.length === 0) return [];
  const decisions = new Map<string, boolean>();
  const filtered: PluginGuiSlotContribution[] = [];
  for (const slot of slots) {
    const key = slot.pluginId.toLowerCase();
    let allowed = decisions.get(key);
    if (allowed === undefined) {
      const check = await isPluginActiveAndAllowed(core, slot.pluginId, workspaceId, sessionId);
      allowed = check.allowed;
      decisions.set(key, allowed);
    }
    if (allowed) filtered.push(slot);
  }
  return filtered;
}

/** Registers `GET /api/plugins/gui-slots` and `/api/plugins/:pluginId/routes/*` on the v1 `/api` router. */
export function registerPluginBrokerRoutes(app: PluginBrokerRouteHost, core: Scope): void {
  const guiSlotsRoute = defineRoute(
    {
      method: 'GET',
      path: '/plugins/gui-slots',
      querystring: pluginGuiSlotsQuerySchema,
      success: { data: listPluginGuiSlotsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'List active declarative E12 GUI slot contributions without resuming cold sessions',
      tags: ['plugins'],
      operationId: 'listPluginGuiSlots',
    },
    async (req, reply) => {
      try {
        const port = resolvePluginExtensionBrokerPort(core);
        if (port === undefined) {
          reply.send(okEnvelope({ slots: [] }, req.id));
          return;
        }
        const scope = await resolveGuiSlotsWorkspace(core, req.query);
        const rawSlots = port.listGuiSlots(scope);
        const slots = await filterAllowedGuiSlots(core, rawSlots, scope.workspaceId, scope.sessionId);
        reply.send(okEnvelope({ slots }, req.id));
      } catch (error) {
        if (isError2(error) && error.code === DomainErrorCodes.REQUEST_INVALID) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
          return;
        }
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
            req.id,
          ),
        );
      }
    },
  );
  app.get(guiSlotsRoute.path, guiSlotsRoute.options, guiSlotsRoute.handler as never);

  const methods = ['GET', 'POST', 'PUT', 'DELETE'] as const;
  for (const method of methods) {
    const hasBody = method === 'POST' || method === 'PUT';
    const route = defineRoute(
      {
        method,
        path: '/plugins/{pluginId}/routes/*',
        params: pluginBrokerRouteParamsSchema,
        body: hasBody ? z.unknown().optional() : undefined,
        querystring: z.record(z.string(), z.unknown()).optional(),
        success: { data: z.unknown() },
        errors: {
          [ErrorCode.VALIDATION_FAILED]: {},
          [ErrorCode.SESSION_NOT_FOUND]: {},
          [ErrorCode.FS_PERMISSION_DENIED]: {},
          [ErrorCode.PLUGIN_NOT_FOUND]: {},
          [ErrorCode.SESSION_BUSY]: {},
          [ErrorCode.FS_TOO_LARGE]: {},
          [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
          [ErrorCode.RATE_LIMITED]: {},
          [ErrorCode.INTERNAL_ERROR]: {},
        },
        description: `Invoke an authenticated ${method} route registered by a plugin`,
        tags: ['plugins'],
        operationId: `invokePluginRoute${method[0]}${method.slice(1).toLowerCase()}`,
      },
      async (rawReq, reply) => {
        const req = rawReq as unknown as BrokerFastifyRequest;
        const { pluginId } = req.params;
        if (!PLUGIN_ID_PATTERN.test(pluginId)) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid pluginId', req.id));
          return;
        }
        const normalized = validateAndNormalizeSubpath(req.params['*'], req.raw?.url);
        if (!normalized.ok) {
          reply.send(errEnvelope(normalized.code, normalized.reason, req.id));
          return;
        }

        const port = resolvePluginExtensionBrokerPort(core);
        if (port === undefined) {
          reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, `plugin route not found: ${pluginId}`, req.id));
          return;
        }

        const query = sanitizeQuery(req.query);
        const headers = sanitizeHeaders(req.headers);
        const currentSpaceId = core.accessor.get(IBootstrapService)?.spaceId ?? 'main';
        const requestedSpaceId = query['space_id'] ?? readHeaderValue(req.headers, 'x-kiki-space-id');
        const requestedSessionId = query['session_id'] ?? readHeaderValue(req.headers, 'x-kiki-session-id');
        const requestedWorkspaceId = query['workspace_id'] ?? readHeaderValue(req.headers, 'x-kiki-workspace-id');

        const initialDescriptor = port.resolveHttpRoute?.(pluginId, method, normalized.subpath);
        if (port.resolveHttpRoute !== undefined && initialDescriptor === undefined) {
          reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, `plugin route not found: ${pluginId} ${method} ${normalized.subpath}`, req.id));
          return;
        }

        if (initialDescriptor !== undefined && initialDescriptor.pluginId.toLowerCase() !== pluginId.toLowerCase()) {
          reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'cross-plugin route dispatch is forbidden', req.id));
          return;
        }

        const effectiveDescriptor: Pick<PluginHttpRouteDescriptor, 'scopeAcl' | 'maxBodyBytes'> = initialDescriptor ?? {
          scopeAcl: 'session',
          maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
        };

        const bodyBytes = estimateBodyBytes(req.body, req.headers);
        if (bodyBytes > effectiveDescriptor.maxBodyBytes) {
          reply.send(
            errEnvelope(
              ErrorCode.FS_TOO_LARGE,
              `request body (${bodyBytes} bytes) exceeds route maxBodyBytes (${effectiveDescriptor.maxBodyBytes})`,
              req.id,
            ),
          );
          return;
        }

        if (effectiveDescriptor.scopeAcl === 'space') {
          if (requestedSpaceId !== undefined && requestedSpaceId !== currentSpaceId) {
            reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'cross-space plugin route access is forbidden', req.id));
            return;
          }
        }

        let workspaceId = requestedWorkspaceId;
        if (effectiveDescriptor.scopeAcl === 'session') {
          if (requestedSessionId === undefined || requestedSessionId.trim() === '') {
            reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'session_id is required for session-scoped plugin routes', req.id));
            return;
          }
          const sessionWorkspaceId = await resolveSessionWorkspaceId(core, requestedSessionId);
          if (sessionWorkspaceId === undefined) {
            reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'target session does not exist or is inaccessible', req.id));
            return;
          }
          if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== sessionWorkspaceId) {
            reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'workspace_id does not match target session workspace', req.id));
            return;
          }
          if (requestedSpaceId !== undefined && requestedSpaceId !== currentSpaceId) {
            reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'cross-space plugin route access is forbidden', req.id));
            return;
          }
          workspaceId = sessionWorkspaceId;
        } else if (requestedSessionId !== undefined && requestedSessionId.trim() !== '') {
          const sessionWorkspaceId = await resolveSessionWorkspaceId(core, requestedSessionId);
          if (sessionWorkspaceId === undefined) {
            reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'target session does not exist or is inaccessible', req.id));
            return;
          }
          if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== sessionWorkspaceId) {
            reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, 'workspace_id does not match target session workspace', req.id));
            return;
          }
          workspaceId = sessionWorkspaceId;
        }

        const access = await isPluginActiveAndAllowed(core, pluginId, workspaceId, requestedSessionId);
        if (!access.exists) {
          reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, `plugin ${pluginId} is not installed`, req.id));
          return;
        }
        if (!access.allowed) {
          reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, `plugin ${pluginId} is disabled in this scope`, req.id));
          return;
        }

        const connection = reply as unknown as Parameters<typeof withReplyCloseSignal>[0];
        try {
          const result = await withReplyCloseSignal(
            connection,
            async (signal) => {
              const currentPort = resolvePluginExtensionBrokerPort(core);
              if (currentPort !== port) return undefined;
              if (port.resolveHttpRoute !== undefined) {
                const currentDescriptor = port.resolveHttpRoute(pluginId, method, normalized.subpath);
                if (currentDescriptor === undefined || currentDescriptor !== initialDescriptor) {
                  return undefined;
                }
              }
              const handlerCtx: PluginHttpRouteHandlerContext = {
                pluginId,
                method,
                subpath: normalized.subpath,
                query,
                headers,
                body: req.body,
                spaceId: currentSpaceId,
                sessionId: requestedSessionId,
                workspaceId,
                signal,
              };
              return port.invokeHttpRoute(handlerCtx);
            },
            rawReq,
          );
          if (connection.raw?.destroyed === true) return;
          if (result === undefined) {
            reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, `plugin route not found: ${pluginId} ${method} ${normalized.subpath}`, req.id));
            return;
          }
          const status = result.status ?? 200;
          if (status === 200 || status === 201) {
            reply.send(okEnvelope(result.data ?? null, req.id));
            return;
          }
          reply.send(
            errEnvelope(
              mapPluginRouteStatusToErrorCode(status),
              result.errorMessage ?? `plugin route failed with status ${status}`,
              req.id,
            ),
          );
        } catch (error) {
          if (connection.raw?.destroyed === true) return;
          reply.send(
            errEnvelope(
              ErrorCode.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
              req.id,
            ),
          );
        }
      },
    );

    const optionsWithLimit = { ...route.options, bodyLimit: MAX_ALLOWED_BODY_BYTES };
    if (method === 'GET') app.get(route.path, optionsWithLimit, route.handler as never);
    else if (method === 'POST') app.post(route.path, optionsWithLimit, route.handler as never);
    else if (method === 'PUT') app.put(route.path, optionsWithLimit, route.handler as never);
    else app.delete(route.path, optionsWithLimit, route.handler as never);
  }
}
