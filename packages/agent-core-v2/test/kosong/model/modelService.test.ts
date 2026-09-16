import { describe, expect, it, vi } from 'vitest';

import { modelsFromToml, modelsToToml } from '#/app/kosongConfig/configSection';
import { type ModelRecord } from '#/kosong/model/model';
import { ModelService } from '#/kosong/model/modelService';

describe('models TOML transforms', () => {
  it('converts snake_case entries to camelCase and back', () => {
    const from = modelsFromToml({
      k1: {
        provider: 'moonshot',
        model: 'kimi-k2',
        max_context_size: 262144,
        max_output_size: 8192,
        display_name: 'K2',
        reasoning_key: 'reasoning_content',
        adaptive_thinking: true,
        beta_api: true,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        overrides: { max_output_size: 4096, default_effort: 'low' },
      },
    }) as Record<string, Record<string, unknown>>;
    expect(from['k1']).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2',
      maxContextSize: 262144,
      maxOutputSize: 8192,
      displayName: 'K2',
      reasoningKey: 'reasoning_content',
      adaptiveThinking: true,
      betaApi: true,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      overrides: { maxOutputSize: 4096, defaultEffort: 'low' },
    });

    const back = modelsToToml(from, undefined) as Record<string, Record<string, unknown>>;
    expect(back['k1']).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2',
      max_context_size: 262144,
      max_output_size: 8192,
      display_name: 'K2',
      reasoning_key: 'reasoning_content',
      adaptive_thinking: true,
      beta_api: true,
      support_efforts: ['low', 'high'],
      default_effort: 'high',
      overrides: { max_output_size: 4096, default_effort: 'low' },
    });
  });

  it('converts nested cognition overlay_mode and path arrays', () => {
    const from = modelsFromToml({
      flash: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        cognition: {
          overlay: 'cognition/flash-overlay.md',
          overlay_mode: 'append',
          steering: ['cognition/a.md', 'cognition/b.md'],
          anchor: ['cognition/flash-anchor.md', 'cognition/flash-anchor-2.md'],
          anchor_steps: 3,
          anchor_scope: 'turn',
        },
      },
    }) as Record<string, Record<string, unknown>>;
    expect(from['flash']?.['cognition']).toEqual({
      overlay: 'cognition/flash-overlay.md',
      overlayMode: 'append',
      steering: ['cognition/a.md', 'cognition/b.md'],
      anchor: ['cognition/flash-anchor.md', 'cognition/flash-anchor-2.md'],
      anchorSteps: 3,
      anchorScope: 'turn',
    });

    const back = modelsToToml(from, undefined) as Record<string, Record<string, unknown>>;
    expect(back['flash']?.['cognition']).toEqual({
      overlay: 'cognition/flash-overlay.md',
      overlay_mode: 'append',
      steering: ['cognition/a.md', 'cognition/b.md'],
      anchor: ['cognition/flash-anchor.md', 'cognition/flash-anchor-2.md'],
      anchor_steps: 3,
      anchor_scope: 'turn',
    });
  });
});

describe('ModelService', () => {
  function createService(models: Readonly<Record<string, ModelRecord>> = {}): ModelService {
    const service = new ModelService();
    service.loadAll({ ...models }, undefined);
    return service;
  }

  it('resolves ready on the first loadAll and exposes the default pointer', async () => {
    const service = new ModelService();
    let ready = false;
    void service.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    service.loadAll({ k1: { model: 'kimi-k2', maxContextSize: 262144 } }, 'k1');
    await service.ready;
    expect(ready).toBe(true);
    expect(service.getDefaultModel()).toBe('k1');
  });

  it('resolves an unambiguous bare id without changing exact get semantics', () => {
    const service = createService({
      'axon-message/deepseek-v4-flash': { model: 'vendor/deepseek-v4-flash' },
    });

    expect(service.resolveId('deepseek-v4-flash')).toBe(
      'axon-message/deepseek-v4-flash',
    );
    expect(service.get('deepseek-v4-flash')).toBeUndefined();
  });

  it('prefers an exact configured key over bare-id matches', () => {
    const service = createService({
      'deepseek-v4-flash': { model: 'exact-wire-model' },
      'axon-message/deepseek-v4-flash': { model: 'deepseek-v4-flash' },
    });

    expect(service.resolveId('deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  it('resolves an ambiguous bare id to the first catalog candidate and warns', () => {
    const service = createService({
      'alpha/deepseek-v4-flash': { model: 'deepseek-v4-flash' },
      'beta/other': { model: 'deepseek-v4-flash' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(service.resolveId('deepseek-v4-flash')).toBe('alpha/deepseek-v4-flash');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('"deepseek-v4-flash"');
      expect(warn.mock.calls[0]?.[0]).toContain('"alpha/deepseek-v4-flash"');
      expect(warn.mock.calls[0]?.[0]).toContain('"beta/other"');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns only once while memoizing repeated resolutions of the same ambiguous id', () => {
    const service = createService({
      'alpha/deepseek-v4-flash': { model: 'deepseek-v4-flash' },
      'beta/other': { model: 'deepseek-v4-flash' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(service.resolveId('deepseek-v4-flash')).toBe('alpha/deepseek-v4-flash');
      }
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('re-resolves after the catalog changes and warns again on the new ambiguity', async () => {
    const service = createService({
      'alpha/deepseek-v4-flash': { model: 'deepseek-v4-flash' },
      'beta/other': { model: 'deepseek-v4-flash' },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(service.resolveId('deepseek-v4-flash')).toBe('alpha/deepseek-v4-flash');
      await service.replaceAll({
        'gamma/deepseek-v4-flash': { model: 'deepseek-v4-flash' },
        'delta/other': { model: 'deepseek-v4-flash' },
      });
      expect(service.resolveId('deepseek-v4-flash')).toBe('gamma/deepseek-v4-flash');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not suffix-match unknown or qualified ids', () => {
    const service = createService({
      'axon-message/deepseek-v4-flash': { model: 'deepseek-v4-flash' },
    });

    expect(service.resolveId('missing')).toBeUndefined();
    expect(service.resolveId('other/deepseek-v4-flash')).toBeUndefined();
  });

  it('resolves a provider-qualified id to the matching bare key', () => {
    const service = createService({
      'fast-model': { provider: 'openai', model: 'fast-model' },
    });

    expect(service.resolveId('openai/fast-model')).toBe('fast-model');
  });

  it('resolves a provider-qualified id when provider uses a managed: prefix', () => {
    const service = createService({
      'k3-review': { provider: 'managed:kimi-code', model: 'k3-review' },
    });

    expect(service.resolveId('kimi-code/k3-review')).toBe('k3-review');
  });

  it('does not resolve a provider-qualified id whose prefix matches no provider', () => {
    const service = createService({
      'fast-model': { provider: 'openai', model: 'fast-model' },
    });

    expect(service.resolveId('anthropic/fast-model')).toBeUndefined();
  });

  it('resolves an exact aliases entry that contains a slash', () => {
    const service = createService({
      'fast-model': {
        provider: 'openai',
        model: 'fast-model',
        aliases: ['openai/legacy-flash'],
      },
    });

    expect(service.resolveId('openai/legacy-flash')).toBe('fast-model');
  });

  it('resolves duplicate aliases to the first catalog candidate and warns', () => {
    const service = createService({
      alpha: { aliases: ['fast-model'] },
      beta: { aliases: ['fast-model'] },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(service.resolveId('fast-model')).toBe('alpha');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('"fast-model"');
      expect(warn.mock.calls[0]?.[0]).toContain('"alpha"');
      expect(warn.mock.calls[0]?.[0]).toContain('"beta"');
    } finally {
      warn.mockRestore();
    }
  });

  it('prefers an exact aliases hit over bare-name tail matching', () => {
    const service = createService({
      'openai/fast-model': { provider: 'openai', model: 'fast-model' },
      'k3-review': { aliases: ['fast-model'] },
    });

    expect(service.resolveId('fast-model')).toBe('k3-review');
  });

  it('uses providerId when provider is unset to accept or reject a qualified prefix', () => {
    const service = createService({
      'fast-model': { providerId: 'openai', model: 'fast-model' },
    });

    expect(service.resolveId('openai/fast-model')).toBe('fast-model');
    expect(service.resolveId('anthropic/fast-model')).toBeUndefined();
  });

  it('supports CRUD and diffs state changes into onDidChangeModels', async () => {
    const service = createService();
    const events: Array<{
      added: readonly string[];
      removed: readonly string[];
      changed: readonly string[];
    }> = [];
    service.onDidChangeModels((e) =>
      events.push({ added: e.added, removed: e.removed, changed: e.changed }),
    );

    const k1: ModelRecord = { provider: 'moonshot', model: 'kimi-k2', maxContextSize: 262144 };
    await service.set('k1', k1);
    expect(service.get('k1')).toEqual(k1);
    expect(service.list()).toEqual({ k1 });
    expect(events).toEqual([{ added: ['k1'], removed: [], changed: [] }]);

    const updated: ModelRecord = { ...k1, displayName: 'K2' };
    await service.set('k1', updated);
    expect(events.at(-1)).toEqual({ added: [], removed: [], changed: ['k1'] });

    await service.set('k1', updated);
    expect(events).toHaveLength(2);

    await service.delete('k1');
    expect(service.get('k1')).toBeUndefined();
    expect(events.at(-1)).toEqual({ added: [], removed: ['k1'], changed: [] });
  });

  it('replaceAll replaces the records and keeps the default pointer', async () => {
    const service = createService({ a: { model: 'm-a' }, b: { model: 'm-b' } });
    await service.setDefaultModel('a');

    await service.replaceAll({ c: { model: 'm-c' } });
    expect(service.list()).toEqual({ c: { model: 'm-c' } });
    expect(service.getDefaultModel()).toBe('a');
  });

  it('fires the pointer event only on real pointer changes', async () => {
    const service = createService({ k1: { model: 'kimi-k2' } });
    const pointerEvents: Array<string | undefined> = [];
    service.onDidChangeDefaultModel((e) => pointerEvents.push(e.id));

    await service.setDefaultModel('k1');
    await service.setDefaultModel('k1');
    expect(pointerEvents).toEqual(['k1']);

    await service.setDefaultModel(undefined);
    expect(pointerEvents).toEqual(['k1', undefined]);
  });
});
