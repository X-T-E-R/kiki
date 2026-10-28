import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpTool } from '#/agent/mcp/tools/mcp';
import { mcpResultToExecutableOutput } from '#/agent/mcp/output';
import { ErrorCodes } from '#/errors';
import {
  computerExecutorKind,
  computerSelectionAdmits,
  computerToolDescription,
  isComputerMcpConfig,
  isWindowsMcpServeReady,
  notifyComputerAdmission,
  setComputerConnectionSelection,
  windowsMcpStdioConfig,
} from '#/mcpCore/computer';
import { computerSpawnHeld, StdioMcpClient, type StdioMcpClientOptions } from '#/mcpCore/client-stdio';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { toMcpServerConfigView } from '#/mcpCore/configView';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { hostProcessPathClass } from './stubs';

const windows = windowsMcpStdioConfig('C:\\Env\\python.exe', 'C:\\Kiki\\windows-mcp\\config.toml');
const cua: McpServerConfig = { transport: 'stdio', command: 'C:\\driver\\cua-driver.exe', args: ['mcp'] };
const schemaFixture = fileURLToPath(new URL('./fixtures/windows-mcp-schema-stdio-server.mjs', import.meta.url));
const computerFixture = fileURLToPath(new URL('./fixtures/computer-stdio-server.mjs', import.meta.url));

afterEach(() => {
  setComputerConnectionSelection(undefined);
});

function runtime() {
  return Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      { capabilities: ['process'], pathClass: hostProcessPathClass, environment: { osKind: 'Windows' } },
    ),
    { process: new HostProcessService() },
  );
}

function createClient(config: McpServerConfig, options: Partial<StdioMcpClientOptions> = {}): StdioMcpClient {
  const bound = runtime();
  return new StdioMcpClient(config.transport === 'stdio' ? config : { transport: 'stdio', command: process.execPath, args: [computerFixture] }, {
    runtimeResolver: {
      _serviceBrand: undefined,
      inspect: () => bound,
      acquire: () => ({ runtime: bound, track: (resource) => resource, dispose: () => {} }),
    },
    workspaceId: 'workspace',
    runtimeId: 'local',
    defaultCwd: process.cwd(),
    ...options,
  });
}

describe('computer executor selection', () => {
  it('keeps the cua basename path and does not treat ordinary Python, uvx, or install as a servable desktop', () => {
    expect(isComputerMcpConfig(cua)).toBe(true);
    expect(computerExecutorKind(cua)).toBe('cua');
    expect(isComputerMcpConfig({ transport: 'stdio', command: 'C:\\Python\\python.exe', args: ['server.py'] })).toBe(false);
    expect(isComputerMcpConfig({ transport: 'stdio', command: 'python', args: ['-m', 'other_mcp'] })).toBe(false);
    expect(isComputerMcpConfig({ transport: 'stdio', command: 'uvx', args: ['windows-mcp@latest'] })).toBe(false);
    expect(isComputerMcpConfig({ transport: 'stdio', command: 'uv', args: ['run', 'windows-mcp'] })).toBe(false);
    const install = { transport: 'stdio' as const, command: 'C:\\Env\\python.exe', args: ['-m', 'windows_mcp', 'install'] };
    expect(computerExecutorKind(install)).toBe('windows-mcp');
    expect(isWindowsMcpServeReady(install)).toBe(false);
    expect(computerSpawnHeld('kiki-windows-mcp', install)).toBe(true);
    expect(isWindowsMcpServeReady({ ...windows, executor: 'kaos' })).toBe(false);
    expect(isWindowsMcpServeReady(windows)).toBe(true);
    expect(computerSelectionAdmits('kiki-computer', cua)).toBe(true);
    expect(computerSelectionAdmits('kiki-windows-mcp', windows)).toBe(false);
    setComputerConnectionSelection('kiki-windows-mcp');
    expect(computerSelectionAdmits('kiki-computer', cua)).toBe(false);
    expect(computerSelectionAdmits('kiki-windows-mcp', windows)).toBe(true);
    expect(computerSelectionAdmits('python-tools', { transport: 'stdio', command: 'python', args: ['server.py'] })).toBe(false);

    const readyView = toMcpServerConfigView(windows);
    expect(readyView).toMatchObject({
      transport: 'stdio',
      envKeys: ['ANONYMIZED_TELEMETRY', 'WINDOWS_MCP_WATCHDOG'],
      computerServeReady: true,
    });
    expect('env' in readyView).toBe(false);

    const telemetryTrue = { ...windows, env: { ...windows.env, ANONYMIZED_TELEMETRY: 'true' } };
    expect(isWindowsMcpServeReady(telemetryTrue)).toBe(false);
    expect(computerSelectionAdmits('kiki-windows-mcp', telemetryTrue)).toBe(false);
    const notReadyView = toMcpServerConfigView(telemetryTrue);
    expect(notReadyView).toMatchObject({
      transport: 'stdio',
      envKeys: ['ANONYMIZED_TELEMETRY', 'WINDOWS_MCP_WATCHDOG'],
      computerServeReady: false,
    });
    expect('env' in notReadyView).toBe(false);
    expect(toMcpServerConfigView(cua)).toMatchObject({ computerServeReady: undefined });
  });

  it('adds input recovery to Windows-MCP actions without claiming screenshot is a replayable observation', () => {
    expect(computerToolDescription('Click', 'Click a point.')).toContain('do not replay');
    expect(computerToolDescription('Scroll', 'Scroll the desktop.')).toContain('do not replay');
    expect(computerToolDescription('Screenshot', 'Capture the desktop.')).not.toContain('do not replay');
    expect(computerToolDescription('type_text', 'Type.')).toContain('do not replay');
  });

  it('does not spawn Windows-MCP until it is selected and no other computer process occupies the desktop', async () => {
    const bound = runtime();
    const manager = new McpConnectionManager({
      runtimeResolver: {
        _serviceBrand: undefined,
        inspect: () => bound,
        acquire: () => ({ runtime: bound, track: (resource) => resource, dispose: () => {} }),
      },
      workspaceId: 'workspace',
      runtimeId: 'local',
      stdioCwd: process.cwd(),
    });
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    const windowsSpawns = () => spawn.mock.calls.filter((call) => call[1]?.includes('windows_mcp') === true);
    const occupant = createClient({ transport: 'stdio', command: process.execPath, args: [computerFixture] }, { computerControl: true, serverName: 'occupant' });
    try {
      await manager.connectAll({ 'kiki-windows-mcp': windows });
      expect(manager.get('kiki-windows-mcp')).toMatchObject({ status: 'disabled', error: 'computer-admission-held' });
      expect(windowsSpawns()).toHaveLength(0);
      await occupant.connect();
      setComputerConnectionSelection('kiki-windows-mcp');
      await vi.waitFor(() => expect(manager.get('kiki-windows-mcp')?.error).toBe('computer-admission-held'));
      expect(windowsSpawns()).toHaveLength(0);
      await occupant.close();
      notifyComputerAdmission();
      await vi.waitFor(() => expect(windowsSpawns().length).toBeGreaterThan(0));
    } finally {
      setComputerConnectionSelection(undefined);
      await occupant.close().catch(() => undefined);
      await manager.shutdown();
      spawn.mockRestore();
    }
  });

  it('leaves an in-flight computer call running when the selection changes and does not replay a lost Windows-MCP call', async () => {
    const client = createClient(
      { transport: 'stdio', command: process.execPath, args: [schemaFixture] },
      { computerControl: true, serverName: 'schema' },
    );
    try {
      await client.connect();
      expect((await client.listTools()).map((tool) => tool.name)).toEqual([
        'ControlStatus', 'DisplayInventory', 'Screenshot', 'Snapshot', 'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'Wait', 'WaitFor', 'App',
      ]);
      const shot = client.callTool('Screenshot', {});
      setComputerConnectionSelection('kiki-computer');
      const result = await shot;
      expect(result.content.some((block) => block.type === 'image' && block.mimeType === 'image/png')).toBe(true);
      const output = await mcpResultToExecutableOutput(result, 'mcp__kiki-windows-mcp__Screenshot', { preserveStructuredContent: true });
      const parts = Array.isArray(output.output) ? output.output : [];
      expect(parts.some((part) => part.type === 'image_url')).toBe(true);
    } finally {
      await client.close();
    }

    let calls = 0;
    const failing = {
      async listTools() { return []; },
      async ping() { throw new Error('closed'); },
      async callTool() { calls += 1; throw new Error('stdio closed'); },
    };
    const tool = createMcpTool('mcp__kiki-windows-mcp__Scroll', {
      name: 'Scroll', description: 'Scroll', parameters: {},
    }, failing, { computerControl: true, reconnect: async () => failing });
    const resolved = tool.resolveExecution({});
    const execution = resolved instanceof Promise ? await resolved : resolved;
    if (execution.isError === true) throw new Error('expected a call');
    await expect(execution.execute({ turnId: 1, toolCallId: 'scroll', signal: new AbortController().signal })).rejects.toMatchObject({
      code: ErrorCodes.MCP_COMPUTER_OUTCOME_UNKNOWN,
    });
    expect(calls).toBe(1);
  });
});
