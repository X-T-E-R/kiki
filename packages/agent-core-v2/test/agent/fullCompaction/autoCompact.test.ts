import { describe, expect, it } from 'vitest';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ProfileModelContext } from '#/agent/profile/profile';
import { LoopControlSchema } from '#/agent/loop/configSection';
import { ModelOverrideSchema } from '#/app/kosongConfig/configSection';
import { globalPercentFromTokens, resolveAutoCompact } from '#/agent/fullCompaction/autoCompact';

function context(window: number, extra: Partial<ProfileModelContext> = {}): ProfileModelContext {
  return {
    modelAlias: 'test', modelCapabilities: { ...UNKNOWN_CAPABILITY, max_context_tokens: window },
    maxOutputSize: undefined, alwaysThinking: undefined, thinkingLevel: 'off',
    reservedContextSize: undefined, compactionTriggerRatio: undefined,
    compactionMaxAttempts: undefined, compactionSoftContextSize: undefined, ...extra,
  };
}

describe('auto_compact resolution', () => {
  it('preserves the prior threshold for unconfigured 200k, 550k and 1M windows', () => {
    for (const window of [200_000, 550_000, 1_000_000]) {
      expect(resolveAutoCompact(context(window))).toMatchObject({
        tokens: Math.min(window * .85, window - 50_000), source: 'legacy',
      });
      expect(resolveAutoCompact(context(window, { compactionTriggerRatio: .6, compactionSoftContextSize: 90_000 })).tokens)
        .toBe(Math.min(window * .6, window - 50_000, 90_000));
    }
  });

  it('picks the nearest soft target and only lowers the effective context limit', () => {
    const model = context(550_000, {
      modelCapabilities: { ...UNKNOWN_CAPABILITY, max_context_tokens: 300_000, max_input_tokens: 300_000 },
      globalAutoCompact: '85%', modelAutoCompact: 210_000, profileAutoCompact: 240_000,
    });
    expect(resolveAutoCompact(model).tokens).toBe(240_000);
    expect(resolveAutoCompact(model).source).toBe('profile');
    expect(resolveAutoCompact(model, 180_000)).toMatchObject({ tokens: 180_000, source: 'session', effectiveMaxContextTokens: 300_000 });
    expect(resolveAutoCompact(context(550_000, { globalAutoCompact: '85%' })).tokens).toBe(467_500);
    expect(resolveAutoCompact(context(300_000, { modelAutoCompact: 290_000 })).tokens).toBe(250_000);
    expect(resolveAutoCompact(context(300_000, { profileAutoCompact: 1_000 }), undefined, 80_000).tokens).toBe(112_000);
  });

  it('rejects formats at the wrong layer with a layer-specific error', () => {
    expect(LoopControlSchema.safeParse({ autoCompact: 400_000 }).error?.message).toContain('global loop_control.auto_compact');
    expect(LoopControlSchema.safeParse({ autoCompact: '85%' }).success).toBe(true);
    expect(ModelOverrideSchema.safeParse({ autoCompact: '85%' }).error?.message).toContain('model auto_compact');
    expect(ModelOverrideSchema.safeParse({ autoCompact: 400_000 }).success).toBe(true);
  });

  it('converts an absolute session token count to a global percentage of the usable limit', () => {
    expect(globalPercentFromTokens(400_000, 550_000)).toBe('72.72727273%');
    expect(resolveAutoCompact(context(550_000, { globalAutoCompact: globalPercentFromTokens(400_000, 550_000) })).tokens).toBe(400_000);
    expect(globalPercentFromTokens(1, 1_000_000_000)).toBe('0.0000001%');
    expect(LoopControlSchema.safeParse({ autoCompact: globalPercentFromTokens(1, 1_000_000_000) }).success).toBe(true);
    expect(() => globalPercentFromTokens(100_000, 0)).toThrow();
  });
});
