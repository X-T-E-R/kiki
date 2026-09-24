import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'pathe';

import { beforeEach, describe, expect, it } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IBootstrapService,
  bootstrap,
  bootstrapSeed,
  resolveBootstrapOptions,
} from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { stubClientIdentity } from './stubs';

describe('BootstrapService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IBootstrapService,
      BootstrapService,
      ScopeActivation.OnScopeCreated,
      'bootstrap',
    );
  });

  it('resolves homeDir/configPath from the seeded context token', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    const homeDir = resolve('/tmp/kimi-home');
    expect(svc.homeDir).toBe(homeDir);
    expect(svc.configPath).toBe(join(homeDir, 'config.toml'));
    expect(svc.configReadOnly).toBe(false);
    expect(svc.userAgentProfileHomeDir).toBe(homeDir);
    expect(svc.modelAccountHomeDir).toBe(homeDir);
    expect(svc.scope('sessions')).toBe('sessions');
    host.dispose();
  });

  it('exposes the seeded client identity', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.clientIdentity).toEqual(stubClientIdentity);
    host.dispose();
  });

  it('getEnv reads from the seeded env bag', () => {
    const host = createScopedTestHost(
      bootstrapSeed({ env: { FOO: 'bar' }, clientIdentity: stubClientIdentity }),
    );
    const svc = host.app.accessor.get(IBootstrapService);
    expect(svc.getEnv('FOO')).toBe('bar');
    expect(svc.getEnv('MISSING')).toBeUndefined();
    host.dispose();
  });
});

describe('resolveBootstrapOptions', () => {
  it('prefers explicit homeDir over KIKI_HOME over osHomeDir', () => {
    expect(
      resolveBootstrapOptions({ homeDir: '/a', osHomeDir: '/b', env: {}, clientIdentity: stubClientIdentity })
        .homeDir,
    ).toBe(resolve('/a'));
    expect(
      resolveBootstrapOptions({
        osHomeDir: '/b',
        env: { KIKI_HOME: '/c' },
        clientIdentity: stubClientIdentity,
      }).homeDir,
    ).toBe(resolve('/c'));
    expect(
      resolveBootstrapOptions({ osHomeDir: '/b', env: {}, clientIdentity: stubClientIdentity }).homeDir,
    ).toBe(resolve('/b', '.kiki'));
  });

  it('passes through an explicit clientIdentity', () => {
    expect(
      resolveBootstrapOptions({ env: {}, clientIdentity: stubClientIdentity }).clientIdentity,
    ).toEqual(stubClientIdentity);
  });

  it('resolves an independent read-only config and user-agent source', () => {
    const options = resolveBootstrapOptions({
      homeDir: '/runtime',
      configPath: '/active/config.toml',
      configReadOnly: true,
      userAgentProfileHomeDir: '/active',
      modelAccountHomeDir: '/accounts',
      env: {},
      clientIdentity: stubClientIdentity,
    });
    expect(options).toMatchObject({
      homeDir: resolve('/runtime'),
      configPath: '/active/config.toml',
      configReadOnly: true,
      userAgentProfileHomeDir: '/active',
      modelAccountHomeDir: '/accounts',
    });
  });
});

describe('bootstrap() storage seeding', () => {
  it('seeds IFileSystemStorageService as a FileStorageService instance', () => {
    const { app } = bootstrap({ homeDir: '/tmp/kimi-home', clientIdentity: stubClientIdentity });
    try {
      const storage = app.accessor.get(IFileSystemStorageService);
      expect(storage).toBeInstanceOf(FileStorageService);
    } finally {
      app.dispose();
    }
  });

  it('cleans expired dead session locks on startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-bootstrap-locks-'));
    const lockDir = join(root, 'session-locks');
    const lockPath = join(lockDir, 'orphan.lock');
    await mkdir(lockDir);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      processStartedAt: 0,
      token: 'orphan',
      acquiredAt: Date.now() - 10_000,
      leaseMs: 1_000,
    }));
    const expiredAt = new Date(Date.now() - 5_000);
    await utimes(lockPath, expiredAt, expiredAt);
    const { app } = bootstrap({ homeDir: root, clientIdentity: stubClientIdentity });
    try {
      await expect.poll(async () => (await readdir(lockDir)).includes('orphan.lock')).toBe(false);
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('reads an external config without allowing writes through the runtime store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-bootstrap-config-'));
    const runtimeHome = join(root, 'runtime');
    const activeHome = join(root, 'active');
    const configPath = join(activeHome, 'active.toml');
    await mkdir(activeHome);
    await writeFile(configPath, 'default_model = "grok-4.6"\n', { encoding: 'utf8', flag: 'wx' });
    const { app } = bootstrap({
      homeDir: runtimeHome,
      configPath,
      configReadOnly: true,
      clientIdentity: stubClientIdentity,
    });
    try {
      const store = app.accessor.get(IAtomicTomlDocumentStore);
      expect(await store.get('', 'active.toml')).toEqual({ default_model: 'grok-4.6' });
      await expect(store.set('', 'active.toml', { default_model: 'other' })).rejects.toMatchObject({
        code: 'storage.permission_denied',
      });
      expect(await readFile(configPath, 'utf8')).toBe('default_model = "grok-4.6"\n');
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
