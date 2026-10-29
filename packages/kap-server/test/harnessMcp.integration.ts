import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createKlient } from '@kiki/klient/http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IHarnessMcpService, IAgentProfileService, IAgentExecutorRegistry, IAgentProfileRegistry, IAgentLoopService, IAgentPromptService, IWireService, normalizeAgentProfile,
  ensureMainAgent, resumeSessionById, type IAgentScopeHandle } from '@kiki/agent-core-v2';
import { acquireHarnessMcp } from '@kiki/agent-core-v2/agent/execution/harnessMcpLease';
import { executionBindingSchema, type ExecutionSelection } from '@kiki/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKikiMcpServer } from '../src/mcp/server';
import { describe, expect, it, vi } from 'vitest';
import { createContextKlient, contextProcedureTable } from '@kiki/klient/procedures';
import { IAgentPermissionModeService } from '@kiki/agent-core-v2/agent/permissionMode/permissionMode';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';
import { ISessionTodoService } from '@kiki/agent-core-v2/session/todo/sessionTodo';
import { IAgentContextMemoryService } from '@kiki/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IAgentToolRegistryService } from '@kiki/agent-core-v2/agent/toolRegistry/toolRegistry';
import { IAgentCollaborationMessageStore } from '@kiki/agent-core-v2/session/agentCollaboration/messageMailbox';
import { ToolAccesses } from '@kiki/agent-core-v2/tool/toolContract';
import { resolveExecutionBinding } from '@kiki/agent-core-v2/agent/profile/executionBinding';

import { startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const require = createRequire(import.meta.url);

describe('attached harness MCP', () => {
  it('runs the actual stdio CLI against the existing main session and revokes disabled/released bindings', { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-harness-bridge-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const client = new Client({ name: 'harness-fixture', version: '1' });
    let lease: Awaited<ReturnType<IHarnessMcpService['acquire']>> | undefined;
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: home } }) });
      expect(created.status).toBe(200);
      const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
      const session = (await resumeSessionById(server.core.accessor, sessionId))!;
      const main = await ensureMainAgent(session);
      const profile = main.accessor.get(IAgentProfileService);
      const binding = profile.data();
      profile.applyBindingSnapshot({ ...binding, allowKikiSubagents: true });
      lease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: main.id, workspacePath: home });
      expect(lease.server).toMatchObject({ name: 'kiki-harness', args: ['mcp', '--workspace', home, '--attached'] });
      if (!('command' in lease.server)) throw new Error('Expected stdio bridge');
      const env = Object.fromEntries(lease.server.env.map(({ name, value }) => [name, value]));
      const call = async () => {
        const response = await fetch(`${base}/api/klient/delegation/list`, { method: 'POST', headers: { authorization: `Bearer ${env['KIKI_DELEGATION_TOKEN']}`, 'content-type': 'application/json' }, body: '{}' });
        return { status: response.status, body: await response.json() as { code: number } };
      };
      expect(await call()).toMatchObject({ status: 200, body: { code: 0 } });
      const cli = fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts', import.meta.url));
      const loader = new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href;
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--import', loader, cli, ...lease.server.args],
        env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...env,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json', import.meta.url)) }, cwd: home,
      }));
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(13);
      const listed = await client.callTool({ name: 'kiki_list', arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({ binding: { sessionId, workspacePath: home } });
      const seats = await fetch(`${base}/api/external-delegation/seats`, { headers: authHeaders(server) });
      expect(await seats.json()).toMatchObject({ code: 0, data: [] });
      profile.applyBindingSnapshot({ ...binding, allowKikiSubagents: false });
      expect((await call()).body.code).not.toBe(0);
      profile.applyBindingSnapshot({ ...binding, allowKikiSubagents: true });
      expect((await call()).body.code).toBe(0);
      lease.dispose();
      expect((await call()).status).toBe(401);
    } finally {
      await client.close();
      lease?.dispose();
      await server.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});


describe('harness context authority', () => {
  it('gates every context group, executes native approval, rejects spoofing, and deduplicates projected hook context', { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-context-bridge-'));
    await writeFile(join(home, 'config.toml'), '[thread_communication]\nenabled = true\n');
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    let lease: Awaited<ReturnType<IHarnessMcpService['acquire']>> | undefined;
    try {
      const endpoint = `http://127.0.0.1:${server.port}`;
      const created = await fetch(`${endpoint}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: home } }) });
      const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
      const session = (await resumeSessionById(server.core.accessor, sessionId))!;
      const main = await ensureMainAgent(session);
      const profile = main.accessor.get(IAgentProfileService);
      const binding = profile.data();
      lease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: main.id, workspacePath: home });
      if (!('command' in lease.server)) throw new Error('Expected stdio bridge');
      const env = Object.fromEntries(lease.server.env.map(({ name, value }) => [name, value]));
      const token = env['KIKI_DELEGATION_TOKEN']!;
      const context = createContextKlient({ endpoint, token });
      expect(await context.catalog()).toEqual({ delegation: false, tools: [] });
      for (const group of ['memory', 'board', 'cron', 'threads', 'history'] as const) {
        profile.applyBindingSnapshot({ ...binding, kikiContext: [group] });
        const catalog = await context.catalog();
        expect(catalog.tools.map((tool) => tool.name)).toEqual(contextProcedureTable.filter((entry) => entry.group === group).map((entry) => entry.name));
        profile.applyBindingSnapshot({ ...binding, kikiContext: [] });
        for (const tool of catalog.tools) await expect(context.call({ name: tool.name as never, arguments: {} })).rejects.toThrow();
      }
      profile.applyBindingSnapshot({ ...binding, kikiContext: ['memory', 'cron', 'hooks'] });
      main.accessor.get(IAgentPermissionModeService).setMode('yolo');
      const read = await context.call({ name: 'memory_read', arguments: { id: 'm_missing' } });
      expect(read, JSON.stringify(read)).not.toMatchObject({ isError: true });
      expect(read.output).toContain('missing');
      const mcp = createKikiMcpServer({ endpoint, delegationToken: token, sessionId }, {
        contextCatalog: await context.catalog(), contextCall: context.call,
      });
      const mcpClient = new Client({ name: 'context-fixture', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([mcp.connect(serverTransport), mcpClient.connect(clientTransport)]);
        expect((await mcpClient.listTools()).tools.map((tool) => tool.name)).toEqual(['kiki_memory_read', 'kiki_memory_search', 'kiki_memory_write', 'kiki_cron']);
        expect((await mcpClient.callTool({ name: 'kiki_memory_read', arguments: { id: 'm_missing' } })).isError).not.toBe(true);
      } finally {
        await mcpClient.close();
        await mcp.close();
      }
      profile.applyBindingSnapshot({ ...binding, kikiContext: ['memory', 'cron', 'hooks'], disallowedTools: ['MemoryRead'] });
      expect((await context.catalog()).tools.map((tool) => tool.name)).not.toContain('memory_read');
      expect((await context.call({ name: 'memory_read', arguments: { id: 'm_missing' } })).isError).toBe(true);
      const forged = await fetch(`${endpoint}/api/klient/delegation/context/call`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'memory_read', arguments: { id: 'm_missing' }, session_id: 'another-session', principalId: 'another-owner' }),
      });
      expect(await forged.json()).toMatchObject({ code: 40001 });
      const escaped = await fetch(`${endpoint}/api/memory/global`, { headers: { authorization: `Bearer ${token}` } });
      expect(escaped.status).toBe(401);
      main.accessor.get(IAgentPermissionModeService).setMode('manual');
      const interaction = session.accessor.get(ISessionInteractionService);
      interaction.acquireConsumer('context-test');
      const write = context.call({ name: 'cron', arguments: { action: 'create', cron: '0 12 * * *', prompt: 'Review progress', recurring: false } });
      await vi.waitFor(() => expect(interaction.listPending('approval')).toHaveLength(1));
      const pending = interaction.listPending('approval')[0]!;
      expect(pending.origin.agentId).toBe('main');
      interaction.respond(pending.id, { decision: 'rejected' });
      expect((await write).isError).toBe(true);
      interaction.releaseConsumer('context-test');
      const todos = session.accessor.get(ISessionTodoService);
      todos.setNotes({ goal: 'Keep the context contract stable', next: 'Run the smoke checks' }, { turnId: 0, step: 0, toolCallId: 'notes-fixture' }, 'main');
      const first = await context.hook({ harness: 'claude', event: 'UserPromptSubmit' }) as { content: string };
      expect(first.content).toContain('Keep the context contract stable');
      const second = await context.hook({ harness: 'claude', event: 'UserPromptSubmit' });
      expect(second).toEqual({ content: '' });
      const history = main.accessor.get(IAgentContextMemoryService).get();
      expect(history.filter((message) => message.origin?.kind === 'hook_result' && message.origin.event === 'kiki:claude:UserPromptSubmit')).toHaveLength(1);
      expect(await context.hook({ harness: 'claude', event: 'PreCompact' })).toEqual({ content: '' });
      expect(main.accessor.get(IAgentContextMemoryService).get().findLast((message) => message.origin?.kind === 'hook_result')?.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining('[Handoff prepared; not injected by this hook]') }),
      ]);
      expect((await context.hook({ harness: 'claude', event: 'SessionStart', compact: true }) as { content: string }).content).toContain('Keep the context contract stable');
      expect(await context.hook({ harness: 'codex', event: 'PreCompact' })).toEqual({ content: '' });
      expect((await context.hook({ harness: 'codex', event: 'UserPromptSubmit' }) as { content: string }).content).toContain('Keep the context contract stable');
      expect(await context.hook({ harness: 'codex', event: 'UserPromptSubmit' })).toEqual({ content: '' });
      const notes = 'Keep the context contract stable';
      const noteCopies = (): number => main.accessor.get(IAgentContextMemoryService).get()
        .filter((message) => JSON.stringify(message.content ?? '').includes(notes)).length;
      const grokLease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: main.id, workspacePath: home, executorId: 'grok-acp', hooks: true });
      try {
        const beforeStop = noteCopies();
        expect(await grokLease.contextHook!('Stop')).toContain(notes);
        expect(await grokLease.contextHook!('Stop')).toBe('');
        expect(noteCopies()).toBe(beforeStop);
        expect(main.accessor.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'hook_result' && message.origin.event === 'kiki:grok:Stop')).toHaveLength(0);
      } finally { grokLease.dispose(); }
      await expect(grokLease.contextHook!('Stop')).rejects.toThrow('closed');
      await main.accessor.get(IWireService).flush();
      const { TRANSCRIPT_COVERAGE_VERSION } = await import('@kiki/transcript');
      const projected = await fetch(`${endpoint}/api/sessions/${sessionId}/transcript?agent_id=main&transcript_coverage_version=${TRANSCRIPT_COVERAGE_VERSION}`, { headers: authHeaders(server) });
      const projectedBody = await projected.json();
      expect(projectedBody).toMatchObject({ code: 0 });
      expect(JSON.stringify(projectedBody.data)).toContain('Keep the context contract stable');
      expect(JSON.stringify(projectedBody.data)).toContain('kiki:claude:UserPromptSubmit');
      lease.dispose();
      await expect(context.catalog()).rejects.toThrow('Unauthorized');
    } finally {
      lease?.dispose();
      await server.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});


describe('native harness tool parity', () => {
  it('uses the child identity for notification, plugin/MCP tools and approvals, and revokes list/call together', { timeout: 60_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-native-harness-'));
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const client = new Client({ name: 'native-harness-fixture', version: '1' });
    let lease: Awaited<ReturnType<IHarnessMcpService['acquire']>> | undefined;
    let mcp: ReturnType<typeof createKikiMcpServer> | undefined;
    let settleHeldChild = async (): Promise<void> => {};
    try {
      const endpoint = `http://127.0.0.1:${server.port}`;
      const created = await fetch(`${endpoint}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: home } }) });
      const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
      const session = (await resumeSessionById(server.core.accessor, sessionId))!;
      const main = await ensureMainAgent(session);
      const mainProfile = main.accessor.get(IAgentProfileService);
      const mainBinding = mainProfile.data();
      const mainLease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: main.id, workspacePath: home, nativeTools: true });
      try {
        if (!('command' in mainLease.server)) throw new Error('Expected stdio bridge');
        const mainEnv = Object.fromEntries(mainLease.server.env.map(({ name, value }) => [name, value]));
        const mainContext = createContextKlient({ endpoint, token: mainEnv['KIKI_DELEGATION_TOKEN']! });
        expect((await mainContext.catalog()).tools).toEqual([]);
        expect((await mainContext.call({ name: 'Read', arguments: {} })).isError).toBe(true);
        mainProfile.applyBindingSnapshot({ ...mainBinding, kikiContext: ['memory'], allowKikiSubagents: false });
        const mainNames = (await mainContext.catalog()).tools.map((tool) => tool.name);
        expect(mainNames).toContain('MemoryRead');
        expect(mainNames).not.toContain('Read');
        expect(mainNames).not.toContain('AgentRun');
        mainProfile.applyBindingSnapshot({ ...mainBinding, allowKikiSubagents: true, disallowedTools: ['AgentRun'] });
        for (const body of [{}, { nativeTools: false }]) {
          const bypass = await fetch(`${endpoint}/api/klient/delegation/list`, {
            method: 'POST', headers: { authorization: `Bearer ${mainEnv['KIKI_DELEGATION_TOKEN']}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          expect(await bypass.json()).toMatchObject({ code: 40001 });
        }
        mainProfile.applyBindingSnapshot({ ...mainBinding, disallowedTools: [] });
      } finally { mainLease.dispose(); }
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.create({ agentId: 'bridge-child', delegator: { kind: 'agent', agentId: 'main' } });
      const loop = child.accessor.get(IAgentLoopService);
      let resolveHeldTurn!: (turnId: number) => void;
      const heldTurn = new Promise<number>((resolve) => { resolveHeldTurn = resolve; });
      const hold = loop.hooks.onWillBeginStep.register('hold-child-approval-turn', async (ctx) => {
        resolveHeldTurn(ctx.turnId);
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener('abort', () => { resolve(); }, { once: true });
        });
        ctx.signal.throwIfAborted();
      }, { before: 'context-injector' });
      let released = false;
      settleHeldChild = async () => {
        if (released) return;
        released = true;
        const status = loop.status();
        for (const id of status.pendingTurnIds) loop.cancel(id);
        if (status.activeTurnId !== undefined) loop.cancel(status.activeTurnId);
        void hold.dispose();
        await loop.settled();
      };
      const profile = child.accessor.get(IAgentProfileService);
      const original = profile.data();
      child.accessor.get(IAgentPermissionModeService).setMode('yolo');
      const registry = child.accessor.get(IAgentToolRegistryService);
      const registrations = ['plugin', 'mcp'].map((source) => registry.register({
        name: `${source}_fixture`, description: `${source} fixture`, parameters: { type: 'object', properties: {} },
        resolveExecution: () => ({ approvalRule: `${source}_fixture`, accesses: ToolAccesses.all(),
          execute: async () => ({ output: `${child.id}:${source}` }) }),
      }, { source: source as 'plugin' | 'mcp' }));
      lease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: child.id, workspacePath: home, nativeTools: true });
      if (!('command' in lease.server)) throw new Error('Expected stdio bridge');
      const env = Object.fromEntries(lease.server.env.map(({ name, value }) => [name, value]));
      const context = createContextKlient({ endpoint, token: env['KIKI_DELEGATION_TOKEN']! });
      const catalog = await context.catalog();
      expect(catalog.delegation).toBe(false);
      expect(catalog.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['AgentNotify', 'plugin_fixture', 'mcp_fixture']));
      mcp = createKikiMcpServer({ endpoint, delegationToken: env['KIKI_DELEGATION_TOKEN']!, sessionId }, {
        contextCatalog: catalog, contextCall: context.call, contextList: context.catalog,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('kiki_AgentNotify');
      const notified = await client.callTool({ name: 'kiki_AgentNotify', arguments: { message: 'The parent must change the integration route.' } });
      expect(notified.isError, JSON.stringify(notified)).not.toBe(true);
      expect((await client.callTool({ name: 'kiki_AgentNotify', arguments: {} })).isError).toBe(true);
      registry.register({ name: 'plugin_media_fixture', description: 'Media fixture',
        parameters: { type: 'object', properties: {} }, resolveExecution: () => ({
          approvalRule: 'plugin_media_fixture', accesses: ToolAccesses.none(), execute: async () => ({ output: [
            { type: 'text', text: 'Exact media bytes' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,cGl4ZWxz' } },
          ] }),
        }) }, { source: 'plugin' });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('kiki_plugin_media_fixture');
      expect((await client.callTool({ name: 'kiki_plugin_media_fixture', arguments: {} })).content).toEqual([
        { type: 'text', text: 'Exact media bytes' }, { type: 'image', mimeType: 'image/png', data: 'cGl4ZWxz' },
      ]);
      const store = server.core.accessor.get(IAgentCollaborationMessageStore);
      const queued = await store.nextQueued(sessionId, 'main');
      expect(queued?.message).toMatchObject({ sourceAgentId: child.id, targetAgentId: 'main', content: 'The parent must change the integration route.' });
      for (const name of ['plugin_fixture', 'mcp_fixture']) expect(await context.call({ name, arguments: {} })).toEqual({ output: `${child.id}:${name.split('_')[0]}` });
      profile.applyBindingSnapshot({ ...original, disallowedTools: ['plugin_fixture', 'AgentNotify'] });
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('kiki_plugin_fixture');
      expect((await context.call({ name: 'plugin_fixture', arguments: {} })).isError).toBe(true);
      expect((await context.call({ name: 'AgentNotify', arguments: { message: 'must not deliver' } })).isError).toBe(true);
      const normalized = resolveExecutionBinding({ executor: 'fixture' }, undefined, undefined, undefined);
      profile.applyBindingSnapshot({ ...original, disallowedTools: [], execution: normalized, kikiContext: [], allowKikiSubagents: false });
      expect((await context.catalog()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['plugin_fixture', 'HistoryList']));
      const off = resolveExecutionBinding({ executor: 'fixture', overrides: { kiki_context: [], allow_kiki_subagents: false } }, undefined, undefined, normalized);
      profile.applyBindingSnapshot({ ...original, disallowedTools: [], execution: off, kikiContext: [], allowKikiSubagents: false });
      const closedNames = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ['MemoryRead', 'HistoryList', 'AgentRun', 'AgentList', 'AgentSend']) {
        expect(closedNames).not.toContain(`kiki_${name}`);
        expect((await context.call({ name, arguments: {} })).isError).toBe(true);
      }
      expect(closedNames).toContain('kiki_AgentNotify');
      for (const body of [{}, { nativeTools: false, harnessAgentId: 'main' }]) {
        const childBypass = await fetch(`${endpoint}/api/klient/delegation/list`, {
          method: 'POST', headers: { authorization: `Bearer ${env['KIKI_DELEGATION_TOKEN']}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(await childBypass.json()).toMatchObject({ code: 40001 });
      }
      expect(await context.call({ name: 'plugin_fixture', arguments: {} })).toEqual({ output: `${child.id}:plugin` });
      const inherited = resolveExecutionBinding({ executor: 'fixture', overrides: { kiki_context: null, allow_kiki_subagents: null } },
        { kiki_context: ['history'], allow_kiki_subagents: true }, undefined, off);
      profile.applyBindingSnapshot({ ...original, disallowedTools: [], execution: inherited });
      expect((await context.catalog()).tools.map((tool) => tool.name)).toContain('HistoryList');
      expect((await context.catalog()).tools.map((tool) => tool.name)).not.toContain('MemoryRead');
      profile.applyBindingSnapshot({ ...original, disallowedTools: [], execution: normalized });
      child.accessor.get(IAgentPermissionModeService).setMode('manual');
      const interaction = session.accessor.get(ISessionInteractionService);
      interaction.acquireConsumer('child-bridge-test');
      registry.register({ name: 'plugin_approval_fixture', description: 'Approval fixture',
        parameters: { type: 'object', properties: {} }, resolveExecution: () => ({
          approvalRule: 'plugin_approval_fixture', accesses: ToolAccesses.all(), execute: async () => ({ output: 'approved' }),
        }) }, { source: 'plugin' });
      registry.register({ name: 'plugin_approval_revoke_fixture', description: 'Approval revoke fixture',
        parameters: { type: 'object', properties: {} }, resolveExecution: () => ({
          approvalRule: 'plugin_approval_revoke_fixture', accesses: ToolAccesses.all(), execute: async () => ({ output: 'approved' }),
        }) }, { source: 'plugin' });
      const prompts = child.accessor.get(IAgentPromptService);
      const running = loop.status();
      const started = running.activeTurnId === undefined && running.pendingTurnIds.length === 0
        ? prompts.submit({ input: [{ type: 'text', text: 'Hold the child turn across the approval.' }] })
        : undefined;
      const turnId = await new Promise<number>((resolve, reject) => {
        void heldTurn.then(resolve, reject);
        if (started !== undefined) void started.then(() => undefined, reject);
      });
      expect(loop.status().activeTurnId).toBe(turnId);
      const pendingCall = context.call({ name: 'plugin_approval_fixture', arguments: {} });
      let outcome: unknown;
      void pendingCall.then((value) => { outcome = value; });
      await vi.waitFor(() => expect(interaction.listPending('approval'), JSON.stringify(outcome)).toHaveLength(1));
      const pending = interaction.listPending('approval')[0]!;
      expect(pending.origin.agentId).toBe(child.id);
      expect(pending.origin.turnId).toBe(turnId);
      expect(loop.status().activeTurnId).toBe(turnId);
      interaction.respond(pending.id, { decision: 'rejected' });
      const rejected = await pendingCall;
      expect(rejected.isError).toBe(true);
      expect(rejected.output).toContain('the user rejected the approval request');
      expect(rejected.output).not.toContain('turn_ended');
      const endedCall = context.call({ name: 'plugin_approval_revoke_fixture', arguments: {} });
      let ended: Awaited<typeof endedCall> | undefined;
      void endedCall.then((value) => { ended = value; });
      await vi.waitFor(() => { expect(interaction.listPending('approval'), JSON.stringify(ended)).toHaveLength(1); });
      const ending = interaction.listPending('approval')[0]!;
      expect(ending.origin.agentId).toBe(child.id);
      expect(ending.origin.turnId).toBe(turnId);
      expect(loop.status().activeTurnId).toBe(turnId);
      for (const id of loop.status().pendingTurnIds) loop.cancel(id);
      expect(loop.status().activeTurnId).toBe(turnId);
      loop.cancel(turnId);
      await vi.waitFor(() => {
        expect(ended).toEqual({ output: 'Tool "plugin_approval_revoke_fixture" was not run because the system cancelled the approval request (turn_ended).', isError: true });
        expect(interaction.listPending('approval')).toHaveLength(0);
      });
      await prompts.drain(new Error('approval fixture released the held turn'));
      await settleHeldChild();
      expect(loop.status().activeTurnId).toBeUndefined();
      interaction.releaseConsumer('child-bridge-test');
      await registrations[1]!.dispose();
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('kiki_mcp_fixture');
      await expect(context.call({ name: 'mcp_fixture', arguments: {} })).rejects.toThrow();
      const forged = await fetch(`${endpoint}/api/klient/delegation/context/call`, {
        method: 'POST', headers: { authorization: `Bearer ${env['KIKI_DELEGATION_TOKEN']}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'AgentNotify', arguments: { message: 'spoofed' }, agentId: 'main' }),
      });
      expect(await forged.json()).toMatchObject({ code: 40001 });
      await lifecycle.remove(child.id);
      await expect(context.catalog()).rejects.toThrow();
      await expect(context.call({ name: 'AgentNotify', arguments: { message: 'gone' } })).rejects.toThrow();
      await lifecycle.create({ agentId: child.id, delegator: { kind: 'agent', agentId: 'main' } });
      await expect(context.catalog()).rejects.toThrow();
      lease.dispose();
      await expect(context.catalog()).rejects.toThrow('Unauthorized');
    } finally {
      await settleHeldChild();
      await client.close();
      await mcp?.close();
      lease?.dispose();
      await server.close();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});


it.each(['claude-acp', 'grok-acp'])('exposes callable native tools through the default %s child lease', { timeout: 60_000 }, async (executorId) => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-builtin-child-mcp-'));
  await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n[subagent]\nautomatic_notification = false\n');
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  let lease: Awaited<ReturnType<IHarnessMcpService['acquire']>> | undefined;
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${endpoint}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: home } }) });
    const sessionId = ((await response.json()) as { data: { id: string } }).data.id;
    const session = (await resumeSessionById(server.core.accessor, sessionId))!;
    await ensureMainAgent(session);
    const child = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'native-child', delegator: { kind: 'agent', agentId: 'main' } });
    const profile = child.accessor.get(IAgentProfileService);
    const binding = { ...profile.data(), execution: resolveExecutionBinding({ executor: executorId }, undefined, undefined, undefined) };
    profile.applyBindingSnapshot(binding);
    child.accessor.get(IAgentPermissionModeService).setMode('yolo');
    lease = await acquireHarnessMcp({ agent: child, binding, descriptor: server.core.accessor.get(IAgentExecutorRegistry).get(executorId)! }, home);
    if (lease === undefined || !('command' in lease.server)) throw new Error('Expected default child stdio bridge');
    expect(binding.execution.effective.native_agent).toBeUndefined();
    const context = createContextKlient({ endpoint, token: lease.server.env.find((entry) => entry.name === 'KIKI_DELEGATION_TOKEN')!.value });
    expect((await context.catalog()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['MemoryRead', 'AgentNotify']));
    expect((await context.call({ name: 'MemoryRead', arguments: { id: 'm_missing' } })).output).toContain('missing');
    expect((await context.call({ name: 'AgentNotify', arguments: { message: 'The native child connection is ready.' } })).isError).not.toBe(true);
    const queued = await server.core.accessor.get(IAgentCollaborationMessageStore).nextQueued(sessionId, 'main');
    expect(queued?.message).toMatchObject({ sourceAgentId: child.id, targetAgentId: 'main', content: 'The native child connection is ready.' });
    profile.applyBindingSnapshot({ ...binding, disallowedTools: ['MemoryRead'] });
    expect((await context.call({ name: 'MemoryRead', arguments: { id: 'm_missing' } })).isError).toBe(true);
    const off = { ...binding, execution: resolveExecutionBinding({ executor: executorId, overrides: { inject_kiki_mcp: false } }, undefined, undefined, binding.execution) };
    profile.applyBindingSnapshot(off);
    expect(await acquireHarnessMcp({ agent: child, binding: off, descriptor: server.core.accessor.get(IAgentExecutorRegistry).get(executorId)! }, home)).toBeUndefined();
    await expect(context.catalog()).rejects.toThrow();
  } finally {
    lease?.dispose();
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('applies engine profile and session injection choices to the real HTTP tool bridge for main and child bindings', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiki-injection-defaults-'));
  await writeFile(join(home, 'config.toml'), `[search]\nenabled = false\n[agent_executors.bridge-fixture]\nprotocol = "acp-v1"\ncommand = ${JSON.stringify(process.execPath)}\nsupports_mcp = true\n[agent_executor_overrides.bridge-fixture.env]\nFIXTURE_CREDENTIAL = "credential-sentinel"\n[agent_executor_overrides.bridge-fixture.defaults]\ninject_kiki_mcp = false\n`);
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const leases: Awaited<ReturnType<IHarnessMcpService['acquire']>>[] = [];
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const post = async (path: string, value: unknown) => {
      const response = await fetch(`${endpoint}/api${path}`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify(value) });
      const body = await response.json() as { code: number; msg: string; data: { id: string; agent_config?: { execution?: unknown } } };
      expect(body.code, body.msg).toBe(0);
      return body.data;
    };
    server.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'bridge-defaults-fixture', priority: 50, contribution: {
      profiles: [undefined, false, true].map((injectKikiMcp) => normalizeAgentProfile({
        name: `bridge-${String(injectKikiMcp)}`, definitionId: `bridge:${String(injectKikiMcp)}`, executor: 'bridge-fixture',
        modelAlias: 'vendor-model', injectKikiMcp, kikiContext: ['memory'], systemPrompt: () => 'Bridge fixture',
      })),
    } });
    const selection: ExecutionSelection = { executor: 'bridge-fixture', profile: 'bridge-true', overrides: { inject_kiki_mcp: false } };
    const created = await post('/sessions', { metadata: { cwd: home }, agent_config: { execution: selection } });
    const session = (await resumeSessionById(server.core.accessor, created.id))!;
    const main = await ensureMainAgent(session);
    const registry = server.core.accessor.get(IAgentExecutorRegistry);
    const acquire = async (agent: IAgentScopeHandle) => {
      const lease = await acquireHarnessMcp({ agent, descriptor: registry.get('bridge-fixture')!, binding: agent.accessor.get(IAgentProfileService).data() }, home);
      if (lease !== undefined) leases.push(lease);
      return lease;
    };
    expect(await acquire(main)).toBeUndefined();
    const cleared = await post(`/sessions/${created.id}/profile`, { agent_config: { execution: { ...selection, overrides: { inject_kiki_mcp: null } } } });
    const binding = executionBindingSchema.parse(cleared.agent_config?.execution);
    expect(binding.effective.inject_kiki_mcp).toBe(true);
    expect(binding.sources['inject_kiki_mcp']).toBe('profile');
    const lease = await acquire(main);
    if (lease === undefined || !('command' in lease.server)) throw new Error('Expected injected stdio bridge');
    const env = Object.fromEntries(lease.server.env.map(({ name, value }) => [name, value]));
    const context = createContextKlient({ endpoint, token: env['KIKI_DELEGATION_TOKEN']! });
    main.accessor.get(IAgentPermissionModeService).setMode('yolo');
    expect((await context.catalog()).tools.map((tool) => tool.name)).toContain('MemoryRead');
    expect((await context.call({ name: 'MemoryRead', arguments: { id: 'm_missing' } })).isError).not.toBe(true);
    await post(`/sessions/${created.id}/profile`, { agent_config: { execution: { ...selection, overrides: { inject_kiki_mcp: true, kiki_context: [] } } } });
    expect((await context.catalog()).tools.map((tool) => tool.name)).not.toContain('MemoryRead');
    await post(`/sessions/${created.id}/profile`, { agent_config: { execution: { ...selection, overrides: { inject_kiki_mcp: null, kiki_context: null } } } });
    expect((await context.catalog()).tools.map((tool) => tool.name)).toContain('MemoryRead');
    await post(`/sessions/${created.id}/profile`, { agent_config: { execution: { ...selection, overrides: { inject_kiki_mcp: false } } } });
    await expect(context.catalog()).rejects.toThrow('Kiki context request is not admitted or its arguments are invalid.');
    await expect(context.call({ name: 'MemoryRead', arguments: { id: 'm_missing' } })).rejects.toThrow('Kiki context request is not admitted or its arguments are invalid.');
    lease.dispose();
    await expect(context.catalog()).rejects.toThrow('Unauthorized');

    const child = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'bridge-child', delegator: { kind: 'agent', agentId: 'main' } });
    const profile = child.accessor.get(IAgentProfileService);
    await profile.bind({ profile: 'bridge-undefined', delegationPosition: 'sub' });
    expect(profile.data().injectKikiMcp).toBe(false);
    expect(await acquire(child)).toBeUndefined();
    await post('/config', { agent_executor_overrides: { 'bridge-fixture': { defaults: { inject_kiki_mcp: true } } } });
    expect(profile.data().injectKikiMcp).toBe(false);
    await profile.bind({ profile: 'bridge-undefined', delegationPosition: 'sub' });
    expect(profile.data().injectKikiMcp).toBe(true);
    const childLease = await acquire(child);
    if (childLease === undefined || !('command' in childLease.server)) throw new Error('Expected child stdio bridge');
    const childContext = createContextKlient({ endpoint, token: childLease.server.env.find((entry) => entry.name === 'KIKI_DELEGATION_TOKEN')!.value });
    expect((await childContext.catalog()).tools.map((tool) => tool.name)).toContain('MemoryRead');
    await profile.bind({ profile: 'bridge-false', delegationPosition: 'sub' });
    expect(profile.data().injectKikiMcp).toBe(false);
    expect(await acquire(child)).toBeUndefined();
    await expect(childContext.catalog()).rejects.toThrow('Kiki context request is not admitted or its arguments are invalid.');
    await expect(childContext.call({ name: 'MemoryRead', arguments: { id: 'm_missing' } })).rejects.toThrow('Kiki context request is not admitted or its arguments are invalid.');
    childLease.dispose();
    await post('/config', { agent_executor_overrides: { 'bridge-fixture': { defaults: { inject_kiki_mcp: false } } } });
    await profile.bind({ profile: 'bridge-true', delegationPosition: 'sub' });
    expect(profile.data().injectKikiMcp).toBe(true);
    expect(await acquire(child)).toBeDefined();
    expect(profile.data().execution).toBeUndefined();
    expect(JSON.stringify(profile.data())).not.toContain('credential-sentinel');
    expect(registry.get('bridge-fixture')?.env?.['FIXTURE_CREDENTIAL']).toBe('credential-sentinel');
    await post('/config', { agent_executor_overrides: { 'bridge-fixture': { defaults: { inject_kiki_mcp: null } } } });
    await profile.bind({ profile: 'bridge-undefined', delegationPosition: 'sub' });
    expect(profile.data().injectKikiMcp).toBeUndefined();
    expect(await acquire(child)).toBeDefined();
  } finally {
    for (const lease of leases) lease.dispose();
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it('launches advertised native agents from the public generic caller without a profile file', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-agent-caller-'));
  const fixture = join(home, 'neutral-acp.mjs');
  const audit = join(home, 'launches.ndjson');
  const acpRequire = createRequire(new URL('../../acp-client/package.json', import.meta.url));
  await writeFile(fixture, `import {agent,ndJsonStream,PROTOCOL_VERSION} from ${JSON.stringify(pathToFileURL(acpRequire.resolve('@agentclientprotocol/sdk')).href)};
import {Readable,Writable} from 'node:stream'; import {appendFile} from 'node:fs/promises'; import {randomUUID} from 'node:crypto';
const sessions=new Map(); const config=s=>[{id:'agent-choice',name:'Native agent',category:'native_agent',type:'select',currentValue:s.agent,options:[{value:'specialist',name:'Specialist'}]}];
const conn=agent({name:'neutral-acp',version:'1'}).onRequest('initialize',()=>({protocolVersion:PROTOCOL_VERSION,agentCapabilities:{}}))
.onRequest('session/new',ctx=>{const s={id:randomUUID(),agent:'factory-main',cwd:ctx.params.cwd};sessions.set(s.id,s);return {sessionId:s.id,configOptions:config(s)};})
.onRequest('session/set_config_option',ctx=>{const s=sessions.get(ctx.params.sessionId);if(ctx.params.configId!=='agent-choice'||ctx.params.value!=='specialist')throw Error('unsupported agent');s.agent=ctx.params.value;return {configOptions:config(s)};})
.onRequest('session/prompt',async ctx=>{const s=sessions.get(ctx.params.sessionId);await appendFile(${JSON.stringify(audit)},JSON.stringify({...s,pid:process.pid,prompt:ctx.params.prompt})+'\\n');return {stopReason:'end_turn'};})
.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin))); await conn.closed;
`);
  await writeFile(join(home, 'config.toml'), `[search]\nenabled = false\n[agent_executors.neutral-fixture]\nprotocol = "acp-v1"\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\nsupports_mcp = false\n`);
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
  try {
    const created = await client.global.sessions.create({ workDir: home });
    const target = client.session(created.id).agent('main');
    const submit = (nativeAgent: string | null | undefined) => target.prompt({ input: [{ type: 'text', text: 'Neutral fixture input' }],
      execution: { execution: { executor: 'neutral-fixture', overrides: { native_agent: nativeAgent, inject_kiki_mcp: false } } } }, { waitFor: 'terminal' });
    expect(await submit(undefined)).toMatchObject({ state: 'completed' });
    expect(await submit('engine-default')).toMatchObject({ state: 'completed' });
    expect(await submit('specialist')).toMatchObject({ state: 'completed' });
    const session = (await resumeSessionById(server.core.accessor, created.id))!;
    const main = await ensureMainAgent(session);
    const binding = main.accessor.get(IAgentProfileService).data().execution;
    expect(binding?.effective.native_agent).toBe('specialist');
    expect(await submit('unadvertised')).toMatchObject({ state: 'failed' });
    expect(main.accessor.get(IAgentProfileService).data().execution).toEqual(binding);
    expect(await submit(null)).toMatchObject({ state: 'completed' });
    const launches = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { id: string; agent: string; pid: number });
    expect(launches.map(row => row.agent)).toEqual(['factory-main', 'factory-main', 'specialist', 'factory-main']);
    expect(new Set(launches.map(row => row.id)).size).toBe(4);
    expect(new Set(launches.map(row => row.pid)).size).toBe(4);
    expect(main.accessor.get(IAgentProfileService).data().execution?.effective.native_agent).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it.skipIf(!process.env['KIKI_AGY_LIVE_SMOKE'])('live AGY session uses the source native child bridge and returns complete tool receipts', { timeout: 180_000 }, async () => {
  const workspace = fileURLToPath(new URL('../../../.tmp/agent68-live-agy/vertical/', import.meta.url));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), 'kiki-agy-vertical-'));
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const { AgyBridge } = await import(new URL('../../../scripts/external-harness/agy-cli-acp.mjs', import.meta.url).href);
  const bridge = new AgyBridge({ cliPath: process.env['KIKI_AGY_LIVE_SMOKE'], model: 'gemini-3.8-flash-high', auditDir: join(workspace, 'audit') });
  const events: Array<{ ms: number; kind: string; data: unknown }> = [];
  const started = performance.now();
  const record = (kind: string, data: unknown) => events.push({ ms: performance.now() - started, kind, data });
  let lease: Awaited<ReturnType<IHarnessMcpService['acquire']>> | undefined;
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${endpoint}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: workspace } }) });
    const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
    const session = (await resumeSessionById(server.core.accessor, sessionId))!;
    await ensureMainAgent(session);
    const child = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'agy-vertical-child', delegator: { kind: 'agent', agentId: 'main' } });
    child.accessor.get(IAgentPermissionModeService).setMode('yolo');
    for (const source of ['plugin', 'mcp'] as const) child.accessor.get(IAgentToolRegistryService).register({
      name: `${source}_identity_fixture`, description: 'Return the current native child identity.', parameters: { type: 'object', properties: {} },
      resolveExecution: () => ({ approvalRule: `${source}_identity_fixture`, accesses: ToolAccesses.none(), execute: async () => {
        record('native_tool_consumed', { source, agentId: child.id }); return { output: `${source}:${child.id}` };
      } }),
    }, { source });
    lease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: child.id, workspacePath: workspace, nativeTools: true });
    if (!('command' in lease.server)) throw new Error('Expected stdio native bridge');
    const cli = fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts', import.meta.url));
    const loader = new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href;
    const native = { ...lease.server, command: process.execPath,
      args: ['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--import', loader, cli, ...lease.server.args],
      env: [...lease.server.env, { name: 'TSX_TSCONFIG_PATH', value: fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json', import.meta.url)) }],
    };
    const direct = createContextKlient({ endpoint, token: lease.server.env.find(entry => entry.name === 'KIKI_DELEGATION_TOKEN')!.value });
    const directStarted = performance.now();
    expect(await direct.call({ name: 'plugin_identity_fixture', arguments: {} })).toEqual({ output: `plugin:${child.id}` });
    record('native_direct_roundtrip', { ms: performance.now() - directStarted });
    const opened = await bridge.newSession({ cwd: workspace, mcpServers: [native] });
    bridge.setConfig({ sessionId: opened.sessionId, configId: 'effort', value: 'high' });
    record('adapter_session_ready', { sessionId: opened.sessionId });
    const prompt = 'This is one bounded bridge integration task. Using the kiki-harness MCP server, call kiki_AgentNotify exactly once with message "AGY source bridge is connected; parent can consume this evidence.", then call kiki_plugin_identity_fixture and kiki_mcp_identity_fixture once each with empty arguments. Do not use builtin tools, shell, network, or subagents. Reply with both returned identities and nothing else.';
    record('message_accepted', { prompt });
    expect(await bridge.prompt({ sessionId: opened.sessionId, prompt: [{ type: 'text', text: prompt }] }, {
      notify: async (method: string, data: unknown) => record(method, data),
    })).toEqual({ stopReason: 'end_turn' });
    record('turn_final', { sessionId: opened.sessionId });
    const mailbox = await server.core.accessor.get(IAgentCollaborationMessageStore).nextQueued(sessionId, 'main');
    expect(mailbox?.message).toMatchObject({ sourceAgentId: child.id, content: 'AGY source bridge is connected; parent can consume this evidence.' });
    const readyIndex = events.findIndex((row) => row.kind === 'adapter_session_ready');
    const directEvents = events.slice(0, readyIndex >= 0 ? readyIndex : events.length);
    const vendorEvents = readyIndex >= 0 ? events.slice(readyIndex) : [];
    expect(directEvents.filter((row) => row.kind === 'native_tool_consumed').map((row) => row.data)).toEqual([
      { source: 'plugin', agentId: child.id },
    ]);
    expect(vendorEvents.filter((row) => row.kind === 'native_tool_consumed').map((row) => row.data)).toEqual([
      { source: 'mcp', agentId: child.id },
    ]);
    const updates = vendorEvents.filter((row) => row.kind === 'session/update').map((row) => (row.data as { update: { sessionUpdate: string; status?: string; rawOutput?: string; content?: { text?: string } } }).update);
    expect(updates.filter((update) => update.sessionUpdate === 'tool_call')).toHaveLength(3);
    const completed = updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed');
    expect(completed).toHaveLength(3);
    expect(completed.some((update) => typeof update.rawOutput === 'string' && update.rawOutput.includes('queued'))).toBe(true);
    expect(completed.some((update) => update.rawOutput === `plugin:${child.id}`)).toBe(true);
    expect(completed.some((update) => update.rawOutput === `mcp:${child.id}`)).toBe(true);
    const text = updates.filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => update.content?.text).join('');
    expect(text).toContain(`plugin:${child.id}`);
    expect(text).toContain(`mcp:${child.id}`);
  } finally {
    await bridge.close(); record('adapter_closed', {});
    lease?.dispose(); await server.close();
    await writeFile(join(workspace, 'events.json'), JSON.stringify(events, null, 2));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});


it('leases a directly executable SEA or npm MCP command and preserves unknown-host and explicit source launches', { timeout: 60_000 }, async () => {
  const launches = await import('@kiki/agent-core-v2/os/backends/node-local/kikiCliPath');
  const home = await mkdtemp(join(tmpdir(), 'kiki-mcp-launch-'));
  await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
  const entry = join(home, 'main.mjs');
  const cli = fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts', import.meta.url));
  const loader = new URL('../../../build/register-raw-text-loader.mjs', import.meta.url).href;
  await writeFile(entry, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,${JSON.stringify(['--import', pathToFileURL(require.resolve('tsx/esm')).href, '--import', loader, cli])}.concat(process.argv.slice(2)),{stdio:'inherit',env:{...process.env,TSX_TSCONFIG_PATH:${JSON.stringify(fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json', import.meta.url)))}}});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('close',code=>{process.exitCode=code??1;});
`);
  const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  const resolveLaunch = vi.spyOn(launches, 'resolveKikiCliLaunch');
  let lease: Awaited<ReturnType<IHarnessMcpService['acquire']>> | undefined;
  const client = new Client({ name: 'native-launch-fixture', version: '1' });
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${endpoint}/api/sessions`, { method: 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: JSON.stringify({ metadata: { cwd: home } }) });
    const sessionId = ((await created.json()) as { data: { id: string } }).data.id;
    const session = (await resumeSessionById(server.core.accessor, sessionId))!;
    await ensureMainAgent(session);
    const child = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'native-launch-child', delegator: { kind: 'agent', agentId: 'main' } });
    child.accessor.get(IAgentPermissionModeService).setMode('yolo');
    const acquire = () => server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: child.id, workspacePath: home, nativeTools: true });
    resolveLaunch.mockResolvedValue({ kind: 'executable', executable: 'C:/example/kiki-server.exe' });
    lease = await acquire();
    expect(lease.server).toMatchObject({ command: 'C:/example/kiki-server.exe', args: ['mcp', '--workspace', home, '--attached'] });
    lease.dispose();
    resolveLaunch.mockResolvedValue(undefined);
    lease = await acquire();
    expect(lease.server).toMatchObject({ command: 'kiki', args: ['mcp', '--workspace', home, '--attached'] });
    lease.dispose();
    resolveLaunch.mockResolvedValue({ kind: 'node', nodePath: process.execPath, entryPath: entry });
    lease = await acquire();
    expect(lease.server).toMatchObject({ command: process.execPath, args: [entry, 'mcp', '--workspace', home, '--attached'] });
    if (!('command' in lease.server)) throw new Error('Expected stdio native launch');
    const env = Object.fromEntries(lease.server.env.map(({ name, value }) => [name, value]));
    await client.connect(new StdioClientTransport({ command: lease.server.command, args: lease.server.args,
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...env } }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('kiki_MemoryRead');
    const read = await client.callTool({ name: 'kiki_MemoryRead', arguments: { id: 'm_missing' } });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read.content)).toContain('missing');
    expect(resolveLaunch).toHaveBeenCalledWith(expect.objectContaining({ execPath: process.execPath, argv: process.argv }));
  } finally {
    await client.close(); lease?.dispose(); resolveLaunch.mockRestore(); await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
