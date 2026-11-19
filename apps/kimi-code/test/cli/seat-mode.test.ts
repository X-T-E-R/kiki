import { describe, expect, it } from 'vitest';

import { parseMode } from '../../src/kiki/seat';

describe('kiki seat --mode', () => {
  it('accepts every seat mode, review included', () => {
    for (const mode of ['manual', 'auto', 'review', 'yolo']) expect(parseMode(mode)).toBe(mode);
  });

  it('refuses anything else', () => {
    expect(() => parseMode('trusted')).toThrow(/Invalid permission mode/);
  });
});
