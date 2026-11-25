import { isDeepStrictEqual } from 'node:util';
import {
  ErrorCode,
  desktopSshCommitResponseSchema,
  desktopSshCommitSchema,
  desktopSshConnectResponseSchema,
  desktopSshConnectSchema,
  desktopSshDisconnectResponseSchema,
  desktopSshProfileParamsSchema,
  desktopSshProfilePutSchema,
  desktopSshProfilesResponseSchema,
  desktopSshResumeResponseSchema,
  desktopSshResumeSchema,
  desktopSshTunnelParamsSchema,
  desktopSshTunnelRunningResponseSchema,
} from '@kiki/protocol';
import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { DesktopSshProfileError, type DesktopSshProfileStore } from '../services/desktopSsh/profileStore';
import { DesktopSshTunnelError, type DesktopSshTunnelManager } from '../services/desktopSsh/tunnelManager';

export interface DesktopSshRouteContext {
  readonly profiles: DesktopSshProfileStore;
  readonly tunnels: DesktopSshTunnelManager;
  readonly homeId: string;
}

interface DesktopSshRouteHost {
  get(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
  put(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
  post(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
  delete(path: string, options: object, handler: (...args: never[]) => unknown): unknown;
}

function profileError(error: unknown): { message: string; validation: boolean } {
  if (error instanceof DesktopSshProfileError) {
    return { message: error.message, validation: error.reason === 'invalid' || error.reason === 'too_many' };
  }
  return { message: 'SSH profile store is unavailable', validation: false };
}

function tunnelError(error: unknown): string {
  if (error instanceof DesktopSshTunnelError) return error.message;
  if (error instanceof Error) return error.message;
  return 'SSH tunnel operation failed';
}

export function registerDesktopSshRoutes(app: DesktopSshRouteHost, context: DesktopSshRouteContext): void {
  const list = defineRoute({
    method: 'GET', path: '/desktop/ssh/profiles',
    success: { data: desktopSshProfilesResponseSchema }, tags: ['desktop'],
    description: 'List desktop SSH connection profiles; profiles never contain bearer tokens',
  }, async (req, reply) => {
    try {
      reply.send(okEnvelope({ profiles: await context.profiles.list() }, req.id));
    } catch (error) {
      const failure = profileError(error);
      reply.send(errEnvelope(failure.validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.CAPABILITY_UNSUPPORTED, failure.message, req.id));
    }
  });
  app.get(list.path, list.options, list.handler as never);

  const put = defineRoute({
    method: 'PUT', path: '/desktop/ssh/profiles', body: desktopSshProfilePutSchema,
    success: { data: desktopSshProfilesResponseSchema }, tags: ['desktop'],
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.CAPABILITY_UNSUPPORTED]: {} },
    description: 'Validate and upsert one desktop SSH profile with an atomic write',
  }, async (req, reply) => {
    try {
      reply.send(okEnvelope({ profiles: await context.profiles.save(req.body.profile) }, req.id));
    } catch (error) {
      const failure = profileError(error);
      reply.send(errEnvelope(failure.validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.CAPABILITY_UNSUPPORTED, failure.message, req.id));
    }
  });
  app.put(put.path, put.options, put.handler as never);

  const remove = defineRoute({
    method: 'DELETE', path: '/desktop/ssh/profiles/{id}', params: desktopSshProfileParamsSchema,
    success: { data: desktopSshProfilesResponseSchema }, tags: ['desktop'],
    errors: { [ErrorCode.CAPABILITY_UNSUPPORTED]: {} },
    description: 'Remove one desktop SSH profile with an atomic write',
  }, async (req, reply) => {
    try {
      reply.send(okEnvelope({ profiles: await context.profiles.remove(req.params.id) }, req.id));
    } catch (error) {
      const failure = profileError(error);
      reply.send(errEnvelope(failure.validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.CAPABILITY_UNSUPPORTED, failure.message, req.id));
    }
  });
  app.delete(remove.path, remove.options, remove.handler as never);

  const connect = defineRoute({
    method: 'POST', path: '/desktop/ssh/connect', body: desktopSshConnectSchema,
    success: { data: desktopSshConnectResponseSchema }, tags: ['desktop'],
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.CAPABILITY_UNSUPPORTED]: {} },
    description: 'Open a verified SSH tunnel lease for one profile; staged leases wait for an explicit commit',
  }, async (req, reply) => {
    let profile;
    try {
      profile = (await context.profiles.list()).find((entry) => entry.id === req.body.id);
    } catch (error) {
      const failure = profileError(error);
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, failure.message, req.id));
      return;
    }
    if (profile === undefined) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Unknown SSH profile', req.id));
      return;
    }
    try {
      const connection = await context.tunnels.connect(profile, req.body.token, req.body.home_id ?? context.homeId, req.body.staged);
      reply.send(okEnvelope({ connection }, req.id));
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, tunnelError(error), req.id));
    }
  });
  app.post(connect.path, connect.options, connect.handler as never);

  const resume = defineRoute({
    method: 'POST', path: '/desktop/ssh/resume', body: desktopSshResumeSchema,
    success: { data: desktopSshResumeResponseSchema }, tags: ['desktop'],
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.CAPABILITY_UNSUPPORTED]: {} },
    description: 'Revalidate an existing SSH tunnel lease for the same home and return its exact connection',
  }, async (req, reply) => {
    try {
      const resumed = context.tunnels.resume(req.body.id, req.body.tunnel_id, req.body.home_id);
      const stored = (await context.profiles.list()).find((entry) => entry.id === req.body.id);
      if (stored === undefined || !isDeepStrictEqual(stored, resumed.profile)) {
        reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'SSH profile changed since the tunnel was verified; reconnect', req.id));
        return;
      }
      reply.send(okEnvelope(resumed, req.id));
    } catch (error) {
      if (error instanceof DesktopSshProfileError) {
        reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, error.message, req.id));
        return;
      }
      const validation = error instanceof DesktopSshTunnelError && error.reason === 'lease_expired';
      reply.send(errEnvelope(validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.CAPABILITY_UNSUPPORTED, tunnelError(error), req.id));
    }
  });
  app.post(resume.path, resume.options, resume.handler as never);

  const commit = defineRoute({
    method: 'POST', path: '/desktop/ssh/commit', body: desktopSshCommitSchema,
    success: { data: desktopSshCommitResponseSchema }, tags: ['desktop'],
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.CAPABILITY_UNSUPPORTED]: {} },
    description: 'Accept a staged SSH tunnel lease as the active connection for its profile',
  }, async (req, reply) => {
    try {
      const reference = context.tunnels.resume(req.body.id, req.body.tunnel_id, req.body.home_id);
      const stored = (await context.profiles.list()).find((entry) => entry.id === req.body.id);
      if (stored === undefined || !isDeepStrictEqual(stored, reference.profile)) {
        reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, 'SSH profile changed since the tunnel was verified; reconnect', req.id));
        return;
      }
      context.tunnels.commit(req.body.id, req.body.tunnel_id, req.body.home_id);
      reply.send(okEnvelope({ committed: true as const }, req.id));
    } catch (error) {
      if (error instanceof DesktopSshProfileError) {
        reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, error.message, req.id));
        return;
      }
      const validation = error instanceof DesktopSshTunnelError && error.reason === 'lease_expired';
      reply.send(errEnvelope(validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.CAPABILITY_UNSUPPORTED, tunnelError(error), req.id));
    }
  });
  app.post(commit.path, commit.options, commit.handler as never);

  const running = defineRoute({
    method: 'GET', path: '/desktop/ssh/tunnels/{id}/{tunnelId}', params: desktopSshTunnelParamsSchema,
    success: { data: desktopSshTunnelRunningResponseSchema }, tags: ['desktop'],
    description: 'Report whether one exact SSH tunnel lease is still running',
  }, async (req, reply) => {
    reply.send(okEnvelope({ running: context.tunnels.isRunning(req.params.id, req.params.tunnelId) }, req.id));
  });
  app.get(running.path, running.options, running.handler as never);

  const disconnect = defineRoute({
    method: 'DELETE', path: '/desktop/ssh/tunnels/{id}/{tunnelId}', params: desktopSshTunnelParamsSchema,
    success: { data: desktopSshDisconnectResponseSchema }, tags: ['desktop'],
    description: 'Close one exact SSH tunnel lease and reap its child process deterministically',
  }, async (req, reply) => {
    context.tunnels.disconnect(req.params.id, req.params.tunnelId);
    reply.send(okEnvelope({ disconnected: true as const }, req.id));
  });
  app.delete(disconnect.path, disconnect.options, disconnect.handler as never);
}

