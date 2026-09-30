import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Error2, ErrorCodes, type Scope } from '@kiki/agent-core-v2';
import { IRoomService } from '@kiki/agent-core-v2/app/room/room';
import { registerBotRoomRoutes } from '../src/routes/botRooms';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

function setup() {
  const room = { version: 1, id: 'example', name: 'Room', members: [], host: 'example-host', mode: 'mention', budget: { botMessagesPerUserMessage: 12 }, workspace: 'workspace-room', createdAt: '2026-01-01T00:00:00Z', generation: 0, paused: false, budgetUsed: 0, userMessageCount: 0, cursors: {} };
  const item = { kind: 'room', id: room.id, title: room.name, workspace: room.workspace, createdAt: room.createdAt, updatedAt: room.createdAt, lastSeq: 0, memberCount: 0, busy: false, needsYou: false, pendingInteraction: 'none', failed: false, pinned: false, archived: false };
  const service = {
    listItems: vi.fn(async () => [item]),
    update: vi.fn(async (id: string, input: object) => {
      if (id !== room.id) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Room not found');
      return { ...room, ...input };
    }),
    delete: vi.fn(async (id: string) => {
      if (id !== room.id) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Room not found');
    }),
  };
  const scope = { accessor: { get: (token: unknown) => { expect(token).toBe(IRoomService); return service; } } } as unknown as Scope;
  const app = Fastify();
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  apps.push(app);
  registerBotRoomRoutes(app as unknown as Parameters<typeof registerBotRoomRoutes>[0], scope);
  return { app, service, item };
}

describe('room list and lifecycle routes', () => {
  it('returns complete room rows and forwards metadata-only actions', async () => {
    const { app, service, item } = setup();
    expect((await app.inject({ method: 'GET', url: '/rooms/items' })).json()).toMatchObject({ code: 0, data: [item] });
    const input = { name: 'Renamed', pinned: true, archived: true };
    expect((await app.inject({ method: 'PATCH', url: '/rooms/example', payload: input })).json()).toMatchObject({ code: 0, data: input });
    expect(service.update).toHaveBeenCalledWith('example', input);
    expect((await app.inject({ method: 'DELETE', url: '/rooms/example' })).json()).toMatchObject({ code: 0, data: { deleted: true } });
  });
  it('rejects invalid pin/archive/title patches before mutating the service', async () => {
    const { app, service } = setup();
    for (const payload of [{ pinned: 'true' }, { archived: 1 }, { name: ' ' }, { name: 'x'.repeat(201) }, { unknown: true }]) {
      const reply = await app.inject({ method: 'PATCH', url: '/rooms/example', payload });
      expect(reply.json().code).toBe(40001);
    }
    expect(service.update).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'PATCH', url: '/rooms/missing', payload: { pinned: true } })).json().code).toBe(40001);
    expect((await app.inject({ method: 'DELETE', url: '/rooms/missing' })).json().code).toBe(40001);
  });
});
