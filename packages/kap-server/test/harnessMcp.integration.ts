import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IHarnessMcpService, IAgentProfileService, ensureMainAgent, resumeSessionById } from '@kiki/agent-core-v2';
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
      const grokLease = await server.core.accessor.get(IHarnessMcpService).acquire({ sessionId, agentId: main.id, workspacePath: home, executorId: 'grok-acp', hooks: true });
      try {
        expect(await grokLease.contextHook!('Stop')).toContain('Keep the context contract stable');
        expect(await grokLease.contextHook!('Stop')).toBe('');
      } finally { grokLease.dispose(); }
      await expect(grokLease.contextHook!('Stop')).rejects.toThrow('closed');
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
