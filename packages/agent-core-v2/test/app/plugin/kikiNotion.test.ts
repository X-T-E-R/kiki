import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginService } from '#/app/plugin/pluginService';
import { LifecycleScope } from '#/app/scopes';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import { IPluginSkillSource, PluginSkillSource } from '#/workspace/workspaceSkillCatalog/pluginSkillSource';
import { IMcpRegistryService } from '#/app/mcpRegistry/mcpRegistry';
import { McpRegistryService } from '#/app/mcpRegistry/mcpRegistryService';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IProviderService } from '#/kosong/provider/provider';
import { HttpMcpClient } from '#/mcpCore/client-http';
import { McpServerHttpConfigSchema } from '#/mcpCore/config-schema';
import type { MCPToolResult } from '#/mcpCore/types';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';
import { stubLog } from '../../_base/log/stubs';

const here = import.meta.dirname;
const source = path.resolve(here, '../../../../../plugins/official/kiki-notion');
const cleanups: Array<() => Promise<void> | void> = [];
let root: string;

function data(result: MCPToolResult): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}

function pageData(result: MCPToolResult) {
  return z.object({ content: z.string(), title: z.string(), url: z.string() }).passthrough().parse(result.structuredContent);
}

async function fixture(partial = false) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const pages = new Map([
    ['source-a', { title: 'Launch decision', url: 'https://www.notion.so/source-a', content: 'Launch is planned for 18 October.', path: 'Project / Launch' }],
    ['source-b', { title: 'Release gate', url: 'https://www.notion.so/source-b', content: 'A QA pass is required before launch.', path: 'Project / Gate' }],
    ['target', { title: 'Project brief', url: 'https://www.notion.so/target', content: '# Existing notes\nKeep this paragraph.', path: 'Project / Brief' }],
  ]);
  let queued: { target: string; content: string } | undefined;
  let polls = 0;
  const reply = (value: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError,
  });
  const server = new McpServer({ name: 'synthetic-notion', version: '0.0.1' });
  server.registerTool('workspace_access', { description: 'Check tool access for this workspace', inputSchema: {} }, () => {
    calls.push({ name: 'workspace_access', args: {} });
    return reply({ current_tool_access: {
      search: { status: 'available', restricted_parameters: partial ? { 'filters.title_only': 'full_version_required' } : {} },
      fetch: { status: 'available' }, update_page: { status: 'available' },
    } });
  });
  server.registerTool('find_material', { description: 'Search scoped Notion material', inputSchema: { query: z.string(), page_id: z.string(), cursor: z.string().optional() } }, (args) => {
    calls.push({ name: 'find_material', args });
    expect(args.page_id).toBe('project');
    return reply({
      results: [{ id: args.cursor === undefined ? 'source-a' : 'source-b' }],
      next_cursor: args.cursor === undefined ? 'opaque-next' : null,
      notices: partial ? [{ code: 'filter_dropped', fields: ['filters.title_only'] }] : [],
    });
  });
  server.registerTool('read_original', { description: 'Fetch original Notion content or subtree', inputSchema: { id: z.string() } }, (args) => {
    calls.push({ name: 'read_original', args });
    if (args.id === 'private-subtree') return reply({ error: { code: 'object_not_found' } }, true);
    const page = pages.get(args.id);
    if (page === undefined) return reply({ error: { code: 'object_not_found' } }, true);
    return reply({ ...page, id: args.id, page_last_edited_at: '2026-10-03T10:00:00Z',
      truncated: partial && args.id === 'source-a',
      unknown_block_ids: partial && args.id === 'source-a' ? ['private-subtree'] : [],
      unknown_block_count: partial && args.id === 'source-a' ? 2 : 0,
    });
  });
  server.registerTool('patch_page', { description: 'Update specified Notion page content', inputSchema: { page_id: z.string(), old_str: z.string(), new_str: z.string() } }, (args) => {
    calls.push({ name: 'patch_page', args });
    const page = pages.get(args.page_id);
    if (page === undefined || page.content !== args.old_str) return reply({ error: { code: 'validation_error' } }, true);
    queued = { target: args.page_id, content: args.new_str };
    return reply({ object: 'async_task', id: 'task-fixture', status: 'queued', poll_after_seconds: 0 });
  });
  server.registerTool('check_job', { description: 'Get async task status', inputSchema: { task_id: z.string() } }, (args) => {
    calls.push({ name: 'check_job', args });
    expect(args.task_id).toBe('task-fixture');
    if (++polls === 1) return reply({ status: 'running', poll_after_seconds: 0 });
    const page = pages.get(queued!.target)!;
    page.content = queued!.content;
    return reply({ status: 'succeeded', result: { page_id: queued!.target } });
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'notion-fixture-session' });
  await server.connect(transport);
  const http = createServer((req, res) => { void transport.handleRequest(req, res); });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
  const client = new HttpMcpClient({ transport: 'http', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp` });
  cleanups.push(() => client.close());
  await client.connect();
  const tools = await client.listTools();
  const byDescription = (description: string) => tools.find((tool) => tool.description === description)!.name;
  return { client, calls, pages, byDescription };
}

beforeEach(async () => {
  const scratch = path.resolve(here, '../../../../../.tmp');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, 'notion-plugin-'));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await rm(root, { recursive: true, force: true });
});

describe('kiki-notion install and scripted MCP contract', () => {
  it('installs through consent into an isolated home and exposes the real MCP config and loadable skill', async () => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'notion-test');
    registerScopedService(LifecycleScope.App, ISkillDiscovery, FileSkillDiscovery, ScopeActivation.OnDemand, 'notion-test');
    registerScopedService(LifecycleScope.App, IPluginSkillSource, PluginSkillSource, ScopeActivation.OnDemand, 'notion-test');
    registerScopedService(LifecycleScope.App, IMcpRegistryService, McpRegistryService, ScopeActivation.OnDemand, 'notion-test');
    const home = path.join(root, 'home');
    await mkdir(home);
    const host: ScopedTestHost = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(home)),
      stubPair(ILogService, stubLog()),
      stubPair(IProviderService, stubProviderService()),
      stubPair(IConfigService, { _serviceBrand: undefined, ready: Promise.resolve(), get: () => ({}), replace: async () => {} } as unknown as IConfigService),
      stubPair(IMcpConfigStore, { path: path.join(home, 'mcp.json'), list: async () => [] } as unknown as IMcpConfigStore),
      stubPair(IHostFileSystem, {} as IHostFileSystem),
      stubPair(IAtomicDocumentStore, {} as IAtomicDocumentStore),
    ]);
    cleanups.push(() => { host.dispose(); });
    const plugins = host.app.accessor.get(IPluginService);
    const plan = await plugins.previewPlugin({ source });
    expect(plan.consentRequired).toBe(true);
    expect(plan.contributions).toEqual(['skill:0', 'mcp:notion']);
    await expect(plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: false })).rejects.toThrow();
    const installed = await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
    expect(installed.id).toBe('kiki-notion');
    expect(installed.enabled).toBe(false);
    expect(await plugins.enabledMcpServers()).toEqual({});
    const skillSource = host.app.accessor.get(IPluginSkillSource);
    expect((await skillSource.load()).skills).toEqual([]);
    await plugins.setPluginEnabled({ id: installed.id, enabled: true });
    const entry = (await host.app.accessor.get(IMcpRegistryService).list())[0]!;
    expect(entry).toMatchObject({ name: 'plugin-kiki-notion:notion', source: 'plugin', origin: 'kiki-notion', mutable: false });
    expect(McpServerHttpConfigSchema.parse(entry.config)).toEqual({ transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', enabled: true });
    expect(await plugins.enabledMcpServers()).toEqual({ [entry.name]: entry.config });
    const discovered = await skillSource.load();
    expect(discovered.skipped).toEqual([]);
    expect(discovered.skills).toHaveLength(1);
    const skill = discovered.skills[0]!;
    expect(skill.name).toBe('notion-workspace');
    expect(skill.plugin?.id).toBe('kiki-notion');
    expect(skill.path.replaceAll('\\', '/')).toContain('/home/plugins/managed/kiki-notion/');
    expect(skill.content).toContain('A summary-only request ends at the local artifact.');
    for (const resource of ['references/service-behavior.md', 'assets/brief-template.md']) {
      expect(skill.content).toContain(resource);
      expect((await readFile(path.join(skill.dir, resource), 'utf8')).length).toBeGreaterThan(100);
    }
    const info = await plugins.getPluginInfo({ id: installed.id });
    expect(info.diagnostics.filter((item) => item.severity === 'error' || item.severity === 'warn')).toEqual([]);
  });

  it('consumes two scoped search pages through the native HTTP client, reads originals, saves citations, writes the explicit target and reads back after async success', async () => {
    const f = await fixture();
    const access = f.byDescription('Check tool access for this workspace');
    const search = f.byDescription('Search scoped Notion material');
    const fetch = f.byDescription('Fetch original Notion content or subtree');
    const update = f.byDescription('Update specified Notion page content');
    const status = f.byDescription('Get async task status');
    expect(data(await f.client.callTool(access, {}))['current_tool_access']).toMatchObject({ search: { status: 'available' } });
    const first = data(await f.client.callTool(search, { query: 'launch', page_id: 'project' }));
    const second = data(await f.client.callTool(search, { query: 'launch', page_id: 'project', cursor: first['next_cursor'] }));
    expect(second['next_cursor']).toBeNull();
    const ids = z.array(z.object({ id: z.string() })).parse([...z.array(z.unknown()).parse(first['results']), ...z.array(z.unknown()).parse(second['results'])]).map((item) => item.id);
    expect(ids).toEqual(['source-a', 'source-b']);
    const originals = await Promise.all(ids.map(async (id) => pageData(await f.client.callTool(fetch, { id }))));
    const brief = '# Launch brief\n\n' + originals.map((page) => `${page.content} [${page.title}](${page.url})`).join('\n\n') + '\n\nCoverage: Project; two original pages read; retrieved 2026-10-04.\n';
    const artifact = path.join(root, 'launch-brief.md');
    await writeFile(artifact, brief);
    expect(await readFile(artifact, 'utf8')).toContain('Launch is planned for 18 October.');
    expect(brief).toContain('A QA pass is required before launch.');
    expect(brief).toContain('https://www.notion.so/source-a');
    expect(brief).toContain('https://www.notion.so/source-b');
    const target = pageData(await f.client.callTool(fetch, { id: 'target' }));
    const written = data(await f.client.callTool(update, { page_id: 'target', old_str: target.content, new_str: `${target.content}\n\n${brief}` }));
    expect(written['object']).toBe('async_task');
    expect(data(await f.client.callTool(status, { task_id: written['id'] }))['status']).toBe('running');
    expect(f.pages.get('target')!.content).toBe('# Existing notes\nKeep this paragraph.');
    expect(data(await f.client.callTool(status, { task_id: written['id'] }))['status']).toBe('succeeded');
    const readBack = pageData(await f.client.callTool(fetch, { id: 'target' }));
    expect(readBack.content).toBe(`# Existing notes\nKeep this paragraph.\n\n${brief}`);
    expect(f.calls.filter((call) => call.name === update)).toHaveLength(1);
  });

  it('keeps dropped-filter and inaccessible-subtree evidence in a partial local artifact without a remote write', async () => {
    const f = await fixture(true);
    const search = f.byDescription('Search scoped Notion material');
    const fetch = f.byDescription('Fetch original Notion content or subtree');
    const result = data(await f.client.callTool(search, { query: 'launch', page_id: 'project' }));
    expect(result['notices']).toEqual([{ code: 'filter_dropped', fields: ['filters.title_only'] }]);
    const page = pageData(await f.client.callTool(fetch, { id: 'source-a' }));
    expect(page['truncated']).toBe(true);
    expect(page['unknown_block_count']).toBe(2);
    const missing = await f.client.callTool(fetch, { id: z.array(z.string()).parse(page['unknown_block_ids'])[0] });
    expect(missing.isError).toBe(true);
    expect(data(missing)).toEqual({ error: { code: 'object_not_found' } });
    const artifact = path.join(root, 'partial-brief.md');
    await writeFile(artifact, `# Partial launch brief\n\n${page.content} [Launch](${page.url})\n\nCoverage: title_only filter dropped; not strict title matches. Two omitted subtree roots; one ID returned, inaccessible or missing (object_not_found); another root unresolved. Remote write not requested.\n`);
    const saved = await readFile(artifact, 'utf8');
    expect(saved).toContain('not strict title matches');
    expect(saved).toContain('another root unresolved');
    expect(f.calls.map((call) => call.name)).not.toContain('patch_page');
    expect(f.pages.get('target')!.content).toBe('# Existing notes\nKeep this paragraph.');
  });
});
