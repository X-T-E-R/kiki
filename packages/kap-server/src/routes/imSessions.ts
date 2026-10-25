import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { imBindingPatchSchema, imBindingTestResultSchema, imConfirmRequestSchema, imPolicySchema, imSetupRequestSchema, imSetupResultSchema, imTargetChannelsSchema } from '@kiki/protocol';

import { okEnvelope, errEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { ImIdentityAlreadyBoundError, type ImSessionBridge } from '../services/imSession/bridge';
import { ImSessionSetup, imSetupCatalog } from '../services/imSession/setup';

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/u);

function routeId(req: FastifyRequest): string {
  const params = req.params as { id?: unknown };
  return identifier.parse(params.id);
}

export function registerImSessionRoutes(app: FastifyInstance, bridge: ImSessionBridge): void {
  const setup = new ImSessionSetup(async (provider, fields, instanceId) => {
    if (instanceId !== undefined && (await bridge.snapshot()).instances.find((instance) => instance.id === instanceId)?.provider_kind !== provider) throw new Error('setup_instance_provider_mismatch');
    return bridge.paste({ instanceId, text: [`platform=${provider}`, ...Object.entries(fields).map(([key, value]) => `${key}=${value}`)].join('\n') });
  });
  app.addHook('onClose', async () => { setup.clear(); });
  const respond = async (req: FastifyRequest, reply: FastifyReply, operation: () => Promise<unknown>): Promise<void> => {
    try { reply.send(okEnvelope(await operation(), req.id)); }
    catch (error) {
      if (error instanceof z.ZodError) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), req.id));
        return;
      }
      if (error instanceof ImIdentityAlreadyBoundError) {
        reply.send({ ...errEnvelope(ErrorCode.IM_IDENTITY_ALREADY_BOUND, error.message, req.id), details: error.details });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const validation = /^(?:paste_unrecognized|unknown_|unsupported_|home_session_missing|instance_required|setup_|matrix_|discord_|slack_|oauth_)/u.test(message);
      reply.send(errEnvelope(validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL_ERROR, message, req.id));
    }
  };
  app.get('/im/sessions', (req, reply) => respond(req, reply, () => bridge.snapshot()));
  app.get('/im/sessions/catalog', (req, reply) => respond(req, reply, () => bridge.catalog()));
  app.get('/im/sessions/setup', (req, reply) => respond(req, reply, async () => imSetupCatalog()));
  app.post('/im/sessions/setup', (req, reply) => respond(req, reply, async () => {
    const input = imSetupRequestSchema.parse(req.body);
    try { return imSetupResultSchema.parse(await setup.run(input)); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new Error(/^(?:setup_|matrix_|discord_|slack_|oauth_)[a-z0-9_]+$/u.test(message) ? message : 'setup_failed', { cause: error });
    }
  }));
  app.put('/im/sessions/policy', (req, reply) => respond(req, reply, () => bridge.setPolicy(imPolicySchema.parse(req.body))));
  app.post('/im/sessions/paste', (req, reply) => respond(req, reply, () => {
    const body = z.object({ text: z.string().min(1).max(8192), instance_id: identifier.optional() }).strict().parse(req.body);
    return bridge.paste({ text: body.text, ...(body.instance_id === undefined ? {} : { instanceId: body.instance_id }) });
  }));
  app.post('/im/sessions/instances/:id/check', (req, reply) => respond(req, reply, () => bridge.check(routeId(req))));
  app.post('/im/sessions/instances/:id/listen', (req, reply) => respond(req, reply, () => {
    const body = z.object({ listening: z.boolean() }).strict().parse(req.body);
    return bridge.setListening(routeId(req), body.listening);
  }));
  app.post('/im/sessions/discoveries/:id/confirm', (req, reply) => respond(req, reply, () => bridge.confirm(routeId(req), imConfirmRequestSchema.parse(req.body))));
  app.post('/im/sessions/discoveries/:id/dismiss', (req, reply) => respond(req, reply, () => bridge.dismiss(routeId(req))));
  app.post('/im/sessions/bindings/:id/test', (req, reply) => respond(req, reply, async () => {
    z.object({}).strict().parse(req.body ?? {});
    return imBindingTestResultSchema.parse(await bridge.testBinding(routeId(req)));
  }));
  app.patch('/im/sessions/bindings/:id', (req, reply) => respond(req, reply, () => {
    const patch = imBindingPatchSchema.parse(req.body);
    return bridge.updateBinding(routeId(req), {
      enabled: patch.enabled,
      sessionEnabled: patch.session_enabled,
      inputEnabled: patch.input_enabled,
      outputEnabled: patch.output_enabled,
      rebind: patch.rebind,
      busy: patch.busy,
      reply: patch.reply,
      mobileInteractions: patch.mobile_interactions,
      sessionId: patch.session_id,
      target: patch.target,
    });
  }));
  app.delete('/im/sessions/bindings/:id', (req, reply) => respond(req, reply, () => bridge.removeBinding(routeId(req))));
  const targetChannels = async (sessionId: string) => imTargetChannelsSchema.parse({
    internal_enabled: true,
    channels: (await bridge.channelViews(sessionId)).map((channel) => ({
      id: channel.id, kind: channel.kind, bound: channel.bound, enabled: channel.enabled,
      capabilities: channel.capabilities.map((capability) => ({
        kind: capability.kind, mime_types: capability.mimeTypes === undefined ? undefined : [...capability.mimeTypes],
        max_bytes: capability.maxBytes, rendering: capability.rendering,
      })),
    })),
  });
  app.get('/im/sessions/targets/:id/channels', (req, reply) => respond(req, reply, () => targetChannels(routeId(req))));
  app.put('/im/sessions/targets/:id/notify/:channelId', (req, reply) => respond(req, reply, async () => {
    const channelId = identifier.parse((req.params as { channelId: unknown }).channelId);
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await bridge.setNotificationChannel(routeId(req), channelId, body.enabled);
    return targetChannels(routeId(req));
  }));
  app.delete('/im/sessions/targets/:id/notify/:channelId', (req, reply) => respond(req, reply, async () => {
    const channelId = identifier.parse((req.params as { channelId: unknown }).channelId);
    await bridge.removeNotificationChannel(routeId(req), channelId);
    return targetChannels(routeId(req));
  }));
  app.put('/im/sessions/targets/:id/internal', (req, reply) => respond(req, reply, async () => {
    const sessionId = routeId(req);
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return { enabled: await bridge.setInternalChannel(sessionId, body.enabled) };
  }));
  app.post('/im/sessions/wechat/qrcode', (req, reply) => respond(req, reply, () => {
    z.object({}).strict().parse(req.body ?? {});
    return bridge.startWechatQr();
  }));
  app.post('/im/sessions/wechat/qrcode/:id/poll', (req, reply) => respond(req, reply, () => {
    const body = z.object({ verify_code: z.string().max(64).optional() }).strict().parse(req.body ?? {});
    return bridge.pollWechatQr(routeId(req), body.verify_code);
  }));
  app.post('/im/sessions/wechat/qrcode/:id/cancel', (req, reply) => respond(req, reply, () => {
    z.object({}).strict().parse(req.body ?? {});
    return bridge.cancelWechatQr(routeId(req));
  }));
}
