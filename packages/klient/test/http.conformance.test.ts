import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IAgentToolRegistryService } from '@kiki/agent-core-v2/agent/toolRegistry/toolRegistry';
import { ISendMessageTool } from '@kiki/agent-core-v2/agent/tools/message/sendMessageTool';
import { ISessionDeliveryService } from '@kiki/agent-core-v2/session/delivery/delivery';
import { BotService } from '@kiki/agent-core-v2/app/bot/botService';
import { SEND_PEER_THREAD_MESSAGE, peerSendCapability } from '@kiki/agent-core-v2/app/threadCommunication/peerThreadCapability';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigTarget,
  IConfigService,
  ISessionIndex,
  IBotService,
  IPersonaStore,
  ISessionManager,
  IInstantiationService,
  IThreadCommunicationService,
} from '@kiki/agent-core-v2';
import { expect, it, vi } from 'vitest';
import { getLiveSessionById } from '@kiki/agent-core-v2/app/sessionManager/sessionLookup';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';

import { startServer } from '../../kap-server/src/start.js';
import { createKlient } from '../src/transports/http/index.js';
import { defineKlientConformance } from './helpers/conformance.js';
import { TEST_CLIENT_IDENTITY } from './helpers/engine.js';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

defineKlientConformance('http', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-conformance-http-'));
  const server = await startServer({
    hostIdentity: TEST_CLIENT_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logLevel: 'silent',
  });
  await server.core.accessor
    .get(IConfigService)
    .replace('threadCommunication', { enabled: true }, ConfigTarget.Memory);
  await server.core.accessor.get(ISessionIndex).prepare();
  const klient = createKlient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: server.authTokenService.getToken(),
  });
  return {
    klient,
    app: server.core,
    cleanup: async () => {
      await klient.close();
      await server.close();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    },
  };
});

it('converges interactions, metadata and providers changed in the HTTP black window without later events', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-recovery-http-'));
  const server = await startServer({
    hostIdentity: TEST_CLIENT_IDENTITY, host: '127.0.0.1', port: 0, homeDir, logLevel: 'silent',
  });
  await server.core.accessor.get(ISessionIndex).prepare();
  const sockets: WebSocket[] = [];
  let reconnectBlocked = false;
  class ControlledWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: ConstructorParameters<typeof WebSocket>[1]) {
      if (reconnectBlocked) throw new Error('test reconnect held');
      super(url, protocols);
      sockets.push(this);
    }
  }
  const klient = createKlient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: server.authTokenService.getToken(), WebSocket: ControlledWebSocket,
  });
  try {
    const created = await klient.global.sessions.create({ workDir: process.cwd(), title: 'before disconnect' });
    const session = klient.session(created.id);
    const interactions = getLiveSessionById(server.core.accessor, created.id)!.accessor.get(ISessionInteractionService);
    const first = interactions.enqueue({ kind: 'question', payload: {} });
    const snapshots: Array<{ title: string | undefined; ids: string[] }> = [];
    const providers: string[][] = [];
    const ordinary: unknown[] = [];
    const errors: Error[] = [];
    session.events.onError((error) => errors.push(error));
    klient.events.onError((error) => errors.push(error));
    session.events.on('interactions.changed', (event) => ordinary.push(event));
    session.events.on('metadata.changed', (event) => ordinary.push(event));
    klient.events.on('kosong.providers.changed', (event) => ordinary.push(event));
    session.events.observe({
      events: ['metadata.changed', 'interactions.changed'],
      read: async () => {
        const [meta, pending] = await Promise.all([session.get(), session.interactions.list()]);
        return { title: meta.title, ids: pending.map((item) => item.id) };
      },
    }, (snapshot) => snapshots.push(snapshot));
    klient.events.observe({
      events: ['kosong.providers.changed'],
      read: async () => (await klient.global.kosong.listProviders()).map((provider) => provider.id),
    }, (snapshot) => providers.push(snapshot));
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual({ title: 'before disconnect', ids: [first.id] });
      expect(providers.length).toBeGreaterThan(0);
    });
    expect(ordinary).toEqual([]);
    reconnectBlocked = true;
    sockets.at(-1)!.close();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    interactions.respond(first.id, {});
    const second = interactions.enqueue({ kind: 'approval', payload: {} });
    await session.setTitle('changed while disconnected');
    await klient.global.kosong.addProvider('recovery-provider', {
      type: 'openai', baseUrl: 'http://127.0.0.1:1', auth: { method: 'api-key', apiKey: 'test-key' },
    });
    reconnectBlocked = false;
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual({ title: 'changed while disconnected', ids: [second.id] });
      expect(providers.at(-1)).toContain('recovery-provider');
    }, { timeout: 10_000 });
    expect(ordinary).toEqual([]);
    const beforeErrors = errors.length;
    reconnectBlocked = true;
    sockets.at(-1)!.close();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(beforeErrors));
    interactions.respond(second.id, {});
    await session.setTitle('resolved while disconnected');
    await klient.global.kosong.removeProvider('recovery-provider');
    reconnectBlocked = false;
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toEqual({ title: 'resolved while disconnected', ids: [] });
      expect(providers.at(-1)).not.toContain('recovery-provider');
    }, { timeout: 10_000 });
    expect(ordinary).toEqual([]);
  } finally {
    await klient.close();
    await server.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('persona REST supports action suffixes and character-card import/export', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-persona-rest-'));
  const server = await startServer({
    hostIdentity: TEST_CLIENT_IDENTITY, host: '127.0.0.1', port: 0, homeDir, logLevel: 'silent',
  });
  const klient = createKlient({
    endpoint: `http://127.0.0.1:${server.port}`, token: server.authTokenService.getToken(),
  });
  try {
    if (klient.rest === undefined) throw new Error('HTTP REST facade is required');
    const api = klient.rest.personas;
    const created = await api.put({ definition: { id: 'example-persona', name: 'Example', description: 'Identity only.' } });
    expect((await api.get(created.definition.id)).revision).toBe(created.revision);
    const copy = await api.duplicate(created.definition.id, { id: 'example-copy' });
    expect(copy.definition.id).toBe('example-copy');
    expect((await api.archive(copy.definition.id)).archived).toBe(true);
    expect((await api.list()).map((item) => item.id)).not.toContain('example-copy');
    const exported = await api.exportCard(created.definition.id, 'json');
    const input = { data: exported.bytes, format: 'json' as const };
    const preview = await api.previewImport(input);
    expect(preview.definition.name).toBe('Example');
    const imported = await api.importCard({ ...input, id: 'example-import' });
    expect(imported.snapshot.definition.id).toBe('example-import');
    await expect(api.delete(copy.definition.id)).rejects.toThrow('session index is building');
    expect((await api.get(copy.definition.id)).definition.id).toBe(copy.definition.id);
    await server.core.accessor.get(ISessionIndex).prepare();
    expect(await api.delete(copy.definition.id)).toEqual({ deleted: true, memory: { status: 'committed' } });
    await klient.global.kosong.addProvider({ id: 'example-model', model: 'example-model', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', maxContextSize: 1000, auth: { method: 'api-key', apiKey: 'test-key' } });
    await api.put({ definition: { ...created.definition, modelAlias: 'example-model' } });
    const session = await klient.rest.sessions.create({ persona: created.definition.id, delivery: 'message', ephemeral: false, metadata: { cwd: process.cwd() } });
    expect(session.delivery).toBe('message');
    expect((await klient.rest.sessions.updateProfile(session.id, { delivery: 'reply' })).delivery).toBe('reply');
    await klient.rest.sessions.updateProfile(session.id, { delivery: 'message' });
    const expectedPersona = { id: 'example-persona', name: 'Example', avatarUrl: '/api/personas/example-persona/avatar' };
    const readSession = async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${server.authTokenService.getToken()}` },
      });
      return (await response.json() as { data: typeof session }).data;
    };
    expect(session.agent_config.persona).toEqual(expectedPersona);
    expect((await readSession()).agent_config.persona).toEqual(expectedPersona);
    await klient.session(session.id).close();
    expect(getLiveSessionById(server.core.accessor, session.id)).toBeUndefined();
    expect((await readSession()).agent_config.persona).toEqual(expectedPersona);
    expect((await readSession()).delivery).toBe('message');
    expect(getLiveSessionById(server.core.accessor, session.id)).toBeUndefined();
    await api.put({ definition: { ...imported.snapshot.definition, modelAlias: 'example-model', homeWorkspace: process.cwd() } });
    await api.put({ definition: { ...created.definition, modelAlias: 'example-model', homeWorkspace: process.cwd() } });
    const bot = await klient.rest.bots.enable(created.definition.id);
    expect((await klient.rest.bots.ensureHomeSession(created.definition.id)).homeSessionId).toBe(bot.homeSessionId);
    const botHome = getLiveSessionById(server.core.accessor, bot.homeSessionId!)!;
    await botHome.accessor.get(ISessionDeliveryService).ready;
    expect(botHome.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentToolRegistryService).list().map((tool) => tool.name)).toContain('SendMessage');
    expect((await klient.rest.bots.update(created.definition.id, { hidden: true })).hidden).toBe(true);
    expect((await klient.rest.bots.list()).some((item) => item.personaId === created.definition.id)).toBe(true);
    await klient.session(bot.homeSessionId!).close();
    expect(getLiveSessionById(server.core.accessor, bot.homeSessionId!)).toBeUndefined();
    expect((await klient.rest.bots.ensureHomeSession(created.definition.id)).homeSessionId).toBe(bot.homeSessionId);
    const botService = server.core.accessor.get(IBotService);
    const personaStore = server.core.accessor.get(IPersonaStore);
    const manager = server.core.accessor.get(ISessionManager);
    const sessionsBeforeFailure = manager.list().map((entry) => entry.id).sort();
    const failedSave = vi.spyOn(personaStore, 'updateState').mockRejectedValueOnce(new Error('state persistence failed'));
    await expect(botService.ensureHomeSession(imported.snapshot.definition.id)).rejects.toThrow('state persistence failed');
    failedSave.mockRestore();
    expect(manager.list().map((entry) => entry.id).sort()).toEqual(sessionsBeforeFailure);
    expect((await personaStore.getState(imported.snapshot.definition.id)).homeSessionId).toBeUndefined();
    await botService.enable(imported.snapshot.definition.id);
    await expect(botService.resolve('@Example')).rejects.toThrow('ambiguous');
    await server.core.accessor.get(IConfigService).set('bot', { enabled: true, maxHandoffsPerHour: 1 }, ConfigTarget.Memory);
    const sender = peerSendCapability(server.core.accessor.get(IThreadCommunicationService));
    const send = vi.spyOn(sender, SEND_PEER_THREAD_MESSAGE).mockResolvedValue({ messageId: 'handoff-receipt', targetSeq: 1, acceptedAt: 1, deduplicated: true, delivery: 'delivered' });
    const handoff = { sourceSessionId: session.id, sourcePersonaId: created.definition.id, target: imported.snapshot.definition.id, content: 'Please review.', idempotencyKey: 'same-call' };
    try {
      expect((await botService.sendHandoff(handoff)).handoff?.targetPersonaId).toBe(imported.snapshot.definition.id);
      const recreatedService = server.core.accessor.get(IInstantiationService).createInstance(BotService);
      try {
        expect((await recreatedService.sendHandoff(handoff)).messageId).toBe('handoff-receipt');
        await expect(recreatedService.sendHandoff({ ...handoff, idempotencyKey: 'new-call' })).rejects.toThrow('handoff limit');
        expect(send).toHaveBeenCalledTimes(2);
      } finally { recreatedService.dispose(); }
    } finally { send.mockRestore(); }
    const rooms = klient.rest.rooms;
    const room = await rooms.create({ name: 'REST room', workspace: process.cwd(), members: [{ personaId: created.definition.id }, { personaId: imported.snapshot.definition.id }] });
    expect((await rooms.list()).some((item) => item.id === room.id)).toBe(true);
    expect((await rooms.get(room.id))?.name).toBe('REST room');
    const patched = await rooms.update(room.id, { budget: { botMessagesPerUserMessage: 4 }, members: room.members.map((member) => member.kind === 'persona' ? { kind: 'persona', personaId: member.personaId, muted: true } : { kind: 'thread', sessionId: member.sessionId, muted: true }) });
    expect(patched.budget.botMessagesPerUserMessage).toBe(4);
    expect(patched.members.every((member) => member.muted)).toBe(true);
    await rooms.pause(room.id);
    const memberSession = getLiveSessionById(server.core.accessor, room.members[0]!.sessionId)!;
    const memberMain = memberSession.accessor.get(IAgentLifecycleService).get('main')!;
    await memberSession.accessor.get(ISessionDeliveryService).ready;
    expect(memberMain.accessor.get(IAgentToolRegistryService).list().map((tool) => tool.name)).toContain('SendMessage');
    const memberTool = memberMain.accessor.get(ISendMessageTool);
    const execution = await memberTool.resolveExecution({ text: 'Room delivery from the real tool.' });
    if (!('execute' in execution)) throw new Error('SendMessage must be available in a room');
    const sent = await execution.execute({ toolCallId: 'room-real-delivery', turnId: 1, signal: new AbortController().signal });
    expect(sent.isError).not.toBe(true);
    expect(JSON.parse(sent.output as string).delivered_to).toEqual(['room']);
    expect((await rooms.log(room.id)).entries.some((entry) => entry.kind === 'message' && entry.text === 'Room delivery from the real tool.')).toBe(true);
    const row = await rooms.postUserMessage(room.id, { text: 'Queued while paused', idempotencyKey: 'rest-room-message' });
    expect((await rooms.log(room.id)).entries.some((item) => item.id === row.id)).toBe(true);
    expect((await rooms.usage(room.id)).userMessages).toBe(1);
    await rooms.continue(room.id);
    await rooms.stop(room.id);
    await rooms.delete(room.id);
    expect((await rooms.list()).some((item) => item.id === room.id)).toBe(false);
  } finally {
    await klient.close();
    await server.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('SendMessage keeps immutable downloadable attachments and freezes delivery for an active turn', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-message-rest-'));
  const workDir = join(homeDir, 'workspace');
  await mkdir(workDir);
  const server = await startServer({ hostIdentity: TEST_CLIENT_IDENTITY, host: '127.0.0.1', port: 0, homeDir, logLevel: 'silent' });
  const klient = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.authTokenService.getToken() });
  try {
    if (klient.rest === undefined) throw new Error('HTTP REST facade is required');
    await server.core.accessor.get(ISessionIndex).prepare();
    await klient.global.kosong.addProvider({ id: 'message-test-model', model: 'message-test-model', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', maxContextSize: 1000, auth: { method: 'api-key', apiKey: 'test-key' } });
    const created = await klient.rest.sessions.create({ delivery: 'message', ephemeral: false, metadata: { cwd: workDir }, agent_config: { model: 'message-test-model' } });
    const live = getLiveSessionById(server.core.accessor, created.id)!;
    const main = live.accessor.get(IAgentLifecycleService).get('main')!;
    const registry = main.accessor.get(IAgentToolRegistryService);
    expect(registry.list().map((entry) => entry.name)).toContain('SendMessage');
    const tool = main.accessor.get(ISendMessageTool);
    const delivery = live.accessor.get(ISessionDeliveryService);
    await writeFile(join(workDir, 'report.txt'), 'original immutable report');
    await writeFile(join(homeDir, 'outside.txt'), 'not shared');
    const run = async (text: string, path?: string, to?: string) => {
      const resolution = await tool.resolveExecution({ text, to, attachments: path === undefined ? undefined : [{ path }] });
      if (!('execute' in resolution)) return resolution;
      return resolution.execute({ toolCallId: 'message-call', turnId: 1, signal: new AbortController().signal });
    };
    delivery.beginTurn();
    await delivery.set('reply');
    expect(delivery.mode()).toBe('reply');
    expect(delivery.effectiveMode()).toBe('message');
    const sent = await run('Read this', 'report.txt');
    const receipt = JSON.parse(sent.output as string) as { message_id: string; attachments: Array<{ blob_id: string }> };
    expect(receipt.message_id).toBeTruthy();
    expect(receipt.attachments[0]!.blob_id).toMatch(/^blobref:main:[a-f0-9]{64}$/);
    await writeFile(join(workDir, 'report.txt'), 'changed after sending');
    const download = await klient.rest.sessions.media(created.id, receipt.attachments[0]!.blob_id);
    expect(new TextDecoder().decode(download.bytes)).toBe('original immutable report');
    await expect(run('Escape', join(homeDir, 'outside.txt'))).rejects.toThrow('outside');
    await expect(run('Invalid recipient', undefined, 'someone')).rejects.toThrow('Recipient');
    await expect(run('   ')).rejects.toThrow('blank');
    delivery.endTurn();
    expect(delivery.effectiveMode()).toBe('reply');
    expect(registry.list().map((entry) => entry.name)).not.toContain('SendMessage');
    expect((await run('Not sent')).isError).toBe(true);
  } finally {
    await klient.close();
    await server.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
