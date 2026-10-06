import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { delegationProcedureTable } from '@kiki/klient/procedures';
import type { SeatKlient } from '@kiki/klient/procedures/http';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunningServer, ServerStartOptions } from '@kiki/kap-server';

import {
  KIKI_CLI_PRINCIPAL,
  KIKI_EXIT,
  projectDelegationCommands,
  registerDelegationCommands,
  runDelegationCommand,
  type DelegationRuntimeDependencies,
} from '../../src/kiki/delegation';
import type { DoctorDeps, DoctorOptions } from '../../src/cli/sub/doctor';
import { doctor, registerDoctorCommand } from '../../src/kiki/doctor';
import { resolveKikiHome } from '../../src/kiki/home';
import { mcpCommandConfig, upsertMcpServer } from '../../src/kiki/install';
import { createSeatOnConnection } from '../../src/kiki/seat';
import { mcpPrincipal, registerMcpCommand } from '../../src/kiki/mcp';
import { registerKikiCommands } from '../../src/kiki/register';
import { parseDuration, startServeServer, registerServeCommand, findReachableServer, ensureServer } from '../../src/kiki/serve';

import * as nativeAssets from '../../src/native/native-assets';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('kiki command helpers', () => {
  it('describes the daemon, seat, MCP, and host root commands', () => {
    const program = new Command('kiki');
    registerKikiCommands(program);
    const descriptions = Object.fromEntries(program.commands.map((command) => [command.name(), command.description()]));
    expect(descriptions).toMatchObject({
      serve: expect.stringContaining('foreground'),
      seat: expect.stringContaining('delegation seats'),
      mcp: expect.stringContaining('stdio'),
      'host-attach': expect.stringContaining('prompt-file'),
      'host-claude-bind': expect.stringContaining('event cursor'),
      'host-claude-rewake': expect.stringContaining('notification'),
      'host-codex-bind': expect.stringContaining('Codex thread'),
      'host-codex-queue': expect.stringContaining('notifications'),
    });
  });

  it('gives every seat subcommand a description that names what it acts on', () => {
    const program = new Command('kiki');
    registerKikiCommands(program);
    const seat = program.commands.find((command) => command.name() === 'seat');
    const descriptions = Object.fromEntries(
      (seat?.commands ?? []).map((command) => [command.name(), command.description()]),
    );
    expect(descriptions).toEqual({
      create: expect.stringContaining('workspace and principal'),
      list: expect.stringContaining('this home'),
      revoke: expect.stringContaining('by id'),
      install: expect.stringContaining('MCP config'),
    });
  });

  it('parses daemon idle durations', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(() => parseDuration('30')).toThrow('Invalid duration.');
  });

  it('injects the packaged web assets into the kap server owner', async () => {
    const webAssetsDir = String.raw`C:\Program Files\Kiki\cache\dist\web`;
    const browserDriverPath = String.raw`C:\Program Files\Kiki\cache\runtime\browser-driver\agent-browser.exe`;
    const driver = vi.spyOn(nativeAssets, 'getBrowserDriverFile').mockReturnValue(browserDriverPath);
    let received: ServerStartOptions | undefined;
    const startServer = async (options: ServerStartOptions): Promise<RunningServer> => {
      received = options;
      return {} as RunningServer;
    };

    await startServeServer(
      { homeDir: String.raw`C:\Users\Example\.kiki`, port: 0, idleExitMs: 60_000, debugEndpoints: true, logLevel: 'warn' },
      webAssetsDir,
      startServer,
    );

    expect(received).toMatchObject({
      host: '127.0.0.1',
      port: 0,
      homeDir: String.raw`C:\Users\Example\.kiki`,
      idleExitMs: 60_000,
      debugEndpoints: true,
      logLevel: 'warn',
      webAssetsDir,
      browserDriverPath,
    });
    expect(driver).toHaveBeenCalledOnce();
    driver.mockRestore();
  });

  it('attaches a live backend and refuses ensure when its identity handshake cannot be verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-query-live-')); roots.push(root);
    await writeFile(join(root, 'config.toml'), 'search_backend = "minidb"\n[search]\nenabled = false\n');
    await writeFile(join(root, 'index.html'), '<!doctype html><title>CLI attach fixture</title>');
    const server = await startServeServer({ homeDir: root, port: 0, idleExitMs: 0 }, root);
    try {
      const connection = await findReachableServer(root);
      expect(connection).toMatchObject({ serverId: server.serverId, identity: server.admission.identity, token: server.localOwnerToken });
      expect((await ensureServer({ homeDir: root })).serverId).toBe(server.serverId);
      const fetchImpl = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).endsWith('/api/remote-connections/handshake')
        ? new Response('{}', { status: 404 }) : fetchImpl(input, init));
      await expect(findReachableServer(root)).rejects.toThrow('identity handshake could not be verified');
      await expect(ensureServer({ homeDir: root })).rejects.toThrow('identity handshake could not be verified');
      expect(await readdir(join(root, 'server', 'instances'))).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); await server.close(); }
  }, 30000);

  it('queries an empty explicit home without starting a server or creating home state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-query-test-')); roots.push(root);
    const program = new Command(); registerServeCommand(program);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await program.parseAsync(['node', 'kiki', 'serve', '--home', root, '--query', '--json']);
      expect(output).toHaveBeenCalledWith('{"running":false}\n');
      expect(await readdir(root)).toEqual([]);
    } finally { output.mockRestore(); }
  });

  it('requires one serve effect and gives explicit zero idle timeout a persistent daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-query-flags-')); roots.push(root);
    const program = new Command(); registerServeCommand(program);
    await expect(program.parseAsync(['node', 'kiki', 'serve', '--home', root, '--query', '--ensure'])).rejects.toThrow('--ensure, --stop and --query');
    const started: ServerStartOptions[] = [];
    const start = async (options: ServerStartOptions): Promise<RunningServer> => { started.push(options); return {} as RunningServer; };
    await startServeServer({ homeDir: root, idleExitMs: parseDuration('0ms') }, root, start);
    await startServeServer({ homeDir: root, idleExitMs: parseDuration('30m') }, root, start);
    expect(started[0]!.idleExitMs).toBeUndefined();
    expect(started[1]!.idleExitMs).toBe(1800000);
  });

  it('accepts foreground log levels and rejects invalid or non-foreground log options before starting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-log-flags-')); roots.push(root);
    const program = new Command(); registerServeCommand(program);
    await expect(program.parseAsync(['node', 'kiki', 'serve', '--home', root, '--query', '--log-level', 'warn'])).rejects.toThrow('--log-level applies only to a new foreground daemon.');
    expect(program.commands[0]!.opts()['logLevel']).toBe('warn');
    await expect(program.parseAsync(['node', 'kiki', 'serve', '--home', root, '--log-level', 'shout'])).rejects.toThrow('invalid --log-level');
    expect(await readdir(root)).toEqual([]);
  });

  it('resolves Kiki home consistently and reports the KIKI_HOME token path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-home-test-'));
    roots.push(root);
    const kikiHome = join(root, 'configured-kiki');
    vi.stubEnv('KIKI_HOME', kikiHome);
    vi.stubEnv('USERPROFILE', join(root, 'profile'));

    expect(resolveKikiHome()).toBe(kikiHome);
    expect(resolveKikiHome(join(root, 'explicit'))).toBe(join(root, 'explicit'));
    expect(resolveKikiHome(undefined, {}, root)).toBe(join(root, '.kiki'));
    expect((await doctor()).token.path).toBe(join(kikiHome, 'server.token'));
  });

  it('derives a stable MCP principal from the workspace', () => {
    expect(mcpPrincipal('C:\\workspace')).toBe(mcpPrincipal('C:\\workspace'));
    expect(mcpPrincipal('C:\\workspace')).toMatch(/^mcp:[a-f0-9]{16}$/);
  });

  it('uses the owner POST credential seam for external-client tools mode', async () => {
    const home = String.raw`C:\\fixture-home`;
    const connection = { url: 'http://127.0.0.1:43123', token: 'owner-token', serverId: 'server-fixture' };
    const credential = { mcpUrl: 'http://127.0.0.1:43123/mcp', token: 'connection-token' };
    let ensureOptions: { readonly homeDir: string; readonly workspace?: string } | undefined;
    let request: { readonly method: string; readonly path: string; readonly body: unknown } | undefined;
    type BridgeOptions = { readonly connectionId: string; readonly resolveCredential: (id: string) => Promise<typeof credential> };
    let bridgeOptions: BridgeOptions | undefined;
    const ensure = vi.fn(async (options: { readonly homeDir: string; readonly workspace?: string }) => {
      ensureOptions = options;
      return connection;
    });
    const daemon = vi.fn(async (_connection: typeof connection, method: string, path: string, body: unknown) => {
      request = { method, path, body };
      return credential;
    });
    const bridge = vi.fn(async (options: BridgeOptions) => {
      bridgeOptions = options;
    });
    const dependencies = {
      ensureServer: ensure,
      daemonRequest: daemon,
      createExternalClientStdioBridge: bridge,
    } as never;
    const program = new Command().exitOverride();
    registerMcpCommand(program, dependencies);

    await program.parseAsync(['node', 'kiki', 'mcp', '--client', 'fixture', '--tools', '--home', home]);

    expect(ensureOptions).toEqual({ homeDir: resolveKikiHome(home) });
    expect(request).toEqual({
      method: 'POST',
      path: '/api/external-clients/fixture/credential',
      body: {},
    });
    expect(bridge).toHaveBeenCalledOnce();
    expect(bridgeOptions).toBeDefined();
    const capturedBridge = bridgeOptions!;
    expect(capturedBridge).not.toHaveProperty('token');
    expect(capturedBridge.connectionId).toBe('fixture');
    await expect(capturedBridge.resolveCredential('unrelated-id')).resolves.toEqual(credential);

    const invalid = async (...args: string[]) => {
      const command = new Command().exitOverride();
      registerMcpCommand(command, dependencies);
      return command.parseAsync(['node', 'kiki', 'mcp', '--client', 'fixture', '--tools', ...args]);
    };
    await expect(invalid('--workspace', 'C:\\workspace')).rejects.toThrow('--client cannot be combined');
    await expect(invalid('--attached')).rejects.toThrow('--client cannot be combined');
    const missingTools = new Command().exitOverride();
    registerMcpCommand(missingTools, dependencies);
    await expect(missingTools.parseAsync(['node', 'kiki', 'mcp', '--client', 'fixture'])).rejects.toThrow('--tools is required');
  });

  it('sends only the seat API contract fields', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          seatId: 'seat_example',
          sessionId: 'session_example',
          delegationToken: 'token',
          principal: 'cursor',
          workspace: 'C:\\workspace',
          mode: 'auto',
        },
      }));
    });
    await createSeatOnConnection(
      { url: 'http://127.0.0.1:58627', token: 'server-token', serverId: 'server' },
      {
        workspace: 'C:\\workspace',
        principal: 'cursor',
        mode: 'auto',
        json: true,
      } as never,
    );
    expect(JSON.parse(body)).toEqual({
      workspace: 'C:\\workspace',
      principal: 'cursor',
      mode: 'auto',
    });
  });

  it('backs up and replaces an existing kiki MCP entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-command-test-'));
    roots.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        other: { command: 'other' },
        kiki: { command: 'old' },
      },
    }));

    const config = mcpCommandConfig(root);
    const backup = await upsertMcpServer(configPath, config);
    expect(backup).toBeDefined();
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        other: { command: 'other' },
        kiki: config,
      },
    });
    const names = await readdir(root);
    expect(names.filter((name) => name.startsWith('mcp.json.bak.'))).toHaveLength(1);
  });

  it('routes kiki doctor --agents and kiki doctor agents to handleDoctor while preserving default doctor report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-doctor-test-'));
    roots.push(root);
    const customHome = join(root, 'custom-home');

    const calls: { target: string; home?: string; options?: unknown }[] = [];
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const exits: number[] = [];

    const fakeReport = {
      daemon: { reachable: true, url: 'http://127.0.0.1:58627', serverId: 'server-1' },
      token: { path: join(customHome, 'server.token'), exists: true, secure: true },
      seats: [],
    };

    const deps = {
      doctorReport: async (homeDir: string) => {
        calls.push({ target: 'daemon', home: homeDir });
        return fakeReport;
      },
      handleDoctor: async (docDeps: Partial<DoctorDeps>, options: DoctorOptions) => {
        calls.push({ target: 'handleDoctor', home: docDeps.kimiHomeDir ? docDeps.kimiHomeDir() : undefined, options });
        return 0;
      },
      stdout: { write: (chunk: string) => stdoutChunks.push(chunk) > 0 },
      stderr: { write: (chunk: string) => stderrChunks.push(chunk) > 0 },
      exit: (code: number) => {
        exits.push(code);
      },
    };

    // 1. Default `kiki doctor` produces daemon report JSON
    const p1 = new Command('kiki').exitOverride();
    registerDoctorCommand(p1, deps);
    await p1.parseAsync(['node', 'kiki', 'doctor']);
    expect(calls).toEqual([{ target: 'daemon', home: resolveKikiHome() }]);
    expect(stdoutChunks.join('')).toContain('server-1');
    calls.length = 0;
    stdoutChunks.length = 0;

    // 2. Default `kiki doctor --home <dir>` targets the specified home
    const p2 = new Command('kiki').exitOverride();
    registerDoctorCommand(p2, deps);
    await p2.parseAsync(['node', 'kiki', 'doctor', '--home', customHome]);
    expect(calls).toEqual([{ target: 'daemon', home: customHome }]);
    expect(stdoutChunks.join('')).toContain('custom-home');
    calls.length = 0;
    stdoutChunks.length = 0;

    // 3. `kiki doctor --agents` runs handleDoctor with default home
    const p3 = new Command('kiki').exitOverride();
    registerDoctorCommand(p3, deps);
    await p3.parseAsync(['node', 'kiki', 'doctor', '--agents']);
    expect(calls).toEqual([{ target: 'handleDoctor', home: resolveKikiHome(), options: {} }]);
    calls.length = 0;

    // 4. `kiki doctor --agents --home <dir>` runs handleDoctor with specified home
    const p4 = new Command('kiki').exitOverride();
    registerDoctorCommand(p4, deps);
    await p4.parseAsync(['node', 'kiki', 'doctor', '--agents', '--home', customHome]);
    expect(calls).toEqual([{ target: 'handleDoctor', home: customHome, options: {} }]);
    calls.length = 0;

    // 5. `kiki doctor agents` subcommand runs handleDoctor
    const p5 = new Command('kiki').exitOverride();
    registerDoctorCommand(p5, deps);
    await p5.parseAsync(['node', 'kiki', 'doctor', 'agents']);
    expect(calls).toEqual([{ target: 'handleDoctor', home: resolveKikiHome(), options: {} }]);
    calls.length = 0;

    // 6. `kiki doctor agents --home <dir>` subcommand runs handleDoctor with specified home
    const p6 = new Command('kiki').exitOverride();
    registerDoctorCommand(p6, deps);
    await p6.parseAsync(['node', 'kiki', 'doctor', 'agents', '--home', customHome]);
    expect(calls).toEqual([{ target: 'handleDoctor', home: customHome, options: {} }]);
    calls.length = 0;

    // 7. Error exit code propagation
    const failDeps = {
      ...deps,
      handleDoctor: async () => 1,
    };
    const p7 = new Command('kiki').exitOverride();
    registerDoctorCommand(p7, failDeps);
    await p7.parseAsync(['node', 'kiki', 'doctor', 'agents']);
    expect(exits).toEqual([1]);

    // 8. Help output contains both --agents and agents subcommand, and the
    // flag points at the subcommand so the two entries read as one action.
    const p8 = new Command('kiki').exitOverride();
    const doctorCmd = registerDoctorCommand(p8, deps);
    const help = doctorCmd.helpInformation();
    expect(help).toContain('--agents');
    expect(help).toContain('agents [options]');
    const agentsFlag = doctorCmd.options.find((option) => option.long === '--agents');
    expect(agentsFlag?.description).toBe(
      'Validate agent profiles and configuration. Same as `kiki doctor agents`.',
    );
  });
});

describe('kiki delegation CLI', () => {
  it('projects and registers the thirteen delegation commands from one table', () => {
    const projected = projectDelegationCommands(delegationProcedureTable);
    const program = new Command();
    registerDelegationCommands(program, delegationProcedureTable);

    expect(projected.map((entry) => entry.command.split(/[ <[]/u)[0])).toEqual([
      'agents',
      'list',
      'dispatch',
      'continue',
      'send',
      'interactions',
      'respond',
      'status',
      'wait',
      'result',
      'events',
      'transcript',
      'cancel',
    ]);
    expect(program.commands.map((command) => command.name())).toEqual(projected.map((entry) => entry.command.split(/[ <[]/u)[0]));
  });

  it('describes every delegation command and option with procedure-specific help', () => {
    const program = new Command('kiki');
    registerDelegationCommands(program);
    for (const command of program.commands) {
      expect(command.description().trim()).not.toBe('');
      for (const option of command.options) expect(option.description.trim()).not.toBe('');
    }
    const helpFor = (name: string) => program.commands.find((command) => command.name() === name)!.helpInformation().replace(/\s+/gu, ' ');
    expect(helpFor('list')).toContain('children and continuations owned by the CLI seat');
    expect(helpFor('send')).toContain('next run boundary');
    expect(helpFor('continue')).toContain('terminal main-agent or named-child');
    expect(helpFor('events')).toContain('lifecycle or turn');
    expect(helpFor('transcript')).toContain('text or items');
    expect(helpFor('result')).toContain('bytes per page');
    expect(helpFor('respond')).toContain('bare key means true');
  });

  it.each([['list', '--help'], ['dispatch', '--help']])(
    'terminates help parsing without startup, seat, RPC, or root action: %s %s',
    async (...args) => {
      const harness = runtimeHarness('unused', [], {});
      let stdout = '';
      let stderr = '';
      const rootAction = vi.fn();
      const program = new Command('kiki').configureOutput({
        writeOut: (text) => { stdout += text; },
        writeErr: (text) => { stderr += text; },
      }).action(rootAction);
      registerDelegationCommands(program, delegationProcedureTable, harness.dependencies);
      await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({
        code: 'commander.helpDisplayed', exitCode: KIKI_EXIT.success,
      });
      expect(stdout).toContain('Usage: kiki');
      expect(stderr).toBe('');
      expect(rootAction).not.toHaveBeenCalled();
      expect(harness.ensure).not.toHaveBeenCalled();
      expect(harness.createSeat).not.toHaveBeenCalled();
      expect(harness.createClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    { args: ['dispatch'], message: 'missing required argument' },
    { args: ['list', '--unknown'], message: 'unknown option' },
  ])('preserves Commander usage errors without RPC: $args', async ({ args, message }) => {
    const harness = runtimeHarness('unused', [], {});
    let stderr = '';
    const program = new Command('kiki').configureOutput({ writeErr: (text) => { stderr += text; } });
    registerDelegationCommands(program, delegationProcedureTable, harness.dependencies);
    await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({ exitCode: KIKI_EXIT.usage });
    expect(stderr).toContain(message);
    expect(harness.ensure).not.toHaveBeenCalled();
    expect(harness.createClient).not.toHaveBeenCalled();
  });

  it('rejects invalid canonical input before daemon startup', async () => {
    const harness = runtimeHarness('unused', [], {});
    let stderr = '';
    expect(await runDelegationCommand('respond', ['example'], {}, {
      ...harness.dependencies, stderr: { write: (text) => { stderr += text; return true; } },
    })).toBe(KIKI_EXIT.usage);
    expect(stderr).toContain('Select exactly one approval decision or provide --answer.');
    expect(harness.ensure).not.toHaveBeenCalled();
    expect(harness.createClient).not.toHaveBeenCalled();
  });

  it('keeps the delegation CLI free of direct agent-core imports', async () => {
    const source = await readFile(join(import.meta.dirname, '../../src/kiki/delegation.ts'), 'utf8');
    expect(source).not.toContain('@kiki/agent-core-v2');
  });

  it('executes Commander positionals and options through the generic projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-commander-test-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    await writeFile(workspace, '');
    const calls: { name: string; input: unknown }[] = [];
    const harness = runtimeHarness(workspace, calls, {
      dispatch: [{ dispatchId: 'dispatch-1', status: 'queued' }],
    });
    const program = new Command();
    registerDelegationCommands(program, delegationProcedureTable, harness.dependencies);

    await program.parseAsync([
      'node',
      'kiki',
      'dispatch',
      '--profile',
      'explore',
      '--name',
      'mapper',
      '--dispatch-key',
      'explicit-key',
      '--workspace',
      workspace,
      '--json',
      'inspect this',
    ]);

    expect(calls).toEqual([{ name: 'dispatch', input: {
      target: 'named',
      taskName: 'mapper',
      profileName: 'explore',
      modelAlias: undefined,
      thinkingEffort: undefined,
      dispatchKey: 'explicit-key',
      message: 'inspect this',
    } }]);
  });

  it('maps positionals and options through the procedure codec into canonical input', () => {
    const commands = projectDelegationCommands(delegationProcedureTable);
    const dispatch = commands.find((entry) => entry.procedure.name === 'dispatch')!;
    const respond = commands.find((entry) => entry.procedure.name === 'respond')!;

    expect(dispatch.canonicalInput(['inspect this'], {
      profile: 'explore',
      name: 'mapper',
      model: 'grok-4.6',
      thinking: 'max',
      dispatchKey: 'dispatch-key',
    })).toEqual({
      target: 'named',
      profileName: 'explore',
      taskName: 'mapper',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'max',
      dispatchKey: 'dispatch-key',
      message: 'inspect this',
    });
    expect(respond.canonicalInput(['approval-1'], {
      approve: true,
      selectedOptionId: 'allow',
    })).toEqual({
      interactionId: 'approval-1',
      kind: 'approval',
      response: { decision: 'approved', selectedOptionId: 'allow' },
    });
    expect(respond.canonicalInput(['question-1'], {
      answer: { Continue: 'Yes', Confirm: true },
      method: 'enter',
    })).toEqual({
      interactionId: 'question-1',
      kind: 'question',
      response: { answers: { Continue: 'Yes', Confirm: true }, method: 'enter' },
    });
  });

  it('composes dispatch, wait, and result while surfacing manual interaction status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-delegation-test-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    await writeFile(workspace, '');
    const calls: { name: string; input: unknown }[] = [];
    const outputs: Record<string, unknown[]> = {
      dispatch: [{ dispatchId: 'dispatch-1', status: 'running' }],
      wait: [
        { waitStatus: 'interaction_pending', interactions: [{ interactionId: 'approval-1' }] },
        { waitStatus: 'completed', dispatch: { dispatchId: 'dispatch-1', status: 'completed' } },
      ],
      respond: [{ interactionId: 'approval-1', status: 'resolved' }],
      result: [{ dispatch: { dispatchId: 'dispatch-1', status: 'completed' }, text: 'done' }],
    };
    const harness = runtimeHarness(workspace, calls, outputs);

    expect(await runDelegationCommand('dispatch', ['inspect'], {
      workspace,
      profile: 'explore',
      name: 'worker',
      wait: true,
      json: true,
    }, harness.dependencies)).toBe(KIKI_EXIT.interactionPending);
    expect(await runDelegationCommand('respond', ['approval-1'], {
      workspace,
      approve: true,
      json: true,
    }, harness.dependencies)).toBe(KIKI_EXIT.success);
    expect(await runDelegationCommand('wait', ['dispatch-1'], {
      workspace,
      timeout: 45,
      json: true,
    }, harness.dependencies)).toBe(KIKI_EXIT.success);
    expect(await runDelegationCommand('result', ['dispatch-1'], {
      workspace,
      json: true,
    }, harness.dependencies)).toBe(KIKI_EXIT.success);

    expect(calls.map((call) => call.name)).toEqual(['dispatch', 'wait', 'respond', 'wait', 'result']);
    expect(calls[0]!.input).toEqual(expect.objectContaining({ dispatchKey: expect.any(String) }));
    expect(calls[3]!.input).toEqual({ dispatchId: 'dispatch-1', timeoutMs: 45_000 });
    expect(harness.closed()).toBe(4);

    const failed = runtimeHarness(workspace, [], {});
    expect(await runDelegationCommand('list', [], { workspace }, failed.dependencies)).toBe(KIKI_EXIT.failure);
    expect(failed.closed()).toBe(1);
  });

  it('follows event cursors as JSONL and returns stable terminal exit codes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-events-test-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    await writeFile(workspace, '');
    const calls: { name: string; input: unknown }[] = [];
    const harness = runtimeHarness(workspace, calls, {
      events: [{ items: [{ seq: 1, type: 'started' }, { seq: 2, type: 'completed' }], nextCursor: 3 }],
      status: [{ dispatchId: 'dispatch-1', status: 'completed' }],
    });

    expect(await runDelegationCommand('events', ['dispatch-1'], {
      workspace,
      cursor: 1,
      follow: true,
      interval: 1,
      json: true,
    }, harness.dependencies)).toBe(KIKI_EXIT.success);
    expect(harness.stdout()).toBe('{"seq":1,"type":"started"}\n{"seq":2,"type":"completed"}\n');
    expect(calls).toEqual([
      { name: 'events', input: { dispatchId: 'dispatch-1', cursor: 1 } },
      { name: 'status', input: { dispatchId: 'dispatch-1' } },
    ]);

    for (const [status, code] of [
      ['timed_out', KIKI_EXIT.timedOut],
      ['interaction_pending', KIKI_EXIT.interactionPending],
    ] as const) {
      const waitHarness = runtimeHarness(workspace, [], { wait: [{ waitStatus: status }] });
      expect(await runDelegationCommand('wait', ['dispatch-1'], { workspace }, waitHarness.dependencies)).toBe(code);
    }
    const invalid = runtimeHarness(workspace, [], {});
    expect(await runDelegationCommand('respond', ['approval-1'], { workspace }, invalid.dependencies)).toBe(KIKI_EXIT.usage);
    const failed = runtimeHarness(workspace, [], { status: [{ dispatchId: 'dispatch-1', status: 'failed' }] });
    expect(await runDelegationCommand('status', ['dispatch-1'], { workspace }, failed.dependencies)).toBe(KIKI_EXIT.failure);
    const cancelled = runtimeHarness(workspace, [], { status: [{ dispatchId: 'dispatch-1', status: 'cancelled' }] });
    expect(await runDelegationCommand('status', ['dispatch-1'], { workspace }, cancelled.dependencies)).toBe(KIKI_EXIT.notFound);
  });

  it('advances follow after full and short pages, retains the watermark on empty pages, and emits new turn events once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-follow-test-'));
    roots.push(root);
    const calls: { name: string; input: unknown }[] = [];
    const harness = runtimeHarness(root, calls, {
      events: [
        { items: [{ seq: 6, type: 'started' }], nextCursor: 6 },
        { items: [{ seq: 7, type: 'delta' }] },
        { items: [] },
        { items: [{ seq: 8, type: 'completed' }] },
      ],
      status: [{ status: 'running' }, { status: 'running' }, { status: 'running' }, { status: 'completed' }],
    });
    expect(await runDelegationCommand('events', ['dispatch-1'], {
      workspace: root, cursor: 5, detail: 'turn', follow: true, interval: 1, json: true,
    }, harness.dependencies)).toBe(KIKI_EXIT.success);
    expect(harness.stdout().trim().split('\n').map((line) => JSON.parse(line).seq)).toEqual([6, 7, 8]);
    expect(calls.filter((call) => call.name === 'events').map((call) => call.input)).toEqual(
      [5, 6, 7, 7].map((cursor) => ({ dispatchId: 'dispatch-1', detail: 'turn', cursor })),
    );
    expect(harness.closed()).toBe(1);
  });

  it('resolves home/workspace, reuses the CLI seat identity, and never prints tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-seat-reuse-test-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    await writeFile(workspace, '');
    const home = join(root, 'home');
    const calls: { name: string; input: unknown }[] = [];
    const harness = runtimeHarness(workspace, calls, {
      list: [
        { token: 'DELEGATION_SECRET', children: [] },
        { authorization: 'Bearer DELEGATION_SECRET', children: [] },
      ],
    });

    await runDelegationCommand('list', [], { home, workspace, json: true }, harness.dependencies);
    await runDelegationCommand('list', [], { home, workspace, json: true }, harness.dependencies);

    expect(harness.ensure).toHaveBeenCalledTimes(2);
    expect(harness.ensure).toHaveBeenCalledWith({ homeDir: home, workspace });
    expect(harness.createSeat).toHaveBeenCalledTimes(2);
    expect(harness.createSeat).toHaveBeenCalledWith(expect.anything(), {
      workspace,
      principal: KIKI_CLI_PRINCIPAL,
    });
    expect(harness.createClient).toHaveBeenCalledWith({
      endpoint: 'http://127.0.0.1:58627',
      token: 'DELEGATION_SECRET',
    });
    expect(harness.stdout()).not.toContain('DELEGATION_SECRET');
    expect(harness.stdout()).toContain('[redacted]');
  });
});

function runtimeHarness(
  workspace: string,
  calls: { name: string; input: unknown }[],
  outputs: Record<string, unknown[]>,
): {
  dependencies: DelegationRuntimeDependencies;
  ensure: ReturnType<typeof vi.fn>;
  createSeat: ReturnType<typeof vi.fn>;
  createClient: ReturnType<typeof vi.fn>;
  stdout(): string;
  closed(): number;
} {
  let stdout = '';
  let closed = 0;
  const ensure = vi.fn(async () => ({ url: 'http://127.0.0.1:58627', token: 'server-token', serverId: 'server' }));
  const createSeat = vi.fn(async () => ({
    seatId: 'seat-1',
    sessionId: 'session-1',
    delegationToken: 'DELEGATION_SECRET',
    principal: KIKI_CLI_PRINCIPAL,
    workspace,
    mode: 'manual',
  }));
  const client = {
    call: async (name: string, input: unknown) => {
      calls.push({ name, input });
      const queue = outputs[name];
      if (queue === undefined || queue.length === 0) throw new Error(`Missing fake output for ${name}`);
      return queue.shift();
    },
    close: async () => {
      closed += 1;
    },
  } as unknown as SeatKlient;
  const createClient = vi.fn(() => client);
  return {
    dependencies: {
      ensureServer: ensure as never,
      createSeat: createSeat as never,
      createSeatKlient: createClient as never,
      stdout: { write: (value) => { stdout += String(value); return true; } },
      stderr: { write: () => true },
      sleep: async () => {},
    },
    ensure,
    createSeat,
    createClient,
    stdout: () => stdout,
    closed: () => closed,
  };
}
