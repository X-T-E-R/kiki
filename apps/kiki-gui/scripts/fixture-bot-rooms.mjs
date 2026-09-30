/**
 * Fixture stand-in for the Bot and room routes (kap-server routes/botRooms.ts):
 * `/bots` list / enable / home / patch and `/rooms` CRUD, messages, pause /
 * continue / stop, log and usage. Writes mutate scenario state so the GUI's
 * paths are exercisable; a roster change while `roomRunning` is set is
 * refused with the server's own message.
 *
 * Scenario seed (optional):
 *   bots: [{ personaId, homeSessionId?, pinned?, hidden? }]   // names from `personas`
 *   rooms: [{ room: RoomDocument, log: RoomLogEntry[], usage?: Partial<RoomUsage> }]
 *   roomRunning: { [roomId]: true }
 *
 * Thread members (`{ kind: 'thread', sessionId, joinedAt, queueWhenBusy }`)
 * come from `POST /rooms/from-threads` and `POST /rooms/{id}/members`, and
 * leave through `DELETE /rooms/{id}/members/{memberId}`; `GET /rooms/threads`
 * searches the scenario's top-level sessions. Scenario `config.
 * thread_communication.enabled === false` refuses all three with the server's
 * 40928 message.
 *
 * Scheduling is NOT simulated: a posted message is logged, nobody answers.
 */

import { randomUUID } from 'node:crypto';

/** Reset hook: the fixture server calls this from `loadScenario`. */
export function resetBotRooms(server, data) {
  server.bots = new Map((data.bots ?? []).map((seed) => [seed.personaId, { pinned: false, hidden: false, ...structuredClone(seed) }]));
  server.rooms = new Map((data.rooms ?? []).map((seed) => [seed.room.id, {
    room: structuredClone(seed.room),
    log: structuredClone(seed.log ?? []),
    usage: structuredClone(seed.usage ?? {}),
  }]));
  server.roomRunning = { ...(data.roomRunning ?? {}) };
}

function personaName(server, id) {
  return server.personas?.get(id)?.definition.name ?? id;
}

const memberId = (member) => member.kind === 'thread' ? member.sessionId : member.personaId;

function threadCommsOff(server) {
  return server.config?.thread_communication?.enabled === false;
}

function threadSessions(server) {
  return [...(server.sessions?.values?.() ?? [])].map((entry) => entry.record).filter((session) => {
    const metadata = session.metadata ?? {};
    return session.archived !== true && metadata.room_member_of === undefined && metadata.bot_persona_id === undefined
      && metadata.child_session_kind !== 'child' && typeof metadata.parent_session_id !== 'string';
  });
}

function threadMember(sessionId, input = {}) {
  return { kind: 'thread', sessionId, muted: input.muted === true, joinedAt: new Date().toISOString(), queueWhenBusy: input.queueWhenBusy !== false };
}

function botSummary(server, bot) {
  const definition = server.personas?.get(bot.personaId)?.definition;
  return {
    personaId: bot.personaId,
    name: definition?.name ?? bot.personaId,
    ...(definition?.title !== undefined ? { title: definition.title } : {}),
    ...(bot.homeSessionId !== undefined ? { homeSessionId: bot.homeSessionId } : {}),
    pinned: bot.pinned === true,
    hidden: bot.hidden === true,
  };
}

function system(event, text, data) {
  return { id: `sys_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), kind: 'system', from: 'system', event, text, ...(data !== undefined ? { data } : {}) };
}

function usageOf(record) {
  const { room, log } = record;
  const messages = log.filter((entry) => entry.kind === 'message');
  return {
    userMessages: messages.filter((entry) => entry.from === 'user').length,
    botMessages: messages.filter((entry) => entry.from !== 'user').length,
    budgetUsed: room.budgetUsed,
    budgetLimit: room.budget.botMessagesPerUserMessage,
    paused: room.paused,
    members: room.members.map((member) => ({ sessionId: member.sessionId, ...(member.kind === 'thread' ? {} : { personaId: member.personaId }), usage: record.usage.members?.[memberId(member)] })),
    ...(record.usage.questions !== undefined ? { questions: record.usage.questions } : {}),
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

/** Handle `/api/bots*` and `/api/rooms*`; returns true when it answered. */
export async function handleBotRooms(server, req, res, path, query) {
  if (!path.startsWith('/bots') && !path.startsWith('/rooms')) return false;
  if (server.bots === undefined) resetBotRooms(server, server.scenario?.data ?? {});
  const method = req.method ?? 'GET';
  const ok = (data) => { server.envelope(res, data); return true; };
  const fail = (msg, code = 40001) => { server.envelope(res, null, code, msg); return true; };

  if (path === '/bots' && method === 'GET') return ok([...server.bots.values()].map((bot) => botSummary(server, bot)));
  const botMatch = /^\/bots\/([^/]+)(?:\/(enable|home))?$/u.exec(path);
  if (botMatch !== null) {
    const id = decodeURIComponent(botMatch[1]);
    if (server.personas?.get(id) === undefined) return fail(`Persona "${id}" does not exist.`);
    let bot = server.bots.get(id);
    if (method === 'POST') {
      if (bot === undefined) { bot = { personaId: id, pinned: false, hidden: false }; server.bots.set(id, bot); }
      if (bot.homeSessionId === undefined) bot.homeSessionId = server.createBotHome?.(id) ?? `session_bot_${id}`;
      return ok(botSummary(server, bot));
    }
    if (method === 'PATCH') {
      if (bot === undefined) return fail(`Bot "${id}" is not enabled.`);
      const body = await readJson(req);
      if (typeof body.pinned === 'boolean') bot.pinned = body.pinned;
      if (typeof body.hidden === 'boolean') bot.hidden = body.hidden;
      return ok({ personaId: id, homeSessionId: bot.homeSessionId, pinned: bot.pinned, hidden: bot.hidden });
    }
  }

  if (path === '/rooms' && method === 'GET') return ok([...server.rooms.values()].map((record) => record.room));
  if (path === '/rooms/threads' && method === 'GET') {
    if (threadCommsOff(server)) return ok({ threads: [] });
    const needle = (query.get('query') ?? '').toLocaleLowerCase();
    const limit = Number(query.get('limit') ?? 50);
    const threads = threadSessions(server)
      .filter((session) => `${session.id} ${session.title ?? ''}`.toLocaleLowerCase().includes(needle))
      .slice(0, limit)
      .map((session) => ({
        ref: { hostId: 'fixture-host', workspaceId: session.workspace_id, sessionId: session.id },
        title: session.title, updatedAt: Date.parse(session.updated_at), createdAt: Date.parse(session.created_at),
        state: session.busy === true ? 'running' : 'idle',
      }));
    return ok({ threads });
  }
  if (path === '/rooms/from-threads' && method === 'POST') {
    if (threadCommsOff(server)) return fail('Thread communication is disabled for this thread.', 40928);
    const body = await readJson(req);
    const id = body.id ?? `room-${randomUUID().slice(0, 6)}`;
    const members = body.sessionIds.map((sessionId) => threadMember(sessionId));
    const room = {
      version: 1, id, name: body.name, host: body.host ?? members[0].sessionId, mode: 'mention', members,
      budget: { botMessagesPerUserMessage: body.budget?.botMessagesPerUserMessage ?? 12 },
      workspace: body.workspace, createdAt: new Date().toISOString(), generation: 0, paused: false,
      budgetUsed: 0, userMessageCount: 0, cursors: {},
    };
    server.rooms.set(id, { room, log: members.map((member) => system('member_joined', `${member.sessionId} joined the room.`, { memberId: member.sessionId, kind: 'thread' })), usage: {} });
    return ok(room);
  }
  const memberMatch = /^\/rooms\/([^/]+)\/members(?:\/([^/]+))?$/u.exec(path);
  if (memberMatch !== null) {
    const record = server.rooms.get(decodeURIComponent(memberMatch[1]));
    if (record === undefined) return fail('Room was not found.', 40401);
    const { room } = record;
    if (method === 'POST') {
      if (threadCommsOff(server)) return fail('Thread communication is disabled for this thread.', 40928);
      const body = await readJson(req);
      if (room.members.length >= 6) return fail('A room needs 0–6 members.');
      if (body.kind === 'thread') {
        room.members = [...room.members, threadMember(body.sessionId, body)];
        record.log.push(system('member_joined', `${body.sessionId} joined the room.`, { memberId: body.sessionId, kind: 'thread' }));
      }
      return ok(room);
    }
    if (method === 'DELETE') {
      const id = decodeURIComponent(memberMatch[2]);
      const leaving = room.members.find((member) => memberId(member) === id);
      if (leaving === undefined) return fail('Room member not found.');
      room.members = room.members.filter((member) => member !== leaving);
      if (room.host === id && room.members.length > 0) room.host = memberId(room.members[0]);
      record.log.push(system(leaving.kind === 'thread' ? 'member_left' : 'roster_changed', `${id} left the room.`, { memberId: id, kind: leaving.kind }));
      return ok(room);
    }
  }
  if (path === '/rooms' && method === 'POST') {
    const body = await readJson(req);
    const id = body.id ?? `room-${randomUUID().slice(0, 6)}`;
    const room = {
      version: 1, id, name: body.name, host: body.host ?? body.members[0].personaId, mode: 'mention',
      members: body.members.map((member) => ({ kind: 'persona', personaId: member.personaId, sessionId: `session_room_${id}_${member.personaId}`, muted: member.muted === true })),
      budget: { botMessagesPerUserMessage: body.budget?.botMessagesPerUserMessage ?? 12 },
      workspace: body.workspace, createdAt: new Date().toISOString(), generation: 0, paused: false,
      budgetUsed: 0, userMessageCount: 0, cursors: {},
    };
    server.rooms.set(id, { room, log: [], usage: {} });
    return ok(room);
  }
  const roomMatch = /^\/rooms\/([^/]+)(?:\/(messages|pause|continue|stop|log|usage))?$/u.exec(path);
  if (roomMatch === null) return false;
  const id = decodeURIComponent(roomMatch[1]);
  const record = server.rooms.get(id);
  const action = roomMatch[2];
  if (record === undefined) {
    if (method === 'GET' && action === undefined) return ok(undefined);
    return fail(`Room '${id}' was not found.`, 40401);
  }
  const { room } = record;
  if (action === undefined && method === 'GET') return ok(room);
  if (action === undefined && method === 'DELETE') { server.rooms.delete(id); return ok({ deleted: true }); }
  if (action === undefined && method === 'PATCH') {
    const body = await readJson(req);
    const personaIds = (list) => list.filter((member) => member.kind !== 'thread').map((member) => member.personaId).sort().join(',');
    const roster = body.members !== undefined && personaIds(body.members) !== personaIds(room.members);
    if ((roster || (body.workspace !== undefined && body.workspace !== room.workspace)) && server.roomRunning[id] === true) {
      return fail('Stop the active room turn before changing its members or workspace.');
    }
    if (typeof body.name === 'string' && body.name !== room.name) { room.name = body.name; record.log.push(system('room_renamed', `Room renamed to ${room.name}.`, { name: room.name })); }
    if (typeof body.host === 'string' && body.host !== room.host) { room.host = body.host; record.log.push(system('host_changed', `Room host changed to ${room.host}.`, { host: room.host })); }
    if (body.budget?.botMessagesPerUserMessage !== undefined) room.budget = { botMessagesPerUserMessage: body.budget.botMessagesPerUserMessage };
    if (body.members !== undefined) {
      room.members = body.members.map((member) => member.kind === 'thread'
        ? { ...(room.members.find((existing) => existing.sessionId === member.sessionId) ?? threadMember(member.sessionId)), muted: member.muted === true, queueWhenBusy: member.queueWhenBusy !== false }
        : {
          kind: 'persona',
          personaId: member.personaId,
          sessionId: room.members.find((existing) => existing.personaId === member.personaId)?.sessionId ?? `session_room_${id}_${member.personaId}`,
          muted: member.muted === true,
        });
      if (roster) record.log.push(system('roster_changed', 'Room roster updated.', { members: room.members.map(memberId) }));
    }
    return ok(room);
  }
  if (action === 'messages' && method === 'POST') {
    const body = await readJson(req);
    const nameOfMember = (member) => member.kind === 'thread' ? server.sessions?.get?.(member.sessionId)?.record.title ?? member.sessionId : personaName(server, member.personaId);
    const mentions = room.members.filter((member) => body.text.includes(`@${nameOfMember(member)}`)).map(memberId);
    const entry = { id: `m_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), kind: 'message', from: 'user', text: body.text, mentions, ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}) };
    record.log.push(entry);
    room.userMessageCount += 1;
    room.budgetUsed = 0;
    if (room.paused && room.pauseReason === 'budget') { room.paused = false; delete room.pauseReason; }
    return ok(entry);
  }
  if (method === 'POST' && (action === 'pause' || action === 'continue' || action === 'stop')) {
    if (action === 'pause') { room.paused = true; room.pauseReason = 'manual'; record.log.push(system('paused', 'Discussion paused.')); }
    if (action === 'continue') {
      room.paused = false; delete room.pauseReason; room.budgetUsed = 0;
      record.log.push(system('continued', 'Discussion continued.', { budget: room.budget.botMessagesPerUserMessage }));
    }
    if (action === 'stop') { server.roomRunning[id] = false; record.log.push(system('stopped', 'All active discussion turns stopped.')); }
    return ok(room);
  }
  if (action === 'log' && method === 'GET') {
    const after = query.get('afterId') ?? undefined;
    const limit = Math.min(Number(query.get('limit') ?? 500), 500);
    const start = after === undefined ? 0 : Math.max(0, record.log.findIndex((entry) => entry.id === after) + 1);
    const entries = record.log.slice(start, start + limit);
    return ok({ entries, ...(start + entries.length < record.log.length ? { nextCursor: entries.at(-1)?.id } : {}) });
  }
  if (action === 'usage' && method === 'GET') return ok(usageOf(record));
  return false;
}
