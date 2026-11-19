import { describe, expect, it, vi } from 'vitest';

vi.mock('open', () => ({ default: vi.fn(() => Promise.resolve({})) }));

import open from 'open';
import { openUrl } from '../../src/utils/open-url';

describe('openUrl', () => {
  it('delegates URL opening with query parameters to open without throwing on rejection', async () => {
    const openMock = vi.mocked(open);
    openMock.mockClear();
    openUrl('https://e.test/a?x=1&calc');
    expect(openMock).toHaveBeenCalledWith('https://e.test/a?x=1&calc');

    openMock.mockRejectedValueOnce(new Error('spawn failed'));
    expect(() => openUrl('https://e.test/fail')).not.toThrow();
    await Promise.resolve();
  });
});
