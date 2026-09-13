import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getBinDir,
  getDataDir,
  getInputHistoryFile,
  getLogDir,
} from '#/utils/paths';

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env['KIKI_HOME'];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('getDataDir', () => {
  it('returns ~/.kiki when KIKI_HOME is not set', () => {
    expect(getDataDir()).toBe(join(homedir(), '.kiki'));
  });

  it('returns KIKI_HOME when set', () => {
    process.env['KIKI_HOME'] = '/tmp/kimi-test-data';
    expect(getDataDir()).toBe(resolve('/tmp/kimi-test-data'));
  });

  it('returns KIKI_HOME even if it is a relative path', () => {
    process.env['KIKI_HOME'] = 'relative/path';
    expect(getDataDir()).toBe(resolve('relative/path'));
  });
});

describe('getLogDir', () => {
  it('returns <dataDir>/logs', () => {
    expect(getLogDir()).toBe(join(homedir(), '.kiki', 'logs'));
  });

  it('respects KIKI_HOME', () => {
    process.env['KIKI_HOME'] = '/z';
    expect(getLogDir()).toBe(join(resolve('/z'), 'logs'));
  });
});

describe('getBinDir', () => {
  it('returns <dataDir>/bin', () => {
    expect(getBinDir()).toBe(join(homedir(), '.kiki', 'bin'));
  });

  it('respects KIKI_HOME', () => {
    process.env['KIKI_HOME'] = '/custom-bin-home';
    expect(getBinDir()).toBe(join(resolve('/custom-bin-home'), 'bin'));
  });
});

describe('getInputHistoryFile', () => {
  it('returns <dataDir>/user-history/<md5(workDir)>.jsonl', () => {
    const workDir = '/home/user/project';
    const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
    expect(getInputHistoryFile(workDir)).toBe(
      join(homedir(), '.kiki', 'user-history', `${hash}.jsonl`),
    );
  });

  it('respects KIKI_HOME', () => {
    process.env['KIKI_HOME'] = '/custom/data';
    const hash = createHash('md5').update('/proj', 'utf-8').digest('hex');
    expect(getInputHistoryFile('/proj')).toBe(
      join(resolve('/custom/data'), 'user-history', `${hash}.jsonl`),
    );
  });
});
