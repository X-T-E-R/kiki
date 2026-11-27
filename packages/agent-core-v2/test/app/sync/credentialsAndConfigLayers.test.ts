import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigRegistry,
  ConfigService,
  ConfigTarget,
  CREDENTIALS_POOL_SECTION,
  bootstrap,
  classifyConfigSyncScope,
  createJsAgeX25519Cipher,
  extractMachineLocalConfigLayer,
  extractPortableConfigLayer,
  loadNativeAgeX25519Cipher,
  logSeed,
  mergeCredentialEnvelopes,
  openCredentialEnvelope,
  resolveLoggingConfig,
  resolveProvidersWithCredentialPool,
  sealCredentialEntry,
  sealSyncedCredentialPool,
  type AgeX25519Cipher,
  type CredentialsPoolSection,
  type ProvidersSection,
} from '#/index';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { LOCAL_CONFIG_KEY } from '#/app/config/configLayers';
import { CREDENTIALS_KEY } from '#/app/config/migrations';
import { PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import { IProviderService } from '#/kosong/provider/provider';

const dirs: string[] = [];

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiki-cred-layer-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('credential pool, X25519 envelopes, and 3-layer config.local.toml', () => {
  it('resolves named [credentials.<id>] across multiple providers without duplicating secrets in config.toml', async () => {
    const homeDir = createTempHome();
    writeFileSync(
      join(homeDir, 'config.toml'),
      [
        '[credentials.shared_gateway]',
        'kind = "api_key"',
        'sync_policy = "synced"',
        'api_key = "sk-shared-initial-key"',
        '',
        '[credentials.env_backup]',
        'kind = "env_ref"',
        'sync_policy = "env"',
        'env_var = "SYNTHETIC_POOL_API_KEY"',
        '',
        '[providers.primary_a]',
        'type = "openai"',
        'base_url = "https://api-a.example.test/v1"',
        'credential_id = "shared_gateway"',
        '',
        '[providers.secondary_b]',
        'type = "openai"',
        'base_url = "https://api-b.example.test/v1"',
        'credential_id = "shared_gateway"',
        '',
        '[providers.env_backed]',
        'type = "openai"',
        'base_url = "https://api-c.example.test/v1"',
        'credential_id = "env_backup"',
        '',
      ].join('\n'),
      'utf8',
    );

    const { app, memoryReady } = bootstrap(
      {
        homeDir,
        osHomeDir: homeDir,
        cwd: homeDir,
        env: { ...process.env, SYNTHETIC_POOL_API_KEY: 'sk-from-env-ref' },
        clientIdentity: { productName: 'kiki-test', version: '0.0.1', platform: 'kiki_test' },
      },
      logSeed(resolveLoggingConfig({ homeDir, env: {} })),
    );

    try {
      const config = app.accessor.get(IConfigService);
      const providers = app.accessor.get(IProviderService);
      await config.ready;

      const resolved = config.get<ProvidersSection>(PROVIDERS_SECTION);
      expect(resolved['primary_a']?.apiKey).toBe('sk-shared-initial-key');
      expect(resolved['secondary_b']?.apiKey).toBe('sk-shared-initial-key');
      expect(resolved['env_backed']?.apiKey).toBe('sk-from-env-ref');
      expect(resolved['env_backed']?.apiKeyEnv).toBe('SYNTHETIC_POOL_API_KEY');
      expect(providers.get('primary_a')?.apiKey).toBe('sk-shared-initial-key');
      expect(providers.get('secondary_b')?.apiKey).toBe('sk-shared-initial-key');

      const migratedConfig = readFileSync(join(homeDir, 'config.toml'), 'utf8');
      const migratedCreds = readFileSync(join(homeDir, CREDENTIALS_KEY), 'utf8');
      expect(migratedConfig).not.toContain('sk-shared-initial-key');
      expect(migratedConfig).toContain('credential_id = "shared_gateway"');
      expect(migratedCreds).toContain('sk-shared-initial-key');

      await config.set(
        CREDENTIALS_POOL_SECTION,
        {
          shared_gateway: {
            kind: 'api_key',
            syncPolicy: 'synced',
            apiKey: 'sk-shared-rotated-key',
          },
        },
        ConfigTarget.User,
      );

      const afterRotate = config.get<ProvidersSection>(PROVIDERS_SECTION);
      expect(afterRotate['primary_a']?.apiKey).toBe('sk-shared-rotated-key');
      expect(afterRotate['secondary_b']?.apiKey).toBe('sk-shared-rotated-key');
      expect(providers.get('primary_a')?.apiKey).toBe('sk-shared-rotated-key');
      expect(providers.get('secondary_b')?.apiKey).toBe('sk-shared-rotated-key');

      await config.set(
        PROVIDERS_SECTION,
        {
          primary_a: {
            ...afterRotate['primary_a'],
            baseUrl: 'https://api-a-v2.example.test/v1',
          },
        },
        ConfigTarget.User,
      );
      const configAfterProviderSave = readFileSync(join(homeDir, 'config.toml'), 'utf8');
      expect(configAfterProviderSave).not.toContain('sk-shared-rotated-key');
    } finally {
      await memoryReady.catch(() => undefined);
      await app.dispose();
    }
  });

  it('seals only sync_policy="synced" entries with X25519 multi-recipient envelopes and merges conflict-free', async () => {
    const cipher = loadNativeAgeX25519Cipher();
    const deviceA = await cipher.generateX25519Keypair();
    const deviceB = await cipher.generateX25519Keypair();
    const revokedDevice = await cipher.generateX25519Keypair();

    const poolOnA: CredentialsPoolSection = {
      shared_api: {
        kind: 'api_key',
        syncPolicy: 'synced',
        apiKey: 'sk-synced-v2',
        updatedAt: '2026-11-20T10:00:00.000Z',
        revision: 'rev-2',
      },
      oauth_rotating: {
        kind: 'oauth',
        secret: 'oauth-refresh-machine-a-only',
        updatedAt: '2026-11-20T10:00:00.000Z',
      },
      env_only: {
        kind: 'env_ref',
        syncPolicy: 'env',
        envVar: 'MY_LOCAL_ENV_KEY',
      },
    };

    await expect(
      sealCredentialEntry('oauth_rotating', poolOnA['oauth_rotating']!, [deviceA.recipient], cipher),
    ).rejects.toThrow(/sync_policy='machine'/);

    const sealed = await sealSyncedCredentialPool(poolOnA, [deviceA.recipient, deviceB.recipient], {
      cipher,
    });
    expect(sealed.envelopes).toHaveLength(1);
    expect(sealed.envelopes[0]?.credentialId).toBe('shared_api');
    expect(sealed.skipped.map((s) => s.credentialId).sort()).toEqual(['env_only', 'oauth_rotating']);

    const openedOnB = await openCredentialEnvelope(sealed.envelopes[0]!, deviceB.identity, cipher);
    expect(openedOnB.credentialId).toBe('shared_api');
    expect(openedOnB.entry.apiKey).toBe('sk-synced-v2');
    await expect(
      openCredentialEnvelope(sealed.envelopes[0]!, revokedDevice.identity, cipher),
    ).rejects.toThrow();

    const poolOnB: CredentialsPoolSection = {
      shared_api: {
        kind: 'api_key',
        syncPolicy: 'synced',
        apiKey: 'sk-synced-v1',
        updatedAt: '2026-11-19T10:00:00.000Z',
        revision: 'rev-1',
      },
      unrelated_b_secret: {
        kind: 'api_key',
        syncPolicy: 'synced',
        apiKey: 'sk-b-own-key',
        updatedAt: '2026-11-20T12:00:00.000Z',
        revision: 'rev-b1',
      },
      pinned_local: {
        kind: 'api_key',
        syncPolicy: 'machine',
        apiKey: 'sk-pinned-on-b',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
    };

    const pinnedEnvelopeFromA = await sealCredentialEntry(
      'pinned_local',
      {
        kind: 'api_key',
        syncPolicy: 'synced',
        apiKey: 'sk-attempt-overwrite',
        updatedAt: '2026-11-21T00:00:00.000Z',
        revision: 'rev-override',
      },
      [deviceB.recipient],
      cipher,
    );

    const merged = await mergeCredentialEnvelopes(
      poolOnB,
      [sealed.envelopes[0]!, pinnedEnvelopeFromA],
      deviceB.identity,
      cipher,
    );

    expect(merged.applied).toEqual(['shared_api']);
    expect(merged.merged['shared_api']?.apiKey).toBe('sk-synced-v2');
    expect(merged.merged['unrelated_b_secret']?.apiKey).toBe('sk-b-own-key');
    expect(merged.merged['pinned_local']?.apiKey).toBe('sk-pinned-on-b');
    expect(merged.skipped).toEqual([
      { credentialId: 'pinned_local', reason: 'local_machine_pinned' },
    ]);

    const resolvedProviders = resolveProvidersWithCredentialPool(
      {
        p1: { type: 'openai', credentialId: 'shared_api' },
        p2: { type: 'openai', credentialId: 'shared_api' },
      },
      merged.merged,
    );
    expect(resolvedProviders['p1']?.apiKey).toBe('sk-synced-v2');
    expect(resolvedProviders['p2']?.apiKey).toBe('sk-synced-v2');
  });

  it('falls back to pure-JS age-encryption when @kiki/auth-native is missing and interoperates with Rust across stream chunk boundaries', async () => {
    const fallbackCipher = loadNativeAgeX25519Cipher(() => {
      const err = new Error("Cannot find module '@kiki/auth-native'") as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    });
    const fallbackKey = await fallbackCipher.generateX25519Keypair();
    expect(fallbackKey.identity).toMatch(/^AGE-SECRET-KEY-1[A-Z0-9]+$/);
    expect(fallbackKey.recipient).toMatch(/^age1[a-z0-9]+$/);
    expect(await fallbackCipher.recipientFromIdentity(`  ${fallbackKey.identity}\n`)).toBe(
      fallbackKey.recipient,
    );

    const fallbackEnvelope = await sealCredentialEntry(
      'android_bionic_cred',
      {
        kind: 'api_key',
        syncPolicy: 'synced',
        apiKey: 'sk-bionic-pure-js',
        updatedAt: '2026-11-27T00:00:00.000Z',
        revision: 'rev-js-1',
      },
      [`  ${fallbackKey.recipient}  `],
      fallbackCipher,
    );
    const fallbackOpened = await openCredentialEnvelope(
      fallbackEnvelope,
      ` ${fallbackKey.identity}\n`,
      fallbackCipher,
    );
    expect(fallbackOpened.entry.apiKey).toBe('sk-bionic-pure-js');

    const req = createRequire(import.meta.url);
    let nativeRaw: unknown;
    try {
      const oauthEntry = req.resolve('@kiki/oauth');
      nativeRaw = createRequire(oauthEntry)('@kiki/auth-native');
    } catch {
      nativeRaw = req('@kiki/auth-native');
    }
    const rustCipher = nativeRaw as AgeX25519Cipher;
    const jsCipher = createJsAgeX25519Cipher();

    const rustKey = await rustCipher.generateX25519Keypair();
    const jsKey = await jsCipher.generateX25519Keypair();
    expect(await jsCipher.recipientFromIdentity(rustKey.identity)).toBe(rustKey.recipient);
    expect(await rustCipher.recipientFromIdentity(jsKey.identity)).toBe(jsKey.recipient);

    for (const byteLength of [0, 65535, 65536, 65537]) {
      const expected = Buffer.alloc(byteLength);
      for (let i = 0; i < byteLength; i += 1) {
        expected[i] = (i * 131 + 17) & 0xff;
      }

      const rustCiphertext = Buffer.from(
        await rustCipher.encryptMultiRecipient(expected, [rustKey.recipient, jsKey.recipient]),
      );
      expect(Buffer.from(await jsCipher.decryptIdentity(rustCiphertext, jsKey.identity))).toEqual(
        expected,
      );
      expect(Buffer.from(await jsCipher.decryptIdentity(rustCiphertext, rustKey.identity))).toEqual(
        expected,
      );

      const jsCiphertext = Buffer.from(
        await jsCipher.encryptMultiRecipient(expected, [rustKey.recipient, jsKey.recipient]),
      );
      expect(Buffer.from(await rustCipher.decryptIdentity(jsCiphertext, rustKey.identity))).toEqual(
        expected,
      );
      expect(Buffer.from(await rustCipher.decryptIdentity(jsCiphertext, jsKey.identity))).toEqual(
        expected,
      );
    }
  });

  it('merges config.local.toml sidecar overrides with origin="local" and enforces fail-closed syncScope', async () => {
    const homeDir = createTempHome();
    writeFileSync(
      join(homeDir, 'config.toml'),
      [
        'default_model = "portable-model"',
        '',
        '[thinking]',
        'enabled = true',
        'effort = "medium"',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(homeDir, LOCAL_CONFIG_KEY),
      [
        '[thinking]',
        'effort = "high"',
        '',
      ].join('\n'),
      'utf8',
    );

    const { app, memoryReady } = bootstrap(
      {
        homeDir,
        osHomeDir: homeDir,
        cwd: homeDir,
        clientIdentity: { productName: 'kiki-test', version: '0.0.1', platform: 'kiki_test' },
      },
      logSeed(resolveLoggingConfig({ homeDir, env: {} })),
    );

    try {
      const config = app.accessor.get(IConfigService);
      const registry = app.accessor.get(IConfigRegistry);
      await config.ready;

      expect(config.get<{ enabled?: boolean; effort?: string }>('thinking')).toEqual({
        enabled: true,
        effort: 'high',
      });
      const origins = config.origins('thinking');
      expect(origins['enabled']).toBe('home');
      expect(origins['effort']).toBe('local');

      await config.set('thinking', { enabled: false }, ConfigTarget.User);
      expect(config.get<{ enabled?: boolean; effort?: string }>('thinking')).toEqual({
        enabled: false,
        effort: 'high',
      });
      const portableConfigText = readFileSync(join(homeDir, 'config.toml'), 'utf8');
      expect(portableConfigText).toContain('effort = "medium"');

      await config.set('thinking', { effort: 'low' }, ConfigTarget.Local);
      expect(config.get<{ enabled?: boolean; effort?: string }>('thinking')?.effort).toBe('low');
      expect(readFileSync(join(homeDir, LOCAL_CONFIG_KEY), 'utf8')).toContain('effort = "low"');

      expect(classifyConfigSyncScope('thinking', ['effort'], registry)).toBe('portable');
      expect(classifyConfigSyncScope('cpu_workers', ['max_workers'], registry)).toBe('machine');
      expect(classifyConfigSyncScope('unknown_custom_section', ['flag'], registry)).toBe('machine');
      expect(classifyConfigSyncScope('providers', ['demo', 'api_key'], registry)).toBe('machine');
      expect(classifyConfigSyncScope('providers', ['demo', 'env', 'MY_SECRET'], registry)).toBe('machine');
      expect(classifyConfigSyncScope('providers', ['demo', 'local_port'], registry)).toBe('machine');
      expect(classifyConfigSyncScope('providers', ['demo', 'binary_path'], registry)).toBe('machine');

      const mixedRaw = {
        default_model: 'portable-model',
        thinking: { enabled: true, effort: 'medium' },
        cpu_workers: { max_workers: 8 },
        custom_hardware: { gpu_index: 0 },
        providers: {
          demo: {
            type: 'openai',
            base_url: 'https://api.example.test/v1',
            credential_id: 'shared_api',
            api_key: 'sk-should-stay-machine-local',
          },
        },
      };

      const portable = extractPortableConfigLayer(mixedRaw, registry);
      const machine = extractMachineLocalConfigLayer(mixedRaw, registry);

      expect(portable).toEqual({
        default_model: 'portable-model',
        thinking: { enabled: true, effort: 'medium' },
        providers: {
          demo: {
            type: 'openai',
            base_url: 'https://api.example.test/v1',
            credential_id: 'shared_api',
          },
        },
      });
      expect(machine).toEqual({
        cpu_workers: { max_workers: 8 },
        custom_hardware: { gpu_index: 0 },
        providers: {
          demo: {
            api_key: 'sk-should-stay-machine-local',
          },
        },
      });
    } finally {
      await memoryReady.catch(() => undefined);
      await app.dispose();
    }
  });
});

void ConfigRegistry;
void ConfigService;
