import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { imBindingPatchSchema, imConfirmRequestSchema, imPolicySchema } from '@kiki/protocol';

import { okEnvelope, errEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import type { ImSessionBridge } from '../services/imSession/bridge';

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/u);

function routeId(req: FastifyRequest): string {
  const params = req.params as { id?: unknown };
  return identifier.parse(params.id);
}

export function registerImSessionRoutes(app: FastifyInstance, bridge: ImSessionBridge): void {
  const respond = async (req: FastifyRequest, reply: FastifyReply, operation: () => Promise<unknown>): Promise<void> => {
    try { reply.send(okEnvelope(await operation(), req.id)); }
    catch (error) {
      if (error instanceof z.ZodError) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), req.id));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const validation = /^(?:paste_unrecognized|unknown_|home_session_missing|instance_required)/u.test(message);
      reply.send(errEnvelope(validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL_ERROR, message, req.id));
    }
  };
  app.get('/im/sessions', (req, reply) => respond(req, reply, () => bridge.snapshot()));
  app.get('/im/sessions/catalog', (req, reply) => respond(req, reply, () => bridge.catalog()));
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
  app.patch('/im/sessions/bindings/:id', (req, reply) => respond(req, reply, () => {
    const patch = imBindingPatchSchema.parse(req.body);
    return bridge.updateBinding(routeId(req), {
      enabled: patch.enabled,
      sessionEnabled: patch.session_enabled,
      busy: patch.busy,
      reply: patch.reply,
      mobileInteractions: patch.mobile_interactions,
      sessionId: patch.session_id,
      target: patch.target,
    });
  }));
  app.delete('/im/sessions/bindings/:id', (req, reply) => respond(req, reply, () => bridge.removeBinding(routeId(req))));
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
