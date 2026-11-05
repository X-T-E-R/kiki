import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { HostProcessLike, HostProcessServiceLike } from '@kiki/acp-client';
import type { HarnessAccountConnection } from '@kiki/protocol';

import { ILogService } from '#/_base/log/log';
import { IAgentExecutorRegistry, type AgentExecutorContext, type AgentExecutorDescriptor } from '#/app/agentExecutor/agentExecutor';
import { materializeExecutorInstance } from '#/app/agentExecutor/executorInstances';
import { executorProcessOptions } from '#/app/agentExecutor/executorOverrides';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { harnessAccountProcess } from '#/agent/execution/harnessAccountProcess';

function setup(engineId = 'agy-cli') {
  const source = 'plugin:fixture-account-source/accounts';
  const descriptor = materializeExecutorInstance('instance-fixture', {
    source_executor: engineId, label: 'Work login', configuration: { kind: 'plugin_account', source, account_id: 'work' }, proxy: { kind: 'inherit' },
  }, { id: engineId, protocol: engineId === 'agy-cli' ? 'acp-v1' : 'codex-app-server', command: 'engine', args: [], revision: 'source' }, () => undefined);
  const connection: HarnessAccountConnection = { protocol: engineId === 'agy-cli' ? 'gemini-v1beta' : 'openai-responses',
    baseUrl: `http://127.0.0.1:12345${engineId === 'agy-cli' ? '' : '/v1'}`, apiKey: 'synthetic-short-lived-key', modelIds: ['fixture-model'] };
  const release = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ connection, release }));
  const record = vi.fn();
  const warn = vi.fn();
  const get = vi.fn((service: unknown) => {
    if (service === IPluginHostService) return { prepareHarnessAccount: prepare };
    if (service === IAgentExecutorRegistry) return { recordNegotiated: record };
    if (service === ILogService) return { warn };
    throw Error('Unexpected fixture service');
  });
  const context = { descriptor, binding: {}, agent: { accessor: { get } } } as unknown as AgentExecutorContext;
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const child: HostProcessLike = { pid: 9, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    wait: () => exited, kill: async () => { finish(0); }, dispose: () => {} };
  const spawn = vi.fn<HostProcessServiceLike['spawn']>(async () => child);
  const launch = harnessAccountProcess({ spawn }, context, 'local');
  return { connection, context, descriptor, source, prepare, release, spawn, launch, finish, get, warn };
}

describe('plugin account process ownership', () => {
  it('does not read a plugin host for an original global engine', async () => {
    const fixture = setup();
    const descriptor: AgentExecutorDescriptor = { id: 'agy-cli', protocol: 'acp-v1', command: 'engine', args: [], revision: 'original' };
    const processes = { spawn: fixture.spawn };
    const global = harnessAccountProcess(processes, { ...fixture.context, descriptor }, 'local');
    expect(global.processes).toBe(processes);
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it.each(['agy-cli', 'codex-app-server'])('keeps %s secrets out of argv and descriptor revisions, releasing at real exit', async (engineId) => {
    const f = setup(engineId);
    const before = JSON.stringify(f.descriptor);
    const signal = new AbortController().signal;
    await f.launch.processes.spawn('engine', ['original-arg'], executorProcessOptions(f.descriptor), signal);
    expect(f.prepare).toHaveBeenCalledWith(f.source, { engineId, accountId: 'work', instanceId: 'instance-fixture', proxy: { mode: 'system', url: undefined } }, signal);
    const [, args, options] = f.spawn.mock.calls[0]!;
    expect(args?.[0]).toBe('original-arg');
    expect(JSON.stringify(args)).not.toContain(f.connection.apiKey);
    expect(options?.env?.[engineId === 'agy-cli' ? 'GEMINI_API_KEY' : 'KIKI_HARNESS_API_KEY']).toBe(f.connection.apiKey);
    expect(options?.envUnset).not.toContain(engineId === 'agy-cli' ? 'GEMINI_API_KEY' : 'KIKI_HARNESS_API_KEY');
    expect(JSON.stringify(f.descriptor)).toBe(before);
    expect(f.launch.processes.redactDiagnostic?.(f.connection.apiKey)).toBe('[redacted]');
    expect(f.release).not.toHaveBeenCalled();
    f.finish(0);
    await vi.waitFor(() => { expect(f.release).toHaveBeenCalledOnce(); });
  });

  it('releases an acquired connection after spawn failure without trying another source', async () => {
    const f = setup();
    f.spawn.mockRejectedValueOnce(Error('spawn failure'));
    await expect(f.launch.processes.spawn('engine')).rejects.toThrow('Could not start the engine');
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('rejects an incompatible protocol before spawn and releases its lease', async () => {
    const f = setup();
    f.connection.protocol = 'openai-responses';
    await expect(f.launch.processes.spawn('engine')).rejects.toThrow('compatible connection');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('names the selected source on preparation failure without exposing backend credentials', async () => {
    const f = setup();
    f.prepare.mockRejectedValueOnce(Error(f.connection.apiKey));
    const error = await f.launch.processes.spawn('engine').catch((failure: unknown) => failure);
    expect(String(error)).toContain(f.source);
    expect(String(error)).not.toContain(f.connection.apiKey);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
