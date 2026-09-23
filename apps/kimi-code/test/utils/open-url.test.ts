import { describe, expect, it, vi } from 'vitest';

import { openUrl } from '../../src/utils/open-url';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';

describe('openUrl', () => {
  it('quotes the cmd /c start target so `&` cannot split the command', () => {
    vi.mocked(execFile).mockClear();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      openUrl('https://e.test/a?x=1&calc');
      expect(execFile).toHaveBeenCalledWith(
        'cmd',
        ['/c', 'start', '', '"https://e.test/a?x=1&calc"'],
        expect.any(Function),
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
