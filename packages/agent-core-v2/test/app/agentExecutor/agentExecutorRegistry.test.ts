import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
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
        grok: {
          protocol: 'acp-v1',
          command: 'grok',
          args: ['agent', 'stdio'],
          startup_timeout_ms: 70_000,
        },
      }),
    );

    expect(parsed['grok']).toMatchObject({
      protocol: 'acp-v1',
      command: 'grok',
      args: ['agent', 'stdio'],
      startupTimeoutMs: 70_000,
    });
    expect(() => AgentExecutorsConfigSchema.parse({
      grok: {
        protocol: 'acp-v1',
        command: 'grok',
        args: [],
        env: { SECRET: 'value' },
      },
    })).toThrow();
  });
});
