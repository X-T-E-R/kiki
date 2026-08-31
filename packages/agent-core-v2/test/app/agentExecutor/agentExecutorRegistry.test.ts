import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import {
  IAgentExecutorRegistry,
  registerAgentExecutorProvider,
} from '#/app/agentExecutor/agentExecutor';
import { AgentExecutorRegistryService } from '#/app/agentExecutor/agentExecutorRegistryService';
import {
  AgentExecutorsConfigSchema,
  agentExecutorsFromToml,
} from '#/app/agentExecutor/configSection';
import type { IDisposable } from '#/_base/di/lifecycle';

const processService = { _serviceBrand: undefined } as unknown as IHostProcessService;
const fs = { _serviceBrand: undefined } as unknown as IHostFileSystem;
const bootstrap = { _serviceBrand: undefined } as unknown as IBootstrapService;

function configWith(value: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: Event.None as IConfigService['onDidChangeConfiguration'],
    onDidSectionChange: Event.None as IConfigService['onDidSectionChange'],
    onDidChangeDiagnostics: Event.None as IConfigService['onDidChangeDiagnostics'],
    get: <T>() => value as T,
    inspect: () => ({
      value: undefined,
      defaultValue: undefined,
      userValue: undefined,
      memoryValue: undefined,
    }),
    getAll: () => ({}),
    set: async () => {},
    replace: async () => {},
    replaceSections: async () => {},
    reload: async () => {},
    diagnostics: () => [],
  };
}

describe('AgentExecutorRegistryService', () => {
  let services: TestInstantiationService;
  let provider: IDisposable | undefined;

  beforeEach(() => {
    services = new TestInstantiationService();
    services.set(IHostProcessService, processService);
    services.set(IHostFileSystem, fs);
    services.set(IBootstrapService, bootstrap);
  });

  afterEach(() => {
    provider?.dispose();
    provider = undefined;
    services.dispose();
  });

  it('normalizes the native executor when no descriptor is configured', () => {
    services.set(IConfigService, configWith({}));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(services.get(IAgentExecutorRegistry).resolve()).toMatchObject({
      descriptor: { id: 'native', protocol: 'native', revision: 'native' },
      options: {},
    });
  });

  it('rejects unknown executor ids instead of falling back to native', () => {
    services.set(IConfigService, configWith({}));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );

    expect(() => services.get(IAgentExecutorRegistry).resolve('typo')).toThrow(
      /Unknown agent executor "typo"/,
    );
  });

  it('derives a stable one-way revision without exposing descriptor environment values', () => {
    const secret = 'sentinel-super-secret-token';
    const first = new AgentExecutorRegistryService(configWith({
      secure: {
        protocol: 'acp-v1',
        command: 'secure-agent',
        args: ['stdio'],
        env: { TOKEN: secret, REGION: 'test' },
      },
    }), processService, fs, bootstrap).get('secure')!;
    const reordered = new AgentExecutorRegistryService(configWith({
      secure: {
        protocol: 'acp-v1',
        command: 'secure-agent',
        args: ['stdio'],
        env: { REGION: 'test', TOKEN: secret },
      },
    }), processService, fs, bootstrap).get('secure')!;

    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.revision).toBe(reordered.revision);
    expect(JSON.stringify({ revision: first.revision })).not.toContain(secret);
  });

  it('delegates closed option validation to the protocol provider', () => {
    provider = registerAgentExecutorProvider({
      id: 'fake-acp',
      protocol: 'acp-v1',
      validateOptions: (value) => {
        const options = value as Readonly<Record<string, unknown>>;
        for (const key of Object.keys(options)) {
          if (key !== 'mode') throw new Error(`Unknown executor option "${key}"`);
        }
        return options as Readonly<Record<string, string | number | boolean>>;
      },
      create: () => {
        throw new Error('not used');
      },
    });
    services.set(IConfigService, configWith({
      'fake-acp': {
        protocol: 'acp-v1',
        command: 'fake',
        args: [],
      },
    }));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );
    const registry = services.get(IAgentExecutorRegistry);

    expect(registry.resolve('fake-acp', { mode: 'default' }).options).toEqual({
      mode: 'default',
    });
    expect(() => registry.resolve('fake-acp', { typo: true })).toThrow(
      /Unknown executor option "typo"/,
    );
  });

  it('parses trusted snake-case descriptors and rejects unknown descriptor keys', () => {
    const parsed = AgentExecutorsConfigSchema.parse(
      agentExecutorsFromToml({
        cursor: {
          protocol: 'acp-v1',
          command: 'cursor-agent',
          args: ['acp'],
          env: { CURSOR_CONFIG_DIR: 'C:/cursor' },
          startup_timeout_ms: 70_000,
          model_binding: 'argv',
          model_args: ['--model', '{model}'],
          revision: 'r1',
        },
      }),
    );

    expect(parsed['cursor']).toMatchObject({
      protocol: 'acp-v1',
      command: 'cursor-agent',
      args: ['acp'],
      env: { CURSOR_CONFIG_DIR: 'C:/cursor' },
      startupTimeoutMs: 70_000,
      modelBinding: 'argv',
      modelArgs: ['--model', '{model}'],
      revision: 'r1',
    });
    expect(() => AgentExecutorsConfigSchema.parse({
      cursor: {
        protocol: 'acp-v1',
        command: 'cursor-agent',
        args: [],
        shell: true,
      },
    })).toThrow();
  });

  it('provides the eight trusted external harness descriptors by default', () => {
    services.set(IConfigService, configWith({}));
    services.set(
      IAgentExecutorRegistry,
      new SyncDescriptor(AgentExecutorRegistryService),
    );
    const registry = services.get(IAgentExecutorRegistry);

    expect([
      'grok-acp',
      'codex-app-server',
      'codex-acp',
      'cursor-acp',
      'claude-acp',
      'gemini-acp',
      'kimi-acp',
      'opencode-acp',
    ].map((id) => registry.get(id)?.id)).toEqual([
      'grok-acp',
      'codex-app-server',
      'codex-acp',
      'cursor-acp',
      'claude-acp',
      'gemini-acp',
      'kimi-acp',
      'opencode-acp',
    ]);
    expect(registry.get('grok-acp')).toMatchObject({
      args: ['--no-auto-update', 'agent', 'stdio'],
      startupTimeoutMs: 70_000,
      revision: '2026-08-30.1',
    });
    expect(registry.get('codex-acp')).toMatchObject({
      env: { DISABLE_MCP_CONFIG_FILTERING: 'true' },
      startupTimeoutMs: 150_000,
    });
    expect(registry.get('cursor-acp')).toMatchObject({
      args: ['acp'],
      modelBinding: 'argv',
      modelArgs: ['--model', '{model}'],
    });
  });
});
