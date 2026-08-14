import { describe, expect, it } from 'vitest';

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
