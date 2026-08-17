import { describe, expect, it } from 'vitest';

import { effectiveModelAlias, resolveModelAlias } from '#/config/model';
import type { ModelAlias } from '#/config/schema';
import { ProviderManager } from '#/session/provider-manager';

function alias(overrides?: ModelAlias['overrides']): ModelAlias {
  return {
    provider: 'managed:kimi-code',
    model: 'kimi-k2',
    maxContextSize: 262144,
    capabilities: ['thinking'],
    supportEfforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
    overrides,
  };
}

describe('resolveModelAlias', () => {
  const configured = alias();

  it('resolves an unambiguous bare id through ProviderManager', () => {
    const manager = new ProviderManager({
      config: {
        providers: {
          'managed:kimi-code': { type: 'kimi', apiKey: 'test-key' },
        },
        defaultModel: 'kimi-k2',
        models: { 'kimi-code/kimi-k2': configured },
      },
    });

    expect(manager.resolveProviderConfig('kimi-k2').provider.model).toBe('kimi-k2');
  });

  it('prefers an exact key over suffix matches', () => {
    const exact = { ...configured, model: 'exact-wire-model' };
    const models = {
      'kimi-k2': exact,
      'kimi-code/kimi-k2': configured,
    };

    expect(resolveModelAlias(models, 'kimi-k2')).toEqual({ id: 'kimi-k2', alias: exact });
  });

  it('rejects ambiguous bare ids with every canonical candidate', () => {
    const models = {
      'alpha/kimi-k2': configured,
      'beta/other': configured,
    };

    expect(() => resolveModelAlias(models, 'kimi-k2')).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/alpha\/kimi-k2.*beta\/other.*full model id/),
      }),
    );
  });

  it('does not suffix-match unknown or qualified ids', () => {
    const models = { 'kimi-code/kimi-k2': configured };

    expect(resolveModelAlias(models, 'missing')).toBeUndefined();
    expect(resolveModelAlias(models, 'other/kimi-k2')).toBeUndefined();
  });
});

describe('effectiveModelAlias', () => {
  it('clamps the input cap to the effective total window without mutating the source', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'gpt-5',
      maxContextSize: 400000,
      maxInputSize: 272000,
      overrides: { maxContextSize: 128000 },
    };

    const effective = effectiveModelAlias(model);
    expect(effective.maxContextSize).toBe(128000);
    expect(effective.maxInputSize).toBe(128000);
    expect(model.maxInputSize).toBe(272000);

    const noOverrides: ModelAlias = {
      provider: 'custom',
      model: 'gpt-5',
      maxContextSize: 128000,
      maxInputSize: 272000,
    };
    expect(effectiveModelAlias(noOverrides).maxInputSize).toBe(128000);
    expect(noOverrides.maxInputSize).toBe(272000);
  });

  it('returns the alias unchanged when there are no overrides', () => {
    const model = alias();

    expect(effectiveModelAlias(model)).toEqual(model);
  });

  it('lets overrides win over top-level fields', () => {
    const model = alias({ supportEfforts: ['low', 'high'] });

    expect(effectiveModelAlias(model).supportEfforts).toEqual(['low', 'high']);
  });

  it('allows overriding non-identity model fields such as maxContextSize', () => {
    const model = alias({ maxContextSize: 128000 });

    expect(effectiveModelAlias(model).maxContextSize).toBe(128000);
  });

  it('drops an incompatible defaultEffort when supportEfforts is overridden', () => {
    const model = alias({ supportEfforts: ['low', 'high'] });

    expect(effectiveModelAlias(model).defaultEffort).toBeUndefined();
  });

  it('keeps an explicit defaultEffort override when it is valid', () => {
    const model = alias({ supportEfforts: ['low', 'high'], defaultEffort: 'high' });

    expect(effectiveModelAlias(model).defaultEffort).toBe('high');
  });

  it('derives the official effort list and thinking capability from a Claude model name', () => {
    const model: ModelAlias = {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      maxContextSize: 200000,
    };

    expect(effectiveModelAlias(model)).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'high',
    });
  });

  it('infers Anthropic effort metadata for an unknown Claude-marked model on a non-Kimi Anthropic provider', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'custom-claude-model',
      maxContextSize: 200000,
      protocol: 'anthropic',
    };

    expect(effectiveModelAlias(model, 'anthropic')).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it('infers Anthropic effort metadata for a bare Claude family alias on a non-Kimi Anthropic provider', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'sonnet-latest',
      maxContextSize: 200000,
      protocol: 'anthropic',
    };

    expect(effectiveModelAlias(model, 'anthropic')).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it('does not infer Anthropic effort metadata for a clearly non-Claude model on a non-Kimi Anthropic provider', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'custom-anthropic-model',
      maxContextSize: 200000,
      protocol: 'anthropic',
    };

    expect(effectiveModelAlias(model, 'anthropic')).toEqual(model);
  });

  it('does not infer Anthropic effort metadata for a Kimi provider routed through the Anthropic protocol', () => {
    const model: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['thinking', 'always_thinking'],
      protocol: 'anthropic',
      adaptiveThinking: true,
    };

    expect(effectiveModelAlias(model, 'kimi')).toEqual(model);
  });

  it('does not infer the fallback profile without provider context', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'custom-anthropic-model',
      maxContextSize: 200000,
      protocol: 'anthropic',
    };

    expect(effectiveModelAlias(model)).toEqual(model);
  });

  it('limits an adaptive_thinking=false model to budget efforts', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'custom-claude-model',
      maxContextSize: 200000,
      protocol: 'anthropic',
      adaptiveThinking: false,
    };

    expect(effectiveModelAlias(model, 'anthropic')).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    });
  });

  it('keeps a declared supportEfforts list authoritative when adaptive_thinking=false', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'custom-claude-model',
      maxContextSize: 200000,
      protocol: 'anthropic',
      adaptiveThinking: false,
      supportEfforts: ['low', 'high'],
    };

    expect(effectiveModelAlias(model, 'anthropic')).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
    });
  });

  it('does not infer Anthropic effort metadata for an unknown model without an Anthropic protocol', () => {
    const model: ModelAlias = {
      provider: 'custom',
      model: 'custom-anthropic-model',
      maxContextSize: 200000,
    };

    expect(effectiveModelAlias(model)).toEqual(model);
  });

  it('marks official always-on models and does not surface off', () => {
    const model: ModelAlias = {
      provider: 'anthropic',
      model: 'claude-fable-5',
      maxContextSize: 200000,
    };

    expect(effectiveModelAlias(model)).toMatchObject({
      capabilities: ['always_thinking'],
      supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it('keeps an explicit supportEfforts list authoritative over the official profile', () => {
    const model: ModelAlias = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      maxContextSize: 200000,
      supportEfforts: ['low', 'max'],
      defaultEffort: 'max',
    };

    expect(effectiveModelAlias(model)).toMatchObject({
      supportEfforts: ['low', 'max'],
      defaultEffort: 'max',
    });
  });
});
