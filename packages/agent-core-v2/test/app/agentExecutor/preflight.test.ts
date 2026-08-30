import { PassThrough, Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  AgentExecutorPreflightService,
  IAgentExecutorPreflightService,
} from '#/app/agentExecutor/preflight';
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
    homeDir: 'C:/Users/test/.kimi-code',
    configPath: 'C:/Users/test/.kimi-code/config.toml',
    configReadOnly: true,
    userAgentProfileHomeDir: 'C:/Users/test/.kimi-code',
    modelAccountHomeDir: 'C:/Users/test/.kimi-code',
    clientIdentity: { productName: 'test', version: '0', platform: 'test' },
    args: { requestHeaders: {} },
    sessionsDir: 'sessions',
    blobsDir: 'blobs',
    storeDir: 'store',
    cacheDir: 'cache',
    logsDir: 'logs',
    configKey: 'config.toml',
    getEnv: (name) => name === 'CODEX_HOME' ? 'C:/codex-home' : undefined,
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
      'C:/Users/test/.claude',
      'C:/Users/test/.gemini',
    ]));
    services.set(IBootstrapService, bootstrap());
    services.set(
      IAgentExecutorPreflightService,
      new SyncDescriptor(AgentExecutorPreflightService),
    );
  });

  afterEach(() => services.dispose());

  it('probes all seven harnesses and selects the Gemini experimental fallback', async () => {
    processService.outputs.set('grok --version', { output: 'grok 1.0.13' });
    processService.outputs.set('codex-acp --version', { output: 'codex-acp 1.7.0' });
    processService.outputs.set('codex --version', { output: 'codex 0.1.0' });
    processService.outputs.set('cursor-agent --version', { output: 'cursor 1.0.0' });
    processService.outputs.set('claude-agent-acp --version', { output: 'claude-agent-acp 0.69.0' });
    processService.outputs.set('gemini --version', { output: '0.55.1' });
    processService.outputs.set('gemini --help', { output: '  --experimental-acp  Start ACP mode' });
    processService.outputs.set('kimi --version', { output: '0.37.1' });
    processService.outputs.set('opencode --version', { output: '1.18.18' });

    const results = await services.get(IAgentExecutorPreflightService).run();

    expect(results).toHaveLength(7);
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

  it('reports unavailable binaries without treating missing auth as success', async () => {
    services.set(IHostFileSystem, fsWith([]));
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
