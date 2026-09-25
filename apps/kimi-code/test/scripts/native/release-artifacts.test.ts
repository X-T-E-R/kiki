import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { appRoot } from '../../../scripts/native/paths.mjs';

const execFileAsync = promisify(execFile);
const packageScript = resolve(appRoot, 'scripts/native/package.mjs');
const manifestScript = resolve(appRoot, 'scripts/native/produce-manifest.mjs');
const artifactsDir = resolve(appRoot, 'dist-native/artifacts');
const target = 'test-native-artifact';
const executableName = process.platform === 'win32' ? 'kiki.exe' : 'kiki';
const artifactName = `kiki-${target}${process.platform === 'win32' ? '.exe' : ''}`;
const artifactPath = resolve(artifactsDir, artifactName);
const fakeBinary = resolve(appRoot, 'dist-native/bin', target, executableName);

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('native release artifacts', () => {
  afterEach(() => {
    rmSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(artifactPath, { force: true });
    rmSync(`${artifactPath}.sha256`, { force: true });
  });

  it('stages a platform-named executable and checksums its exact bytes', async () => {
    const binaryContent = 'native binary payload\n';
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, binaryContent, { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIKI_BUILD_TARGET: target },
    });

    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, 'utf-8')).toBe(binaryContent);
    if (process.platform !== 'win32') expect(statSync(artifactPath).mode & 0o111).toBe(0o111);
    expect(readFileSync(`${artifactPath}.sha256`, 'utf-8')).toBe(
      `${sha256(readFileSync(artifactPath))}  ${artifactName}\n`,
    );
  });

  it('produces a manifest for Unix executables and Windows .exe files', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kiki-manifest-native-'));
    const names = ['kiki-darwin-arm64', 'kiki-linux-x64', 'kiki-win32-x64.exe'];
    try {
      for (const name of names) {
        const bytes = Buffer.from(`fake executable: ${name}`);
        await writeFile(join(releaseDir, name), bytes);
        await writeFile(join(releaseDir, `${name}.sha256`), `${sha256(bytes)}  ${name}\n`);
      }
      await execFileAsync(process.execPath, [manifestScript, releaseDir, '@kiki/cli@0.5.0']);
      const manifest = JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf-8')) as {
        version: string;
        tag: string;
        platforms: Record<string, { filename: string; checksum: string }>;
      };
      expect(manifest).toEqual({
        version: '0.5.0',
        tag: '@kiki/cli@0.5.0',
        platforms: Object.fromEntries(names.map((name) => [
          name.slice('kiki-'.length).replace(/\.exe$/, ''),
          { filename: name, checksum: sha256(`fake executable: ${name}`) },
        ])),
      });
      await writeFile(join(releaseDir, 'kiki-win32-x64.exe.sha256'), `${'0'.repeat(64)}  kiki-linux-x64\n`);
      await expect(execFileAsync(process.execPath, [manifestScript, releaseDir, '@kiki/cli@0.5.0']))
        .rejects.toThrow();
    } finally {
      await rm(releaseDir, { recursive: true, force: true });
    }
  });
});
