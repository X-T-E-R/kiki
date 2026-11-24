import { IAntigravityService, type Scope } from '@kiki/agent-core-v2';
import type { AntigravityProfileStatus } from '@kiki/agent-core-v2/app/agentExecutor/antigravityService';
import {
  antigravityActivateRequestSchema,
  antigravityInstallRequestSchema,
  antigravityLoginCancelRequestSchema,
  antigravityLoginCompleteRequestSchema,
  antigravityLoginOutcomeSchema,
  antigravityLoginRequestSchema,
  antigravityLoginStartSchema,
  antigravityLogoutRequestSchema,
  antigravityStatusQuerySchema,
  antigravityStatusSchema,
} from '@kiki/protocol';
import { z } from 'zod';

import { defineRoute } from '../middleware/defineRoute';
import { okEnvelope } from '../envelope';
import type { AgentProfilesRouteHost } from './agentProfiles';

function projectProfile(profile: AntigravityProfileStatus | undefined) {
  if (profile === undefined) return undefined;
  return {
    instance_id: profile.instanceId,
    signed_in: profile.signedIn,
    auth_method: profile.authMethod,
    account_label: profile.accountLabel,
    gcp_project: profile.gcpProject,
    gcp_location: profile.gcpLocation,
    eligibility: profile.eligibility,
    eligibility_message: profile.eligibilityMessage,
    token_expired: profile.tokenExpired,
    auto_mode_supported: profile.autoModeSupported,
    models: profile.models?.map((model) => ({
      id: model.id,
      label: model.label,
      thinking_levels: model.thinkingLevels === undefined ? undefined : [...model.thinkingLevels],
    })),
    commands: profile.commands === undefined ? undefined : [...profile.commands],
    checked_at: profile.checkedAt,
  };
}

export function registerAntigravityRoutes(app: AgentProfilesRouteHost, core: Scope): void {
  const service = () => core.accessor.get(IAntigravityService);
  const root = '/executors/antigravity-acp';
  const project = (value: Awaited<ReturnType<IAntigravityService['status']>>) => ({
    release: {
      version: value.release.version,
      platform: value.release.platform,
      url: value.release.url,
      entry: value.release.entry,
      required_sibling: value.release.requiredSibling ?? '',
      layout: value.release.layout,
      sha512: value.release.sha512,
      args: [...value.release.args],
    },
    latest_release: value.latestRelease === undefined
      ? undefined
      : {
        version: value.latestRelease.version,
        update_available: value.latestRelease.updateAvailable,
      },
    versions: [...value.versions],
    active_version: value.activeVersion,
    phase: value.phase,
    error: value.error,
    profile: projectProfile(value.profile),
  });

  const status = defineRoute({
    method: 'GET',
    path: `${root}/binaries`,
    querystring: antigravityStatusQuerySchema,
    success: { data: antigravityStatusSchema },
    tags: ['agents'],
  }, async (req, reply) => {
    reply.send(okEnvelope(project(await service().status({
      instanceId: req.query.instance_id,
      checkUpdates: req.query.check_updates,
      refreshModels: req.query.refresh_models,
    })), req.id));
  });
  app.get(status.path, status.options, status.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const install = defineRoute({
    method: 'POST',
    path: `${root}/binaries/install`,
    body: antigravityInstallRequestSchema,
    success: { data: antigravityStatusSchema },
    tags: ['agents'],
  }, async (req, reply) => {
    reply.send(okEnvelope(project(await service().install(req.body.version, {
      instanceId: req.body.instance_id,
    })), req.id));
  });
  app.post(install.path, install.options, install.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const activate = defineRoute({
    method: 'POST',
    path: `${root}/binaries/activate`,
    body: antigravityActivateRequestSchema,
    success: { data: antigravityStatusSchema },
    tags: ['agents'],
  }, async (req, reply) => {
    reply.send(okEnvelope(project(await service().activate(req.body.version, {
      instanceId: req.body.instance_id,
    })), req.id));
  });
  app.post(activate.path, activate.options, activate.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const start = defineRoute({
    method: 'POST',
    path: `${root}/login/start`,
    body: antigravityLoginRequestSchema,
    success: { data: antigravityLoginStartSchema },
    tags: ['agents'],
  }, async (req, reply) => {
    const value = await service().beginLogin({
      methodId: req.body.method_id,
      instanceId: req.body.instance_id,
      gcpProject: req.body.gcp_project,
      gcpLocation: req.body.gcp_location,
      apiKey: req.body.api_key,
      force: req.body.force,
    });
    reply.send(okEnvelope(value.alreadySignedIn
      ? {
        already_signed_in: true as const,
        instance_id: value.instanceId,
        profile: projectProfile(value.profile),
      }
      : {
        already_signed_in: false as const,
        handle: value.handle,
        auth_url: value.authUrl,
        redirect_uri: value.redirectUri,
        flow_kind: value.flowKind,
        method_id: value.methodId,
        instance_id: value.instanceId,
        expires_in_secs: value.expiresInSecs,
      }, req.id));
  });
  app.post(start.path, start.options, start.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const complete = defineRoute({
    method: 'POST',
    path: `${root}/login/complete`,
    body: antigravityLoginCompleteRequestSchema,
    success: { data: antigravityLoginOutcomeSchema },
    tags: ['agents'],
  }, async (req, reply) => {
    const value = await service().completeLogin(
      req.body.handle,
      req.body.code_or_url ?? req.body.redirect_url!,
      req.body.instance_id,
    );
    reply.send(okEnvelope({
      signed_in: value.signedIn,
      retryable: value.retryable,
      message: value.message,
      message_code: value.messageCode,
      profile: projectProfile(value.profile),
    }, req.id));
  });
  app.post(complete.path, complete.options, complete.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const cancel = defineRoute({
    method: 'POST',
    path: `${root}/login/cancel`,
    body: antigravityLoginCancelRequestSchema,
    success: { data: z.object({ cancelled: z.literal(true) }) },
    tags: ['agents'],
  }, async (req, reply) => {
    await service().cancelLogin(req.body.handle, req.body.instance_id);
    reply.send(okEnvelope({ cancelled: true as const }, req.id));
  });
  app.post(cancel.path, cancel.options, cancel.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const logout = defineRoute({
    method: 'POST',
    path: `${root}/logout`,
    body: antigravityLogoutRequestSchema,
    success: { data: z.object({ signed_out: z.literal(true) }) },
    tags: ['agents'],
  }, async (req, reply) => {
    await service().logout(req.body.instance_id);
    reply.send(okEnvelope({ signed_out: true as const }, req.id));
  });
  app.post(logout.path, logout.options, logout.handler as Parameters<AgentProfilesRouteHost['post']>[2]);
}
