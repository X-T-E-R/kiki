import { afterEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import { HookRulesRegistry } from '#/features/externalHooks/app/hookRulesService';
import { IHookRulesRegistry } from '#/features/externalHooks/app/hookRules';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IModelService } from '#/kosong/model/model';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function config(): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: Event.None,
    onDidSectionChange: Event.None,
    onDidChangeDiagnostics: Event.None,
    get: () => undefined,
    inspect: () => ({ key: '', defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({}),
    origins: () => ({}),
    removeOverride: async () => {},
    set: async () => {},
    replace: async () => {},
    replaceSections: async () => {},
    reload: async () => {},
    diagnostics: () => [],
  } as unknown as IConfigService;
}

describe('HookRulesRegistry readiness', () => {
  let disposables: DisposableStore | undefined;

  afterEach(async () => {
    await disposables?.dispose();
    disposables = undefined;
  });

  it('waits for host environment readiness before reading pathClass and recovers diagnostics on reload', async () => {
    const environmentReady = deferred();
    let environmentReadyResolved = false;
    let pathReads = 0;
    const environment = {
      _serviceBrand: undefined,
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      get pathClass(): 'posix' {
        pathReads += 1;
        if (!environmentReadyResolved) throw new Error('environment not ready');
        return 'posix';
      },
      homeDir: '/tmp',
      ready: environmentReady.promise,
    } as unknown as IHostEnvironment;
    const enabledHookRules = vi.fn(async () => []);
    const plugins = {
      _serviceBrand: undefined,
      enabledHookRules,
      onWillChange: Event.None,
      onDidReload: Event.None,
      onDidMutate: Event.None,
    } as unknown as IPluginService;
    const models = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeModels: Event.None,
      onDidChangeDefaultModel: Event.None,
      resolveId: (id: string) => id,
      get: () => undefined,
      list: () => ({}),
      getDefaultModel: () => undefined,
      set: async () => {},
      delete: async () => {},
      loadAll: () => {},
      replaceAll: async () => {},
      setDefaultModel: async () => {},
    } as unknown as IModelService;
    disposables = new DisposableStore();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHookRulesRegistry, HookRulesRegistry);
        reg.defineInstance(IConfigService, config());
        reg.defineInstance(IPluginService, plugins);
        reg.defineInstance(IModelService, models);
        reg.defineInstance(IHostEnvironment, environment);
        reg.defineInstance(IBootstrapService, { configPath: '/tmp/config.toml', configReadOnly: false } as IBootstrapService);
        reg.defineInstance(IHostFileSystem, {} as IHostFileSystem);
        reg.defineInstance(IHostFsWatchService, { _serviceBrand: undefined, watch: () => { throw new Error('watch should not start without rules'); } });
      },
    });
    const registry = ix.get(IHookRulesRegistry);
    let settled = false;
    const ready = registry.ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pathReads).toBe(0);
    environmentReadyResolved = true;
    environmentReady.resolve();
    await ready;
    expect(pathReads).toBe(1);
    enabledHookRules.mockRejectedValueOnce(new Error('plugin probe failed'));
    await registry.reload();
    expect(registry.snapshot().diagnostics[0]?.message).toContain('plugin probe failed');
    enabledHookRules.mockResolvedValueOnce([]);
    await registry.reload();
    expect(registry.snapshot().diagnostics).toEqual([]);
  });
});
