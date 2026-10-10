import { PassThrough, Readable } from 'node:stream';

import { normalize } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '@kiki/codex-client';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { AgentExecutionService } from '#/agent/execution/executionService';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { AgentExecutorRegistryService } from '#/app/agentExecutor/agentExecutorRegistryService';
import { AGENT_EXECUTORS_SECTION } from '#/app/agentExecutor/configSection';
import { AGENT_EXECUTOR_OVERRIDES_SECTION } from '#/app/agentExecutor/executorOverrides';
import {
  AgentExecutorPreflightService,
  IAgentExecutorPreflightService,
  type AgentExecutorPreflightResult,
} from '#/app/agentExecutor/preflight';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import {
  IHostProcessService,
  type HostProcessOptions,
  type IHostProcess,
} from '#/os/interface/hostProcess';

class FakeProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;
  readonly calls: string[] = [];
  readonly options: HostProcessOptions[] = [];
  readonly outputs = new Map<string, { readonly output: string; readonly code?: number }>();

  async spawn(
    command: string,
    args: readonly string[] = [],
    options?: HostProcessOptions,
  ): Promise<IHostProcess> {
    const key = [command, ...args].join(' ');
    this.options.push(options ?? {});
    this.calls.push(key);
    const fixture = this.outputs.get(key);
    if (fixture === undefined) throw new Error('missing');
    return {
      _serviceBrand: undefined,
      pid: 1,
      exitCode: fixture.code ?? 0,
      stdin: new PassThrough(),
      stdout: Readable.from([fixture.output]),
      stderr: Readable.from([]),
      wait: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return fixture.code ?? 0;
      },
      kill: async () => {},
      dispose: () => {},
    };
  }
}

function bootstrap(env: Readonly<Record<string, string>> = {}): IBootstrapService {
  return {
    _serviceBrand: undefined,
    platform: 'win32',
    arch: 'x64',
    cwd: 'C:/workspace',
    osHomeDir: 'C:/Users/test',
    homeDir: 'C:/Users/test/.kiki',
    configPath: 'C:/Users/test/.kiki/config.toml',
    configReadOnly: true,
    userAgentProfileHomeDir: 'C:/Users/test/.kiki',
    modelAccountHomeDir: 'C:/Users/test/.kiki',
    credentialsHomeDir: 'C:/Users/test/.kiki',
    clientIdentity: { productName: 'test', version: '0', platform: 'test' },
    args: { requestHeaders: {} },
    sessionsDir: 'sessions',
    blobsDir: 'blobs',
    storeDir: 'store',
    cacheDir: 'cache',
    logsDir: 'logs',
    configKey: 'config.toml',
    getEnv: (name) => ({
      CODEX_HOME: 'C:/codex-home',
      CODEX_PATH: 'C:/tools/codex.exe',
      ALT_CODEX_PATH: 'C:/alt/codex.exe',
      PATH: 'C:/tools',
      PATHEXT: '.EXE;.CMD',
      ...env,
    })[name],
    scope: () => '',
  };
}

const CLAUDE_MANAGED = 'C:/Users/test/.kiki/tools/claude-agent-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js';
const CLAUDE_PROBE = `${normalize(process.execPath)} ${CLAUDE_MANAGED} --version`;
const CLAUDE_USER_SETTINGS = 'C:/Users/test/.claude/settings.json';

function fsWith(
  paths: readonly string[],
  files: Readonly<Record<string, string>> = {},
): IHostFileSystem {
  const present = new Set(paths);
  return {
    _serviceBrand: undefined,
    stat: async (path) => {
      if (!present.has(path)) throw new Error('missing');
      return { isFile: true, isDirectory: false, size: 1 } satisfies HostFileStat;
    },
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('missing');
      return text;
    },
  } as IHostFileSystem;
}

describe('AgentExecutorPreflightService', () => {
  let services: TestInstantiationService;
  let processService: FakeProcessService;

  beforeEach(() => {
    services = new TestInstantiationService();
    processService = new FakeProcessService();
    services.set(IHostProcessService, processService);
    services.set(IHostFileSystem, fsWith([
      'C:/codex-home/auth.json',
      'C:/tools/codex.exe',
      'C:/Users/test/.local/bin/cursor-agent',
      'C:/Users/test/.claude',
      'C:/Users/test/.gemini',
      'C:/tools/node.EXE',
      'C:/tools/claude.EXE',
      CLAUDE_MANAGED,
    ]));
    services.set(IBootstrapService, bootstrap());
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTORS_SECTION ? undefined : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(
      IAgentExecutorPreflightService,
      new SyncDescriptor(AgentExecutorPreflightService),
    );
  });

  afterEach(() => { vi.restoreAllMocks(); services.dispose(); });

  it('invalidates cached and pending checks when the executor descriptor revision changes', async () => {
    let command = '/fixture/first';
    services.set(IConfigService, { _serviceBrand: undefined, get: (domain: string) => domain === AGENT_EXECUTORS_SECTION
      ? { example: { protocol: 'acp-v1', args: [], sources: [{ id: 'fixture', kind: 'explicit-path', path: command }] } } : undefined } as IConfigService);
    const registry = services.get(IAgentExecutorRegistry);
    const discovery = vi.spyOn(registry, 'discover').mockResolvedValue([{ id: 'fixture', kind: 'explicit-path', available: true, command, version: '1.0' }]);
    const preflight = services.get(IAgentExecutorPreflightService);
    await preflight.run(['example']);
    expect(preflight.lastCheck('example')?.version).toBe('1.0');
    command = '/fixture/second';
    expect(preflight.lastCheck('example')).toBeUndefined();
    let release!: (sources: Awaited<ReturnType<IAgentExecutorRegistry['discover']>>) => void;
    discovery.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = preflight.run(['example']);
    command = '/fixture/third';
    release([{ id: 'fixture', kind: 'explicit-path', available: true, command: '/fixture/second', version: '2.0' }]);
    expect((await pending)[0]?.version).toBe('2.0');
    expect(preflight.lastCheck('example')).toBeUndefined();
    expect(processService.calls).toEqual([]);
  });

  it('keeps the latest check when an older check completes late and expires the cached result', async () => {
    services.set(IConfigService, { _serviceBrand: undefined, get: (domain: string) => domain === AGENT_EXECUTORS_SECTION
      ? { example: { protocol: 'acp-v1', args: [], sources: [{ id: 'fixture', kind: 'explicit-path', path: '/fixture/example' }] } } : undefined } as IConfigService);
    const registry = services.get(IAgentExecutorRegistry);
    let release!: (sources: Awaited<ReturnType<IAgentExecutorRegistry['discover']>>) => void;
    vi.spyOn(registry, 'discover').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue([{ id: 'fixture', kind: 'explicit-path', available: true, command: '/fixture/example', version: '2.0' }]);
    const preflight = services.get(IAgentExecutorPreflightService);
    const older = preflight.run(['example']);
    await preflight.run(['example']);
    release([{ id: 'fixture', kind: 'explicit-path', available: true, command: '/fixture/example', version: '1.0' }]);
    await older;
    expect(preflight.lastCheck('example')?.version).toBe('2.0');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    expect(preflight.lastCheck('example')).toBeUndefined();
    expect(processService.calls).toEqual([]);
  });

  it('reports just the IDE/ACP distinction when only Antigravity IDE is installed', async () => {
    services.set(IHostFileSystem, fsWith(['C:/tools/antigravity.EXE']));
    const result = await services.get(IAgentExecutorPreflightService).run(['antigravity-acp']);
    expect(result).toHaveLength(1);
    expect(result[0]?.diagnostics).toHaveLength(1);
    expect(result[0]?.diagnostics[0]?.message).toContain('这是 Antigravity IDE，不是 ACP CLI');
    expect(result[0]?.diagnostics[0]?.message).toContain('ANTIGRAVITY_ACP_PATH');
    expect(result[0]?.diagnostics[0]?.message).toContain('1.2.1');
    expect(result[0]?.diagnostics[0]?.code).toBe('antigravity_ide_not_acp');
    expect(processService.calls.some((call) => call.includes('antigravity'))).toBe(false);
  });

  it('gives no IDE code when neither the IDE nor the ACP CLI is installed', async () => {
    const [result] = await services.get(IAgentExecutorPreflightService).run(['antigravity-acp']);
    expect(result?.status).toBe('unavailable');
    expect(result?.diagnostics.some((diagnostic) => diagnostic.code === 'antigravity_ide_not_acp')).toBe(false);
  });

  it('probes every builtin harness and selects discovered sources plus the Gemini fallback', async () => {
    processService.outputs.set('grok --version', { output: 'grok 1.0.13' });
    processService.outputs.set('codex-acp --version', { output: 'codex-acp 1.7.0' });
    processService.outputs.set('codex --version', { output: 'codex 0.1.0' });
    processService.outputs.set('C:/tools/codex.exe --version', { output: 'codex-cli 0.151.0-alpha.7.1' });
    processService.outputs.set('C:/Users/test/.local/bin/cursor-agent --version', { output: 'cursor-agent 1.0.0' });
    processService.outputs.set(CLAUDE_PROBE, { output: '0.84.0' });
    processService.outputs.set('claude --version', { output: '2.1.220 (Claude Code)' });
    processService.outputs.set('gemini --version', { output: '0.55.1' });
    processService.outputs.set('gemini --help', { output: '  --experimental-acp  Start ACP mode' });
    processService.outputs.set('kimi --version', { output: '0.37.1' });
    processService.outputs.set('opencode --version', { output: '1.18.18' });

    const results = await services.get(IAgentExecutorPreflightService).run();

    expect([
      'antigravity-acp',
      'claude-acp',
      'cline-acp',
      'codebuddy-acp',
      'codex-acp',
      'codex-app-server',
      'cursor-acp',
      'deepseek-acp',
      'gemini-acp',
      'grok-acp',
      'kimi-acp',
      'openclaw-acp',
      'opencode-acp',
      'pi-acp',
      'qoder-acp',
    ]).toEqual(results.map((result) => result.id).sort());
    expect(results.find((result) => result.id === 'codex-app-server')).toMatchObject({
      selectedSource: 'env',
      command: 'C:/tools/codex.exe',
      version: 'codex-cli 0.151.0-alpha.7.1',
    });
    expect(results.find((result) => result.id === 'gemini-acp')).toMatchObject({
      status: 'warning',
      resolvedArgs: ['--experimental-acp'],
    });
    expect(results.find((result) => result.id === 'kimi-acp')?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          message: 'This version of Kimi CLI does not accept ACP stdio MCP servers; MCP tools will fail. Upgrade to 0.39.0 or newer.',
        }),
      ]),
    );
    expect(processService.calls).toEqual(expect.arrayContaining([
      'codex-acp --version',
      'codex --version',
      'gemini --help',
      'openclaw --version',
      'cline --version',
      'codebuddy --version',
      'pi-acp --version',
      'deepseek-acp --version',
      'qodercli --version',
    ]));
  });

  it.each([
    { version: '0.36.1', affected: false },
    { version: '0.37.0', affected: true },
    { version: '0.37.2', affected: true },
    { version: '0.38.0', affected: true },
    { version: '0.38.9', affected: true },
    { version: '0.39.0', affected: false },
    { version: '0.39.1', affected: false },
    { version: '2.1.1', affected: false },
    { version: '', affected: false },
    { version: 'unknown', affected: false },
  ])('limits the Kimi MCP regression warning for $version to the affected interval', async ({ version, affected }) => {
    processService.outputs.set('kimi --version', { output: version });
    const [result] = await services.get(IAgentExecutorPreflightService).run(['kimi-acp']);
    expect(result?.diagnostics.some((diagnostic) => diagnostic.severity === 'warning' &&
      diagnostic.message.includes('does not accept ACP stdio MCP servers'))).toBe(affected);
    if (!affected) expect(result?.diagnostics).toContainEqual({
      severity: 'info', message: 'Kimi reuses the existing Kimi Code login and configuration.',
    });
  });

  it('reports a confirmed login only from the declared command probe and caches its check', async () => {
    processService.outputs.set(CLAUDE_PROBE, { output: '0.84.0' });
    processService.outputs.set('claude --version', { output: '2.1.220 (Claude Code)' });
    processService.outputs.set('claude auth status --json', { output: '{"loggedIn":true}' });
    const preflight = services.get(IAgentExecutorPreflightService);
    const [loggedIn] = await preflight.run(['claude-acp']);
    expect(loggedIn?.loginStatus).toBe('logged_in');
    expect(preflight.lastCheck('claude-acp')?.loginStatus).toBe('logged_in');
    processService.outputs.set('claude auth status --json', { output: '{"loggedIn":false}' });
    const [loggedOut] = await preflight.run(['claude-acp']);
    expect(loggedOut?.loginStatus).toBe('logged_out');
    processService.outputs.set('claude auth status --json', { output: '{"unexpected":true}' });
    const [unknown] = await preflight.run(['claude-acp']);
    expect(unknown?.loginStatus).toBe('unknown');
  });

  it('classifies Codex account/read and closes the probe on every outcome', async () => {
    processService.outputs.set('C:/tools/codex.exe --version', { output: 'codex-cli 0.158.0' });
    const connect = vi.spyOn(CodexAppServerClient.prototype, 'connect').mockResolvedValue();
    const request = vi.spyOn(CodexAppServerClient.prototype, 'request')
      .mockResolvedValueOnce({ account: { type: 'chatgpt' } })
      .mockResolvedValueOnce({ account: null })
      .mockResolvedValueOnce({ unexpected: true })
      .mockRejectedValueOnce(new Error('offline'));
    const shutdown = vi.spyOn(CodexAppServerClient.prototype, 'shutdown').mockResolvedValue();
    const preflight = services.get(IAgentExecutorPreflightService);
    const results = [];
    for (let index = 0; index < 4; index += 1) {
      const [result] = await preflight.run(['codex-app-server']);
      results.push(result?.loginStatus);
    }
    expect(results).toEqual(['logged_in', 'logged_out', 'unknown', 'unknown']);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledWith('account/read', { refreshToken: false }, expect.any(AbortSignal));
    expect(shutdown).toHaveBeenCalledTimes(4);
  });

  it('honors an explicit source id even when an earlier source is available', async () => {
    services.set(IHostFileSystem, fsWith([
      'C:/tools/codex.exe',
      'C:/alt/codex.exe',
    ]));
    processService.outputs.set('C:/tools/codex.exe --version', { output: 'codex-cli 0.151.0' });
    processService.outputs.set('C:/alt/codex.exe --version', { output: 'codex-cli 0.150.0' });
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTORS_SECTION ? {
        selected: {
          protocol: 'codex-app-server',
          sources: [
            { id: 'preferred', kind: 'env', name: 'CODEX_PATH' },
            { id: 'forced', kind: 'env', name: 'ALT_CODEX_PATH' },
          ],
          source: 'forced',
          versionProbe: { args: ['--version'] },
          args: [],
        },
      } : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));

    const [result] = await services.get(IAgentExecutorPreflightService).run(['selected']);

    expect(result).toMatchObject({
      selectedSource: 'forced',
      command: 'C:/alt/codex.exe',
      version: 'codex-cli 0.150.0',
    });
    expect(result?.sources?.filter((source) => source.available)).toHaveLength(2);
  });

  it('reports a custom executor with descriptor-only diagnostics and no id branch', async () => {
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTORS_SECTION ? { 'new-acp': {
        protocol: 'acp-v1', command: 'new-agent', args: ['acp'],
        diagnostics: [{ kind: 'message', severity: 'info', message: 'Custom agent ready.' }],
      } } : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));
    processService.outputs.set('new-agent --version', { output: 'new-agent 1.0' });
    const [result] = await services.get(IAgentExecutorPreflightService).run(['new-acp']);
    expect(result).toMatchObject({ id: 'new-acp', status: 'ready', version: 'new-agent 1.0',
      resolvedArgs: ['acp'], diagnostics: [{ severity: 'info', message: 'Custom agent ready.' }] });
  });

  it('uses an explicit binary override instead of auto-discovery', async () => {
    services.set(IHostFileSystem, fsWith(['C:/tools/custom-gemini.exe']));
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTOR_OVERRIDES_SECTION ? {
        'gemini-acp': { binPath: 'C:/tools/custom-gemini.exe' },
      } : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));
    processService.outputs.set('C:/tools/custom-gemini.exe --version', { output: 'gemini 1.0.0' });
    processService.outputs.set('C:/tools/custom-gemini.exe --help', { output: '--acp' });

    const [result] = await services.get(IAgentExecutorPreflightService).run(['gemini-acp']);

    expect(result).toMatchObject({
      status: 'ready',
      command: 'C:/tools/custom-gemini.exe',
      selectedSource: 'override',
      version: 'gemini 1.0.0',
    });
    expect(processService.calls).toContain('C:/tools/custom-gemini.exe --version');
    expect(processService.calls).toContain('C:/tools/custom-gemini.exe --help');
    expect(processService.calls).not.toContain('gemini --version');
    expect(processService.calls).not.toContain('gemini --help');
  });

  it('does not fall back when an explicit binary override is missing', async () => {
    services.set(IHostFileSystem, fsWith([]));
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTOR_OVERRIDES_SECTION ? {
        'gemini-acp': { binPath: 'C:/missing/custom-gemini.exe' },
      } : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));

    const [result] = await services.get(IAgentExecutorPreflightService).run(['gemini-acp']);

    expect(result).toMatchObject({ status: 'unavailable', command: '' });
    expect(result?.selectedSource).toBeUndefined();
    expect(result?.sources).toEqual([
      expect.objectContaining({ id: 'override', available: false }),
    ]);
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: 'No configured executable source is available.' }),
    ]));
    expect(processService.calls).not.toContain('gemini --version');
  });

  it('passes a configured home and extra environment into every probe', async () => {
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTOR_OVERRIDES_SECTION ? {
        'gemini-acp': { homeDir: 'C:/gemini-home', env: { GEMINI_TOKEN: 'fixture-token' } },
      } : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));
    processService.outputs.set('gemini --version', { output: 'gemini 1.0.0' });
    processService.outputs.set('gemini --help', { output: '--acp' });

    await services.get(IAgentExecutorPreflightService).run(['gemini-acp']);

    expect(processService.options.filter((options) => options.env !== undefined)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ env: { GEMINI_CLI_HOME: 'C:/gemini-home', GEMINI_TOKEN: 'fixture-token' } }),
      ]),
    );
  });

  it('leaves probe environment undefined without an override', async () => {
    processService.outputs.set('gemini --version', { output: 'gemini 1.0.0' });
    processService.outputs.set('gemini --help', { output: '--acp' });

    await services.get(IAgentExecutorPreflightService).run(['gemini-acp']);

    expect(processService.options.filter((options) => Object.hasOwn(options, 'env'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ env: undefined })]),
    );
  });

  it('resolves sources lazily and stops after the first available source', async () => {
    processService.outputs.set('C:/tools/codex.exe --version', { output: 'codex-cli 0.151.0' });
    processService.outputs.set('C:/Users/test/.local/bin/cursor-agent --version', { output: 'cursor-agent 1.0.0' });

    const codex = await services.get(IAgentExecutorRegistry).resolveExecutable('codex-app-server');
    const cursor = await services.get(IAgentExecutorRegistry).resolveExecutable('cursor-acp');

    expect(codex.descriptor.selectedSource).toBe('env');
    expect(cursor.descriptor.selectedSource).toBe('local-bin');
    expect(processService.calls).toEqual([
      'C:/tools/codex.exe --version',
      'C:/Users/test/.local/bin/cursor-agent --version',
    ]);
  });

  it('probes only an explicitly selected source during runtime resolution', async () => {
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTORS_SECTION ? {
        selected: {
          protocol: 'codex-app-server',
          sources: [
            { id: 'preferred', kind: 'env', name: 'CODEX_PATH' },
            { id: 'forced', kind: 'env', name: 'ALT_CODEX_PATH' },
          ],
          source: 'forced',
          versionProbe: { args: ['--version'] },
          args: [],
        },
      } : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    processService.outputs.set('C:/alt/codex.exe --version', { output: 'codex-cli 0.150.0' });

    const result = await services.get(IAgentExecutorRegistry).resolveExecutable('selected');

    expect(result.descriptor.selectedSource).toBe('forced');
    expect(processService.calls).toEqual(['C:/alt/codex.exe --version']);
  });

  it('ranks glob paths before executing only the selected runtime candidate', async () => {
    services.set(IHostFileSystem, {
      _serviceBrand: undefined,
      stat: async (path: string) => {
        if (!path.endsWith('codex.exe')) throw new Error('missing');
        return { isFile: true, isDirectory: false, size: 1 } satisfies HostFileStat;
      },
      readdir: async (path: string) => {
        if (path === 'C:/extensions') {
          return [
            { name: 'openai.chatgpt-0.151.0', isFile: false, isDirectory: true },
            { name: 'openai.chatgpt-0.152.0', isFile: false, isDirectory: true },
          ];
        }
        return [];
      },
    } as unknown as IHostFileSystem);
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: (domain: string) => domain === AGENT_EXECUTORS_SECTION ? {
        selected: {
          protocol: 'codex-app-server',
          sources: [{
            id: 'extensions',
            kind: 'glob',
            pattern: 'C:/extensions/openai.chatgpt-*/bin/codex.exe',
          }],
          versionProbe: { args: ['--version'] },
          args: [],
        },
      } : undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    processService.outputs.set(
      'C:/extensions/openai.chatgpt-0.152.0/bin/codex.exe --version',
      { output: 'codex-cli 0.152.0' },
    );

    const result = await services.get(IAgentExecutorRegistry).resolveExecutable('selected');

    expect(result.descriptor.command).toBe('C:/extensions/openai.chatgpt-0.152.0/bin/codex.exe');
    expect(processService.calls).toEqual([
      'C:/extensions/openai.chatgpt-0.152.0/bin/codex.exe --version',
    ]);
  });

  it('changes the resolved revision when the same executable path reports a new version', async () => {
    processService.outputs.set('C:/tools/codex.exe --version', { output: 'codex-cli 0.151.0' });
    const registry = services.get(IAgentExecutorRegistry);
    const first = await registry.resolveExecutable('codex-app-server');
    processService.outputs.set('C:/tools/codex.exe --version', { output: 'codex-cli 0.152.0' });
    const second = await registry.resolveExecutable('codex-app-server');

    expect(first.descriptor.command).toBe(second.descriptor.command);
    expect(first.descriptor.revision).not.toBe(second.descriptor.revision);
  });

  it('rejects a prior binding when the same direct command reports a new version', async () => {
    processService.outputs.set('kimi --version', { output: '0.37.1' });
    const registry = services.get(IAgentExecutorRegistry);
    const first = await registry.resolveExecutable('kimi-acp');
    processService.outputs.set('kimi --version', { output: '0.38.0' });
    const second = await registry.resolveExecutable('kimi-acp');
    services.set(IAgentScopeContext, {
      _serviceBrand: undefined,
      agentId: 'agent-test',
      scope: () => 'agent-test',
    });
    services.stub(IAgentProfileService, {
      data: () => ({
        modelCapabilities: UNKNOWN_CAPABILITY,
        thinkingLevel: 'off',
        systemPrompt: '',
        executorId: 'kimi-acp',
        executorProtocol: 'acp-v1',
        executorDescriptorRevision: first.descriptor.revision,
      }),
      preparePromptConfiguration: async () => false,
      getSystemPrompt: () => '',
    });
    services.stub(IAgentStateService, { get: (key) => key.initial(), contributeState: () => ({ dispose: () => {} }) });
    services.stub(IAgentLoopService, {});
    services.stub(IAgentPromptService, {});
    services.stub(ISessionDispatchService, { reserveExecution: () => () => {} });
    services.set(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
    const execution = services.get(IAgentExecutionService);

    expect(first.descriptor.command).toBe('kimi');
    expect(first.descriptor.command).toBe(second.descriptor.command);
    expect(first.descriptor.selectedSource).toBe('command');
    expect(first.descriptor.revision).not.toBe(second.descriptor.revision);
    await expect(execution.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/descriptor.*changed/i);
    await execution.shutdown();
  });

  it('reports unavailable binaries without treating missing auth as success', async () => {
    services.set(IHostFileSystem, fsWith([]));
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(
      IAgentExecutorPreflightService,
      new SyncDescriptor(AgentExecutorPreflightService),
    );

    const [result] = await services.get(IAgentExecutorPreflightService).run(['codex-acp']);

    expect(result).toMatchObject({ status: 'unavailable', version: undefined });
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('codex-acp') }),
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('Vendor codex') }),
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('auth state was not found') }),
    ]));
  });

  it('launches the Kiki-managed Claude adapter through node and lists setup requirements in order', async () => {
    processService.outputs.set(CLAUDE_PROBE, { output: '0.84.0' });
    processService.outputs.set('claude --version', { output: '2.1.220 (Claude Code)' });
    processService.outputs.set('claude auth status --json', { output: '{"loggedIn":false}', code: 1 });

    const [result] = await services.get(IAgentExecutorPreflightService).run(['claude-acp']);
    const resolved = await services.get(IAgentExecutorRegistry).resolveExecutable('claude-acp');

    expect(result).toMatchObject({
      status: 'ready',
      selectedSource: 'kiki-managed',
      command: normalize(process.execPath),
      resolvedArgs: [],
      version: '0.84.0',
      loginStatus: 'logged_out',
    });
    expect(result?.requirements).toEqual([
      expect.objectContaining({ id: 'claude', role: 'dependency', status: 'ok',
        path: 'C:/tools/claude.EXE', version: '2.1.220 (Claude Code)' }),
      expect.objectContaining({ id: 'claude-acp', role: 'program', label: 'claude-agent-acp', status: 'ok',
        path: CLAUDE_MANAGED,
        installHint: expect.stringContaining('C:/Users/test/.kiki/tools/claude-agent-acp') }),
    ]);
    expect(resolved.descriptor).toMatchObject({ command: normalize(process.execPath), launchArgs: [CLAUDE_MANAGED] });
  });

  it('marks the missing Claude CLI and adapter as the first setup steps', async () => {
    services.set(IHostFileSystem, fsWith(['C:/tools/node.EXE']));
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));

    const [result] = await services.get(IAgentExecutorPreflightService).run(['claude-acp']);

    expect(result?.status).toBe('unavailable');
    expect(result?.requirements?.map((requirement) => [requirement.id, requirement.status])).toEqual([
      ['claude', 'missing'],
      ['claude-acp', 'missing'],
    ]);
    expect(result?.requirements?.[0]?.installHint).toBe('npm install -g @anthropic-ai/claude-code');
  });

  describe('Claude Code credentials', () => {
    beforeEach(() => {
      processService.outputs.set(CLAUDE_PROBE, { output: '0.84.0' });
      processService.outputs.set('claude --version', { output: '2.1.220 (Claude Code)' });
    });

    const check = async (): Promise<AgentExecutorPreflightResult | undefined> =>
      (await services.get(IAgentExecutorPreflightService).run(['claude-acp']))[0];

    const setClaudeSettings = (settings: unknown): void => {
      services.set(
        IHostFileSystem,
        fsWith(
          ['C:/tools/claude.EXE', CLAUDE_MANAGED, CLAUDE_USER_SETTINGS],
          { [CLAUDE_USER_SETTINGS]: JSON.stringify(settings) },
        ),
      );
      services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
      services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));
    };

    it('accepts an API key from the host environment without reading the CLI sign-in', async () => {
      services.set(IBootstrapService, bootstrap({ ANTHROPIC_API_KEY: 'sk-ant-api03-fixture-value' }));
      const result = await check();

      expect(result).toMatchObject({
        loginStatus: 'logged_in',
        credentialSource: 'api_key_env',
        credentialDetail: 'ANTHROPIC_API_KEY',
      });
      expect(processService.calls).not.toContain('claude auth status --json');
    });

    it('accepts an auth token from the host environment as its own source', async () => {
      services.set(IBootstrapService, bootstrap({ ANTHROPIC_AUTH_TOKEN: 'fixture-token' }));
      const result = await check();

      expect(result).toMatchObject({
        loginStatus: 'logged_in',
        credentialSource: 'auth_token_env',
        credentialDetail: 'ANTHROPIC_AUTH_TOKEN',
      });
      expect(processService.calls).not.toContain('claude auth status --json');
    });

    it('accepts a key from the env block of the user Claude Code settings file', async () => {
      setClaudeSettings({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-fixture-value' } });
      const result = await check();

      expect(result).toMatchObject({ loginStatus: 'logged_in', credentialSource: 'settings_env' });
      expect(result?.credentialDetail).toBe(`${CLAUDE_USER_SETTINGS}#env.ANTHROPIC_API_KEY`);
      expect(processService.calls).not.toContain('claude auth status --json');
    });

    it('accepts a configured apiKeyHelper', async () => {
      setClaudeSettings({ apiKeyHelper: 'node -e "process.stdout.write(process.env.KEY)"' });
      const result = await check();

      expect(result).toMatchObject({ loginStatus: 'logged_in', credentialSource: 'api_key_helper' });
      expect(result?.credentialDetail).toBe(CLAUDE_USER_SETTINGS);
      expect(processService.calls).not.toContain('claude auth status --json');
    });

    it('accepts a CLI sign-in the probe reports and names the credential', async () => {
      processService.outputs.set('claude auth status --json', {
        output: '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}',
      });
      const result = await check();

      expect(result).toMatchObject({ loginStatus: 'logged_in', credentialSource: 'oauth_login' });
    });

    it('accepts a third-party backend the CLI reports', async () => {
      processService.outputs.set('claude auth status --json', {
        output: '{"loggedIn":false,"apiProvider":"bedrock"}',
      });
      const result = await check();

      expect(result).toMatchObject({
        loginStatus: 'logged_in',
        credentialSource: 'external_backend',
        credentialDetail: 'bedrock',
      });
    });

    it('reports no credential at all as signed out, with no source', async () => {
      processService.outputs.set('claude auth status --json', {
        output: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
      });
      const result = await check();

      expect(result).toMatchObject({ loginStatus: 'logged_out', credentialSource: 'none' });
      expect(result?.credentialDetail).toBeUndefined();
    });

    it('names an API key the CLI reports when nothing local can attribute it', async () => {
      processService.outputs.set('claude auth status --json', {
        output: '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"/login managed key"}',
      });
      const result = await check();

      expect(result).toMatchObject({
        loginStatus: 'logged_in',
        credentialSource: 'api_key',
        credentialDetail: '/login managed key',
      });
    });

    it('accepts a third-party backend declared in the host environment', async () => {
      services.set(IBootstrapService, bootstrap({ CLAUDE_CODE_USE_BEDROCK: '1' }));
      const result = await check();

      expect(result).toMatchObject({
        loginStatus: 'logged_in',
        credentialSource: 'external_backend',
        credentialDetail: 'CLAUDE_CODE_USE_BEDROCK',
      });
      expect(processService.calls).not.toContain('claude auth status --json');
    });

    it('ignores a disabled third-party backend switch', async () => {
      services.set(IBootstrapService, bootstrap({ CLAUDE_CODE_USE_BEDROCK: '0' }));
      processService.outputs.set('claude auth status --json', {
        output: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
      });
      const result = await check();

      expect(result).toMatchObject({ loginStatus: 'logged_out', credentialSource: 'none' });
    });

    it('reports an unreadable credential as unknown when the CLI cannot answer either', async () => {
      processService.outputs.set('claude auth status --json', { output: 'not json' });
      const result = await check();

      expect(result).toMatchObject({ loginStatus: 'unknown', credentialSource: 'unknown' });
    });

    it('leaves the launch environment untouched so Claude Code keeps its own config directory', async () => {
      const resolved = await services.get(IAgentExecutorRegistry).resolveExecutable('claude-acp');

      expect(resolved.descriptor.env).toBeUndefined();
      expect(resolved.descriptor.selectedSource).toBe('kiki-managed');
    });
  });
});
