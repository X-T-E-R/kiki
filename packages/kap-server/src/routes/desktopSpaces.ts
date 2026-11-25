import {
  desktopPluginFocusAckResponseSchema,
  desktopPluginFocusAckSchema,
  desktopPluginFocusQuerySchema,
  desktopPluginFocusRememberResponseSchema,
  desktopPluginFocusRememberSchema,
  desktopPluginFocusResponseSchema,
  desktopSpacesResponseSchema,
} from '@kiki/protocol';
import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { LocalSpacesService } from '../services/localSpaces/localSpacesService';
import type { PluginFocusService } from '../services/pluginFocus/pluginFocusService';

export interface DesktopSpacesRouteContext {
  readonly spaces: LocalSpacesService;
  readonly pluginFocus: PluginFocusService;
}

interface DesktopSpacesRouteHost {
  get(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
  post(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
}

export function registerDesktopSpacesRoutes(app: DesktopSpacesRouteHost, context: DesktopSpacesRouteContext): void {
  const spaces = defineRoute({
    method: 'GET', path: '/desktop/spaces',
    success: { data: desktopSpacesResponseSchema }, tags: ['desktop'],
    description: 'List local spaces and live statuses from the server instance registry and heartbeat records',
  }, async (req, reply) => {
    reply.send(okEnvelope(await context.spaces.snapshot(), req.id));
  });
  app.get(spaces.path, spaces.options, spaces.handler as never);

  const readFocus = defineRoute({
    method: 'GET', path: '/desktop/plugin-focus', querystring: desktopPluginFocusQuerySchema,
    success: { data: desktopPluginFocusResponseSchema }, tags: ['desktop'],
    description: 'Read the pending cross-home plugin focus intent, excluding the home that owns it',
  }, async (req, reply) => {
    reply.send(okEnvelope({ focus: context.pluginFocus.read(req.query.home_id) }, req.id));
  });
  app.get(readFocus.path, readFocus.options, readFocus.handler as never);

  const ack = defineRoute({
    method: 'POST', path: '/desktop/plugin-focus/ack', body: desktopPluginFocusAckSchema,
    success: { data: desktopPluginFocusAckResponseSchema }, tags: ['desktop'],
    description: 'Clear the pending plugin focus intent only when both home and request id match',
  }, async (req, reply) => {
    reply.send(okEnvelope({ cleared: context.pluginFocus.acknowledge(req.body.home_id, req.body.request_id) }, req.id));
  });
  app.post(ack.path, ack.options, ack.handler as never);

  const remember = defineRoute({
    method: 'POST', path: '/desktop/plugin-focus/remember', body: desktopPluginFocusRememberSchema,
    success: { data: desktopPluginFocusRememberResponseSchema }, tags: ['desktop'],
    description: 'Remember a consumed plugin focus request id per home so repeats are suppressed',
  }, async (req, reply) => {
    context.pluginFocus.remember(req.body.home_id, req.body.request_id);
    reply.send(okEnvelope({ remembered: true as const }, req.id));
  });
  app.post(remember.path, remember.options, remember.handler as never);
}
