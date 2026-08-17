import { describe, expect, it } from 'vitest';

import { resolveSelectedEffort } from './Composer';
import { isAbsoluteCwdPath } from './NewSessionDraft';

describe('isAbsoluteCwdPath', () => {
  it('accepts POSIX, Windows-drive, and UNC absolute paths', () => {
    expect(isAbsoluteCwdPath('/home/you/project')).toBe(true);
    expect(isAbsoluteCwdPath('/')).toBe(true);
    expect(isAbsoluteCwdPath('C:/work/project')).toBe(true);
    expect(isAbsoluteCwdPath('C:\\work\\project')).toBe(true);
    expect(isAbsoluteCwdPath('\\\\server\\share\\project')).toBe(true);
  });

  it('rejects relative paths, drive letters without a separator, and empties', () => {
    expect(isAbsoluteCwdPath('project')).toBe(false);
    expect(isAbsoluteCwdPath('./project')).toBe(false);
    expect(isAbsoluteCwdPath('~/project')).toBe(false);
    expect(isAbsoluteCwdPath('C:project')).toBe(false);
    expect(isAbsoluteCwdPath('')).toBe(false);
    expect(isAbsoluteCwdPath('  ')).toBe(false);
  });
});

describe('resolveSelectedEffort', () => {
  it('submits the same catalog default that the untouched select displays', () => {
    expect(resolveSelectedEffort(['low', 'medium', 'high'], undefined, 'medium')).toBe('medium');
  });

  it('falls back to the first visible option and preserves a supported explicit selection', () => {
    expect(resolveSelectedEffort(['low', 'high'], undefined, undefined)).toBe('low');
    expect(resolveSelectedEffort(['low', 'high'], 'high', 'low')).toBe('high');
    expect(resolveSelectedEffort(['low', 'high'], 'stale', 'missing')).toBe('low');
  });

  it('omits thinking when the effective model has no effort selector', () => {
    expect(resolveSelectedEffort(undefined, 'high', 'medium')).toBeUndefined();
    expect(resolveSelectedEffort([], 'high', 'medium')).toBeUndefined();
  });
});
