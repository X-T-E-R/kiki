import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateLegacyKikiConfiguration, resolveKikiHome } from '../src/home';

describe('Kiki product home', () => {
  it('refuses a destination inside the source even with Windows casing differences', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-migration-nested-'));
    const source = join(root, 'source');
    try {
      mkdirSync(source);
      const sourceInput = process.platform === 'win32' ? source.toUpperCase() : source;
      expect(() => migrateLegacyKikiConfiguration(sourceInput, join(source, 'new'))).toThrow('must not be inside');
      expect(readdirSync(source)).toEqual([]);
      expect(migrateLegacyKikiConfiguration(sourceInput, source).status).toBe('absent');
      expect(readdirSync(source)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects linked authored directories without following them or recording completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-migration-link-'));
    const source = join(root, 'old'); const target = join(root, 'new'); const external = join(root, 'external');
    try {
      mkdirSync(source); mkdirSync(external);
      writeFileSync(join(external, 'SKILL.md'), 'Synthetic external resource');
      symlinkSync(external, join(source, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => migrateLegacyKikiConfiguration(source, target)).toThrow('symbolic-link asset');
      expect(existsSync(join(target, '.kiki-config-migration-v2.json'))).toBe(false);
      expect(existsSync(join(target, 'skills', 'SKILL.md'))).toBe(false);
      expect(readFileSync(join(external, 'SKILL.md'), 'utf8')).toBe('Synthetic external resource');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('uses the unique product home and does not reinterpret explicit empty or zero values', () => {
    expect(resolveKikiHome(undefined, {}, '/example')).toBe(resolve('/example/.kiki'));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '/new', KIMI_CODE_HOME: '/old' }, '/example')).toBe(resolve('/new'));
    expect(resolveKikiHome('/explicit', { KIKI_HOME: '/new' })).toBe(resolve('/explicit'));
    expect(resolveKikiHome(undefined, { KIMI_CODE_HOME: '/legacy' }, '/example')).toBe(resolve('/example/.kiki'));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '', KIMI_CODE_HOME: '/legacy' })).toBe(resolve(''));
    expect(resolveKikiHome(undefined, { KIKI_HOME: '0' })).toBe(resolve('0'));
  });
  it('copies configuration once, preserves new files and source data, and excludes runtime state', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-migration-'));
    const source = join(root, 'old'); const target = join(root, 'new');
    try {
      mkdirSync(join(source, 'credentials'), { recursive: true }); mkdirSync(target);
      writeFileSync(join(source, 'config.toml'), 'model = "legacy"');
      writeFileSync(join(target, 'config.toml'), 'model = "new"');
      writeFileSync(join(source, 'tui.toml'), 'theme = "dark"');
      writeFileSync(join(source, 'credentials', 'synthetic.json'), '{"synthetic":true}');
      writeFileSync(join(source, 'server.token'), 'synthetic-runtime-token');
      writeFileSync(join(source, 'device_id'), 'synthetic-device-id');
      mkdirSync(join(source, 'oauth'));
      writeFileSync(join(source, 'oauth', 'synthetic-provider'), '');
      const result = migrateLegacyKikiConfiguration(source, target);
      expect(result.status).toBe('completed');
      expect(readFileSync(join(target, 'device_id'), 'utf8')).toBe('synthetic-device-id');
      expect(existsSync(join(target, 'oauth'))).toBe(false);
      expect(result.preserved).toEqual(['config.toml']);
      expect(readFileSync(join(target, 'config.toml'), 'utf8')).toBe('model = "new"');
      expect(readFileSync(join(source, 'config.toml'), 'utf8')).toBe('model = "legacy"');
      expect(readFileSync(join(target, 'credentials', 'synthetic.json'), 'utf8')).toBe('{"synthetic":true}');
      expect(existsSync(join(target, 'server.token'))).toBe(false);
      expect(migrateLegacyKikiConfiguration(source, target).status).toBe('already-completed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('can retry a partial migration without overwriting successful files or recording false completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-migration-retry-'));
    const source = join(root, 'old'); const target = join(root, 'new');
    try {
      mkdirSync(source); writeFileSync(join(source, 'config.toml'), 'model = "example"'); mkdirSync(join(source, 'mcp.json'));
      expect(() => migrateLegacyKikiConfiguration(source, target)).toThrow('unsupported file type');
      expect(existsSync(join(target, '.kiki-config-migration-v2.json'))).toBe(false);
      expect(readdirSync(target)).toEqual(['config.toml']);
      rmSync(join(source, 'mcp.json'), { recursive: true }); writeFileSync(join(source, 'mcp.json'), '{}');
      const retried = migrateLegacyKikiConfiguration(source, target);
      expect(retried).toMatchObject({ status: 'completed', preserved: ['config.toml'], copied: ['mcp.json'] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reports unknown assets instead of silently marking configuration migration complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-assets-report-'));
    const source = join(root, 'old'); const target = join(root, 'new');
    try {
      mkdirSync(join(source, 'custom-resource'), { recursive: true });
      writeFileSync(join(source, 'config.toml'), '# References custom-resource');
      expect(migrateLegacyKikiConfiguration(source, target)).toMatchObject({ status: 'incomplete', unmigrated: ['custom-resource'] });
      expect(existsSync(join(target, '.kiki-config-migration-v2.json'))).toBe(false);
      mkdirSync(join(target, 'custom-resource'));
      expect(migrateLegacyKikiConfiguration(source, target).status).toBe('completed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
