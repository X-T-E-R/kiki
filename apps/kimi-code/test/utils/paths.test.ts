import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getBinDir,
  getDataDir,
  getInputHistoryFile,
  getLogDir,
} from '#/utils/paths';

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env['KIMI_CODE_HOME'];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('getDataDir', () => {
  it('returns ~/.kimi-code when KIMI_CODE_HOME is not set', () => {
    expect(getDataDir()).toBe(join(homedir(), '.kimi-code'));
  });

  it('returns KIMI_CODE_HOME when set', () => {
    process.env['KIMI_CODE_HOME'] = '/tmp/kimi-test-data';
    expect(getDataDir()).toBe('/tmp/kimi-test-data');
  });

  it('returns KIMI_CODE_HOME even if it is a relative path', () => {
    process.env['KIMI_CODE_HOME'] = 'relative/path';
    expect(getDataDir()).toBe('relative/path');
  });
});

describe('getLogDir', () => {
  it('returns <dataDir>/logs', () => {
    expect(getLogDir()).toBe(join(homedir(), '.kimi-code', 'logs'));
  });

  it('respects KIMI_CODE_HOME', () => {
    process.env['KIMI_CODE_HOME'] = '/z';
    expect(getLogDir()).toBe(join('/z', 'logs'));
  });
});

describe('getBinDir', () => {
  it('returns <dataDir>/bin', () => {
    expect(getBinDir()).toBe(join(homedir(), '.kimi-code', 'bin'));
  });

  it('respects KIMI_CODE_HOME', () => {
    process.env['KIMI_CODE_HOME'] = '/custom-bin-home';
    expect(getBinDir()).toBe(join('/custom-bin-home', 'bin'));
  });
});

describe('getInputHistoryFile', () => {
  it('returns <dataDir>/user-history/<md5(workDir)>.jsonl', () => {
    const workDir = '/home/user/project';
    const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
    expect(getInputHistoryFile(workDir)).toBe(
      join(homedir(), '.kimi-code', 'user-history', `${hash}.jsonl`),
    );
  });

  it('respects KIMI_CODE_HOME', () => {
    process.env['KIMI_CODE_HOME'] = '/custom/data';
    const hash = createHash('md5').update('/proj', 'utf-8').digest('hex');
    expect(getInputHistoryFile('/proj')).toBe(
      join('/custom/data', 'user-history', `${hash}.jsonl`),
    );
  });
});
