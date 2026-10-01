import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'pathe';

import { beforeEach, describe, expect, it } from 'vitest';
import { spaceRecordSchema } from '@kiki/protocol';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  IBootstrapService,
  bootstrap,
  bootstrapSeed,
  createBaseConfigDocumentStore,
  resolveBootstrapOptions,
} from '#/app/bootstrap/bootstrap';
import { BootstrapService } from '#/app/bootstrap/bootstrapService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
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

  it('shares model OAuth with the base when credentials are shared and isolates it on opt-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-space-auth-'));
    try {
      const base = join(root, 'base');
      const child = join(root, 'child');
      await mkdir(child);
      await writeFile(join(child, 'home.toml'), `schema = 1\nid = "h-auth"\nname = "Test"\nbase = "${base.replaceAll('\\', '/')}"\n`);
      const shared = resolveBootstrapOptions({ homeDir: child, clientIdentity: stubClientIdentity });
      expect(shared.modelAccountHomeDir).toBe(base);
      expect(shared.credentialsHomeDir).toBe(base);
      await writeFile(join(child, 'home.toml'), `schema = 1\nid = "h-auth"\nname = "Test"\nbase = "${base.replaceAll('\\', '/')}"\n[inherit]\ncredentials = "isolated"\n`);
      const isolated = resolveBootstrapOptions({ homeDir: child, clientIdentity: stubClientIdentity });
      expect(isolated.modelAccountHomeDir).toBe(resolve(child));
      expect(isolated.credentialsHomeDir).toBe(resolve(child));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      await expect(store.getText('', 'active.toml')).resolves.toBe('default_model = "grok-4.6"\n');
      await expect(store.set('', 'active.toml', { default_model: 'other' })).rejects.toMatchObject({
        code: 'storage.permission_denied',
      });
      await expect(store.setText('', 'active.toml', 'default_model = "other"\n')).rejects.toMatchObject({ code: 'storage.permission_denied' });
      await expect(store.compareAndSetText('', 'active.toml', 'default_model = "grok-4.6"\n', 'default_model = "other"\n')).rejects.toMatchObject({ code: 'storage.permission_denied' });
      expect(await readFile(configPath, 'utf8')).toBe('default_model = "grok-4.6"\n');
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('permits a no-recovery preview read while keeping ordinary store recovery unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-config-peek-'));
    const orphan = join(root, 'config.toml.tmp.2147483647.dead');
    const text = '[models.acme]\nprovider = "acme"\n';
    await writeFile(orphan, text, 'utf8');
    try {
      const store = new TomlAtomicDocumentStore(new FileStorageService(root));
      await expect(store.getText('', 'config.toml', { recoverMissing: false })).resolves.toBeUndefined();
      expect(await readdir(root)).toEqual(['config.toml.tmp.2147483647.dead']);
      await expect(store.getText('', 'config.toml')).resolves.toBe(text);
      expect(await readdir(root)).toEqual(['config.toml']);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});


describe('space home bootstrap', () => {
  it('reads the base config through a write-denying document store', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kiki-base-store-'));
    try {
      await writeFile(join(base, 'config.toml'), 'default_model = "original"\n');
      const store = createBaseConfigDocumentStore(base);
      expect(await store.getText('', 'config.toml')).toContain('original');
      await expect(store.setText('', 'config.toml', 'default_model = "changed"\n')).rejects.toMatchObject({ code: 'storage.permission_denied' });
      expect(await readFile(join(base, 'config.toml'), 'utf8')).toContain('original');
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('keeps legacy homes without home.toml unchanged', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kiki-legacy-home-'));
    try {
      const options = resolveBootstrapOptions({ homeDir, clientIdentity: stubClientIdentity });
      expect(options).toMatchObject({ homeDir: resolve(homeDir), credentialsHomeDir: resolve(homeDir), modelAccountHomeDir: resolve(homeDir) });
      expect(options.spaceId).toBeUndefined();
      expect(options.baseHomeDir).toBeUndefined();
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });

  it('parses identity, defaults, stacking, and the shared credential source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-space-home-'));
    const base = join(root, 'base');
    const home = join(root, 'space');
    await mkdir(base); await mkdir(home);
    try {
      await writeFile(join(home, 'home.toml'), `schema = 1\nid = "h-abc123"\nname = "Demo"\ncolor = "#C2410C"\nbase = "${base.replaceAll('\\', '/')}"\n[inherit]\ninstructions = "stack"\n`);
      const options = resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity });
      expect(options).toMatchObject({ baseHomeDir: base, spaceId: 'h-abc123', credentialsHomeDir: base, modelAccountHomeDir: base, space: { inherit: { instructions: 'stack', config: true, credentials: 'shared', plugins: false } } });
      await writeFile(join(home, 'home.toml'), `schema = 1\nid = "h-abc123"\nname = "Demo"\nbase = "${base.replaceAll('\\', '/')}"\n[inherit]\ncredentials = "isolated"\n`);
      expect(resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity }).credentialsHomeDir).toBe(resolve(home));
      await writeFile(join(base, 'home.toml'), 'schema = 1\nid = "h-base"\nname = "Base"\n');
      const nested = resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity });
      expect(nested.baseHomeDir).toBeUndefined();
      expect(nested.homeDiagnostic).toContain('multi-level inheritance');
      await writeFile(join(home, 'home.toml'), 'schema = 2\nid = "h-abc123"\nname = "Demo"\n');
      const invalid = resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity });
      expect(invalid.spaceId).toBeUndefined();
      expect(invalid.homeDiagnostic).toContain('schema = 1');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('inherits preset display values but preserves authored values and unknown preset identities', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-space-preset-'));
    try {
      await writeFile(join(home, 'home.toml'), 'schema = 1\nid = "h-preset"\npreset = "kiki"\n');
      expect(resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity }).space).toMatchObject({ name: 'Kiki', color: undefined, preset: 'kiki' });
      await writeFile(join(home, 'home.toml'), 'schema = 1\nid = "h-preset"\npreset = "kiki"\nname = "Custom"\ncolor = "#be185d"\n');
      expect(resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity }).space).toMatchObject({ name: 'Custom', color: '#be185d', preset: 'kiki' });
      await writeFile(join(home, 'home.toml'), 'schema = 1\nid = "h-preset"\npreset = "future"\nname = "Retained"\n');
      expect(resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity }).space).toMatchObject({ name: 'Retained', preset: 'future' });
      await writeFile(join(home, 'home.toml'), 'schema = 1\nid = "h-preset"\npreset = "../escape"\n');
      expect(resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity }).homeDiagnostic).toContain('Invalid home.toml');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('validates space identity with the same schemas the REST record uses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-space-identity-'));
    const home = join(root, 'space');
    await mkdir(home);
    const cases = [
      { id: 'h-abc-1', name: 'Demo', color: '#C2410C', accepted: true },
      { id: 'h-ABC1', name: 'Demo', accepted: false },
      { id: 'space-1', name: 'Demo', accepted: false },
      { id: 'h-abc1', name: '   ', accepted: false },
      { id: 'h-abc1', name: 'Demo', color: 'C2410C', accepted: false },
    ] as const;
    try {
      for (const entry of cases) {
        const color = 'color' in entry ? `color = "${entry.color}"\n` : '';
        const name = JSON.stringify(entry.name);
        await writeFile(join(home, 'home.toml'), `schema = 1\nid = "${entry.id}"\nname = ${name}\n${color}`);
        const options = resolveBootstrapOptions({ homeDir: home, clientIdentity: stubClientIdentity });
        expect(options.spaceId).toBe(entry.accepted ? entry.id : undefined);
        expect(spaceRecordSchema.safeParse({
          id: entry.id,
          name: entry.name,
          color: 'color' in entry ? entry.color : undefined,
          path: home,
        }).success).toBe(entry.accepted);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
