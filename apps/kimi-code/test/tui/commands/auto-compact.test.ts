import { describe, expect, it, vi } from 'vitest';

import { handleAutoCompactCommand, parseAutoCompactArgs } from '#/tui/commands/auto-compact';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

const current = { tokens: 467_500, source: 'legacy' as const, effectiveMaxContextTokens: 550_000, reservedContextTokens: 50_000 };

describe('/autocompact', () => {
  it('converts UI units and percentages into absolute tokens before sending', () => {
    expect(parseAutoCompactArgs('400k', 550_000)).toEqual({ tokens: 400_000 });
    expect(parseAutoCompactArgs('0.4m --save global', 550_000)).toEqual({ tokens: 400_000, save: 'global' });
    expect(parseAutoCompactArgs('73%', 550_000)).toEqual({ tokens: 401_500 });
    expect(parseAutoCompactArgs('default', 550_000)).toEqual({ tokens: null });
    expect(parseAutoCompactArgs('', 550_000)).toBeUndefined();
  });

  it('rejects invalid values and attempts to save a reset', () => {
    for (const input of ['0', '-1', '0.5', '101%', 'abc', 'default --save model', '400k --save invalid', '400k --save']) {
      expect(() => parseAutoCompactArgs(input, 550_000), input).toThrow();
    }
  });

  it('reads status and delegates saves to the session API', async () => {
    const getAutoCompact = vi.fn().mockResolvedValue(current);
    const setAutoCompact = vi.fn().mockResolvedValue({
      effective: { ...current, tokens: 400_000, source: 'global' },
      default: { ...current, tokens: 400_000, source: 'global' },
      overrideCleared: true, savedAs: '72.72727273%',
    });
    const host = {
      session: { getAutoCompact, setAutoCompact }, showNotice: vi.fn(), showError: vi.fn(),
    } as unknown as SlashCommandHost;
    await handleAutoCompactCommand(host, '');
    expect(getAutoCompact).toHaveBeenCalledOnce();
    expect(setAutoCompact).not.toHaveBeenCalled();
    await handleAutoCompactCommand(host, '400k --save global');
    expect(setAutoCompact).toHaveBeenCalledWith({ tokens: 400_000, save: 'global' });
    expect(host.showNotice).toHaveBeenLastCalledWith('Automatic compaction', expect.stringContaining('72.72727273%'));
  });
});
