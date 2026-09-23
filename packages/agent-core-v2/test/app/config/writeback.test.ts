import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IMAGE_SECTION, type ImageConfig } from '#/agent/media/configSection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { MODELS_SECTION, PROVIDERS_SECTION, THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { type ThinkingConfig } from '#/kosong/model/thinking';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

describe('config.toml writeback preservation', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-v2-writeback-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function setup(
    toml: string,
    env: Record<string, string> = {},
    credentials?: string,
    storage: InMemoryStorageService | FileStorageService = new InMemoryStorageService(),
  ) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    if (credentials !== undefined) {
      await storage.write('', 'credentials.toml', new TextEncoder().encode(credentials));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap(homeDir, env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    const readText = async (key = 'config.toml'): Promise<string> => {
      const bytes = await storage.read('', key);
      if (bytes === undefined) throw new Error(`${key} missing`);
      return new TextDecoder().decode(bytes);
    };
    return { config, disposables, storage, readText };
  }

  function section(parsed: Record<string, unknown>, key: string): Record<string, unknown> {
    return parsed[key] as Record<string, unknown>;
  }

  it('preserves comments, blank lines and untouched domains byte-for-byte on set()', async () => {
    const seed = [
      '# 顶部注释：全局设置',
      'default_model = "kimi-k2"   # 行尾注释',
      '',
      '# 图片配置区块',
      '[image]',
      'max_edge_px = 1500',
      '',
      '# 自定义区域',
      '[custom]',
      'notes = """',
      '第一行',
      '[not_a_header] 这一行以左括号开头',
      '"""',
      'keep_me = "yes"',
      '',
    ].join('\n');
    const { config, disposables, readText } = await setup(seed);

    await config.set(IMAGE_SECTION, { maxEdgePx: 2000 });

    const text = await readText();
    expect(
      text.startsWith(
        '# 顶部注释：全局设置\ndefault_model = "kimi-k2"   # 行尾注释\n\n# 图片配置区块\n',
      ),
    ).toBe(true);
    expect(
      text.endsWith(
        '\n# 自定义区域\n[custom]\nnotes = """\n第一行\n[not_a_header] 这一行以左括号开头\n"""\nkeep_me = "yes"\n',
      ),
    ).toBe(true);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(section(parsed, 'image')['max_edge_px']).toBe(2000);
    expect(parsed['default_model']).toBe('kimi-k2');
    expect(section(parsed, 'custom')['keep_me']).toBe('yes');
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({ maxEdgePx: 2000 });

    disposables.dispose();
  });

  it('skips the write entirely when the staged result is byte-identical', async () => {
    const { config, disposables, storage, readText } = await setup('[image]\nmax_edge_px = 1500\n');
    const writeSpy = vi.spyOn(storage, 'write');

    await config.set(IMAGE_SECTION, { maxEdgePx: 2000 });
    const afterFirst = await readText();
    expect(writeSpy).toHaveBeenCalledTimes(1);

    await config.set(IMAGE_SECTION, { maxEdgePx: 2000 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await readText()).toBe(afterFirst);

    disposables.dispose();
  });

  it('appends a new domain at the end with a single trailing newline', async () => {
    const seed = '# 只有图片\n[image]\nmax_edge_px = 1500\n';
    const { config, disposables, readText } = await setup(seed);

    await config.set(THINKING_SECTION, { effort: 'high' });

    const text = await readText();
    expect(text.startsWith(seed)).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(section(parsed, 'thinking')['effort']).toBe('high');
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'high' });

    disposables.dispose();
  });

  it('removes a deleted domain region while keeping neighboring trivia', async () => {
    const seed = [
      '# 头部注释',
      '[thinking]',
      'effort = "high"',
      '',
      '# 图片注释',
      '[image]',
      'max_edge_px = 1500',
      '',
      '# 尾部注释',
      '[custom]',
      'keep_me = "yes"',
      '',
    ].join('\n');
    const { config, disposables, readText } = await setup(seed);

    await config.replace(IMAGE_SECTION, null);

    const text = await readText();
    expect(text.includes('[image]')).toBe(false);
    expect(text.includes('max_edge_px')).toBe(false);
    expect(text.includes('# 头部注释\n[thinking]\neffort = "high"\n')).toBe(true);
    expect(text.includes('# 图片注释')).toBe(true);
    expect(text.includes('# 尾部注释\n[custom]\nkeep_me = "yes"\n')).toBe(true);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(parsed['image']).toBeUndefined();
    expect(section(parsed, 'thinking')['effort']).toBe('high');

    disposables.dispose();
  });

  it('preserves CRLF line endings in untouched regions', async () => {
    const seed = '# 注释\r\ndefault_model = "kimi-k2"\r\n\r\n[image]\r\nmax_edge_px = 1500\r\n';
    const { config, disposables, readText } = await setup(seed);

    await config.set(IMAGE_SECTION, { maxEdgePx: 3000 });

    const text = await readText();
    expect(text.startsWith('# 注释\r\ndefault_model = "kimi-k2"\r\n\r\n')).toBe(true);
    const parsed = parseToml(text) as Record<string, unknown>;
    expect(section(parsed, 'image')['max_edge_px']).toBe(3000);

    disposables.dispose();
  });

  it('migrates thinking effort max to high without dropping the surrounding comments', async () => {
    const seed = '# 思考配置\n[thinking]\n# 不要动我\neffort = "max"\n';
    const { config, disposables, readText } = await setup(seed);

    const text = await readText();
    expect(text.includes('# 思考配置')).toBe(true);
    expect(text.includes('effort = "high"')).toBe(true);
    expect(text.includes('effort = "max"')).toBe(false);
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'high' });

    disposables.dispose();
  });

  it('loads credentials with precedence, migrates old keys once, and keeps a byte-exact backup', async () => {
    const seed = '# original config\n[providers.acme]\nbase_url = "https://example.test"\napi_key   = "legacy" # private\n[providers.acme.oauth]\nstorage = "file"\nkey = "account-ref"\n';
    const credentials = '# existing secret\n[providers.acme]\napi_key = "new-key" # preserve\n';
    const { config, disposables, storage, readText } = await setup(seed, {}, credentials);

    expect(config.get<Record<string, { apiKey: string }>>(PROVIDERS_SECTION)['acme']?.apiKey).toBe('new-key');
    expect(await readText('config.toml.bak-' + new Date().toISOString().slice(0, 10))).toBe(seed);
    const publicText = await readText();
    expect(publicText).toContain('# original config');
    expect(publicText).toContain('key = "account-ref"');
    expect(publicText).not.toContain('api_key');
    expect(await readText('credentials.toml')).toBe(credentials);

    const writeSpy = vi.spyOn(storage, 'write');
    await config.reload();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await readText('config.toml.bak-' + new Date().toISOString().slice(0, 10))).toBe(seed);
    disposables.dispose();
  });

  it('routes provider, model, registry and header secrets separately while preserving both files', async () => {
    const configText = '# config\n[image]\nmax_edge_px = 1500\n';
    const credentialsText = '# secret header\n[providers.acme]\napi_key   = "original" # keep comment\n';
    const { config, disposables, readText } = await setup(configText, {}, credentialsText);
    await config.replace(PROVIDERS_SECTION, {
      acme: {
        type: 'openai', apiKey: 'replaced', baseUrl: 'https://example.test',
        customHeaders: { Authorization: 'Bearer another-secret' },
        env: { KIMI_API_KEY: 'third-secret' },
        source: { url: 'https://registry.example.test', apiKey: 'registry-secret' },
      },
    });
    await config.set(MODELS_SECTION, { 'acme/model': { apiKey: 'model-secret', providerId: 'acme' } });
    const publicText = await readText();
    const privateText = await readText('credentials.toml');
    for (const secret of ['replaced', 'another-secret', 'third-secret', 'registry-secret', 'model-secret']) {
      expect(publicText).not.toContain(secret);
      expect(privateText).toContain(secret);
    }
    expect(publicText).toContain('base_url = "https://example.test"');
    expect(publicText).toContain('# config');
    expect(privateText).toContain('# secret header');
    expect(privateText).toContain('api_key   = "replaced" # keep comment');
    expect(section(parseToml(privateText) as Record<string, unknown>, 'models')['acme/model']).toEqual({ api_key: 'model-secret' });
    await config.replace(PROVIDERS_SECTION, { acme: { type: 'openai', baseUrl: 'https://example.test' } });
    expect(await readText('credentials.toml')).not.toContain('replaced');
    expect(await readText('credentials.toml')).toContain('model-secret');
    disposables.dispose();
  });

  it('creates credential files with restricted mode through the real atomic storage', async () => {
    const { config, disposables, readText } = await setup('', {}, undefined, new FileStorageService(homeDir, 0o700, 0o600));
    await config.set(PROVIDERS_SECTION, { acme: { apiKey: 'private-key' } });
    const path = join(homeDir, 'credentials.toml');
    expect(readFileSync(path, 'utf8')).toContain('private-key');
    expect(await readText()).not.toContain('private-key');
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    disposables.dispose();
  });

  it('keeps the last good values and blocks writes when credentials.toml is invalid', async () => {
    const { config, storage, disposables, readText } = await setup(
      '[providers.acme]\ntype = "openai"\n', {}, '[providers.acme]\napi_key = "working-key"\n',
    );
    await storage.write('', 'credentials.toml', new TextEncoder().encode('[providers.acme\napi_key = "broken"'));
    await config.reload();
    expect(config.get<Record<string, { apiKey: string }>>(PROVIDERS_SECTION)['acme']?.apiKey).toBe('working-key');
    await expect(config.set(IMAGE_SECTION, { maxEdgePx: 1800 })).rejects.toThrow();
    expect(await readText('credentials.toml')).toContain('broken');
    await storage.write('', 'credentials.toml', new TextEncoder().encode('[providers.acme]\napi_key = "fixed-key"\n'));
    await config.reload();
    expect(config.get<Record<string, { apiKey: string }>>(PROVIDERS_SECTION)['acme']?.apiKey).toBe('fixed-key');
    await config.set(IMAGE_SECTION, { maxEdgePx: 1800 });
    disposables.dispose();
  });
});
