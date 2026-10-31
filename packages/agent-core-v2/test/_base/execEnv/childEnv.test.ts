import { describe, expect, it } from 'vitest';

import { mergeChildEnv } from '#/_base/execEnv/childEnv';

describe('mergeChildEnv', () => {
  it('replaces Windows keys case-insensitively and keeps the latest spelling', () => {
    expect(mergeChildEnv(
      { Path: 'a', HOME: 'h', SKIP: undefined },
      { PATH: 'b' },
      { path: 'c', Extra: 'x' },
      ['home'],
      true,
    )).toEqual({ path: 'c', Extra: 'x' });
  });

  it('keeps case-distinct POSIX keys and removes only exact unset names', () => {
    expect(mergeChildEnv(
      { Path: 'a', PATH: 'b', HOME: 'h' },
      { PATH: 'c' },
      {},
      ['Path', 'home'],
      false,
    )).toEqual({ PATH: 'c', HOME: 'h' });
  });

  it('reads the parent environment on every call', () => {
    const parent: Record<string, string | undefined> = { A: '1' };
    expect(mergeChildEnv(parent, {}, {}, [], false)).toEqual({ A: '1' });
    parent['A'] = '2';
    parent['B'] = '3';
    expect(mergeChildEnv(parent, {}, {}, [], false)).toEqual({ A: '2', B: '3' });
  });
});
