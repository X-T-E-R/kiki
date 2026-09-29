import { PassThrough, Readable } from 'node:stream';

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
import {
  AgentExecutorPreflightService,
  IAgentExecutorPreflightService,
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
  readonly outputs = new Map<string, { readonly output: string; readonly code?: number }>();

  async spawn(
    command: string,
    args: readonly string[] = [],
    _options?: HostProcessOptions,
  ): Promise<IHostProcess> {
    const key = [command, ...args].join(' ');
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

function bootstrap(): IBootstrapService {
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
    })[name],
    scope: () => '',
  };
}

function fsWith(paths: readonly string[]): IHostFileSystem {
  const present = new Set(paths);
  return {
    _serviceBrand: undefined,
    stat: async (path) => {
      if (!present.has(path)) throw new Error('missing');
      return { isFile: true, isDirectory: false, size: 1 } satisfies HostFileStat;
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
    ]));
    services.set(IBootstrapService, bootstrap());
    services.set(IConfigService, {
      _serviceBrand: undefined,
      get: () => undefined,
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(
      IAgentExecutorPreflightService,
      new SyncDescriptor(AgentExecutorPreflightService),
    );
  });

  afterEach(() => { vi.restoreAllMocks(); services.dispose(); });

  it('probes all eight harnesses and selects discovered sources plus the Gemini fallback', async () => {
    processService.outputs.set('grok --version', { output: 'grok 1.0.13' });
    processService.outputs.set('codex-acp --version', { output: 'codex-acp 1.7.0' });
    processService.outputs.set('codex --version', { output: 'codex 0.1.0' });
    processService.outputs.set('C:/tools/codex.exe --version', { output: 'codex-cli 0.151.0-alpha.7.1' });
    processService.outputs.set('C:/Users/test/.local/bin/cursor-agent --version', { output: 'cursor-agent 1.0.0' });
    processService.outputs.set('claude-agent-acp --version', { output: 'claude-agent-acp 0.69.0' });
    processService.outputs.set('gemini --version', { output: '0.55.1' });
    processService.outputs.set('gemini --help', { output: '  --experimental-acp  Start ACP mode' });
    processService.outputs.set('kimi --version', { output: '0.37.1' });
    processService.outputs.set('opencode --version', { output: '1.18.18' });

    const results = await services.get(IAgentExecutorPreflightService).run();

    expect(results).toHaveLength(8);
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
        expect.objectContaining({ severity: 'warning', message: expect.stringContaining('0.37+') }),
      ]),
    );
    expect(processService.calls).toEqual(expect.arrayContaining([
      'codex-acp --version',
      'codex --version',
      'gemini --help',
    ]));
  });

  it('reports a confirmed login only from the declared command probe and caches its check', async () => {
    processService.outputs.set('claude-agent-acp --version', { output: '0.81.2' });
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
      get: () => ({
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
      }),
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
      get: () => ({ 'new-acp': {
        protocol: 'acp-v1', command: 'new-agent', args: ['acp'],
        diagnostics: [{ kind: 'message', severity: 'info', message: 'Custom agent ready.' }],
      } }),
    } as unknown as IConfigService);
    services.set(IAgentExecutorRegistry, new SyncDescriptor(AgentExecutorRegistryService));
    services.set(IAgentExecutorPreflightService, new SyncDescriptor(AgentExecutorPreflightService));
    processService.outputs.set('new-agent --version', { output: 'new-agent 1.0' });
    const [result] = await services.get(IAgentExecutorPreflightService).run(['new-acp']);
    expect(result).toMatchObject({ id: 'new-acp', status: 'ready', version: 'new-agent 1.0',
      resolvedArgs: ['acp'], diagnostics: [{ severity: 'info', message: 'Custom agent ready.' }] });
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
      get: () => ({
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
      }),
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
      get: () => ({
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
      }),
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
    services.stub(IAgentStateService, { contributeState: () => ({ dispose: () => {} }) });
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
});
