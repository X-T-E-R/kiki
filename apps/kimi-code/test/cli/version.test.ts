import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createKimiCodeUserAgent,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/kimi-code and reads its version', () => {
    const pkgPath = getHostPackageJsonPath();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(pkgPath.endsWith(join('apps', 'kimi-code', 'package.json'))).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(pkgPath));
    expect(getVersion()).toBe(pkg.version);
  });

  it('uses the Kiki product by default and opts into the Kimi Code product from config', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kiki-user-agent-'));
    const configPath = join(homeDir, 'config.toml');
    try {
      const defaultUserAgent = createKimiCodeUserAgent('1.2.3', { configPath });
      expect(defaultUserAgent).toBe('kiki-cli/1.2.3');
      expect(defaultUserAgent).not.toContain('kimi-code');

      writeFileSync(configPath, '[identity]\nadvertise_as_kimi_code = true\n');
      expect(createKimiCodeUserAgent('1.2.3', { configPath })).toBe('kimi-code-cli/1.2.3');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
