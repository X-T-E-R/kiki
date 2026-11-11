import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import {
  IAgentLoopService,
  IAgentProfileRegistry,
  IAgentPromptService,
  IAgentScopeContext,
  IAgentStateService,
  ISessionContext,
  ISessionManager,
  ensureMainAgent,
  normalizeAgentProfile,
} from '@kiki/agent-core-v2';
import { ExecutorSessionUpdated } from '@kiki/agent-core-v2/agent/execution/externalExecutorOps';
import { ContextAppendMessage } from '@kiki/agent-core-v2/agent/contextMemory/contextEvents';
import { turnKey } from '@kiki/agent-core-v2/agent/loop/turnOps';
import { SESSION_MEDIA_DIR } from '@kiki/agent-core-v2/agent/media/mediaRef';
import { PermissionRecordApprovalResult, permissionRulesKey } from '@kiki/agent-core-v2/agent/permissionRules/permissionRulesOps';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { autonomousReceiptsKey } from '@kiki/agent-core-v2/session/subagent/autonomousReceiptOps';
import { ToolsUpdateStore, todoKey } from '@kiki/agent-core-v2/session/todo/todoOps';
import { ISessionMetadata } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '@kiki/agent-core-v2/state/eventDispatcher';
import { IAppendLogStore } from '@kiki/agent-core-v2/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import type { WireRecord } from '@kiki/agent-core-v2/wire/record';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

it('promotes an ephemeral running subagent through the real route without copying its runtime ownership', async () => {
  const home = await mkdtemp(join(tmpdir(), 'promote-agent-route-'));
  const sourceWorkDir = join(home, 'source');
  const independentWorkDir = join(home, 'independent');
  await Promise.all([mkdir(sourceWorkDir), mkdir(independentWorkDir)]);
  const requests: Record<string, unknown>[] = [];
  let pending: ServerResponse | undefined;
  let requestObserved!: () => void;
  const requestReceived = new Promise<void>((resolve) => { requestObserved = resolve; });
  const finishResponse = (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: 'Source reply.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  };
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      pending = response;
      requestObserved();
    })();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture provider address');
  await writeFile(join(home, 'config.toml'), `default_model = "fixture"\n[search]\nenabled = false\n[providers.fixture]\ntype = "openai"\nbase_url = "http://127.0.0.1:${address.port}/v1"\napi_key = "fixture"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 100000\ncapabilities = ["thinking"]\nsupport_efforts = ["low", "medium", "high"]\ndefault_effort = "medium"\n`);
  const server = await startServer({ homeDir: home, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
  const client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
  const registration = server.core.accessor.get(IAgentProfileRegistry).register({
    sourceId: 'promote-agent-fixture', priority: 40,
    contribution: { profiles: [normalizeAgentProfile({
      name: 'researcher', main: false, definitionId: 'fixture:researcher', description: 'Fixture researcher',
      modelAlias: 'fixture', thinkingEffort: 'low', systemPrompt: () => 'Research the assigned question.',
    })] },
  });
  try {
    const manager = server.core.accessor.get(ISessionManager);
    const source = await manager.create({ workDir: sourceWorkDir, ephemeral: true, mainAgentBinding: { profile: 'agent', model: 'fixture', thinking: 'low' } });
    const sourceContext = source.accessor.get(ISessionContext);
    const child = await source.accessor.get(IAgentLifecycleService).create({
      agentId: 'agent-research',
      delegator: { kind: 'agent', agentId: 'main' },
      userLabel: 'Researcher',
      workspaceRoots: { workDir: independentWorkDir, additionalDirs: [sourceWorkDir] },
      binding: { profile: 'researcher', model: 'fixture', thinking: 'low' },
    });
    const childContext = child.accessor.get(IAgentScopeContext);
    const dispatcher = child.accessor.get(IEventDispatcher);
    const storage = server.core.accessor.get(IFileSystemStorageService);
    const ownHash = 'a'.repeat(64);
    const sharedHash = 'b'.repeat(64);
    const taskId = 'bash-visual-12345678';
    await Promise.all([
      storage.write(childContext.scope('blobs'), ownHash, new Uint8Array([1, 2, 3]), { atomic: true }),
      storage.write(sourceContext.scope('agents/main/blobs'), sharedHash, new Uint8Array([4, 5, 6]), { atomic: true }),
      storage.write(childContext.scope('tool-results'), 'result.txt', new TextEncoder().encode('saved tool output'), { atomic: true }),
      storage.write(childContext.scope(`tasks/${taskId}`), 'output.log', new TextEncoder().encode('full bash output'), { atomic: true }),
      storage.write(childContext.scope(`tasks/${taskId}`), `${taskId}.json`, new TextEncoder().encode('{"status":"completed"}'), { atomic: true }),
      storage.write(sourceContext.scope(SESSION_MEDIA_DIR), 'f_visual1.png', new Uint8Array([7, 8, 9]), { atomic: true }),
      storage.write(sourceContext.scope(SESSION_MEDIA_DIR), 'meta/f_visual1.json', new TextEncoder().encode(JSON.stringify({ name: 'evidence.png', mime: 'image/png' })), { atomic: true }),
    ]);
    await dispatcher.dispatch(new ExecutorSessionUpdated({
      executorId: 'fixture-acp', descriptorRevision: 'rev-1', sessionEpoch: 1,
      sessionRef: { executorId: 'fixture-acp', version: 1, ref: { sessionId: 'remote-source' } },
    }));
    await dispatcher.dispatch(new PermissionRecordApprovalResult({
      turnId: 0, toolCallId: 'source-approval', toolName: 'Write', action: 'write file',
      sessionApprovalRule: 'Write', result: { decision: 'approved', scope: 'session' },
    }));
    await dispatcher.dispatch(new ToolsUpdateStore({ key: 'todo', value: [{ title: 'Verify promotion', status: 'in_progress' }] }));
    await dispatcher.dispatch(new ToolsUpdateStore({ key: 'todo_notes', value: { notes: { decided: 'Keep the source session intact.' } } }));
    const childMeta = (await source.accessor.get(ISessionMetadata).read()).agents?.['agent-research'];
    if (childMeta?.homedir === undefined) throw new Error('Missing source agent home');
    const resultPath = join(childMeta.homedir, 'tool-results', 'result.txt');
    const taskOutputPath = join(childMeta.homedir, 'tasks', taskId, 'output.log');
    const mediaPath = join(sourceContext.sessionDir, SESSION_MEDIA_DIR, 'f_visual1.png');
    const submitted = await child.accessor.get(IAgentPromptService).enqueue({
      id: 'source-running-prompt',
      message: {
        role: 'user', id: 'source-running-prompt', origin: { kind: 'user' }, toolCalls: [],
        content: [{ type: 'text', text: `Inspect blobref:agent-research:${ownHash} and blobref:main:${sharedHash}; attach f_visual1, ${mediaPath}, ${resultPath} and ${taskOutputPath}` }],
      },
    });
    await submitted.launched;
    await requestReceived;
    expect(child.accessor.get(IAgentLoopService).status().state).toBe('running');
    await dispatcher.flush();
    const logs = server.core.accessor.get(IAppendLogStore);
    const readRecords = async (scope: string) => {
      const records: WireRecord[] = [];
      for await (const record of logs.read<WireRecord>(scope, 'wire.jsonl')) records.push(record);
      return records;
    };
    const sourceBefore = await readRecords(childContext.scope());
    const promoted = await client.session(source.id).commands.promoteAgent('agent-research', { title: 'Independent research' });
    expect(promoted).toMatchObject({
      title: 'Independent research',
      promoted_from: { session_id: source.id, agent_id: 'agent-research', agent_name: 'Researcher', profile: 'researcher' },
    });
    expect(child.accessor.get(IAgentLoopService).status().state).toBe('running');
    expect(source.accessor.get(IAgentLifecycleService).get('agent-research')).toBe(child);
    expect(requests).toHaveLength(1);
    const target = manager.get(promoted.id);
    if (target === undefined) throw new Error('Promoted session is not live');
    const targetContext = target.accessor.get(ISessionContext);
    expect(targetContext.cwd).toBe(independentWorkDir);
    expect(targetContext.workspaceId).not.toBe(sourceContext.workspaceId);
    const targetMain = await ensureMainAgent(target);
    expect(targetMain.accessor.get(IAgentScopeContext).parentAgentId).toBeUndefined();
    expect(targetMain.accessor.get(IAgentStateService).has(autonomousReceiptsKey)).toBe(false);
    expect(targetMain.accessor.get(IAgentLoopService).status().state).toBe('idle');
    expect(targetMain.accessor.get(IAgentStateService).get(turnKey).lastEnded).toMatchObject({ turnId: 0, reason: 'cancelled' });
    expect(targetMain.accessor.get(IAgentStateService).get(todoKey)).toMatchObject({
      items: [{ title: 'Verify promotion', status: 'in_progress' }],
      notes: { decided: 'Keep the source session intact.' },
    });
    expect(targetMain.accessor.get(IAgentStateService).get(permissionRulesKey).sessionApprovalRulePatterns).toEqual([]);
    const targetMeta = await target.accessor.get(ISessionMetadata).read();
    expect(targetMeta.agents?.['main']).toMatchObject({ type: 'main', parentAgentId: undefined, delegator: undefined });
    expect(targetMeta.promotedFrom).toMatchObject({ sessionId: source.id, agentId: 'agent-research', agentName: 'Researcher' });
    const targetRecords = await readRecords(targetContext.scope('agents/main'));
    const targetText = JSON.stringify(targetRecords).replaceAll('\\\\', '/');
    expect(targetRecords.some((record) => record.type === 'executor.session.updated')).toBe(false);
    expect(targetRecords.some((record) => record.type === 'permission.record_approval_result')).toBe(false);
    expect(targetRecords.some((record) => record.type.startsWith('prompt.'))).toBe(false);
    expect(targetRecords.some((record) => record.type === 'context.append_loop_event')).toBe(false);
    expect(targetRecords).toContainEqual(expect.objectContaining({ type: 'turn.ended', turnId: 0, reason: 'cancelled' }));
    expect(sourceContext.ephemeral).toBe(true);
    expect(targetText).toContain('source-running-prompt');
    expect(targetText).toContain(`blobref:main:${ownHash}`);
    expect(targetText).toContain(`blobref:main:${sharedHash}`);
    expect(targetText).not.toContain('blobref:agent-research');
    expect(targetText).not.toContain('remote-source');
    expect(targetText).toContain('agents/main/tool-results/result.txt');
    expect(targetText).toContain(`agents/main/tasks/${taskId}/output.log`);
    expect(targetText).not.toContain('agents/agent-research/tool-results');
    expect(targetText).toContain(join(targetContext.sessionDir, SESSION_MEDIA_DIR, 'f_visual1.png').replaceAll('\\', '/'));
    expect(targetText).not.toContain(mediaPath.replaceAll('\\', '/'));
    expect(await storage.read(targetContext.scope('agents/main/blobs'), ownHash)).toEqual(Buffer.from([1, 2, 3]));
    expect(await storage.read(targetContext.scope('agents/main/blobs'), sharedHash)).toEqual(Buffer.from([4, 5, 6]));
    expect(await storage.read(targetContext.scope('agents/main/tool-results'), 'result.txt')).toEqual(Buffer.from('saved tool output'));
    expect(await storage.read(targetContext.scope(`agents/main/tasks/${taskId}`), 'output.log')).toEqual(Buffer.from('full bash output'));
    expect(await storage.read(targetContext.scope(`agents/main/tasks/${taskId}`), `${taskId}.json`)).toBeUndefined();
    expect(await storage.read(childContext.scope(`tasks/${taskId}`), `${taskId}.json`)).toBeDefined();
    expect(await storage.read(targetContext.scope(SESSION_MEDIA_DIR), 'f_visual1.png')).toEqual(Buffer.from([7, 8, 9]));
    expect(await storage.read(targetContext.scope(SESSION_MEDIA_DIR), 'meta/f_visual1.json')).toBeDefined();
    await expect(client.session(source.id).commands.promoteAgent('missing-agent')).rejects.toMatchObject({ code: 40401 });
    await expect(client.session(source.id).commands.promoteAgent('main')).rejects.toMatchObject({ code: 40001 });
    await expect(client.session('session_missing').commands.promoteAgent('agent-research')).rejects.toMatchObject({ code: 40401 });
    expect(requests).toHaveLength(1);
    await manager.close(promoted.id);
    const coldSnapshot = await client.session(promoted.id).view.snapshot();
    expect(coldSnapshot.session.promoted_from).toMatchObject({ session_id: source.id, agent_id: 'agent-research', agent_name: 'Researcher' });
    expect(manager.get(promoted.id)).toBeUndefined();
    const resumed = await manager.resume(promoted.id);
    if (resumed === undefined) throw new Error('Promoted session did not resume');
    const coldMain = await ensureMainAgent(resumed);
    expect(coldMain.accessor.get(IAgentLoopService).status().state).toBe('idle');
    expect(coldMain.accessor.get(IAgentStateService).get(turnKey).lastEnded).toMatchObject({ turnId: 0, reason: 'cancelled' });
    expect(requests).toHaveLength(1);
    if (pending === undefined) throw new Error('Source provider request is missing');
    finishResponse(pending);
    pending = undefined;
    await expect(submitted.completion).resolves.toMatchObject({ state: 'completed' });
    await child.accessor.get(IAgentLoopService).settled();
    const sourceAfter = await readRecords(childContext.scope());
    expect(sourceAfter.slice(0, sourceBefore.length)).toEqual(sourceBefore);
    expect(sourceAfter).toContainEqual(expect.objectContaining({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
    await vi.waitFor(async () => {
      expect((await source.accessor.get(ISessionMetadata).read()).agents?.['agent-research']).toMatchObject({
        status: 'completed', resultSummary: 'Source reply.', delegator: { kind: 'agent', agentId: 'main' },
      });
    });
    expect(manager.get(promoted.id)).toBeDefined();
    expect(requests).toHaveLength(1);
  } finally {
    if (pending !== undefined && !pending.writableEnded) finishResponse(pending);
    await registration.dispose();
    await client.close();
    await server.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 60_000);

it('rewrites media paths recorded before an ephemeral source was saved and moved', async () => {
  const home = await mkdtemp(join(tmpdir(), 'promote-agent-saved-'));
  const workDir = join(home, 'source');
  await mkdir(workDir);
  await writeFile(join(home, 'config.toml'), `default_model = "fixture"\n[search]\nenabled = false\n[providers.fixture]\ntype = "openai"\nbase_url = "http://127.0.0.1:1/v1"\napi_key = "fixture"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 100000\ncapabilities = ["thinking"]\nsupport_efforts = ["low", "medium", "high"]\ndefault_effort = "medium"\n`);
  const server = await startServer({ homeDir: home, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
  const client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
  try {
    const manager = server.core.accessor.get(ISessionManager);
    const source = await manager.create({ workDir, ephemeral: true });
    const sourceContext = source.accessor.get(ISessionContext);
    const child = await source.accessor.get(IAgentLifecycleService).create({
      agentId: 'agent-research', delegator: { kind: 'agent', agentId: 'main' }, userLabel: 'Researcher',
    });
    const storage = server.core.accessor.get(IFileSystemStorageService);
    const mediaPath = join(sourceContext.sessionDir, SESSION_MEDIA_DIR, 'f_saved1.pdf');
    await Promise.all([
      storage.write(sourceContext.scope(SESSION_MEDIA_DIR), 'f_saved1.pdf', new Uint8Array([7, 8, 9]), { atomic: true }),
      storage.write(sourceContext.scope(SESSION_MEDIA_DIR), 'meta/f_saved1.json', new TextEncoder().encode(JSON.stringify({ name: 'evidence.pdf', mime: 'application/pdf' })), { atomic: true }),
    ]);
    const dispatcher = child.accessor.get(IEventDispatcher);
    await dispatcher.dispatch(new ContextAppendMessage({
      message: {
        role: 'user', id: 'saved-attachment', origin: { kind: 'user' }, toolCalls: [],
        content: [{ type: 'text', text: `Original attachment saved at ${mediaPath}; reference f_saved1` }],
      },
    }));
    await dispatcher.flush();
    await source.accessor.get(ISessionMetadata).drain();
    await manager.saveEphemeral(source.id);
    expect(await storage.read(sourceContext.scope(SESSION_MEDIA_DIR), 'f_saved1.pdf')).toBeUndefined();
    const promoted = await client.session(source.id).commands.promoteAgent('agent-research', { title: 'Saved temporary research' });
    const target = manager.get(promoted.id);
    if (target === undefined) throw new Error('Saved temporary promotion is not live');
    const targetContext = target.accessor.get(ISessionContext);
    const logs = server.core.accessor.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of logs.read<WireRecord>(targetContext.scope('agents/main'), 'wire.jsonl')) records.push(record);
    const text = JSON.stringify(records).replaceAll('\\\\', '/');
    expect(text).toContain('saved-attachment');
    expect(text).toContain(join(targetContext.sessionDir, SESSION_MEDIA_DIR, 'f_saved1.pdf').replaceAll('\\', '/'));
    expect(text).not.toContain(mediaPath.replaceAll('\\', '/'));
    expect(await storage.read(targetContext.scope(SESSION_MEDIA_DIR), 'f_saved1.pdf')).toEqual(Buffer.from([7, 8, 9]));
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 60_000);
