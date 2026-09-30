import { Error2, ErrorCodes, type Scope } from '@kiki/agent-core-v2';
import { IBotService } from '@kiki/agent-core-v2/app/bot/bot';
import { IRoomService } from '@kiki/agent-core-v2/app/room/room';
import { z } from 'zod';
import {
  botIdParamsSchema, botSummarySchema, botStateSchema, botUpdateInputSchema,
  roomIdParamsSchema, roomDocumentSchema, createRoomInputSchema, updateRoomInputSchema,
  postRoomMessageInputSchema, roomMessageSchema, roomLogOptionsSchema, roomLogResultSchema,
  roomUsageSchema, deleteRoomResponseSchema, createThreadRoomInputSchema, roomMemberInputSchema,
  roomMemberParamsSchema, searchRoomThreadsInputSchema, searchRoomThreadsResultSchema,
} from '@kiki/protocol';
import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { mapError } from '../transport/errors';

type Route = ReturnType<typeof defineRoute>;
interface BotRoomRouteHost {
  get(path: string, options: Route['options'], handler: Route['handler']): unknown;
  post(path: string, options: Route['options'], handler: Route['handler']): unknown;
  patch(path: string, options: Route['options'], handler: Route['handler']): unknown;
  delete(path: string, options: Route['options'], handler: Route['handler']): unknown;
}

export function registerBotRoomRoutes(app: BotRoomRouteHost, core: Scope): void {
  const bots = () => core.accessor.get(IBotService);
  const rooms = () => core.accessor.get(IRoomService);
  const handle = async (id: string, reply: { send(value: unknown): unknown }, run: () => Promise<unknown>) => {
    try { reply.send(okEnvelope(await run(), id)); }
    catch (error) { reply.send(mapError(error, id)); }
  };
  const add = (verb: keyof BotRoomRouteHost, route: Route) => { app[verb](route.path, route.options, route.handler); };
  add('get', defineRoute({ method: 'GET', path: '/bots', success: { data: z.array(botSummarySchema) }, tags: ['bots'] },
    (req, reply) => handle(req.id, reply, () => bots().list())));
  for (const action of ['enable', 'home'] as const) {
    add('post', defineRoute({ method: 'POST', path: `/bots/{id}/${action}`, params: botIdParamsSchema, success: { data: botSummarySchema }, tags: ['bots'] },
      (req, reply) => handle(req.id, reply, () => action === 'enable' ? bots().enable(req.params.id) : bots().ensureHomeSession(req.params.id))));
  }
  add('patch', defineRoute({ method: 'PATCH', path: '/bots/{id}', params: botIdParamsSchema, body: botUpdateInputSchema, success: { data: botStateSchema }, tags: ['bots'] },
    (req, reply) => handle(req.id, reply, () => bots().update(req.params.id, req.body))));
  add('get', defineRoute({ method: 'GET', path: '/rooms', success: { data: z.array(roomDocumentSchema) }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().list())));
  add('post', defineRoute({ method: 'POST', path: '/rooms', body: createRoomInputSchema, success: { data: roomDocumentSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().create(req.body))));
  add('post', defineRoute({ method: 'POST', path: '/rooms/from-threads', body: createThreadRoomInputSchema, success: { data: roomDocumentSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().createFromThreads(req.body))));
  add('get', defineRoute({ method: 'GET', path: '/rooms/threads', querystring: searchRoomThreadsInputSchema, success: { data: searchRoomThreadsResultSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().searchThreads(req.query))));
  add('post', defineRoute({ method: 'POST', path: '/rooms/{id}/members', params: roomIdParamsSchema, body: roomMemberInputSchema, success: { data: roomDocumentSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().addMember(req.params.id, req.body))));
  add('delete', defineRoute({ method: 'DELETE', path: '/rooms/{id}/members/{memberId}', params: roomMemberParamsSchema, success: { data: roomDocumentSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().removeMember(req.params.id, req.params.memberId))));
  add('get', defineRoute({ method: 'GET', path: '/rooms/{id}', params: roomIdParamsSchema, success: { data: roomDocumentSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, async () => {
      const room = await rooms().get(req.params.id);
      if (room === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, `Room '${req.params.id}' does not exist.`);
      return room;
    })));
  add('patch', defineRoute({ method: 'PATCH', path: '/rooms/{id}', params: roomIdParamsSchema, body: updateRoomInputSchema, success: { data: roomDocumentSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().update(req.params.id, req.body))));
  add('delete', defineRoute({ method: 'DELETE', path: '/rooms/{id}', params: roomIdParamsSchema, success: { data: deleteRoomResponseSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, async () => { await rooms().delete(req.params.id); return { deleted: true }; })));
  add('post', defineRoute({ method: 'POST', path: '/rooms/{id}/messages', params: roomIdParamsSchema, body: postRoomMessageInputSchema, success: { data: roomMessageSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().postUserMessage(req.params.id, req.body))));
  for (const action of ['pause', 'continue', 'stop'] as const) {
    add('post', defineRoute({ method: 'POST', path: `/rooms/{id}/${action}`, params: roomIdParamsSchema, success: { data: roomDocumentSchema }, tags: ['rooms'] },
      (req, reply) => handle(req.id, reply, () => rooms()[action](req.params.id))));
  }
  add('get', defineRoute({ method: 'GET', path: '/rooms/{id}/log', params: roomIdParamsSchema, querystring: roomLogOptionsSchema, success: { data: roomLogResultSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().log(req.params.id, req.query))));
  add('get', defineRoute({ method: 'GET', path: '/rooms/{id}/usage', params: roomIdParamsSchema, success: { data: roomUsageSchema }, tags: ['rooms'] },
    (req, reply) => handle(req.id, reply, () => rooms().usage(req.params.id))));
}
