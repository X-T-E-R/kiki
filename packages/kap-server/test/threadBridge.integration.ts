import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import {
  ISessionManager, ISessionContext, ensureMainAgent, IThreadCommunicationService, IThreadMailboxStore, IAgentContextMemoryService,
  IAgentLoopService, IAgentPromptService, ISendMessageToThreadTool, IListThreadsTool, IReadThreadTool, IWaitThreadsTool,
  IThreadCreateTool, ISessionMetadata, IAgentPermissionModeService, ISessionIndex, CREATED_BY_SESSION_ID_KEY, CREATED_BY_AGENT_ID_KEY,
  SEND_PEER_THREAD_MESSAGE as importedPeerSend,
  type AgentTool, type ThreadRef, type ReadThreadResult, type SendThreadMessageResult, type WaitThreadsResult,
} from '@kiki/agent-core-v2';
import type { BridgeLink, BridgePolicy, BridgeReceipt } from '@kiki/protocol';
import { SpaceThreadBridge } from '../src/services/threadBridge/bridge';
import * as privateFiles from '../src/services/auth/privateFiles';
import { agentTranscriptToBlocks } from '../../session-core/src/session/transcript';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const roots: string[] = []; const servers: RunningServer[] = []; const providers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close();
  for (const provider of providers.splice(0)) await new Promise<void>((resolve) => { provider.closeAllConnections(); provider.close(() => resolve()); });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
const endpoint = (server: RunningServer) => `http://127.0.0.1:${server.port}`;
const owner = (server: RunningServer) => createKlient({ endpoint: endpoint(server), token: server.localOwnerToken });
async function call(server: RunningServer, path: string, body?: unknown, token = server.localOwnerToken) {
  const response = await fetch(endpoint(server) + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, envelope: await response.json() as { code: number; msg: string; data: unknown } };
}
async function execute<T>(tool: AgentTool, input: unknown, signal = new AbortController().signal): Promise<T> {
  const execution = await tool.resolveExecution(input);
  if (!('execute' in execution)) throw new Error('tool was rejected');
  const result = await execution.execute({ signal, turnId: 0, toolCallId: 'bridge-fixture' });
  if (typeof result.output !== 'string') throw new Error('expected text tool output');
  return JSON.parse(result.output) as T;
}
async function fixture() {
  const root = await mkdtemp(resolve('../..', '.tmp/thread-bridge-')); roots.push(root);
  const aHome = join(root, 'a'); const bHome = join(root, 'b'); const workspace = join(root, 'workspace');
  await Promise.all([mkdir(aHome), mkdir(bHome), mkdir(workspace)]);
  let modelRequests = 0;
  const provider = createServer((request, response) => {
    modelRequests++; request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: `Verified bridge reply.${' bounded reply content'.repeat(5000)}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  }); providers.push(provider); await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); if (address === null || typeof address === 'string') throw new Error('provider not listening');
  const config = `default_model = "stub"\n[thread_communication]\nenabled = true\n[providers.stub]\ntype = "openai"\nbase_url = "http://127.0.0.1:${address.port}/v1"\napi_key = "fixture"\n[models.stub]\nprovider = "stub"\nmodel = "stub"\nmax_context_size = 100000\n`;
  await Promise.all([writeFile(join(aHome, 'config.toml'), config), writeFile(join(bHome, 'config.toml'), config)]);
  await writeFile(join(bHome, 'home.toml'), `schema = 1\nid = "h-bridge-fixture"\nname = "Target fixture"\nbase = ${JSON.stringify(aHome.replaceAll('\\', '/'))}\n[inherit]\nconfig = false\ncredentials = "isolated"\n`);
  await writeFile(join(aHome, 'homes.json'), JSON.stringify([{ id: 'h-bridge-fixture', name: 'Target fixture', path: bHome }]));
  const boot = async (home: string, port = 0) => { const server = await startServer({ homeDir: home, port, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY }); servers.push(server); return server; };
  const a = await boot(aHome); const b = await boot(bHome);
  const create = async (server: RunningServer): Promise<ThreadRef> => {
    const client = owner(server);
    try {
      const data = await client.global.sessions.create({ sessionId: 'same-session', workDir: workspace, mainAgentBinding: { model: 'stub', profile: 'agent' } });
      const session = server.core.accessor.get(ISessionManager).get(data.id)!;
      const context = session.accessor.get(ISessionContext);
      await server.core.accessor.get(ISessionManager).close(data.id);
      return { hostId: server.admission.identity.hostId, workspaceId: context.workspaceId, sessionId: data.id };
    } finally { await client.close(); }
  };
  const source = await create(a); const target = await create(b);
  const sourceSession = await a.core.accessor.get(ISessionManager).resume(source.sessionId); if (sourceSession === undefined) throw new Error('source missing');
  const main = await ensureMainAgent(sourceSession);
  return { root, aHome, bHome, a, b, source, target, main, boot, modelRequests: () => modelRequests };
}
async function linkFor(f: Awaited<ReturnType<typeof fixture>>, location: 'local' | 'network', wake = true, pendingLimit = 20, overrides?: Partial<BridgePolicy>): Promise<BridgeLink> {
  const aClient = owner(f.a); const bClient = owner(f.b);
  try {
    await bClient.rest!.connections.setInbound(true);
    const policy: BridgePolicy = { source: f.a.admission.identity, target: f.b.admission.identity,
      sourceScope: { workspaceId: f.source.workspaceId, sessionId: f.source.sessionId }, targetScope: { workspaceId: f.target.workspaceId, sessionId: f.target.sessionId },
      operations: wake ? ['read', 'send', 'wait', 'wake'] : ['read', 'send', 'wait'], expiresAt: Date.now() + 3600000,
      pendingLimit, messagesPerMinute: 100, location, label: 'Fixture bridge', ...overrides };
    if (location === 'local') { const { source: _source, target: _target, location: _location, ...local } = policy; return await aClient.rest!.threadBridges.provisionLocal({ ...local, spaceId: 'h-bridge-fixture' }); }
    const descriptor = await aClient.rest!.threadBridges.registerTarget({ label: policy.label, endpoint: endpoint(f.b), target: policy.target });
    const approved = await bClient.rest!.threadBridges.approve(policy);
    return await aClient.rest!.threadBridges.install({ connectionId: descriptor.id, ...approved });
  } finally { await aClient.close(); await bClient.close(); }
}
const toolRef = (ref: ThreadRef, link: BridgeLink) => ({ host_id: ref.hostId, workspace_id: ref.workspaceId, session_id: ref.sessionId, bridge_id: link.grant.id, connection_id: link.connectionId });

it('creates workspace-pinned threads over HTTP and shares the send rate budget', async () => {
  const f = await fixture();
  const workspace = { workspaceId: f.target.workspaceId };
  const operations: BridgePolicy['operations'] = ['read', 'send', 'wait', 'wake', 'create'];
  const link = await linkFor(f, 'network', true, 20, { targetScope: workspace, operations, messagesPerMinute: 3 });
  const sessionOnly = await linkFor(f, 'network', true, 20, { operations });
  const readOnly = await linkFor(f, 'network', true, 20, { targetScope: workspace, operations: ['read'] });
  const create = async (grant: BridgeLink, body: Record<string, unknown>) => {
    const secret = await f.a.remoteConnections.secrets.read<{ credential: string }>({ connectionId: grant.grant.id, purpose: 'bridge' });
    return call(f.b, '/api/thread-bridge/create', { bridgeId: grant.grant.id, revision: grant.grant.revision, source: f.source, idempotencyKey: 'boundary', ...body }, secret.credential);
  };
  for (const [grant, body, msg] of [
    [readOnly, {}, 'bridge_operation_denied'], [sessionOnly, {}, 'bridge_target_scope'],
    [link, { workspaceId: 'other' }, 'bridge_target_scope'], [link, { permissionMode: 'yolo' }, 'bridge_permission_ceiling'],
  ] as const) expect(await create(grant, body)).toMatchObject({ status: 403, envelope: { msg } });
  expect(await create(link, { cwd: '/other' })).toMatchObject({ status: 400, envelope: { msg: 'invalid_bridge_request' } });
  expect(await create(link, { fromSubagent: 'child' })).toMatchObject({ status: 400, envelope: { msg: 'invalid_bridge_request' } });
  const tool = f.main.accessor.get(IThreadCreateTool);
  await expect(execute(tool, { bridge_id: link.grant.id, idempotency_key: 'initial', profile: 'explore' })).rejects.toThrow('not a main-agent profile');

  const input = { bridge_id: link.grant.id, workspace_id: f.target.workspaceId, idempotency_key: 'initial', prompt: 'Initial bridge prompt.\nSecond line.' };
  type Created = { id: string; title: string; profile: string; prompt_started: boolean; thread: ReturnType<typeof toolRef> };
  const [created, replay] = await Promise.all([execute<Created>(tool, input), execute<Created>(tool, input)]);
  expect(replay).toEqual(created);
  expect(created).toMatchObject({ title: 'Initial bridge prompt.', profile: 'agent', prompt_started: true,
    thread: toolRef({ ...f.target, sessionId: created.id }, link) });
  await expect(execute(tool, { ...input, title: 'Changed' })).rejects.toThrow('bridge_idempotency_conflict');
  const createdSession = f.b.core.accessor.get(ISessionManager).get(created.id)!;
  const createdMain = await ensureMainAgent(createdSession);
  expect(createdSession.accessor.get(ISessionContext)).toMatchObject({ cwd: join(f.root, 'workspace'), workspaceId: f.target.workspaceId });
  expect(createdMain.accessor.get(IAgentPermissionModeService).modeCeiling).toBe('auto');
  expect((await createdSession.accessor.get(ISessionMetadata).read()).custom).toMatchObject({
    [CREATED_BY_SESSION_ID_KEY]: `${f.source.hostId}:${f.source.sessionId}`, [CREATED_BY_AGENT_ID_KEY]: 'bridged_peer',
  });
  await createdMain.accessor.get(IAgentLoopService).settled();
  expect(f.modelRequests()).toBe(1);
  const read = await execute<ReadThreadResult>(f.main.accessor.get(IReadThreadTool), { thread: created.thread });
  expect(JSON.stringify(read.view)).toContain('Initial bridge prompt.');
  const empty = await execute<Created>(tool, { bridge_id: link.grant.id, idempotency_key: 'empty', title: 'Empty bridge thread', permission_mode: 'manual' });
  expect(empty).toMatchObject({ title: 'Empty bridge thread', prompt_started: false });
  await f.b.core.accessor.get(ISessionManager).close(empty.id);
  const restored = await f.b.core.accessor.get(ISessionManager).resume(empty.id);
  const restoredMain = await ensureMainAgent(restored!);
  expect(restoredMain.accessor.get(IAgentPermissionModeService).modeCeiling).toBe('auto');
  expect(restoredMain.accessor.get(IAgentPermissionModeService).mode).toBe('manual');
  expect(restoredMain.accessor.get(IAgentPermissionModeService).externalOverride).toBe('manual');
  const saved = JSON.parse(await readFile(join(f.bHome, 'server', 'thread-bridges.json'), 'utf8')) as { inboundCreates: Array<{ result: { ref: ThreadRef } }> };
  expect(saved.inboundCreates.map((entry) => entry.result.ref.sessionId)).toEqual([created.id, empty.id]);
  const wait = f.main.accessor.get(IWaitThreadsTool);
  const baseline = await execute<WaitThreadsResult>(wait, { threads: [{ thread: empty.thread }], timeout_ms: 0 });
  const send = { thread: empty.thread, content: 'Start from the returned reference.', idempotency_key: 'followup' };
  await vi.waitFor(async () => expect(await execute(f.main.accessor.get(ISendMessageToThreadTool), send)).toMatchObject({ delivery: 'delivered' }), { timeout: 15000, interval: 100 });
  const activity = await execute<WaitThreadsResult>(wait, { threads: [{ thread: empty.thread, cursor: baseline.threads[0]!.cursor }], timeout_ms: 10000 });
  expect(activity.threads[0]!.activities.some((entry) => entry.kind === 'terminal')).toBe(true);
  await expect(execute(tool, { bridge_id: link.grant.id, idempotency_key: 'over-limit' })).rejects.toThrow('bridge_rate_limit');
  expect(await execute(tool, input)).toEqual(created);
  expect(await f.b.core.accessor.get(ISessionIndex).get(created.id)).toMatchObject(workspace);
}, 60000);

it('reuses the reserved session and prompt after a lost create acknowledgement and server reload', async () => {
  const f = await fixture();
  const link = await linkFor(f, 'network', true, 20, { targetScope: { workspaceId: f.target.workspaceId }, operations: ['read', 'send', 'wait', 'create'] });
  const manager = f.b.core.accessor.get(ISessionManager);
  const create = manager.create.bind(manager);
  let createdId: string | undefined;
  const creating = vi.spyOn(manager, 'create').mockImplementationOnce(async (input) => {
    const handle = await create(input);
    createdId = handle.id;
    const main = await ensureMainAgent(handle);
    const prompts = main.accessor.get(IAgentPromptService);
    const enqueue = prompts.enqueue.bind(prompts);
    vi.spyOn(prompts, 'enqueue').mockImplementationOnce(async (prompt) => {
      await enqueue(prompt);
      throw new Error('lost create acknowledgement');
    });
    return handle;
  });
  const threads = f.a.core.accessor.get(IThreadCommunicationService);
  const input = { caller: f.source, bridgeId: link.grant.id, idempotencyKey: 'lost-create-ack', prompt: 'Exactly one initial task.' };
  try {
    await expect(threads.createThread(input)).rejects.toThrow('lost create acknowledgement');
    expect(manager.get(createdId!)).toBeDefined();
    await expect(threads.createThread({ ...input, title: 'Changed payload' })).rejects.toThrow('bridge_idempotency_conflict');
    const recovered = await threads.createThread(input);
    expect(recovered.ref.sessionId).toBe(createdId);
    expect(creating).toHaveBeenCalledTimes(1);
    const main = await ensureMainAgent(manager.get(createdId!)!);
    await main.accessor.get(IAgentLoopService).settled();
    expect(f.modelRequests()).toBe(1);
    await f.b.close(); servers.splice(servers.indexOf(f.b), 1);
    await f.boot(f.bHome, f.b.port);
    expect(await threads.createThread(input)).toEqual(recovered);
    expect(f.modelRequests()).toBe(1);
  } finally { creating.mockRestore(); }
}, 60000);

describe.each(['tls', 'peer_socket'] as const)('paired cross-space create (%s)', (transport) => {
  it('creates with and without a prompt and immediately reads, sends and waits using its reference', async () => {
    const f = await fixture();
    const aClient = owner(f.a); const bClient = owner(f.b);
    try {
      const issued = await bClient.rest!.connections.createPairCode({ bridgeOperations: ['read', 'send', 'wait', 'wake', 'create'] });
      const record = await aClient.rest!.connections.pair({ endpoint: issued.suggestedEndpoints[0]!, code: issued.code, fingerprint: issued.tlsFingerprint, backgroundSummary: false });
      expect(record.pinnedFingerprint).toBe(issued.tlsFingerprint);
      let source = f.a; let destination = f.b; let caller = f.source;
      let link = (await aClient.rest!.threadBridges.status()).outbound.find((entry) => entry.connectionId === record.id)!;
      if (transport === 'peer_socket') {
        source = f.b; destination = f.a; caller = f.target;
        await aClient.rest!.connections.setInbound(true);
        const approved = await aClient.rest!.threadBridges.approve({ source: f.b.admission.identity, target: f.a.admission.identity,
          sourceScope: { workspaceId: f.target.workspaceId }, targetScope: { workspaceId: f.source.workspaceId },
          operations: ['read', 'send', 'wait', 'wake', 'create'], expiresAt: Date.now() + 3600000,
          pendingLimit: 20, messagesPerMinute: 60, location: 'network', label: 'Explicit reverse create' });
        const secret = await f.a.remoteConnections.secrets.read<{ grant: string }>({ connectionId: record.credentialRef, purpose: 'gui' });
        const installed = await call(f.b, '/api/thread-bridges/peer/outbound', approved, secret.grant);
        expect(installed.status).toBe(200);
        link = installed.envelope.data as BridgeLink;
        expect(source.remoteConnections.get(link.connectionId).transport?.kind).toBe('peer_socket');
      }
      const threads = source.core.accessor.get(IThreadCommunicationService);
      await vi.waitFor(async () => expect((await threads.listThreads({ caller, bridgeId: link.grant.id })).threads).not.toHaveLength(0), { timeout: 15000, interval: 100 });
      const input = { caller, bridgeId: link.grant.id, idempotencyKey: 'paired-initial', prompt: `Start here.\n${'文'.repeat(99980)}` };
      const created = await threads.createThread(input);
      expect(created).toMatchObject({ title: 'Start here.', promptStarted: true, ref: { hostId: destination.admission.identity.hostId, bridgeId: link.grant.id, connectionId: link.connectionId } });
      expect(await threads.createThread(input)).toEqual(created);
      await expect(threads.createThread({ ...input, prompt: 'Changed' })).rejects.toThrow('bridge_idempotency_conflict');
      await expect(threads.createThread({ ...input, idempotencyKey: 'yolo', permissionMode: 'yolo' })).rejects.toThrow('bridge_permission_ceiling');
      const createdSession = destination.core.accessor.get(ISessionManager).get(created.ref.sessionId)!;
      const main = await ensureMainAgent(createdSession);
      await main.accessor.get(IAgentLoopService).settled();
      expect(main.accessor.get(IAgentPermissionModeService).mode).toBe('auto');
      expect(main.accessor.get(IAgentPermissionModeService).modeCeiling).toBe('auto');
      expect(JSON.stringify((await threads.readThread({ caller, thread: created.ref })).view)).toContain('Start here.');
      const empty = await threads.createThread({ caller, connectionId: link.connectionId, idempotencyKey: 'paired-empty', title: 'No initial prompt' });
      expect(empty.promptStarted).toBe(false);
      const baseline = await threads.waitThreads({ caller, threads: [{ thread: empty.ref }], timeoutMs: 0 });
      const peerSend = threads as IThreadCommunicationService & import('@kiki/agent-core-v2').IThreadPeerSendCapability;
      const sendInput = { source: caller, target: empty.ref, content: 'Follow up on the created thread.', idempotencyKey: 'paired-followup' };
      await vi.waitFor(async () => expect(await peerSend[importedPeerSend](sendInput)).toMatchObject({ delivery: 'delivered' }), { timeout: 15000, interval: 100 });
      const waited = await threads.waitThreads({ caller, threads: [{ thread: empty.ref, cursor: baseline.threads[0]!.cursor }], timeoutMs: 10000 });
      expect(waited.threads[0]!.activities.some((entry) => entry.kind === 'terminal')).toBe(true);
    } finally { await aClient.close(); await bClient.close(); }
  }, 90000);
});

describe.each(['local', 'network'] as const)('directed space thread bridge (%s, real KAP)', (location) => {
  it('runs real thread tools through persistent outbox, independent target auth, cold mailbox/prompt and bounded reply reads', async () => {
    const f = await fixture(); const link = await linkFor(f, location);
    expect(f.a.admission.status().enabled).toBe(false);
    expect(f.source.sessionId).toBe(f.target.sessionId); expect(f.source.hostId).not.toBe(f.target.hostId);
    const list = await execute<{ threads: { ref: ThreadRef }[] }>(f.main.accessor.get(IListThreadsTool), { bridge_id: link.grant.id });
    expect(list.threads.map((entry) => entry.ref.sessionId)).toEqual([f.target.sessionId]);
    const baseline = await execute<WaitThreadsResult>(f.main.accessor.get(IWaitThreadsTool), { threads: [{ thread: toolRef(f.target, link) }], timeout_ms: 0 });
    const input = { thread: toolRef(f.target, link), content: 'Answer this explicit message.', idempotency_key: 'message-key' };
    let receipt = await execute<SendThreadMessageResult>(f.main.accessor.get(ISendMessageToThreadTool), input);
    expect(['pending', 'delivered']).toContain(receipt.delivery); expect(receipt.targetSeq).toBeGreaterThan(0);
    await vi.waitFor(async () => { receipt = await execute<SendThreadMessageResult>(f.main.accessor.get(ISendMessageToThreadTool), input); expect(receipt.delivery).toBe('delivered'); }, { timeout: 15000, interval: 100 });
    const session = f.b.core.accessor.get(ISessionManager).get(f.target.sessionId); expect(session).toBeDefined();
    const main = await ensureMainAgent(session!); await main.accessor.get(IAgentLoopService).settled();
    const liveList = await execute<{ threads: { state: string }[] }>(f.main.accessor.get(IListThreadsTool), { bridge_id: link.grant.id });
    expect(liveList.threads[0]?.state).toBe('idle');
    const duplicate = await execute<SendThreadMessageResult>(f.main.accessor.get(ISendMessageToThreadTool), input);
    expect(duplicate.messageId).toBe(receipt.messageId); expect(duplicate.deduplicated).toBe(true);
    await expect(execute(f.main.accessor.get(ISendMessageToThreadTool), { ...input, content: 'Different body.' })).rejects.toThrow('bridge_idempotency_conflict');
    const activity = await execute<WaitThreadsResult>(f.main.accessor.get(IWaitThreadsTool), { threads: [{ thread: input.thread, cursor: baseline.threads[0]!.cursor }], timeout_ms: 0 });
    expect(activity.threads[0]!.activities.some((entry) => entry.kind === 'terminal')).toBe(true);
    const read = await execute<ReadThreadResult>(f.main.accessor.get(IReadThreadTool), { thread: input.thread });
    const transcript = read.view!.transcript!;
    const refs = transcript.items.flatMap((item) => item.kind === 'turn'
      ? [...(item.contentRefs ?? []), ...item.steps.flatMap((step) => step.frames.flatMap((frame) => frame.contentRefs ?? []))] : []);
    const contents = await Promise.all(refs.map((ref) => execute<ReadThreadResult>(f.main.accessor.get(IReadThreadTool), { thread: input.thread, content_ref: ref })));
    expect(JSON.stringify([transcript, ...contents.map((result) => result.view?.segment)])).toContain('Verified bridge reply.');
    const blocks = agentTranscriptToBlocks(transcript);
    const verified = blocks.filter((block) => block.kind === 'user' && block.bridgedPeer !== undefined);
    expect(verified).toHaveLength(1); expect(verified[0]).toMatchObject({ bridgedPeer: { source: f.source, sourceHomeId: f.a.admission.identity.homeId, location, bridgeId: link.grant.id } });
    expect(main.accessor.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'bridged_peer')).toHaveLength(1);
    const aClient = owner(f.a); try { const receipts = await aClient.rest!.threadBridges.receipts(); expect(receipts.items[0]).toMatchObject({ messageId: receipt.messageId, targetSeq: receipt.targetSeq, delivery: 'delivered' }); } finally { await aClient.close(); }
    const disk = await readFile(join(f.aHome, 'server', 'thread-bridges.json'), 'utf8'); expect(disk).toContain(receipt.messageId); expect(disk).not.toContain('Answer this explicit message.'); expect(disk).not.toContain('credential');
    await expect(execute(main.accessor.get(ISendMessageToThreadTool), { thread: { host_id: f.source.hostId, workspace_id: f.source.workspaceId, session_id: f.source.sessionId }, content: 'Unapproved reverse', idempotency_key: 'reverse' })).rejects.toThrow('bridge_not_authorized');
    for (const token of [f.b.localOwnerToken, f.b.authTokenService.getToken()]) expect((await call(f.b, '/api/thread-bridge/list', { bridgeId: link.grant.id, revision: 1, source: f.source }, token)).status).toBeGreaterThanOrEqual(400);
    const secret = await f.a.remoteConnections.secrets.read<{ credential: string }>({ connectionId: link.grant.id, purpose: 'bridge' });
    expect(refs.length).toBeGreaterThan(0);
    const stale = await call(f.b, '/api/thread-bridge/read', { bridgeId: link.grant.id, revision: 1, source: f.source, target: f.target, contentRef: { ...refs[0]!, revision: 'stale-fixture' } }, secret.credential);
    expect(stale).toMatchObject({ status: 409, envelope: { code: 40922, msg: 'Content changed; reload its preview before continuing.' } });
    expect((await call(f.b, '/api/thread-bridge/list', { bridgeId: link.grant.id, revision: 1, source: { ...f.source, workspaceId: 'forged' } }, secret.credential)).status).toBe(403);
    expect((await call(f.b, '/api/thread-bridge/read', { bridgeId: link.grant.id, revision: 1, source: f.source, target: { ...f.target, hostId: f.source.hostId } }, secret.credential)).status).toBe(403);
  }, 60000);
  it('keeps send-only cold pending, survives restart, and rejects pending after revocation without starting a turn', async () => {
    const f = await fixture(); const link = await linkFor(f, location, false, 1);
    const input = { thread: toolRef(f.target, link), content: 'No wake authority.', idempotency_key: 'cold-key' };
    const receipt = await execute<SendThreadMessageResult>(f.main.accessor.get(ISendMessageToThreadTool), input);
    expect(receipt.delivery).toBe('pending'); expect(f.b.core.accessor.get(ISessionManager).get(f.target.sessionId)).toBeUndefined();
    await expect(execute(f.main.accessor.get(ISendMessageToThreadTool), { ...input, idempotency_key: 'queue-overflow' })).rejects.toThrow('bridge_queue_full');
    const cancel = new AbortController(); const cancellation = new Error('fixture wait cancelled');
    const waiting = execute(f.main.accessor.get(IWaitThreadsTool), { threads: [{ thread: input.thread }], timeout_ms: 60000 }, cancel.signal);
    const timer = setTimeout(() => cancel.abort(cancellation), 100);
    try { await expect(waiting).rejects.toThrow(cancellation.message); } finally { clearTimeout(timer); }
    expect(f.a.remoteConnections.activeCount()).toBe(0);
    await f.b.close(); servers.splice(servers.indexOf(f.b), 1); const restarted = await f.boot(f.bHome, location === 'network' ? f.b.port : 0);
    expect(restarted.admission.identity).toEqual(f.b.admission.identity);
    if (location === 'local') expect(restarted.port).not.toBe(f.b.port);
    const list = await execute<{ threads: { ref: ThreadRef }[] }>(f.main.accessor.get(IListThreadsTool), { bridge_id: link.grant.id });
    expect(list.threads[0]?.ref.sessionId).toBe(f.target.sessionId);
    const bClient = owner(restarted); try { await bClient.rest!.threadBridges.revoke('inbound', link.grant.id); } finally { await bClient.close(); }
    const page = await restarted.core.accessor.get(IThreadMailboxStore).readMessages({ group: `session:${f.target.sessionId}`, limit: 10 });
    expect(page.items[0]?.delivery).toBe('undeliverable'); expect(restarted.core.accessor.get(ISessionManager).get(f.target.sessionId)).toBeUndefined();
    expect(restarted.core.accessor.get(IThreadCommunicationService).hostId).toBe(f.target.hostId);
    expect(f.modelRequests()).toBe(0);
  }, 60000);
  it('finishes revocation on the latest grant revision while an older recheck is in flight', async () => {
    const f = await fixture(); const link = await linkFor(f, location, false, 1);
    const receipt = await execute<SendThreadMessageResult>(f.main.accessor.get(ISendMessageToThreadTool), {
      thread: toolRef(f.target, link), content: 'Stay cold across revocation.', idempotency_key: 'revoke-in-flight',
    });
    expect(receipt.delivery).toBe('pending');
    let validationEntered!: () => void; let releaseValidation!: () => void; let revocationPersisted!: () => void;
    const entered = new Promise<void>((resolve) => { validationEntered = resolve; });
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const persisted = new Promise<void>((resolve) => { revocationPersisted = resolve; });
    let targetStatus: SpaceThreadBridge['status'] | undefined; let hold = true;
    const beforeDelivery = SpaceThreadBridge.prototype.beforeDelivery;
    const validation = vi.spyOn(SpaceThreadBridge.prototype, 'beforeDelivery').mockImplementation(async function (this: SpaceThreadBridge, message) {
      const result = await beforeDelivery.call(this, message);
      if (hold && message.producer.kind === 'bridged_peer' && message.producer.bridgeId === link.grant.id) {
        hold = false; targetStatus = this.status.bind(this);
        expect(result).toBe('pending'); validationEntered(); await validationGate;
      }
      return result;
    });
    const writePrivateFile = privateFiles.writePrivateFile;
    const writing = vi.spyOn(privateFiles, 'writePrivateFile').mockImplementation(async (path, data) => {
      await writePrivateFile(path, data);
      if (path === join(f.bHome, 'server', 'thread-bridges.json') && targetStatus?.().inbound.some((grant) => grant.id === link.grant.id && grant.revoked)) revocationPersisted();
    });
    const client = owner(f.b); let revoking: Promise<void> | undefined;
    try {
      await entered;
      let completed = false;
      revoking = client.rest!.threadBridges.revoke('inbound', link.grant.id).then(() => { completed = true; });
      await persisted;
      expect(targetStatus!().inbound.find((grant) => grant.id === link.grant.id)).toMatchObject({ revoked: true, enabled: false, revision: link.grant.revision + 1 });
      expect(completed).toBe(false);
      releaseValidation(); await revoking;
      const page = await f.b.core.accessor.get(IThreadMailboxStore).readMessages({ group: `session:${f.target.sessionId}`, limit: 10 });
      expect(page.items[0]).toMatchObject({ delivery: 'undeliverable', message: { messageId: receipt.messageId } });
      expect(f.b.core.accessor.get(ISessionManager).get(f.target.sessionId)).toBeUndefined();
      expect(f.modelRequests()).toBe(0);
    } finally {
      releaseValidation();
      try { await revoking; }
      finally { validation.mockRestore(); writing.mockRestore(); await client.close(); }
    }
  }, 60000);
  it('recovers source outbox and an enqueued target prompt after a lost mailbox ACK without a second model turn', async () => {
    const f = await fixture(); const link = await linkFor(f, location, true, 1);
    const mailbox = f.b.core.accessor.get(IThreadMailboxStore);
    const ack = vi.spyOn(mailbox, 'acknowledgeDelivery').mockRejectedValue(new Error('fixture lost mailbox ACK'));
    const input = { thread: toolRef(f.target, link), content: 'Deliver once despite lost ACK.', idempotency_key: 'ack-key' };
    let accepted: Awaited<ReturnType<IThreadMailboxStore['readMessages']>>['items'][number];
    try {
      const pending = await execute<SendThreadMessageResult>(f.main.accessor.get(ISendMessageToThreadTool), input);
      expect(pending.delivery).toBe('pending');
      const targetMain = await ensureMainAgent(f.b.core.accessor.get(ISessionManager).get(f.target.sessionId)!);
      await targetMain.accessor.get(IAgentLoopService).settled(); expect(f.modelRequests()).toBe(1);
      await vi.waitFor(() => expect(ack).toHaveBeenCalled());
      accepted = (await mailbox.readMessages({ group: `session:${f.target.sessionId}`, limit: 10 })).items[0]!;
      expect(accepted.delivery).toBe('pending');
      await f.b.close(); servers.splice(servers.indexOf(f.b), 1);
    } finally { ack.mockRestore(); }
    await f.a.close(); servers.splice(servers.indexOf(f.a), 1);
    const b = await f.boot(f.bHome, location === 'network' ? f.b.port : 0); const a = await f.boot(f.aHome);
    const client = owner(a);
    try {
      await vi.waitFor(async () => { const page = await client.rest!.threadBridges.receipts(); expect(page.items[0]).toMatchObject({ delivery: 'delivered', messageId: accepted.message.messageId }); }, { timeout: 15000, interval: 100 });
      const source = await a.core.accessor.get(ISessionManager).resume(f.source.sessionId); const main = await ensureMainAgent(source!);
      const duplicate = await execute<SendThreadMessageResult>(main.accessor.get(ISendMessageToThreadTool), input);
      expect(duplicate).toMatchObject({ deduplicated: true, delivery: 'delivered', messageId: accepted.message.messageId });
      const session = await b.core.accessor.get(ISessionManager).resume(f.target.sessionId); const restored = await ensureMainAgent(session!);
      expect(restored.accessor.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'bridged_peer')).toHaveLength(1);
      expect(f.modelRequests()).toBe(1);
      const next = await execute<SendThreadMessageResult>(main.accessor.get(ISendMessageToThreadTool), { ...input, content: 'Next independent message.', idempotency_key: 'next-key' });
      expect(['pending', 'delivered']).toContain(next.delivery);
      let nextReceipt: BridgeReceipt | undefined;
      await vi.waitFor(async () => {
        const page = await client.rest!.threadBridges.receipts();
        nextReceipt = page.items.find((entry) => entry.id === next.messageId || entry.messageId === next.messageId);
        expect(nextReceipt).toMatchObject({ delivery: 'delivered' });
      }, { timeout: 15000, interval: 100 });
      expect(nextReceipt!.messageId).not.toBe(accepted.message.messageId);
      expect(nextReceipt!.targetSeq).toBeGreaterThan(accepted.message.targetSeq);
      await restored.accessor.get(IAgentLoopService).settled(); expect(f.modelRequests()).toBe(2);
      expect((await client.rest!.threadBridges.receipts()).items).toHaveLength(2);
    } finally { await client.close(); }
  }, 60000);
});
