import { describe, expect, it } from 'vitest';

import { permissionTestResult } from '../../src/kiki/permission';

describe('kiki permission test result', () => {
  it('treats review mode like auto: routine calls pass, the reviewer only sees what would ask', () => {
    expect(permissionTestResult('review', 0, 0, 0)).toBe('approve');
    expect(permissionTestResult('auto', 0, 0, 0)).toBe('approve');
    expect(permissionTestResult('manual', 0, 0, 0)).toBe('deny');
  });

  it('lets deny and ask rules win in every mode', () => {
    for (const mode of ['manual', 'auto', 'review', 'yolo'] as const) {
      expect(permissionTestResult(mode, 1, 0, 1)).toBe('deny');
      expect(permissionTestResult(mode, 0, 1, 0)).toBe('deny');
    }
    expect(permissionTestResult('manual', 0, 0, 1)).toBe('approve');
  });
});
