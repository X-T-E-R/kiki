import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import {
  ISessionManager, ISessionContext, ensureMainAgent, IThreadCommunicationService, IThreadMailboxStore, IAgentContextMemoryService,
  IAgentLoopService, IAgentPromptService, ISendMessageToThreadTool, IListThreadsTool, IReadThreadTool, IWaitThreadsTool,
  type AgentTool, type ThreadRef, type ReadThreadResult, type SendThreadMessageResult, type WaitThreadsResult,
} from '@kiki/agent-core-v2';
import type { BridgeLink, BridgePolicy } from '@kiki/protocol';
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
    response.end(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: 'Verified bridge reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
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
async function linkFor(f: Awaited<ReturnType<typeof fixture>>, location: 'local' | 'network', wake = true, pendingLimit = 20): Promise<BridgeLink> {
  const aClient = owner(f.a); const bClient = owner(f.b);
  try {
    await bClient.rest!.connections.setInbound(true);
    const policy: BridgePolicy = { source: f.a.admission.identity, target: f.b.admission.identity,
      sourceScope: { workspaceId: f.source.workspaceId, sessionId: f.source.sessionId }, targetScope: { workspaceId: f.target.workspaceId, sessionId: f.target.sessionId },
      operations: wake ? ['read', 'send', 'wait', 'wake'] : ['read', 'send', 'wait'], expiresAt: Date.now() + 3600000,
      pendingLimit, messagesPerMinute: 100, location, label: 'Fixture bridge' };
    if (location === 'local') { const { source: _source, target: _target, location: _location, ...local } = policy; return await aClient.rest!.threadBridges.provisionLocal({ ...local, spaceId: 'h-bridge-fixture' }); }
    const descriptor = await aClient.rest!.threadBridges.registerTarget({ label: policy.label, endpoint: endpoint(f.b), target: policy.target });
    const approved = await bClient.rest!.threadBridges.approve(policy);
    return await aClient.rest!.threadBridges.install({ connectionId: descriptor.id, ...approved });
  } finally { await aClient.close(); await bClient.close(); }
}
const toolRef = (ref: ThreadRef, link: BridgeLink) => ({ host_id: ref.hostId, workspace_id: ref.workspaceId, session_id: ref.sessionId, bridge_id: link.grant.id, connection_id: link.connectionId });

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
    const refs = transcript.items.flatMap((item) => item.kind === 'turn' ? item.contentRefs ?? [] : []);
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
      expect(next.delivery).toBe('delivered');
      await restored.accessor.get(IAgentLoopService).settled(); expect(f.modelRequests()).toBe(2);
      expect((await client.rest!.threadBridges.receipts()).items).toHaveLength(2);
    } finally { await client.close(); }
  }, 60000);
});
