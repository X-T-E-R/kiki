import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import { StdioMcpClient } from '#/mcpCore/client-stdio';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { BrowserConnectionsTool, BrowserTabsTool, projectBrowserToolSchema, validateBrowserValues } from '#/agent/tools/browser/browserTools';
import { estimateTokensForTools } from '#/kosong/contract/tokens';
import { browserResponse, BrowserControlService, isBrowserOperation } from '#/app/browser/browserControlService';
import { browserRuntimeResolver, IBrowserBackendFactory } from '#/app/browser/browserBackend';
import { IBrowserControlService } from '#/app/browser/browser';
import { IBrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { compileToolArgsValidator } from '#/tool/args-validator';
import { IFlagService } from '#/app/flag/flag';

const driver = process.env['KIKI_BROWSER_TEST_DRIVER'];
const fixture = fileURLToPath(new URL('./fixtures/native-daemon.mjs', import.meta.url));
function createClient(root: string, session: string, namespace: string): StdioMcpClient {
  const runtime = Object.assign(new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' },
    { capabilities: ['process'], pathClass: 'win32', environment: { osKind: 'Windows' } }), { process: new HostProcessService() });
  const env = { AGENT_BROWSER_CONFIG: join(root, 'config.json'), AGENT_BROWSER_SOCKET_DIR: root, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_NAMESPACE: namespace };
  return new StdioMcpClient({ transport: 'stdio', command: driver!, args: ['mcp', '--tools', 'all'], env }, {
    runtimeResolver: browserRuntimeResolver({ _serviceBrand: undefined, inspect: () => runtime, acquire: () => ({ runtime, track: (resource) => resource, dispose: () => undefined }) }, env),
    workspaceId: 'fixture', runtimeId: 'local', defaultCwd: root, computerControl: false, toolCallTimeoutMs: 10_000,
  });
}

async function daemon(root: string, session: string, namespace: string, id: string) {
  const child = spawn(process.execPath, [fixture, root, session, namespace, id], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', (code) => reject(new Error(`Fixture exited: ${code}`))); });
  return child;
}

describe.skipIf(driver === undefined || process.platform !== 'win32')('real managed agent-browser MCP with isolated daemon fixture (not a real browser)', () => {
  it('runs Kiki control selection, reference ownership and confirmed disconnect over the real managed MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-browser-control-native-'));
    const child = await daemon(root, 'controlled', 'fixture', 'controlled');
    const client = createClient(root, 'controlled', 'fixture');
    const ix = new TestInstantiationService();
    ix.stub(IFlagService, { enabled: () => true });
    const config = { id: 'controlled', type: 'agent-browser-profile' as const, name: 'Controlled', enabled: true };
    ix.stub(IBrowserConnectionStore, { _serviceBrand: undefined, resolve: async () => config,
      list: async () => ({ connections: [config] }), upsert: async () => config, remove: async () => undefined,
      setDefault: async () => undefined, revealEndpoint: async () => undefined });
    ix.stub(IBrowserBackendFactory, { _serviceBrand: undefined, open: async () => {
      await client.connect();
      return { client, runtime: new FakeRuntime({ workspaceId: 'fixture', runtimeId: 'local', generation: '1' }),
        version: '0.38.2', namespace: 'fixture', session: 'controlled', profilePath: join(root, 'profile'), close: () => client.close() };
    } });
    ix.set(IBrowserControlService, new SyncDescriptor(BrowserControlService));
    const control = ix.get(IBrowserControlService);
    try {
      await writeFile(join(root, 'config.json'), '{}');
      expect((await control.connect('controlled')).state).toBe('ready');
      const input = { browser: 'controlled', caller: { sessionId: 'test', agentId: 'main' }, tab: 'controlled-target', tool: 'agent_browser_snapshot', args: {} };
      expect(browserResponse((await control.invoke(input)).result).success).toBe(true);
      const clicked = await control.invoke({ ...input, tool: 'agent_browser_click', args: { selector: '@e1' } });
      expect(browserResponse(clicked.result).data).toMatchObject({ targetId: 'controlled-target' });
      const commands = JSON.parse(await readFile(join(root, 'controlled-commands.json'), 'utf8')) as { action: string }[];
      expect(commands.filter((command) => command.action === 'tab_switch')).toHaveLength(1);
      await control.invoke(input);
      await expect(control.invoke({ ...input, caller: { sessionId: 'test', agentId: 'child' }, tool: 'agent_browser_click', args: { selector: '@e1' } })).rejects.toMatchObject({ code: 'browser.target' });
      expect((await control.disconnect('controlled')).state).toBe('disconnected');
      expect(child.exitCode).toBe(0);
    } finally {
      await ix.dispose();
      await client.close();
      if (child.exitCode === null) { const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill(); await exited; }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it('discovers every schema, validates first/middle/last-page calls, and does not start a browser during discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-browser-catalog-'));
    const client = createClient(root, 'catalog', 'fixture');
    try {
      await writeFile(join(root, 'config.json'), '{}');
      await client.connect();
      const tools = await client.listTools();
      expect(tools.length).toBe(156);
      expect((await client.callTool(tools[0]!.name, {})).isError).toBe(false);
      await expect(client.callTool(tools[64]!.name, {})).rejects.toThrow('username must be a string');
      await expect(client.callTool(tools[155]!.name, {})).rejects.toThrow('message must be a string');
      const operations = tools.filter((tool) => isBrowserOperation(tool.name));
      for (const tool of operations) compileToolArgsValidator(projectBrowserToolSchema(tool));
      const service = { _serviceBrand: undefined, connections: async () => ({ output: '' }), tabs: async () => ({ output: '' }) };
      const native = [new BrowserConnectionsTool(service), new BrowserTabsTool(service)].map(({ name, description, parameters }) => ({ name, description, parameters }));
      const selected = operations.filter((tool) => ['agent_browser_snapshot', 'agent_browser_fill', 'agent_browser_network_requests', 'agent_browser_eval'].includes(tool.name)).map((tool) => ({ name: `browser__${tool.name}`, description: tool.description, parameters: projectBrowserToolSchema(tool) }));
      console.log('Browser schema footprint', JSON.stringify({ catalogCount: tools.length, operationCount: operations.length,
        nativeCount: native.length, nativeBytes: Buffer.byteLength(JSON.stringify(native)), nativeEstimatedTokens: estimateTokensForTools(native),
        selectedCount: selected.length, selectedBytes: Buffer.byteLength(JSON.stringify(selected)), selectedEstimatedTokens: estimateTokensForTools(selected),
        estimation: 'existing Kiki ASCII/4 heuristic; not provider token measurement' }));
      if (process.env['KIKI_BROWSER_SCHEMA_OUTPUT'] !== undefined) await writeFile(process.env['KIKI_BROWSER_SCHEMA_OUTPUT'], JSON.stringify({ native, selected }, null, 2));
      const info = browserResponse(await client.callTool('agent_browser_session_info', {}));
      expect(info.data).toMatchObject({ active: false, pid: null, runtime: null });
    } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('maps native typed tab/frame/refs/upload/download to the selected daemon without replaying a lost response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-browser-native-'));
    const aDaemon = await daemon(root, 'a', 'fixture', 'a');
    const bDaemon = await daemon(root, 'b', 'fixture', 'b');
    const a = createClient(root, 'a', 'fixture');
    const b = createClient(root, 'b', 'fixture');
    const file = join(root, 'upload.txt');
    const destination = join(root, 'b-download.txt');
    try {
      await writeFile(join(root, 'config.json'), '{}');
      await Promise.all([a.connect(), b.connect()]);
      expect(browserResponse(await a.callTool('agent_browser_tab_list', {})).data?.['tabs']).toMatchObject([{ targetId: 'a-target' }]);
      expect(browserResponse(await b.callTool('agent_browser_tab_list', {})).data?.['tabs']).toMatchObject([{ targetId: 'b-target' }]);
      await a.callTool('agent_browser_tab_switch', { tab: 'a-target' });
      await a.callTool('agent_browser_frame_switch', { frame: '#embedded' });
      expect(browserResponse(await a.callTool('agent_browser_snapshot', {})).data?.['refs']).toMatchObject({ '@e1': { name: 'a' } });
      expect(browserResponse(await a.callTool('agent_browser_click', { selector: '@e1' })).data).toMatchObject({ targetId: 'a-target', frame: '#embedded' });
      await writeFile(file, 'fixture upload');
      expect(browserResponse(await a.callTool('agent_browser_upload', { selector: '#upload', files: [file] })).data).toMatchObject({ uploaded: 1, values: ['fixture upload'] });
      expect(browserResponse(await b.callTool('agent_browser_download', { selector: '#download', path: destination })).data).toEqual({ path: destination });
      expect(await readFile(destination, 'utf8')).toBe('download-from-b');
      validateBrowserValues({ script: 'document.title = "--session"' });
      const lost = await a.callTool('agent_browser_click', { selector: '#lose-response' });
      expect(lost.isError).toBe(true);
      expect(JSON.stringify(lost.structuredContent)).toContain('outcome_unknown');
      const commands = JSON.parse(await readFile(join(root, 'a-commands.json'), 'utf8')) as { action: string; selector?: string }[];
      expect(commands.filter((command) => command.action === 'click' && command.selector === '#lose-response')).toHaveLength(1);
      const close = browserResponse(await a.callTool('agent_browser_close', { all: false }));
      expect(close.data).toEqual({ closed: true });
      await new Promise<void>((resolve) => aDaemon.once('exit', () => resolve()));
      expect(browserResponse(await a.callTool('agent_browser_session_info', {})).data).toMatchObject({ active: false, pid: null, runtime: null });
      expect(browserResponse(await b.callTool('agent_browser_session_info', {})).data?.['active']).toBe(true);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await Promise.all([aDaemon, bDaemon].map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        await exited;
      }));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});
