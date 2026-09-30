import { IAntigravityService, type Scope } from '@kiki/agent-core-v2';
import {
  antigravityActivateRequestSchema, antigravityInstallRequestSchema, antigravityLoginCancelRequestSchema,
  antigravityLoginCompleteRequestSchema, antigravityLoginOutcomeSchema, antigravityLoginRequestSchema,
  antigravityLoginStartSchema, antigravityStatusSchema,
} from '@kiki/protocol';
import { z } from 'zod';

import { defineRoute } from '../middleware/defineRoute';
import { okEnvelope } from '../envelope';
import type { AgentProfilesRouteHost } from './agentProfiles';

export function registerAntigravityRoutes(app: AgentProfilesRouteHost, core: Scope): void {
  const service = () => core.accessor.get(IAntigravityService);
  const root = '/executors/antigravity-acp';
  const project = (value: Awaited<ReturnType<IAntigravityService['status']>>) => ({
    release: { version: value.release.version, platform: value.release.platform, url: value.release.url,
      entry: value.release.entry, required_sibling: value.release.requiredSibling, args: value.release.args },
    versions: value.versions, active_version: value.activeVersion, phase: value.phase, error: value.error,
  });
  const status = defineRoute({ method: 'GET', path: `${root}/binaries`, success: { data: antigravityStatusSchema }, tags: ['agents'] },
    async (req, reply) => { reply.send(okEnvelope(project(await service().status()), req.id)); });
  app.get(status.path, status.options, status.handler as Parameters<AgentProfilesRouteHost['get']>[2]);
  const install = defineRoute({ method: 'POST', path: `${root}/binaries/install`, body: antigravityInstallRequestSchema,
    success: { data: antigravityStatusSchema }, tags: ['agents'] }, async (req, reply) => {
    reply.send(okEnvelope(project(await service().install(req.body.version)), req.id));
  });
  app.post(install.path, install.options, install.handler as Parameters<AgentProfilesRouteHost['post']>[2]);
  const activate = defineRoute({ method: 'POST', path: `${root}/binaries/activate`, body: antigravityActivateRequestSchema,
    success: { data: antigravityStatusSchema }, tags: ['agents'] }, async (req, reply) => {
    reply.send(okEnvelope(project(await service().activate(req.body.version)), req.id));
  });
  app.post(activate.path, activate.options, activate.handler as Parameters<AgentProfilesRouteHost['post']>[2]);
  const start = defineRoute({ method: 'POST', path: `${root}/login/start`, body: antigravityLoginRequestSchema,
    success: { data: antigravityLoginStartSchema }, tags: ['agents'] }, async (req, reply) => {
    const value = await service().beginLogin(req.body.method_id);
    reply.send(okEnvelope(value.alreadySignedIn ? { already_signed_in: true as const } : {
      already_signed_in: false as const, handle: value.handle, auth_url: value.authUrl, redirect_uri: value.redirectUri,
      method_id: value.methodId, expires_in_secs: value.expiresInSecs,
    }, req.id));
  });
  app.post(start.path, start.options, start.handler as Parameters<AgentProfilesRouteHost['post']>[2]);
  const complete = defineRoute({ method: 'POST', path: `${root}/login/complete`, body: antigravityLoginCompleteRequestSchema,
    success: { data: antigravityLoginOutcomeSchema }, tags: ['agents'] }, async (req, reply) => {
    const value = await service().completeLogin(req.body.handle, req.body.redirect_url);
    reply.send(okEnvelope({ signed_in: value.signedIn, retryable: value.retryable, message: value.message, message_code: value.messageCode }, req.id));
  });
  app.post(complete.path, complete.options, complete.handler as Parameters<AgentProfilesRouteHost['post']>[2]);
  const cancel = defineRoute({ method: 'POST', path: `${root}/login/cancel`, body: antigravityLoginCancelRequestSchema,
    success: { data: z.object({ cancelled: z.literal(true) }) }, tags: ['agents'] }, async (req, reply) => {
    await service().cancelLogin(req.body.handle);
    reply.send(okEnvelope({ cancelled: true as const }, req.id));
  });
  app.post(cancel.path, cancel.options, cancel.handler as Parameters<AgentProfilesRouteHost['post']>[2]);
  const logout = defineRoute({ method: 'POST', path: `${root}/logout`, body: z.object({}).strict(),
    success: { data: z.object({ signed_out: z.literal(true) }) }, tags: ['agents'] }, async (req, reply) => {
    await service().logout();
    reply.send(okEnvelope({ signed_out: true as const }, req.id));
  });
  app.post(logout.path, logout.options, logout.handler as Parameters<AgentProfilesRouteHost['post']>[2]);
}
