import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  resolveDefaultSubagentProfileName,
  resolveDispatchCapacityLimits,
  resolveSubagentTimeoutMs,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
} from '#/session/subagent/configSection';
import {
  DISABLED_BUILTIN_PROFILES_SECTION,
  SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION,
} from '#/workspace/workspaceAgentProfileLoader/configSection';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

async function withConfig(toml: string, run: (config: IConfigService) => Promise<void> | void): Promise<void> {
  const disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  const storage = new InMemoryStorageService();
  await storage.write('', 'config.toml', new TextEncoder().encode(toml));
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, stubBootstrap('/tmp/profile-config'));
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  try {
    const config = ix.get(IConfigService);
    await config.ready;
    await run(config);
  } finally {
    disposables.dispose();
  }
}

describe('agent profile configuration through TOML', () => {
  it.each(['', '[subagent]', '[subagent]\ntimeout_ms = 1234', '[subagent]\ndeny_models = ["example"]'])('inherits general from partial config %s', async (toml) => {
    await withConfig(toml, (config) => {
      expect(resolveDefaultSubagentProfileName(config)).toBe('general');
      expect(resolveDispatchCapacityLimits(config)).toEqual({ maxDirectChildren: 16, maxTotalSubagents: 0 });
      expect(resolveSubagentTimeoutMs(config)).toBe(toml.includes('1234') ? 1234 : DEFAULT_SUBAGENT_TIMEOUT_MS);
      expect(config.diagnostics()).toEqual([]);
    });
  });

  it('enters strict mode only for an explicitly blank default_profile and restores defaults on removal', async () => {
    await withConfig('[subagent]\ntimeout_ms = 1234\ndefault_profile = ""', async (config) => {
      expect(resolveDefaultSubagentProfileName(config)).toBeUndefined();
      await config.replace('subagent', { timeoutMs: 5678 });
      expect(resolveDefaultSubagentProfileName(config)).toBe('general');
      await config.reload();
      expect(resolveDefaultSubagentProfileName(config)).toBe('general');
    });
  });

  it('loads the installation policy and warns while retaining the deprecated alias', async () => {
    await withConfig('disabled_builtin_profiles = ["plan"]\nskip_builtin_profile_installation = []', (config) => {
      expect(config.get(DISABLED_BUILTIN_PROFILES_SECTION)).toEqual(['plan']);
      expect(config.get(SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION)).toEqual([]);
      expect(config.diagnostics()).toEqual([expect.objectContaining({
        domain: DISABLED_BUILTIN_PROFILES_SECTION,
        severity: 'warning',
        message: expect.stringContaining('skip_builtin_profile_installation'),
      })]);
    });
  });

  it('does not emit a deprecation warning for the new installation key alone', async () => {
    await withConfig('skip_builtin_profile_installation = ["general"]', (config) => {
      expect(config.get(SKIP_BUILTIN_PROFILE_INSTALLATION_SECTION)).toEqual(['general']);
      expect(config.diagnostics()).toEqual([]);
    });
  });
});
