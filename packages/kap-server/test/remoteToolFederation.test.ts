import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IPluginHostService,
  ISessionManager,
  ISessionContext,
  ISessionMediaStore,
  IWorkspaceService,
  IThreadCreateTool,
  IReadThreadTool,
  ISendMessageToThreadTool,
  IWaitThreadsTool,
  IAgentLoopService,
  IAgentToolRegistryService,
  IAgentToolExecutorService,
  ensureMainAgent,
  type AgentTool,
  type IAgentScopeHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import { IAgentRemoteToolService } from '@kiki/agent-core-v2/agent/remoteTools/agentRemoteToolService';
import { IRemoteSpaceToolBridgeService } from '@kiki/agent-core-v2/app/remoteTools/remoteSpaceToolBridge';
import { parseDaemonFileUrl } from '@kiki/agent-core-v2/agent/media/mediaRef';
import { createKlient } from '@kiki/klient/http';
import { formatPairingUri } from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import { listExportedTools } from '../src/services/threadBridge/remoteToolsHost';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const roots: string[] = [];
const servers: RunningServer[] = [];
const providers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close();
  for (const provider of providers.splice(0)) {
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

async function execute<T>(tool: AgentTool, input: unknown): Promise<T> {
  const execution = await tool.resolveExecution(input);
  if (!('execute' in execution)) throw new Error('tool was rejected');
  const result = await execution.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: `call-${Date.now()}` });
  if (typeof result.output !== 'string') throw new Error('expected text tool output');
  return JSON.parse(result.output) as T;
}

async function createStubPlugin(baseDir: string, id: string, toolName: string, marker: string): Promise<string> {
  const dir = join(baseDir, 'plugin-sources', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'entry.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const manifest = JSON.parse(readFileSync(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));",
    'export function register(api) {',
    '  const def = manifest["x-kiki"].tools[0];',
    '  api.registerTool(def, async (args) => ({',
    '    output: [',
    `      { type: 'text', text: ${JSON.stringify(marker)} + ':' + String(args?.input ?? '') },`,
    `      { type: 'image_url', imageUrl: { url: args?.large ? 'data:image/png;base64,' + Buffer.alloc(200 * 1024, 0x41).toString('base64') : 'data:image/png;base64,${TINY_PNG_BASE64}', name: 'snap.png' } },`,
    '    ],',
    '    isError: false,',
    '  }));',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'kimi.plugin.json'), JSON.stringify({
    name: id,
    version: '1.0.0',
    description: `${id} test plugin`,
    'x-kiki': {
      engines: { kiki: '^0.4.0' },
      entry: './entry.mjs',
      permissions: { fs: 'workspace' },
      tools: [{
        schemaVersion: 1,
        name: toolName,
        description: `Remote tool ${toolName}`,
        concurrencySafe: true,
        parameters: { type: 'object', properties: { input: { type: 'string' }, large: { type: 'boolean' } } },
        accesses: [{ kind: 'all' }],
      }],
    },
  }));
  return dir;
}

async function installAndEnablePlugin(server: RunningServer, sourceDir: string, pluginId: string): Promise<void> {
  const base = `http://127.0.0.1:${server.port}`;
  const previewRes = await authedFetch(server, base, '/api/plugins:preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: sourceDir }),
  });
  const preview = await previewRes.json() as { code: number; msg: string; data: { fingerprint: string } };
  expect(preview.code, preview.msg).toBe(0);
  const installRes = await authedFetch(server, base, '/api/plugins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: sourceDir, fingerprint: preview.data.fingerprint, consent: true, defaultEnabled: true }),
  });
  const installed = await installRes.json() as { code: number; msg: string };
  expect(installed.code, installed.msg).toBe(0);
  const enableRes = await authedFetch(server, base, `/api/plugins/${pluginId}:enable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const enabled = await enableRes.json() as { code: number; msg: string };
  expect(enabled.code, enabled.msg).toBe(0);
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for predicate');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runToolOnAgent(agent: { accessor: IAgentScopeHandle['accessor'] }, toolName: string, args: Record<string, unknown>) {
  const registry = agent.accessor.get(IAgentToolRegistryService);
  const executor = agent.accessor.get(IAgentToolExecutorService);
  await registry.prepare();
  const resolved = registry.resolve(toolName);
  expect(resolved, `Expected tool ${toolName} to be registered`).toBeDefined();
  const collected = [];
  for await (const item of executor.execute([
    { type: 'function', id: `exec-${Date.now()}`, name: toolName, arguments: JSON.stringify(args) },
  ], { signal: new AbortController().signal, turnId: 1, step: 0, deduplicationKey: `dedup-${Date.now()}` })) {
    collected.push(item);
  }
  expect(collected).toHaveLength(1);
  return collected[0]!.result;
}

describe('space bridge zero-workspace pairing, telemetry, and remote tool federation', () => {
  it('supports zero-workspace pairing, auto-bootstrap ThreadCreate, bidirectional remote plugin tool calls with PNG attachments, live toggles, and telemetry', async () => {
    const root = await mkdtemp(resolve('../..', '.tmp/remote-federation-'));
    roots.push(root);
    const alphaHome = join(root, 'alpha');
    const betaHome = join(root, 'beta');
    const alphaWorkspaceDir = join(root, 'alpha-workspace');
    await Promise.all([mkdir(alphaHome), mkdir(betaHome), mkdir(alphaWorkspaceDir)]);

    const provider = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        id: 'stub-reply',
        choices: [{ index: 0, delta: { content: 'Federation stub reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`);
    });
    providers.push(provider);
    await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
    const providerAddress = provider.address();
    if (providerAddress === null || typeof providerAddress === 'string') throw new Error('provider did not bind');
    const config = [
      'default_model = "stub"',
      '[providers.stub]',
      'type = "openai"',
      `base_url = "http://127.0.0.1:${providerAddress.port}/v1"`,
      'api_key = "test-only"',
      '[models.stub]',
      'provider = "stub"',
      'model = "stub"',
      'max_context_size = 32000',
      '',
    ].join('\n');
    await Promise.all([writeFile(join(alphaHome, 'config.toml'), config), writeFile(join(betaHome, 'config.toml'), config)]);

    const alpha = await startServer({ homeDir: alphaHome, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
    const beta = await startServer({ homeDir: betaHome, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
    servers.push(alpha, beta);

    const alphaClient = createKlient({ endpoint: `http://127.0.0.1:${alpha.port}`, token: alpha.localOwnerToken });
    const betaClient = createKlient({ endpoint: `http://127.0.0.1:${beta.port}`, token: beta.localOwnerToken });
    try {
      const alphaPluginDir = await createStubPlugin(root, 'alpha-probe', 'ping', 'alpha-pong');
      const betaPluginDir = await createStubPlugin(root, 'beta-camera', 'snap', 'beta-snap');
      await installAndEnablePlugin(alpha, alphaPluginDir, 'alpha-probe');
      await installAndEnablePlugin(beta, betaPluginDir, 'beta-camera');

      await alphaClient.global.sessions.create({
        sessionId: 'alpha-main',
        workDir: alphaWorkspaceDir,
        mainAgentBinding: { model: 'stub', profile: 'agent' },
      });
      expect(await beta.core.accessor.get(IWorkspaceService).list()).toEqual([]);

      const betaHandshake = await betaClient.rest!.connections.handshake();
      expect(['win32', 'linux', 'darwin']).toContain(betaHandshake.platform);

      const pairCode = await betaClient.rest!.connections.createPairCode({
        allowBridge: true,
        bridgeOperations: ['read', 'send', 'wait', 'wake', 'create', 'tools'],
      });
      expect(pairCode.suggestedEndpoints.length).toBeGreaterThan(0);

      const paired = await alphaClient.rest!.connections.pair({
        endpoint: formatPairingUri({ endpoint: pairCode.suggestedEndpoints[0]!, code: pairCode.code }),
        code: pairCode.code,
        backgroundSummary: true,
      });
      expect(paired.purposes).toEqual(['gui', 'bridge']);

      const alphaBridgeStatus = await alphaClient.rest!.threadBridges.status();
      const outboundLink = alphaBridgeStatus.outbound.find((link) => link.connectionId === paired.id);
      expect(outboundLink).toBeDefined();
      expect(outboundLink!.grant.sourceScope).toEqual({ workspaceId: '*' });
      expect(outboundLink!.grant.targetScope).toEqual({ workspaceId: '*' });
      expect(outboundLink!.grant.operations).toEqual(['read', 'send', 'wait', 'wake', 'create', 'tools']);

      const betaBridgeStatus = await waitFor(
        () => betaClient.rest!.threadBridges.status(),
        (status) => status.outbound.some((link) => link.grant.target.homeId === alpha.admission.identity.homeId && link.enabled && !link.grant.revoked),
      );
      const reverseLink = betaBridgeStatus.outbound.find((link) => link.grant.target.homeId === alpha.admission.identity.homeId)!;
      expect(reverseLink.grant.sourceScope).toEqual({ workspaceId: '*' });
      expect(reverseLink.grant.targetScope).toEqual({ workspaceId: '*' });
      expect(reverseLink.grant.operations).toEqual(['read', 'send', 'wait', 'wake', 'create', 'tools']);

      await alpha.remoteConnections.pollSummaries();
      const updatedConn = alpha.remoteConnections.get(paired.id);
      expect(updatedConn.rttMs).toBeGreaterThanOrEqual(1);
      expect(updatedConn.summary?.value).toMatchObject({
        online: true,
        arch: process.arch,
        workspace_count: 0,
        borrowable_tool_count: 1,
      });
      expect(['win32', 'linux', 'darwin']).toContain(updatedConn.summary?.value.platform);

      const verifiedConn = await alphaClient.rest!.connections.verifyFingerprint(paired.id);
      expect(verifiedConn.fingerprintToVerify).toBeUndefined();

      const alphaSession = await alpha.core.accessor.get(ISessionManager).resume('alpha-main');
      const alphaMain = await ensureMainAgent(alphaSession!);
      const alphaWsId = alphaSession!.accessor.get(ISessionContext).workspaceId;

      const createdOnBeta = await execute<{ id: string; title: string; prompt_started: boolean; thread: { host_id: string; workspace_id: string; session_id: string; bridge_id: string; connection_id: string } }>(
        alphaMain.accessor.get(IThreadCreateTool),
        { bridge_id: outboundLink!.grant.id, idempotency_key: 'zero-ws-create', prompt: 'Hello auto-bootstrapped workspace' },
      );
      expect(createdOnBeta.prompt_started).toBe(true);
      expect(createdOnBeta.thread.workspace_id).toBeTruthy();

      const betaWorkspaces = await beta.core.accessor.get(IWorkspaceService).list();
      expect(betaWorkspaces).toHaveLength(1);
      expect(betaWorkspaces[0]!.root).toBe(join(betaHome, 'workspaces', 'default'));

      const betaCreatedSession = beta.core.accessor.get(ISessionManager).get(createdOnBeta.id)!;
      const betaCreatedMain = await ensureMainAgent(betaCreatedSession);
      await betaCreatedMain.accessor.get(IAgentLoopService).settled();

      const readBack = await execute<{ view: unknown }>(alphaMain.accessor.get(IReadThreadTool), { thread: createdOnBeta.thread });
      expect(JSON.stringify(readBack.view)).toContain('Federation stub reply');

      const waitTool = alphaMain.accessor.get(IWaitThreadsTool);
      const baseline = await execute<{ threads: Array<{ cursor: string }> }>(waitTool, { threads: [{ thread: createdOnBeta.thread }], timeout_ms: 0 });
      const sent = await execute<{ delivery: string }>(alphaMain.accessor.get(ISendMessageToThreadTool), {
        thread: createdOnBeta.thread,
        content: 'Follow-up over wildcard bridge',
        idempotency_key: 'followup-1',
      });
      expect(['delivered', 'pending']).toContain(sent.delivery);
      const activity = await execute<{ threads: Array<{ activities: Array<{ kind: string }> }> }>(waitTool, {
        threads: [{ thread: createdOnBeta.thread, cursor: baseline.threads[0]!.cursor }],
        timeout_ms: 10_000,
      });
      expect(activity.threads[0]!.activities.some((a) => a.kind === 'terminal')).toBe(true);

      const alphaToolBridge = alpha.core.accessor.get(IRemoteSpaceToolBridgeService);
      const catalogsOnAlpha = await alphaToolBridge.listBorrowedTools({ caller: { workspaceId: alphaWsId, sessionId: 'alpha-main' } });
      expect(catalogsOnAlpha).toHaveLength(1);
      expect(catalogsOnAlpha[0]!.tools.map((t) => t.remoteName)).toContain('plugin__beta_camera__snap');

      const alphaRemoteTools = alphaMain.accessor.get(IAgentRemoteToolService);
      await alphaRemoteTools.ready();
      const alphaBorrowedTool = alphaMain.accessor.get(IAgentToolRegistryService).list().find((t) => t.name.includes('beta_camera_snap'));
      expect(alphaBorrowedTool).toBeDefined();

      const httpToolResult = await runToolOnAgent(alphaMain, alphaBorrowedTool!.name, { input: 'http-frame' });
      expect(httpToolResult.isError).not.toBe(true);
      expect(Array.isArray(httpToolResult.output)).toBe(true);
      const httpParts = httpToolResult.output as Array<{ type: string; text?: string; imageUrl?: { url: string } }>;
      expect(httpParts.some((p) => p.type === 'text' && p.text?.includes('beta-snap:http-frame'))).toBe(true);
      const httpImgPart = httpParts.find((p) => p.type === 'image_url');
      expect(httpImgPart?.imageUrl?.url).toMatch(/^kimi-file:\/\/f_remote_/);
      const httpMediaRef = parseDaemonFileUrl(httpImgPart!.imageUrl!.url)!;
      const storedHttpPng = await alphaMain.accessor.get(ISessionMediaStore).read(httpMediaRef.fileId);
      expect(Buffer.from(storedHttpPng!.data).toString('base64')).toBe(TINY_PNG_BASE64);

      const betaToolBridge = beta.core.accessor.get(IRemoteSpaceToolBridgeService);
      const catalogsOnBeta = await betaToolBridge.listBorrowedTools({
        caller: { workspaceId: betaWorkspaces[0]!.id, sessionId: createdOnBeta.id },
      });
      expect(catalogsOnBeta).toHaveLength(1);
      expect(catalogsOnBeta[0]!.tools.map((t) => t.remoteName)).toContain('plugin__alpha_probe__ping');

      const betaRemoteTools = betaCreatedMain.accessor.get(IAgentRemoteToolService);
      await betaRemoteTools.ready();
      const betaBorrowedTool = betaCreatedMain.accessor.get(IAgentToolRegistryService).list().find((t) => t.name.includes('alpha_probe_ping'));
      expect(betaBorrowedTool).toBeDefined();

      const wsToolResult = await runToolOnAgent(betaCreatedMain, betaBorrowedTool!.name, { input: 'ws-frame' });
      expect(wsToolResult.isError).not.toBe(true);
      const wsParts = wsToolResult.output as Array<{ type: string; text?: string; imageUrl?: { url: string } }>;
      expect(wsParts.some((p) => p.type === 'text' && p.text?.includes('alpha-pong:ws-frame'))).toBe(true);
      const wsImgPart = wsParts.find((p) => p.type === 'image_url');
      expect(wsImgPart?.imageUrl?.url).toMatch(/^kimi-file:\/\/f_remote_/);
      const wsMediaRef = parseDaemonFileUrl(wsImgPart!.imageUrl!.url)!;
      const storedWsPng = await betaCreatedMain.accessor.get(ISessionMediaStore).read(wsMediaRef.fileId);
      expect(Buffer.from(storedWsPng!.data).toString('base64')).toBe(TINY_PNG_BASE64);

      const largeInput = `ws-large-${'p'.repeat(320 * 1024)}`;
      const wsLargeResult = await betaToolBridge.callBorrowedTool({
        bridgeId: reverseLink.grant.id,
        connectionId: reverseLink.connectionId,
        caller: { workspaceId: betaWorkspaces[0]!.id, sessionId: createdOnBeta.id },
        remoteName: 'plugin__alpha_probe__ping',
        arguments: { input: largeInput, large: true },
        callId: 'ws-large-call',
      });
      expect(JSON.stringify(wsLargeResult.output)).toContain('ws-large-ppp');
      expect(wsLargeResult.media?.length).toBeGreaterThanOrEqual(1);
      const wsPngMedia = wsLargeResult.media!.find((item) => item.mimeType === 'image/png');
      expect(wsPngMedia?.dataBase64.length).toBeGreaterThan(200 * 1024);

      await alphaClient.rest!.threadBridges.setBorrowTools(outboundLink!.grant.id, false);
      expect(await alphaToolBridge.listBorrowedTools({ caller: { workspaceId: alphaWsId, sessionId: 'alpha-main' } })).toEqual([]);
      await expect(alphaToolBridge.callBorrowedTool({
        bridgeId: outboundLink!.grant.id,
        connectionId: paired.id,
        caller: { workspaceId: alphaWsId, sessionId: 'alpha-main' },
        remoteName: 'plugin__beta_camera__snap',
        arguments: { input: 'blocked' },
        callId: 'blocked-borrow',
      })).rejects.toThrow('bridge_operation_denied');

      await alphaClient.rest!.threadBridges.setBorrowTools(outboundLink!.grant.id, true);
      expect(await alphaToolBridge.listBorrowedTools({ caller: { workspaceId: alphaWsId, sessionId: 'alpha-main' } })).toHaveLength(1);

      const betaInbound = betaBridgeStatus.inbound.find((grant) => grant.id === outboundLink!.grant.id)!;
      const beforeRevision = betaInbound.revision;
      const afterRevokeTools = await betaClient.rest!.threadBridges.setOperations(betaInbound.id, ['read', 'send', 'wait', 'wake', 'create']);
      const updatedInbound = afterRevokeTools.inbound.find((grant) => grant.id === betaInbound.id)!;
      expect(updatedInbound.revision).toBe(beforeRevision);
      expect(updatedInbound.operations).not.toContain('tools');

      await expect(alphaToolBridge.callBorrowedTool({
        bridgeId: outboundLink!.grant.id,
        connectionId: paired.id,
        caller: { workspaceId: alphaWsId, sessionId: 'alpha-main' },
        remoteName: 'plugin__beta_camera__snap',
        arguments: { input: 'revoked' },
        callId: 'revoked-tools',
      })).rejects.toThrow('bridge_operation_denied');

      await expect(alphaClient.rest!.threadBridges.syncConnection(paired.id, {
        operations: ['read', 'send', 'wait', 'wake', 'create', 'tools'],
        borrowTools: true,
      })).rejects.toThrow('bridge_operation_denied');

      const storedGuiSecret = await alpha.remoteConnections.secrets.read<{ grant: string }>({
        connectionId: alpha.remoteConnections.get(paired.id).credentialRef,
        purpose: 'gui',
      });
      const bareRequestRes = await fetch(`http://127.0.0.1:${beta.port}/api/thread-bridges/peer/request-bridge`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${storedGuiSecret.grant}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      const bareRequestJson = await bareRequestRes.json() as { code: number; data?: { bridge?: Array<{ grant: { id: string; operations: string[] }; credential: string }> } };
      expect(bareRequestJson.code).toBe(0);
      expect(bareRequestJson.data?.bridge?.[0]?.grant.operations).toEqual(['read', 'send', 'wait', 'wake', 'create']);
      expect(bareRequestJson.data?.bridge?.[0]?.grant.operations).not.toContain('tools');

      await alphaClient.rest!.threadBridges.syncConnection(paired.id, {
        operations: ['read', 'send', 'wait', 'wake', 'create'],
        borrowTools: true,
      });
      const latestBetaInbound = (await betaClient.rest!.threadBridges.status()).inbound.find((g) => !g.revoked && g.source.homeId === alpha.admission.identity.homeId)!;
      expect(latestBetaInbound.id).not.toBe(betaInbound.id);

      await betaClient.rest!.threadBridges.setOperations(latestBetaInbound.id, ['read', 'send', 'wait', 'wake', 'create', 'tools']);
      const synced = await alphaClient.rest!.threadBridges.syncConnection(paired.id, {
        operations: ['read', 'send', 'wait', 'wake', 'create', 'tools'],
        borrowTools: true,
      });
      const refreshedLink = synced.outbound.find((l) => l.connectionId === paired.id && !l.grant.revoked)!;
      expect(refreshedLink.grant.operations).toContain('tools');
      const afterSyncResult = await alphaToolBridge.callBorrowedTool({
        bridgeId: refreshedLink.grant.id,
        connectionId: paired.id,
        caller: { workspaceId: alphaWsId, sessionId: 'alpha-main' },
        remoteName: 'plugin__beta_camera__snap',
        arguments: { input: 'synced-again' },
        callId: 'synced-tools',
      });
      expect(JSON.stringify(afterSyncResult.output)).toContain('beta-snap:synced-again');
    } finally {
      await alphaClient.close();
      await betaClient.close();
    }
  }, 120_000);

  it('bootstraps a bridge on syncConnection when initial pairing had requestBridge false', async () => {
    const root = await mkdtemp(resolve('../..', '.tmp/remote-sync-bootstrap-'));
    roots.push(root);
    const alphaHome = join(root, 'alpha');
    const betaHome = join(root, 'beta');
    const alphaWorkspaceDir = join(root, 'alpha-workspace');
    await Promise.all([mkdir(alphaHome), mkdir(betaHome), mkdir(alphaWorkspaceDir)]);
    const config = 'default_model = "stub"\n';
    await Promise.all([writeFile(join(alphaHome, 'config.toml'), config), writeFile(join(betaHome, 'config.toml'), config)]);

    const alpha = await startServer({ homeDir: alphaHome, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
    const beta = await startServer({ homeDir: betaHome, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
    servers.push(alpha, beta);
    const alphaClient = createKlient({ endpoint: `http://127.0.0.1:${alpha.port}`, token: alpha.localOwnerToken });
    const betaClient = createKlient({ endpoint: `http://127.0.0.1:${beta.port}`, token: beta.localOwnerToken });
    try {
      const pairCode = await betaClient.rest!.connections.createPairCode({
        allowBridge: true,
        bridgeOperations: ['read', 'send', 'wait', 'wake', 'create', 'tools'],
      });
      expect(pairCode.bridgeOperations).toEqual(['read', 'send', 'wait', 'wake', 'create', 'tools']);
      const paired = await alphaClient.rest!.connections.pair({
        endpoint: formatPairingUri({ endpoint: pairCode.suggestedEndpoints[0]!, code: pairCode.code }),
        code: pairCode.code,
        requestBridge: false,
        backgroundSummary: false,
      });
      expect(paired.purposes).toEqual(['gui']);
      expect((await alphaClient.rest!.threadBridges.status()).outbound).toHaveLength(0);

      const synced = await alphaClient.rest!.threadBridges.syncConnection(paired.id, {
        operations: ['read', 'send', 'wait', 'wake', 'create', 'tools'],
        borrowTools: true,
      });
      expect(synced.outbound).toHaveLength(1);
      expect(synced.outbound[0]!.grant.operations).toEqual(['read', 'send', 'wait', 'wake', 'create', 'tools']);
      expect(alpha.remoteConnections.get(paired.id).purposes).toContain('bridge');

      await waitFor(
        () => betaClient.rest!.threadBridges.status(),
        (status) => status.outbound.some((link) => link.grant.target.homeId === alpha.admission.identity.homeId && link.enabled),
      );

      const disallowedCode = await betaClient.rest!.connections.createPairCode({ allowBridge: false });
      const disallowedConn = await alphaClient.rest!.connections.pair({
        endpoint: formatPairingUri({ endpoint: disallowedCode.suggestedEndpoints[0]!, code: disallowedCode.code }),
        code: disallowedCode.code,
        requestBridge: false,
        backgroundSummary: false,
      });
      await expect(alphaClient.rest!.threadBridges.syncConnection(disallowedConn.id, {})).rejects.toThrow('bridge_operation_denied');

      const leastPrivCode = await betaClient.rest!.connections.createPairCode({});
      expect(leastPrivCode.bridgeOperations).toEqual(['read', 'send', 'wait']);
      const leastPrivConn = await alphaClient.rest!.connections.pair({
        endpoint: formatPairingUri({ endpoint: leastPrivCode.suggestedEndpoints[0]!, code: leastPrivCode.code }),
        code: leastPrivCode.code,
        requestBridge: false,
        backgroundSummary: false,
      });
      await expect(alphaClient.rest!.threadBridges.syncConnection(leastPrivConn.id, {
        operations: ['read', 'send', 'wait', 'tools'],
      })).rejects.toThrow('bridge_operation_denied');
      const leastPrivSynced = await alphaClient.rest!.threadBridges.syncConnection(leastPrivConn.id, {});
      expect(leastPrivSynced.outbound.find((l) => l.connectionId === leastPrivConn.id && !l.grant.revoked)?.grant.operations).toEqual(['read', 'send', 'wait']);
    } finally {
      await alphaClient.close();
      await betaClient.close();
    }
  }, 90_000);

  it('coalesces concurrent listExportedTools flights per scope and isolates waiter aborts', async () => {
    let release!: () => void;
    let entered!: () => void;
    let gateEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    let listCalls = 0;
    const pluginHost = {
      list: async () => {
        listCalls += 1;
        entered();
        await new Promise<void>((resolveGate) => { release = resolveGate; });
        return [{
          pluginId: 'demo-plugin',
          definition: {
            name: 'ping',
            description: 'Ping demo tool',
            parameters: { type: 'object', properties: {} },
          },
        }];
      },
    };
    const core = {
      accessor: {
        get: (id: unknown) => {
          if (id === IPluginHostService) return pluginHost;
          throw new Error('not registered');
        },
      },
    } as unknown as Scope;

    const acA = new AbortController();
    const acB = new AbortController();
    const flightA = listExportedTools(core, 'ws-1', { signal: acA.signal });
    const flightB = listExportedTools(core, 'ws-1', { signal: acB.signal });
    await gateEntered;
    expect(listCalls).toBe(1);

    acA.abort(new Error('caller A disconnected'));
    await expect(flightA).rejects.toThrow('caller A disconnected');

    release();
    const resultB = await flightB;
    expect(resultB.tools.map((tool) => tool.remoteName)).toEqual(['plugin__demo_plugin__ping']);
    expect(listCalls).toBe(1);

    gateEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
    const fresh = listExportedTools(core, 'ws-1');
    await gateEntered;
    release();
    await fresh;
    expect(listCalls).toBe(2);
  });
});
