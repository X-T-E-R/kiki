import { describe, expect, it } from 'vitest';

import { effectiveModelInputTokens, inheritedCompactPoint, modelCompactPoint, modelCompactionBounds, modelCompactionPreview, readLoopControl } from './modelCompaction';

describe('model compaction settings preview', () => {
  it('uses the effective 400k input window rather than an oversized 529.4k declaration', () => {
    const usable = effectiveModelInputTokens(400_000, 529_400);
    expect(usable).toBe(400_000);
    expect(inheritedCompactPoint(usable, {})).toEqual({ tokens: 340_000, from: 'legacy' });
    expect(inheritedCompactPoint(usable, { autoCompact: '85%' })).toEqual({ tokens: 340_000, from: 'global', percent: '85%' });
  });

  it('applies a model context budget after the declared input and total-window limits', () => {
    expect(effectiveModelInputTokens(400_000, 529_400, 300_000)).toBe(300_000);
    expect(effectiveModelInputTokens(400_000, 272_000, 300_000)).toBe(272_000);
    expect(effectiveModelInputTokens(400_000, undefined, 600_000)).toBe(400_000);
  });

  it('merges model overrides before applying the model budget without rewriting the base draft', () => {
    const draft = {
      windowTokens: 400_000, inputTokens: 529_400, contextBudget: 100_000, autoCompact: 200_000,
      overrides: { max_context_size: 350_000, max_input_size: 500_000, context_budget: 300_000, auto_compact: 150_000 },
    };
    expect(modelCompactionPreview(draft)).toEqual({
      valid: true, windowTokens: 350_000, inputTokens: 500_000, contextBudget: 300_000,
      usableTokens: 300_000, autoCompact: 150_000, autoCompactOverridden: true,
    });
    expect(draft).toMatchObject({ windowTokens: 400_000, inputTokens: 529_400, contextBudget: 100_000, autoCompact: 200_000 });
    expect(modelCompactionPreview({ windowTokens: 400_000, inputTokens: 529_400, overrides: '{"context_budget":250000}' })).toMatchObject({
      valid: true, usableTokens: 250_000, autoCompactOverridden: false,
    });
  });

  it('removes preview-only overrides as soon as their draft is cleared', () => {
    const draft = { windowTokens: 400_000, inputTokens: 529_400, contextBudget: 300_000, autoCompact: 200_000 };
    for (const overrides of [undefined, '', '{}', {}]) {
      expect(modelCompactionPreview({ ...draft, overrides })).toEqual({
        valid: true, ...draft, usableTokens: 300_000, autoCompactOverridden: false,
      });
    }
    expect(modelCompactionPreview({ windowTokens: 400_000, overrides: '{"max_input_size":272000}' })).toMatchObject({ valid: true, usableTokens: 272_000 });
  });

  it('normalizes editable camelCase overrides with the backend key-order precedence', () => {
    expect(modelCompactionPreview({ windowTokens: 400_000, overrides: { maxContextSize: 350_000, contextBudget: 250_000, autoCompact: 150_000 } })).toMatchObject({
      valid: true, windowTokens: 350_000, usableTokens: 250_000, autoCompact: 150_000, autoCompactOverridden: true,
    });
    expect(modelCompactionPreview({ windowTokens: 400_000, overrides: { contextBudget: 200_000, context_budget: 300_000 } })).toMatchObject({ valid: true, usableTokens: 300_000 });
    expect(modelCompactionPreview({ windowTokens: 400_000, overrides: { context_budget: 300_000, contextBudget: 200_000 } })).toMatchObject({ valid: true, usableTokens: 200_000 });
  });

  it('does not silently show a base preview for malformed JSON or invalid override counts', () => {
    for (const overrides of ['{', 'null', '[]', 'true', null, [], { max_context_size: 0 }, { max_input_size: '500000' }, { context_budget: -1 }, { auto_compact: 1.5 }]) {
      expect(modelCompactionPreview({ windowTokens: 400_000, overrides })).toEqual({ valid: false });
    }
  });

  it('reports an exhausted model reserve as locked while preserving engine ceiling semantics', () => {
    expect(modelCompactionBounds(400_000)).toEqual({ floor: 64_000, ceil: 350_000, locked: false });
    expect(modelCompactionBounds(64_000)).toEqual({ floor: 14_000, ceil: 14_000, locked: true });
    expect(modelCompactionBounds(40_000)).toEqual({ floor: -10_000, ceil: -10_000, locked: true });
    expect(modelCompactionBounds(50_000)).toEqual({ floor: 0, ceil: 0, locked: true });
    expect(modelCompactPoint(40_000, 20_000, {})).toBe(-10_000);
    expect(inheritedCompactPoint(40_000, {}).tokens).toBe(34_000);
  });

  it('recomputes from unsaved draft sizes and preserves the raw input declaration', () => {
    const input = 529_400;
    expect(effectiveModelInputTokens(300_000, input)).toBe(300_000);
    expect(inheritedCompactPoint(effectiveModelInputTokens(300_000, input), {}).tokens).toBe(250_000);
    expect(effectiveModelInputTokens(600_000, input)).toBe(input);
    expect(inheritedCompactPoint(effectiveModelInputTokens(600_000, input), {}).tokens).toBe(449_990);
    expect(input).toBe(529_400);
  });

  it('keeps a smaller input limit and falls back to the context window when absent', () => {
    expect(effectiveModelInputTokens(400_000, 272_000)).toBe(272_000);
    expect(effectiveModelInputTokens(400_000)).toBe(400_000);
    expect(effectiveModelInputTokens(0, 272_000)).toBe(0);
    expect(inheritedCompactPoint(0, { autoCompact: '85%' })).toEqual({ tokens: 0, from: 'legacy' });
  });

  it('matches global percentage and explicit model-token floor and reserve clamps', () => {
    expect(inheritedCompactPoint(400_000, { autoCompact: '1%' }).tokens).toBe(64_000);
    expect(inheritedCompactPoint(400_000, { autoCompact: '95%' }).tokens).toBe(350_000);
    expect(modelCompactPoint(400_000, 450_000, {})).toBe(350_000);
    expect(modelCompactPoint(400_000, 1_000, {})).toBe(64_000);
    expect(modelCompactPoint(400_000, 200_000, {})).toBe(200_000);
    expect(modelCompactPoint(400_000, undefined, {})).toBe(340_000);
    expect(inheritedCompactPoint(64_000, { autoCompact: '85%' }).tokens).toBe(14_000);
  });

  it('preserves legacy ratio, soft ceiling, and reserve behavior rather than applying new percentage rules', () => {
    expect(inheritedCompactPoint(400_000, { compactionTriggerRatio: 0.6, compactionSoftContextSize: 90_000 })).toEqual({ tokens: 90_000, from: 'legacy' });
    expect(inheritedCompactPoint(400_000, { compactionTriggerRatio: 0.01 }).tokens).toBe(4_000);
    expect(inheritedCompactPoint(40_000, {}).tokens).toBe(34_000);
    expect(inheritedCompactPoint(400_000, { reservedContextSize: 0 }).tokens).toBe(340_000);
    expect(inheritedCompactPoint(400_000, { autoCompact: '85%', compactionSoftContextSize: 90_000 }).tokens).toBe(340_000);
  });

  it('reads both config echoes and keeps camelCase precedence including zero reserve', () => {
    expect(readLoopControl({ auto_compact: '85%', compaction_trigger_ratio: 0.6, compaction_soft_context_size: 90_000, reserved_context_size: 0 })).toEqual({
      autoCompact: '85%', compactionTriggerRatio: 0.6, compactionSoftContextSize: 90_000, reservedContextSize: 0,
    });
    expect(readLoopControl({ reservedContextSize: 0, reserved_context_size: 50_000 }).reservedContextSize).toBe(0);
    expect(readLoopControl({ compaction_soft_context_size: 0 }).compactionSoftContextSize).toBeUndefined();
    for (const input of [null, [], 'invalid']) expect(readLoopControl(input)).toEqual({});
  });
});
