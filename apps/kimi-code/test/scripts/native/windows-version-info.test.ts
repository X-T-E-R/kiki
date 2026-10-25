import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  applyWindowsVersionInfo,
  buildVersionInfoResource,
} from '../../../scripts/native/windows-version-info.mjs';
import { appRoot } from '../../../scripts/native/paths.mjs';

const execFileAsync = promisify(execFile);

describe('Windows native version info', () => {
  it('builds a version resource with Kiki identity and the package version', () => {
    const resource = buildVersionInfoResource({
      version: '0.4.2',
      description: 'Kiki local agent workspace and shared daemon',
      author: 'Moonshot AI',
    });

    expect(resource.readUInt16LE(0)).toBe(resource.length);
    expect(resource.readUInt16LE(2)).toBe(52);
    expect(resource.readUInt16LE(4)).toBe(0);
    const text = resource.toString('utf16le');
    expect(text).toContain('FileDescription');
    expect(text).toContain('Kiki local agent workspace and shared daemon');
    expect(text).toContain('ProductName');
    expect(text).toContain('Kiki');
    expect(text).toContain('ProductVersion');
    expect(text).toContain('0.4.2');
    expect(resource.length).toBeLessThan(0x2e8);
  });

  it.runIf(process.platform === 'win32')('rewrites a Windows executable with Kiki identity', async () => {
    const tempRoot = await mkdtemp(`${appRoot}/../../.tmp/kiki-version-info-test-`);
    const executable = `${tempRoot}/kiki.exe`;
    try {
      await copyFile(process.execPath, executable);
      await applyWindowsVersionInfo(executable);
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$v=(Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo; [pscustomobject]@{FileDescription=$v.FileDescription;ProductName=$v.ProductName;FileVersion=$v.FileVersion;ProductVersion=$v.ProductVersion} | ConvertTo-Json -Compress`,
      ]);
      expect(JSON.parse(stdout)).toEqual({
        FileDescription: 'Kiki local agent workspace and shared daemon',
        ProductName: 'Kiki',
        FileVersion: '0.4.2',
        ProductVersion: '0.4.2',
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
