import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureKikiHome, resolveConfigPath, resolveKikiHome } from '#/app/bootstrap/bootstrap';

describe('bootstrap path helpers', () => {
  describe('resolveKikiHome', () => {
    it('uses explicit homeDir when provided', () => {
      expect(resolveKikiHome('/tmp/kimi')).toBe(resolve('/tmp/kimi'));
    });

    it('falls back to KIKI_HOME env', () => {
      const prev = process.env['KIKI_HOME'];
      process.env['KIKI_HOME'] = '/env/kimi';
      try {
        expect(resolveKikiHome()).toBe(resolve('/env/kimi'));
      } finally {
        if (prev === undefined) delete process.env['KIKI_HOME'];
        else process.env['KIKI_HOME'] = prev;
      }
    });
  });

  describe('resolveConfigPath', () => {
    it('uses explicit configPath when provided', () => {
      expect(resolveConfigPath({ configPath: '/x/config.toml' })).toBe('/x/config.toml');
    });

    it('joins homeDir with config.toml', () => {
      expect(resolveConfigPath({ homeDir: '/tmp/kimi' })).toBe(
        join(resolve('/tmp/kimi'), 'config.toml'),
      );
    });
  });

  describe('ensureKikiHome', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    });

    it('creates the directory with 0700 permissions', () => {
      dir = join(mkdtempSync(join(tmpdir(), 'kimi-home-')), 'nested');
      ensureKikiHome(dir);
      expect(existsSync(dir)).toBe(true);
    });
  });
});
