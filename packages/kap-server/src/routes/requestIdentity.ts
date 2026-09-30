import { isError2, type Scope } from '@kiki/agent-core-v2';
import { IConfigService } from '@kiki/agent-core-v2/app/config/config';
import { RequestIdentityErrors } from '@kiki/agent-core-v2/kosong/requestIdentity/errors';
import { IRequestIdentityCatalog } from '@kiki/agent-core-v2/app/requestIdentity/requestIdentityCatalog';
import {
  ErrorCode,
  requestIdentityCatalogSchema,
  requestIdentityCreateProfileSchema,
  requestIdentityManifestRequestSchema,
  requestIdentityPreviewRequestSchema,
  requestIdentityPreviewSchema,
  requestIdentityProfileDraftSchema,
  requestIdentityProfileIdSchema,
  requestIdentityTrackApplyRequestSchema,
  requestIdentityTrackCheckRequestSchema,
  requestIdentityTrackIdSchema,
  requestIdentityTrackPinRequestSchema,
  type RequestIdentityCatalog,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

type Handler = (
  req: { id: string; params: unknown; body: unknown },
  reply: { send(payload: unknown): unknown },
) => Promise<void> | void;

interface RequestIdentityRouteHost {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
  put(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
  delete(path: string, options: { schema?: Record<string, unknown> }, handler: Handler): unknown;
}

const ERRORS = {
  [ErrorCode.VALIDATION_FAILED]: {},
  [ErrorCode.REQUEST_IDENTITY_NOT_FOUND]: {},
  [ErrorCode.REQUEST_IDENTITY_CONFLICT]: {},
};

const profileParams = z.object({ id: requestIdentityProfileIdSchema });
const trackParams = z.object({ track: requestIdentityTrackIdSchema });

/**
 * `/request-identity/*`: identity profiles, upstream client release tracks, where each is used,
 * and what recent requests sent. Every mutation answers with the full catalog so a client can
 * replace its copy in one step.
 */
export function registerRequestIdentityRoutes(app: RequestIdentityRouteHost, core: Scope): void {
  const catalog = () => core.accessor.get(IRequestIdentityCatalog);

  const snapshot = async (): Promise<RequestIdentityCatalog> => {
    await core.accessor.get(IConfigService).ready;
    const service = catalog();
    const [profiles, tracks, manifestUrl, usage] = await Promise.all([
      service.listProfiles(), service.listTracks(), service.manifestUrl(), service.usage(),
    ]);
    return { profiles, tracks, manifest_url: manifestUrl, usage, observations: service.observations() };
  };

  const run = async (reqId: string, reply: { send(payload: unknown): unknown }, action: () => Promise<unknown>) => {
    try {
      await action();
      reply.send(okEnvelope(await snapshot(), reqId));
    } catch (error) {
      reply.send(errorEnvelope(error, reqId));
    }
  };

  const read = defineRoute({
    method: 'GET', path: '/request-identity',
    success: { data: requestIdentityCatalogSchema }, tags: ['request-identity'],
    description: 'List identity profiles, release tracks, where each identity is used, and the latest requests\u2019 identity values.',
  }, async (req, reply) => {
    reply.send(okEnvelope(await snapshot(), req.id));
  });
  app.get(read.path, read.options, read.handler as Handler);

  const preview = defineRoute({
    method: 'POST', path: '/request-identity/preview', body: requestIdentityPreviewRequestSchema,
    success: { data: requestIdentityPreviewSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Render the headers and body fields a stored profile or an unsaved draft would send for one protocol.',
  }, async (req, reply) => {
    try {
      reply.send(okEnvelope(await catalog().preview(req.body), req.id));
    } catch (error) {
      reply.send(errorEnvelope(error, req.id));
    }
  });
  app.post(preview.path, preview.options, preview.handler as Handler);

  const create = defineRoute({
    method: 'POST', path: '/request-identity/profiles', body: requestIdentityCreateProfileSchema,
    success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Create a custom identity by duplicating an existing one.',
  }, async (req, reply) => {
    await run(req.id, reply, () => catalog().duplicateProfile(req.body.from, req.body.label));
  });
  app.post(create.path, create.options, create.handler as Handler);

  const update = defineRoute({
    method: 'PUT', path: '/request-identity/profiles/{id}', params: profileParams, body: requestIdentityProfileDraftSchema,
    success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Replace a custom identity\u2019s editable fields. Built-in identities are read-only.',
  }, async (req, reply) => {
    await run(req.id, reply, () => catalog().updateProfile(req.params.id, req.body));
  });
  app.put(update.path, update.options, update.handler as Handler);

  const remove = defineRoute({
    method: 'DELETE', path: '/request-identity/profiles/{id}', params: profileParams,
    success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Delete a custom identity that no global, provider or model layer uses.',
  }, async (req, reply) => {
    await run(req.id, reply, () => catalog().deleteProfile(req.params.id));
  });
  app.delete(remove.path, remove.options, remove.handler as Handler);

  const check = defineRoute({
    method: 'POST', path: '/request-identity/tracks/{track}/check', params: trackParams, body: requestIdentityTrackCheckRequestSchema,
    success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Read the npm registry, the installed CLI, or the manifest and stage a newer value as a candidate. Requests keep the current value.',
  }, async (req, reply) => {
    await run(req.id, reply, () => catalog().checkTrack(req.params.track, req.body.source));
  });
  app.post(check.path, check.options, check.handler as Handler);

  const apply = defineRoute({
    method: 'POST', path: '/request-identity/tracks/{track}/apply', params: trackParams, body: requestIdentityTrackApplyRequestSchema,
    success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Make the staged candidate current; the replaced value moves to history.',
  }, async (req, reply) => {
    await run(req.id, reply, () => catalog().applyCandidate(req.params.track, req.body.version));
  });
  app.post(apply.path, apply.options, apply.handler as Handler);

  const simple = [
    ['dismiss', 'Discard the staged candidate.', (track: z.infer<typeof requestIdentityTrackIdSchema>) => catalog().dismissCandidate(track)],
    ['rollback', 'Restore the most recent value from history.', (track: z.infer<typeof requestIdentityTrackIdSchema>) => catalog().rollbackTrack(track)],
    ['reset', 'Return to the value shipped with this build.', (track: z.infer<typeof requestIdentityTrackIdSchema>) => catalog().resetTrack(track)],
  ] as const;
  for (const [verb, description, act] of simple) {
    const route = defineRoute({
      method: 'POST', path: `/request-identity/tracks/{track}/${verb}`, params: trackParams,
      success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'], description,
    }, async (req, reply) => {
      await run(req.id, reply, () => act(req.params.track));
    });
    app.post(route.path, route.options, route.handler as Handler);
  }

  const pin = defineRoute({
    method: 'PUT', path: '/request-identity/tracks/{track}/pin', params: trackParams, body: requestIdentityTrackPinRequestSchema,
    success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Pin or unpin a track. A pinned track refuses apply, rollback and reset.',
  }, async (req, reply) => {
    await run(req.id, reply, () => catalog().pinTrack(req.params.track, req.body.pinned));
  });
  app.put(pin.path, pin.options, pin.handler as Handler);

  const manifest = defineRoute({
    method: 'PUT', path: '/request-identity/manifest', body: requestIdentityManifestRequestSchema,
    success: { data: requestIdentityCatalogSchema }, errors: ERRORS, tags: ['request-identity'],
    description: 'Set or clear the https manifest URL the manifest source reads.',
  }, async (req, reply) => {
    await run(req.id, reply, () => catalog().setManifestUrl(req.body.url));
  });
  app.put(manifest.path, manifest.options, manifest.handler as Handler);
}

function errorEnvelope(error: unknown, requestId: string) {
  if (isError2(error)) {
    if (error.code === RequestIdentityErrors.codes.REQUEST_IDENTITY_NOT_FOUND) {
      return errEnvelope(ErrorCode.REQUEST_IDENTITY_NOT_FOUND, error.message, requestId);
    }
    if (error.code === RequestIdentityErrors.codes.REQUEST_IDENTITY_CONFLICT) {
      return errEnvelope(ErrorCode.REQUEST_IDENTITY_CONFLICT, error.message, requestId);
    }
    if (error.code === RequestIdentityErrors.codes.REQUEST_IDENTITY_INVALID) {
      return errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, requestId);
    }
  }
  if (error instanceof z.ZodError) {
    return errEnvelope(ErrorCode.VALIDATION_FAILED, error.issues[0]?.message ?? 'Invalid request identity', requestId);
  }
  throw error;
}
