import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isComputerMcpConfig, computerToolDescription } from '#/mcpCore/computer';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';

import { Error2 } from '#/errors';
import { mergeStdioEnv, StdioMcpClient, captureComputerMcpStop, allowComputerMcp, type StdioMcpClientOptions } from '#/mcpCore/client-stdio';
import type { McpServerStdioConfig } from '#/mcpCore/config-schema';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';

import {
  crashAfterConnectFixture,
  cwdStdioFixture,
  hostProcessPathClass,
  stderrThenExitFixture,
  stdioFixture,
} from './stubs';

function createClient(
  config: McpServerStdioConfig,
  options: Partial<StdioMcpClientOptions> = {},
  osKind = 'Linux',
): StdioMcpClient {
  const runtime = Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      { capabilities: ['process'], pathClass: hostProcessPathClass, environment: { osKind } },
    ),
    { process: new HostProcessService() },
  );
  return new StdioMcpClient(config, {
    runtimeResolver: {
      _serviceBrand: undefined,
      inspect: () => runtime,
      acquire: () => ({
        runtime,
        track: (resource) => resource,
        dispose: () => {},
      }),
    },
    workspaceId: 'workspace',
    runtimeId: 'local',
    defaultCwd: process.cwd(),
    ...options,
  });
}

describe('StdioMcpClient', () => {
  it('round-trips per-call metadata and all elicitation outcomes without retaining the previous caller', async () => {
    const script = fileURLToPath(new URL('./fixtures/elicitation-stdio-server.mjs', import.meta.url));
    const client = createClient({ transport: 'stdio', command: process.execPath, args: [script] }, { elicitation: true });
    try {
      await client.connect();
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(['elicit']);
      for (const action of ['accept', 'decline', 'cancel'] as const) {
        const meta = { 'x-codex-turn-metadata': JSON.stringify({ session_id: 'kiki:fixture:main', turn_id: `kiki:${action}` }) };
        const result = await client.callTool('elicit', { message: action }, undefined, {
          meta, elicit: async (request) => { expect(request.message).toBe(action); return action === 'accept' ? { action, content: {} } : { action }; },
        });
        expect(result.structuredContent).toMatchObject({ caller: meta, result: { action }, capabilities: { elicitation: { form: {} } } });
      }
      const missing = await client.callTool('elicit', { message: 'no caller' });
      expect(missing.structuredContent).toMatchObject({ result: { action: 'cancel' } });
    } finally { await client.close(); }
  });

  it('keeps the current elicitation caller isolated from a concurrent call', async () => {
    const script = fileURLToPath(new URL('./fixtures/elicitation-stdio-server.mjs', import.meta.url));
    const client = createClient({ transport: 'stdio', command: process.execPath, args: [script] }, { elicitation: true });
    let release!: () => void;
    const decision = new Promise<void>((resolve) => { release = resolve; });
    const elicit = vi.fn(async () => { await decision; return { action: 'decline' as const }; });
    try {
      await client.connect();
      const first = client.callTool('elicit', { message: 'owner' }, undefined, { elicit });
      await vi.waitFor(() => expect(elicit).toHaveBeenCalledOnce());
      await expect(client.callTool('elicit', { message: 'other' })).rejects.toMatchObject({ code: 'mcp.computer_busy' });
      release();
      expect((await first).structuredContent).toMatchObject({ result: { action: 'decline' } });
    } finally { release(); await client.close(); }
  });

  it('cancels a pending elicitation when its client closes', async () => {
    const script = fileURLToPath(new URL('./fixtures/elicitation-stdio-server.mjs', import.meta.url));
    const client = createClient({ transport: 'stdio', command: process.execPath, args: [script] }, { elicitation: true });
    let elicitationSignal: AbortSignal | undefined;
    const elicit = vi.fn(async (_request: unknown, signal: AbortSignal) => {
      elicitationSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { action: 'cancel' as const };
    });
    try {
      await client.connect();
      const work = client.callTool('elicit', { message: 'pending' }, undefined, { elicit }).catch(() => undefined);
      await vi.waitFor(() => expect(elicit).toHaveBeenCalledOnce());
      await client.close();
      await work;
      expect(elicitationSignal?.aborted).toBe(true);
    } finally { await client.close(); }
  });
  const computerFixture = fileURLToPath(new URL('./fixtures/computer-stdio-server.mjs', import.meta.url));
  const computerClient = (options: Partial<StdioMcpClientOptions> = {}, env?: Record<string, string>) =>
    createClient({ transport: 'stdio', command: process.execPath, args: [computerFixture], env },
      { computerControl: true, ...options });

  it('discovers all 151 tools through real stdio SDK pagination requests', async () => {
    const client = createClient({ transport: 'stdio', command: process.execPath, args: [computerFixture],
      env: { KIKI_TEST_TOOL_PAGES: '1' } });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(Array.from({ length: 151 }, (_, index) => `tool_${index}`));
      expect(tools[150]?.inputSchema).toEqual({ type: 'object', properties: {} });
    } finally { await client.close(); }
  });

  it('recognizes direct cua MCP configuration without treating other commands as cua', () => {
    expect(isComputerMcpConfig({ transport: 'stdio', command: 'C:\\driver\\cua-driver.exe', args: ['mcp'] })).toBe(true);
    expect(isComputerMcpConfig({ transport: 'stdio', command: '/opt/cua-driver', args: ['mcp'] })).toBe(true);
    expect(isComputerMcpConfig({ transport: 'stdio', command: 'other', args: ['mcp'] })).toBe(false);
    expect(isComputerMcpConfig({ transport: 'stdio', command: 'cua-driver', args: ['doctor'] })).toBe(false);
  });

  it('adds cautious guidance to observations and preserves action recovery in both preferences', () => {
    const observation = computerToolDescription('list_windows', 'List exact windows.');
    expect(observation).toContain('List exact windows.');
    expect(observation).toContain('generally avoid computer control unless');
    expect(observation).not.toContain('observe again');
    for (const preference of ['avoid', 'prefer'] as const) {
      expect(computerToolDescription('type_text', 'Type foreground text.', preference)).toContain('observe again');
      const upstream = 'Click the exact window. Do not replay unconfirmed input.';
      expect(computerToolDescription('click', upstream, preference).split(upstream)).toHaveLength(2);
    }
    expect(computerToolDescription('screenshot', 'Observe.', 'prefer')).toContain('prefer computer control for suitable interactive tasks');
  });

  it('captures running children and closes admission before any awaited stop work', async () => {
    const name = 'capture-fixture';
    const config: McpServerStdioConfig = { transport: 'stdio', command: process.execPath, args: [computerFixture] };
    const client = createClient(config, { serverName: name, computerControl: true });
    try {
      await client.connect();
      const stop = captureComputerMcpStop(name, config);
      await expect(client.callTool('type_text', {})).rejects.toMatchObject({ code: 'mcp.server_disabled' });
      const repeated = captureComputerMcpStop(name, config);
      expect((await stop()).state).toBe('stopped');
      expect((await repeated()).state).toBe('stopped');
      expect((await captureComputerMcpStop(name, config)()).state).toBe('idle');
    } finally { await client.close(); allowComputerMcp(name, config); }
  });

  it('waits for an in-progress child spawn before confirming a scoped stop', async () => {
    const name = 'starting-fixture';
    const config: McpServerStdioConfig = { transport: 'stdio', command: process.execPath, args: [computerFixture] };
    const spawnOriginal = HostProcessService.prototype.spawn;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn').mockImplementation(async function (this: HostProcessService, ...args) {
      await wait;
      return spawnOriginal.apply(this, args);
    });
    const client = createClient(config, { serverName: name, computerControl: true });
    try {
      const connecting = client.connect().catch((error: unknown) => error);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      let stopped = false;
      const stopping = captureComputerMcpStop(name, config)().then((result) => { stopped = true; return result; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release();
      expect((await stopping).state).toBe('stopped');
      await connecting;
      const process = await spawn.mock.results[0]!.value;
      expect(process.exitCode).not.toBeNull();
    } finally { release(); await client.close(); spawn.mockRestore(); allowComputerMcp(name, config); }
  });

  it('releases a failed spawn without claiming a child remains active', async () => {
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn').mockRejectedValueOnce(new Error('fixture spawn failure'));
    const first = computerClient();
    const second = computerClient();
    try {
      await expect(first.connect()).rejects.toThrow('fixture spawn failure');
      await second.connect();
      expect((await second.callTool('type_text', { delay: 1 })).isError).toBe(false);
    } finally { await first.close(); await second.close(); spawn.mockRestore(); }
  });

  it('retains occupancy after a tool deadline even if the late response is discarded, then recovers after EOF exit', async () => {
    const first = computerClient({ toolCallTimeoutMs: 20 });
    const second = computerClient();
    try {
      await first.connect(); await second.connect();
      await expect(first.callTool('type_text', { delay: 100 })).rejects.toThrow();
      await expect(second.callTool('type_text', {})).rejects.toMatchObject({ code: 'mcp.computer_busy' });
      await first.close();
      expect((await second.callTool('type_text', { delay: 1 })).isError).toBe(false);
    } finally { await first.close(); await second.close(); }
  });

  it('reports unconfirmed exit on kill failure and keeps admission blocked until actual child exit', async () => {
    const name = 'kill-failure-fixture';
    const config: McpServerStdioConfig = { transport: 'stdio', command: process.execPath, args: [computerFixture], env: { KIKI_TEST_IGNORE_EOF: '1' } };
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    const first = createClient(config, { computerControl: true, serverName: name, drainTimeoutMs: 20 });
    const second = computerClient();
    let kill: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await first.connect(); await second.connect();
      const process = await spawn.mock.results[0]!.value;
      kill = vi.spyOn(process, 'kill').mockRejectedValue(new Error('fixture termination failure'));
      expect((await captureComputerMcpStop(name, config)()).state).toBe('unconfirmed');
      await expect(second.callTool('type_text', {})).rejects.toMatchObject({ code: 'mcp.computer_busy' });
      expect((await captureComputerMcpStop(name, config)()).state).toBe('unconfirmed');
      kill.mockRestore();
      await process.kill(); await process.wait();
      expect((await second.callTool('type_text', { delay: 1 })).isError).toBe(false);
    } finally {
      kill?.mockRestore(); await first.close().catch(() => undefined); await second.close();
      spawn.mockRestore(); allowComputerMcp(name, config);
    }
  });

  it('cancels only the waiter and retains desktop occupancy until the original result arrives', async () => {
    const first = computerClient();
    const second = computerClient();
    try {
      await first.connect();
      await second.connect();
      const signal = new AbortController();
      const pending = first.callTool('type_text', { delay: 200 }, signal.signal);
      await vi.waitFor(() => expect(first.stderrSnapshot()).toContain('dispatched'));
      signal.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await expect(second.callTool('type_text', {})).rejects.toMatchObject({ code: 'mcp.computer_busy' });
      await vi.waitFor(async () => {
        const result = await second.callTool('type_text', { delay: 1 });
        expect(result.structuredContent).toEqual({ effect: 'unknown', delivery: 'foreground', route: 'fixture', summary: 'sent' });
      });
    } finally { await first.close(); await second.close(); }
  });

  it('requests EOF and waits for pending work to drain before close resolves', async () => {
    const client = computerClient();
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    try {
      await client.connect();
      const process = await spawn.mock.results[0]!.value;
      const kill = vi.spyOn(process, 'kill');
      const pending = client.callTool('type_text', { delay: 200 });
      await vi.waitFor(() => expect(client.stderrSnapshot()).toContain('dispatched'));
      await client.close();
      await pending.catch(() => undefined);
      expect(client.stderrSnapshot()).toContain('eof');
      expect(client.stderrSnapshot()).toContain('drained');
      expect(process.exitCode).toBe(0);
      expect(kill).not.toHaveBeenCalled();
    } finally { await client.close(); spawn.mockRestore(); }
  });

  it('terminates only its own child after an EOF drain timeout and confirms exit', async () => {
    const client = computerClient({ drainTimeoutMs: 20 }, { KIKI_TEST_IGNORE_EOF: '1' });
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    try {
      await client.connect();
      const process = await spawn.mock.results[0]!.value;
      const kill = vi.spyOn(process, 'kill');
      await client.close();
      expect(client.stderrSnapshot()).toContain('eof');
      expect(kill).toHaveBeenCalledOnce();
      expect(process.exitCode).not.toBeNull();
    } finally { await client.close(); spawn.mockRestore(); }
  });
  it('rejects unsupported executor at construction time', () => {
    expect(
      () =>
        createClient({
          transport: 'stdio',
          command: 'true',
          executor: 'kaos',
        }),
    ).toThrow(
      expect.objectContaining({ name: 'Error2', code: 'not_implemented' }) as unknown as Error,
    );

    let thrown: unknown;
    try {
      const client = createClient({ transport: 'stdio', command: 'true', executor: 'kaos' });
      void client;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error2);
  });

  it('uses defaultCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
      },
      { defaultCwd: cwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 15000);

  it('prefers explicit config.cwd over defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const configuredCwd = join(defaultCwd, 'configured');
    mkdirSync(configuredCwd);
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: configuredCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(configuredCwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 15000);

  it('resolves relative config.cwd from defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-relative-cwd-'));
    const configuredCwd = join(defaultCwd, 'tools', 'mcp');
    mkdirSync(configuredCwd, { recursive: true });
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: 'tools/mcp',
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 15000);

  it('allows explicit config.cwd outside defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const outsideCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-outside-cwd-'));
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: outsideCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(outsideCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      await rm(outsideCwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 15000);

  it('connects, lists tools, and round-trips a text result', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual([
        'boom',
        'echo',
        'read_env',
        'whoami',
      ]);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toBe('Echoes input text');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });

      const result = await client.callTool('echo', { text: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('propagates server-reported isError', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('boom', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'boom!' });
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards configured env to the spawned server', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
      env: { KIKI_TEST_ENV: 'forwarded-value' },
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: 'KIKI_TEST_ENV' });
      expect(result.content).toEqual([{ type: 'text', text: 'forwarded-value' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('inherits parent process env so PATH/HOME survive; config.env overrides on conflict', async () => {
    const parentOnly = `KIKI_TEST_PARENT_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const shared = `KIKI_TEST_SHARED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[parentOnly] = 'from-parent';
    process.env[shared] = 'from-parent';
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
      env: { [shared]: 'from-config' },
    });
    try {
      await client.connect();
      const inherited = await client.callTool('read_env', { name: parentOnly });
      expect(inherited.content).toEqual([{ type: 'text', text: 'from-parent' }]);
      const overridden = await client.callTool('read_env', { name: shared });
      expect(overridden.content).toEqual([{ type: 'text', text: 'from-config' }]);
    } finally {
      delete process.env[parentOnly];
      delete process.env[shared];
      await client.close();
    }
  }, 15000);

  it('captures recent stderr into a snapshot the manager can attach to errors', async () => {
    const banner = `kimi-test-stderr-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stderrThenExitFixture],
      env: { KIKI_TEST_MCP_STDERR: banner },
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      expect(client.stderrSnapshot()).toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('keeps the stderr buffer bounded so noisy servers cannot exhaust memory', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      expect(StdioMcpClient.stderrBufferCapacity).toBeLessThanOrEqual(16 * 1024);
      expect(StdioMcpClient.stderrBufferCapacity).toBeGreaterThanOrEqual(1024);
    } finally {
      await client.close();
    }
  }, 15000);

  it('notifies an unexpected-close listener when the child exits after connect', async () => {
    const banner = `kimi-test-crash-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIKI_TEST_MCP_EXIT_AFTER_MS: '50', KIKI_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ stderr?: string; error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ stderr: reason.stderr, error: reason.error?.message });
    });
    try {
      await client.connect();
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('buffers an early close and replays it on listener registration', async () => {
    const banner = `kimi-test-early-${Date.now()}`;
    const spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIKI_TEST_MCP_STDERR: banner, KIKI_TEST_MCP_EXIT_CODE: '0' },
    });
    try {
      await client.connect();
      const reply = await client.callTool('exit_after_reply', {});
      expect(reply.isError).toBe(false);
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && !client.stderrSnapshot().includes(banner)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.stderrSnapshot()).toContain(banner);

      const drainDeadline = Date.now() + 5000;
      let transportConfirmedDead = false;
      while (Date.now() < drainDeadline) {
        try {
          await client.callTool('echo', { text: 'probe' });
        } catch {
          transportConfirmedDead = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transportConfirmedDead).toBe(true);
      const spawned = await spawn.mock.results[0]!.value;
      await spawned.wait();

      let received: { stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onUnexpectedClose((reason) => {
        syncedOnRegister = true;
        received = { stderr: reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received?.stderr ?? '').toContain(banner);
    } finally {
      spawn.mockRestore();
      await client.close();
    }
  }, 15000);

  it('does not fire unexpected-close when the caller closes the client itself', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);

  it('does not treat a proxy child exit as external daemon action termination', async () => {
    const name = 'proxy-fixture';
    const config: McpServerStdioConfig = { transport: 'stdio', command: process.execPath, args: [computerFixture] };
    const proxy = createClient(config, { computerControl: true, serverName: name }, 'macOS');
    const next = computerClient();
    try {
      await proxy.connect(); await next.connect();
      const pending = proxy.callTool('type_text', { delay: 200 });
      await vi.waitFor(() => expect(proxy.stderrSnapshot()).toContain('dispatched'));
      const result = await captureComputerMcpStop(name, config)();
      await pending.catch(() => undefined);
      expect(result).toMatchObject({ state: 'unconfirmed', output: expect.stringContaining('external daemon') });
      await expect(next.callTool('type_text', {})).rejects.toMatchObject({ code: 'mcp.computer_busy' });
      expect((await captureComputerMcpStop(name, config)()).state).toBe('unconfirmed');
    } finally { await proxy.close().catch(() => undefined); await next.close(); }
  });
});

describe('mergeStdioEnv', () => {
  it('enables NODE_USE_ENV_PROXY for a proxy set only in the server config.env', () => {
    const merged = mergeStdioEnv({ HTTP_PROXY: 'http://corp:3128' }, { PATH: '/usr/bin' });
    expect(merged['HTTP_PROXY']).toBe('http://corp:3128');
    expect(merged['NODE_USE_ENV_PROXY']).toBe('1');
    expect(merged['NO_PROXY']).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('does not inject NODE_USE_ENV_PROXY when no proxy is configured', () => {
    const merged = mergeStdioEnv(undefined, { PATH: '/usr/bin' });
    expect(merged['NODE_USE_ENV_PROXY']).toBeUndefined();
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('lets config.env override the parent env', () => {
    const merged = mergeStdioEnv({ FOO: 'override' }, { FOO: 'parent', PATH: '/x' });
    expect(merged['FOO']).toBe('override');
  });

  it('does not depend on a filesystem cwd fixture for env merging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-mcp-env-'));
    await rm(dir, { recursive: true, force: true });
    expect(mergeStdioEnv(undefined, { PATH: dir })['PATH']).toBe(dir);
  });
});
