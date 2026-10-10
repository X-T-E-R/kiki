import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { MODEL_SWITCH_SECTION, type ModelSwitchPreferencesConfig } from '#/app/modelSwitchPreferences/configSection';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

const disposables = new DisposableStore();
afterEach(() => {
  disposables.clear();
});

function createConfig(storage = new InMemoryStorageService()): { config: IConfigService; storage: InMemoryStorageService } {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, stubBootstrap('/tmp/model-switch-config'));
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  return { config: ix.get(IConfigService), storage };
}

async function readToml(storage: InMemoryStorageService): Promise<string> {
  return new TextDecoder().decode(await storage.read('', 'config.toml'));
}

describe('model switch config section', () => {
  it('registers defaults without writing the file on read', async () => {
    const { config, storage } = createConfig();
    await config.ready;
    expect(config.get(MODEL_SWITCH_SECTION)).toEqual({ defaultMode: 'direct', confirm: true, rules: [] });
    expect(await storage.read('', 'config.toml')).toBeUndefined();
  });

  it('round trips nested TOML rules, preserving order and replacing removed rule fields', async () => {
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode([
      'custom_top = "preserve"', '[model_switch]', 'default_mode = "compact"', 'confirm = false',
      '[[model_switch.rules]]', 'id = "first"', 'enabled = false', 'from_models = ["example/Source-*"]', 'mode = "fresh"', 'confirm = true',
      '[[model_switch.rules]]', 'id = "second"', 'to_models = ["example/target?"]', 'mode = "direct"', '',
    ].join('\n')));
    const { config } = createConfig(storage);
    await config.ready;
    const initial: ModelSwitchPreferencesConfig = {
      defaultMode: 'compact', confirm: false,
      rules: [
        { id: 'first', enabled: false, fromModels: ['example/Source-*'], mode: 'fresh', confirm: true },
        { id: 'second', enabled: true, toModels: ['example/target?'], mode: 'direct' },
      ],
    };
    expect(config.get(MODEL_SWITCH_SECTION)).toEqual(initial);
    await config.set(MODEL_SWITCH_SECTION, { confirm: true });
    expect(config.get(MODEL_SWITCH_SECTION)).toEqual({ ...initial, confirm: true });
    await config.set(MODEL_SWITCH_SECTION, { rules: [{ id: 'first', enabled: true, toModels: ['example/new'], mode: 'compact' }] });
    const written = await readToml(storage);
    expect(written).toContain('[[model_switch.rules]]');
    expect(written).not.toContain('fromModels');
    expect(written).not.toContain('toModels');
    expect(written).not.toContain('defaultMode');
    expect(parse(written)).toEqual({ custom_top: 'preserve', model_switch: {
      default_mode: 'compact', confirm: true,
      rules: [{ id: 'first', enabled: true, to_models: ['example/new'], mode: 'compact' }],
    } });
    const reloaded = createConfig(storage).config;
    await reloaded.ready;
    expect(reloaded.get(MODEL_SWITCH_SECTION)).toEqual(config.get(MODEL_SWITCH_SECTION));
    await reloaded.set(MODEL_SWITCH_SECTION, { rules: [] });
    expect(await readToml(storage)).not.toContain('[[model_switch.rules]]');
  });

  it('validates internal writes before changing effective values or persistent bytes', async () => {
    const { config, storage } = createConfig();
    await config.ready;
    await config.set(MODEL_SWITCH_SECTION, { defaultMode: 'fresh' });
    const before = await readToml(storage);
    const value = config.get(MODEL_SWITCH_SECTION);
    for (const invalid of [
      { defaultMode: 'invalid' }, { confirm: 1 },
      { rules: [{ id: 'empty', mode: 'direct', fromModels: [] }] },
      { rules: [{ id: 'blank', mode: 'direct', toModels: [' '] }] },
      { rules: [{ id: 'missing' }] },
      { rules: [{ id: 'same', mode: 'direct' }, { id: 'same', mode: 'fresh' }] },
    ]) {
      await expect(config.set(MODEL_SWITCH_SECTION, invalid)).rejects.toThrow();
      expect(config.get(MODEL_SWITCH_SECTION)).toEqual(value);
      expect(await readToml(storage)).toBe(before);
    }
  });
});
