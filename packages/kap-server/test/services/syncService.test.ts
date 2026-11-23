import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IConfigRegistry, IConfigService } from '@kiki/agent-core-v2';
import { SyncService } from '../../src/services/sync/syncService';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('SyncService home assets sync', () => {
  it('round-trips prompt overrides, instructions, personas, and custom agents before applying config while excluding builtin/secrets/symlinks', async () => {
    const sandbox = makeTempDir('kiki-sync-home-assets-');
    const sourceHome = join(sandbox, 'source-home');
    const targetHome = join(sandbox, 'target-home');
    const osHome = join(sandbox, 'os-home');
    const outsideFile = join(sandbox, 'outside.txt');
    mkdirSync(join(sourceHome, 'prompt'), { recursive: true });
    mkdirSync(join(sourceHome, 'prompts'), { recursive: true });
    mkdirSync(join(sourceHome, 'cognition'), { recursive: true });
    mkdirSync(join(sourceHome, 'personas'), { recursive: true });
    mkdirSync(join(sourceHome, 'agents', 'builtin'), { recursive: true });
    mkdirSync(join(sourceHome, 'agents', 'custom'), { recursive: true });
    mkdirSync(targetHome, { recursive: true });
    mkdirSync(osHome, { recursive: true });

    writeFileSync(outsideFile, 'do-not-leak\n');
    writeFileSync(join(sourceHome, 'AGENTS.md'), '# Global Instructions\n');
    writeFileSync(join(sourceHome, 'SYSTEM.md'), '# System Prompt\n');
    writeFileSync(join(sourceHome, 'prompt', 'custom.toml'), 'system_prompt = "clean"\n');
    writeFileSync(join(sourceHome, 'prompt', '.env'), 'API_KEY=secret\n');
    writeFileSync(join(sourceHome, 'prompt', 'private.pem'), 'PRIVATE\n');
    writeFileSync(join(sourceHome, 'prompt', 'server.local-owner'), 'SECRET-OWNER\n');
    writeFileSync(join(sourceHome, 'prompts', 'extra.md'), 'extra prompt\n');
    writeFileSync(join(sourceHome, 'cognition', 'style.md'), 'style guide\n');
    writeFileSync(join(sourceHome, 'personas', 'nia.md'), 'persona body\n');
    writeFileSync(join(sourceHome, 'agents', 'custom', 'builder.md'), 'custom agent\n');
    writeFileSync(join(sourceHome, 'agents', 'builtin', 'default.md'), 'builtin agent\n');
    try {
      symlinkSync(outsideFile, join(sourceHome, 'prompt', 'linked.toml'));
    } catch {
      void 0;
    }

    const sourceConfigValues: Record<string, unknown> = {
      defaultModel: 'gemini-4-neon',
      models: {
        'gemini-4-neon': {
          provider: 'axon',
          model: 'gemini-4-neon',
          prompt_overrides: { files: ['prompt/custom.toml'] },
        },
      },
    };
    const sourceConfig: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'> = {
      ready: Promise.resolve(),
      get: (<T>(domain: string) => sourceConfigValues[domain] as T) as IConfigService['get'],
      inspect: ((domain: string) => ({ userValue: sourceConfigValues[domain] })) as IConfigService['inspect'],
      replace: async () => undefined,
    };

    const targetConfigValues: Record<string, unknown> = {};
    let promptOverridePresentDuringConfigReplace = false;
    const targetConfig: Pick<IConfigService, 'ready' | 'get' | 'inspect' | 'replace'> = {
      ready: Promise.resolve(),
      get: (<T>(domain: string) => targetConfigValues[domain] as T) as IConfigService['get'],
      inspect: ((domain: string) => ({ userValue: targetConfigValues[domain] })) as IConfigService['inspect'],
      replace: async (domain: string, value: unknown) => {
        if (domain === 'models' && existsSync(join(targetHome, 'prompt', 'custom.toml'))) {
          promptOverridePresentDuringConfigReplace = true;
        }
        targetConfigValues[domain] = value;
      },
    };

    const configRegistry: Pick<IConfigRegistry, 'getSection' | 'listSections'> = {
      getSection: () => undefined,
      listSections: () => [{ domain: 'models' } as never],
    };

    const sourceSync = new SyncService({ homeDir: sourceHome, osHomeDir: osHome, configService: sourceConfig, configRegistry });
    const targetSync = new SyncService({ homeDir: targetHome, osHomeDir: osHome, configService: targetConfig, configRegistry });

    const bundle = await sourceSync.exportSyncBundle({
      includeConfig: true,
      includeHomeAssets: true,
      includeCredentials: false,
      includeMemories: false,
      includeSkills: false,
    });
    const exportedPaths = (bundle.homeAssets ?? []).map((entry) => entry.relativePath);
    expect(exportedPaths).toEqual([
      'AGENTS.md',
      'agents/custom/builder.md',
      'cognition/style.md',
      'personas/nia.md',
      'prompt/custom.toml',
      'prompts/extra.md',
      'SYSTEM.md',
    ]);

    const receipt = await targetSync.importSyncBundle({
      ...bundle,
      homeAssets: [
        ...(bundle.homeAssets ?? []),
        { relativePath: '../escape.txt', contentBase64: Buffer.from('bad').toString('base64') },
        { relativePath: 'agents/builtin/default.md', contentBase64: Buffer.from('bad').toString('base64') },
        { relativePath: 'credentials/device.key', contentBase64: Buffer.from('bad').toString('base64') },
        { relativePath: 'prompt/secret.pem', contentBase64: Buffer.from('bad').toString('base64') },
      ],
    });

    expect(promptOverridePresentDuringConfigReplace).toBe(true);
    expect(receipt.homeAssetsApplied).toBe(7);
    expect(receipt.homeAssetsSkipped).toBe(4);
    expect(readFileSync(join(targetHome, 'prompt', 'custom.toml'), 'utf8')).toBe('system_prompt = "clean"\n');
    expect(readFileSync(join(targetHome, 'prompts', 'extra.md'), 'utf8')).toBe('extra prompt\n');
    expect(readFileSync(join(targetHome, 'cognition', 'style.md'), 'utf8')).toBe('style guide\n');
    expect(readFileSync(join(targetHome, 'AGENTS.md'), 'utf8')).toBe('# Global Instructions\n');
    expect(readFileSync(join(targetHome, 'SYSTEM.md'), 'utf8')).toBe('# System Prompt\n');
    expect(readFileSync(join(targetHome, 'personas', 'nia.md'), 'utf8')).toBe('persona body\n');
    expect(readFileSync(join(targetHome, 'agents', 'custom', 'builder.md'), 'utf8')).toBe('custom agent\n');
    expect(existsSync(join(targetHome, 'agents', 'builtin', 'default.md'))).toBe(false);
    expect(existsSync(join(targetHome, 'prompt', '.env'))).toBe(false);
    expect(existsSync(join(targetHome, 'prompt', 'secret.pem'))).toBe(false);
    expect(existsSync(join(targetHome, 'credentials', 'device.key'))).toBe(false);
    expect(existsSync(join(sandbox, 'escape.txt'))).toBe(false);
  });
});
