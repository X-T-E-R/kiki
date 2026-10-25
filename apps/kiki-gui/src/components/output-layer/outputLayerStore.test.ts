// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { outputLayerStore } from './outputLayerStore';
import { type OutputLayerPreset, hasConfiguredModel } from './types';

describe('outputLayerStore', () => {
  beforeEach(() => {
    localStorage.clear();
    outputLayerStore.setConfiguration(null);
  });

  it('initializes with builtin presets', () => {
    const presets = outputLayerStore.getPresets();
    expect(presets.length).toBeGreaterThanOrEqual(3);
    expect(presets.some((p) => p.id === 'translate')).toBe(true);
    expect(presets.some((p) => p.id === 'plain')).toBe(true);
  });

  it('can set and switch active preset per session', () => {
    const s1 = 'session-1';
    const s2 = 'session-2';

    outputLayerStore.setActivePreset(s1, 'translate');
    outputLayerStore.setActivePreset(s2, null);

    expect(outputLayerStore.getSessionState(s1).activePresetId).toBe('translate');
    expect(outputLayerStore.getSessionState(s1).viewMode).toBe('processed');
    expect(outputLayerStore.getSessionState(s2).activePresetId).toBeNull();
  });

  it('can toggle viewMode between processed and original', () => {
    const s1 = 'session-view-test';
    outputLayerStore.setActivePreset(s1, 'translate');
    expect(outputLayerStore.getSessionState(s1).viewMode).toBe('processed');

    outputLayerStore.setViewMode(s1, 'original');
    expect(outputLayerStore.getSessionState(s1).viewMode).toBe('original');

    outputLayerStore.setViewMode(s1, 'processed');
    expect(outputLayerStore.getSessionState(s1).viewMode).toBe('processed');
  });

  it('can save new custom preset and edit existing preset with client', async () => {
    const mockClient = {
      configuration: () => Promise.resolve({ enabled: true, presets: [], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } }),
      configure: (input: any) => Promise.resolve({ enabled: true, presets: input.presets, settings: input.settings }),
    } as any;

    const customPreset: OutputLayerPreset = {
      id: 'custom-1',
      label: '自定义测试预设',
      instruction: '请用英文回答',
      modelId: 'gemini-2.0-flash',
      contextWindow: 32768,
      maxOutputTokens: 2048,
    };

    await outputLayerStore.savePreset(customPreset, null, mockClient);
    expect(outputLayerStore.getPreset('custom-1')?.label).toBe('自定义测试预设');

    // Edit it
    await outputLayerStore.savePreset({ ...customPreset, label: '修改后的名称' }, null, mockClient);
    expect(outputLayerStore.getPreset('custom-1')?.label).toBe('修改后的名称');

    // Delete it
    await outputLayerStore.deletePreset('custom-1', mockClient);
    expect(outputLayerStore.getPreset('custom-1')).toBeUndefined();
  });

  it('throws and prevents fake local success when saving or deleting preset without client', async () => {
    const customPreset: OutputLayerPreset = {
      id: 'custom-fake',
      label: 'Fake Preset',
      instruction: 'Fake',
      contextWindow: 32768,
      maxOutputTokens: 2048,
    };
    await expect(outputLayerStore.savePreset(customPreset, null, null)).rejects.toThrow('Output layer client not connected');
    await expect(outputLayerStore.deletePreset('custom-fake', null)).rejects.toThrow('Output layer client not connected');
  });

  it('fetches session-scoped configuration through client', async () => {
    const mockClient = {
      configuration: (opts?: { sessionId?: string }) =>
        Promise.resolve({
          enabled: true,
          presets: [{ id: 'p1', label: 'Preset 1', instruction: 'inst', contextWindow: 32768, maxOutputTokens: 2048 }],
          settings: { groupChars: 800, preloadBefore: 2, preloadAfter: 2, historyTokens: 32000 },
        }),
    } as any;

    const config = await outputLayerStore.fetchConfiguration(mockClient, { sessionId: 'session-xyz' });
    expect(config.enabled).toBe(true);
    expect(config.presets).toHaveLength(1);
    expect(config.settings.groupChars).toBe(800);
    expect(outputLayerStore.getPresets()).toHaveLength(1);
  });

  it('saves preset along with updated settings through client', async () => {
    let savedInput: any = null;
    const mockClient = {
      configuration: () => Promise.resolve({ enabled: true, presets: [], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } }),
      configure: (input: any) => {
        savedInput = input;
        return Promise.resolve({ enabled: true, presets: input.presets, settings: input.settings });
      },
    } as any;

    const preset: OutputLayerPreset = {
      id: 'custom-adv',
      label: '高级预设',
      instruction: '简洁翻译',
      contextWindow: 16384,
      maxOutputTokens: 1024,
    };
    const settings = { groupChars: 750, preloadBefore: 2, preloadAfter: 0, historyTokens: 8192 };

    await outputLayerStore.savePreset(preset, settings, mockClient);

    expect(savedInput).toBeDefined();
    expect(savedInput.settings).toEqual(settings);
    expect(savedInput.presets.some((p: any) => p.id === 'custom-adv')).toBe(true);
  });

  it('preserves session enabled status and new preset when global is off and session is on', async () => {
    const sessionId = 'session-hot-1';
    const contextKey = `local::${sessionId}`;

    // Initial global state: disabled with empty presets
    outputLayerStore.setConfiguration({
      enabled: false,
      presets: [],
      settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
    });

    const mockClient = {
      // Backend PUT configure returns global perspective (disabled, empty presets)
      configure: async (_input: any) => ({
        enabled: false,
        presets: [],
        settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      }),
      // Backend GET configuration with sessionId returns session effective perspective (enabled: true with saved preset)
      configuration: async (opts?: { sessionId?: string }) => {
        if (opts?.sessionId === sessionId) {
          return {
            enabled: true,
            presets: [
              {
                id: 'preset-session-1',
                label: '会话专用预设',
                instruction: '精简改写',
                contextWindow: 32768,
                maxOutputTokens: 2048,
              },
            ],
            settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
          };
        }
        return {
          enabled: false,
          presets: [],
          settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
        };
      },
    } as any;

    const preset: OutputLayerPreset = {
      id: 'preset-session-1',
      label: '会话专用预设',
      instruction: '精简改写',
      contextWindow: 32768,
      maxOutputTokens: 2048,
    };

    const effective = await outputLayerStore.savePreset(preset, {
      client: mockClient,
      sessionId,
      contextKey,
    });

    // Session entry remains enabled with newly saved preset
    expect(effective.enabled).toBe(true);
    expect(effective.presets).toHaveLength(1);
    expect(effective.presets[0]?.label).toBe('会话专用预设');

    // Context store holds effective state
    const sessionConfig = outputLayerStore.getConfiguration(contextKey);
    expect(sessionConfig).toBeDefined();
    expect(sessionConfig?.enabled).toBe(true);
    expect(outputLayerStore.getPresets(contextKey)).toHaveLength(1);

    // Global store must NOT be mutated to enabled
    const globalConfig = outputLayerStore.getConfiguration();
    expect(globalConfig?.enabled).toBe(false);
  });

  it('guarantees context isolation: late update for context A does not alter context B', async () => {
    const ctxA = 'local::session-A';
    const ctxB = 'local::session-B';

    outputLayerStore.setConfiguration(
      { enabled: true, presets: [{ id: 'pA', label: 'Preset A', instruction: '', contextWindow: 32768, maxOutputTokens: 2048 }], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } },
      ctxA,
    );
    outputLayerStore.setConfiguration(
      { enabled: true, presets: [{ id: 'pB', label: 'Preset B', instruction: '', contextWindow: 32768, maxOutputTokens: 2048 }], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } },
      ctxB,
    );

    expect(outputLayerStore.getPresets(ctxA)[0]?.label).toBe('Preset A');
    expect(outputLayerStore.getPresets(ctxB)[0]?.label).toBe('Preset B');

    // Late response for ctxA arrives
    outputLayerStore.setConfiguration(
      { enabled: false, presets: [], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } },
      ctxA,
    );

    // ctxB is untouched
    expect(outputLayerStore.getConfiguration(ctxA)?.enabled).toBe(false);
    expect(outputLayerStore.getConfiguration(ctxB)?.enabled).toBe(true);
    expect(outputLayerStore.getPresets(ctxB)[0]?.label).toBe('Preset B');
  });

  it('treats unknown context as null / unready without falling back to global', () => {
    outputLayerStore.setConfiguration({
      enabled: true,
      presets: [{ id: 'g1', label: 'Global', instruction: '', contextWindow: 32768, maxOutputTokens: 2048 }],
      settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
    });

    // Unknown context must be null, not falling back to global
    expect(outputLayerStore.getConfiguration('unknown-scope::unknown-session')).toBeNull();
  });

  it('strictly rejects when client is explicitly null even if an active client singleton exists', async () => {
    const mockActive = {
      configure: () => Promise.resolve({ enabled: true, presets: [] }),
      configuration: () => Promise.resolve({ enabled: true, presets: [] }),
    } as any;
    outputLayerStore.setConfiguration(null);

    const { setActiveOutputLayerClient } = await import('./useOutputLayerClient');
    setActiveOutputLayerClient(mockActive);

    const preset: OutputLayerPreset = {
      id: 'p-test',
      label: 'Test',
      instruction: '',
      contextWindow: 32768,
      maxOutputTokens: 2048,
    };

    // Explicit null client must throw and NOT fallback to mockActive
    await expect(
      outputLayerStore.savePreset(preset, { client: null }),
    ).rejects.toThrow('Output layer client not connected');

    await expect(
      outputLayerStore.deletePreset('p-test', { client: null }),
    ).rejects.toThrow('Output layer client not connected');

    setActiveOutputLayerClient(null);
  });

  it('hasConfiguredModel identifies unconfigured vs explicitly configured models', () => {
    // Empty preset or null
    expect(hasConfiguredModel(null)).toBe(false);
    expect(hasConfiguredModel(undefined)).toBe(false);

    // Empty modelId
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', contextWindow: 32768 })).toBe(false);
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', modelId: '', contextWindow: 32768 })).toBe(false);
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', modelId: '   ', contextWindow: 32768 })).toBe(false);

    // An explicit catalog ID named default is opaque, not a sentinel.
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', modelId: 'default', contextWindow: 32768 })).toBe(true);

    // Incomplete custom model
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', connectionId: 'conn', contextWindow: 32768 })).toBe(false);
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', customModelId: 'm', contextWindow: 32768 })).toBe(false);

    // Explicit catalog model
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', modelId: 'gemini-2.0-flash', contextWindow: 32768 })).toBe(true);

    // Complete custom model
    expect(hasConfiguredModel({ id: 'p', label: 'L', instruction: 'I', connectionId: 'conn', customModelId: 'custom-m', contextWindow: 32768 })).toBe(true);
  });

  it('saves preset with empty model and omitted token budget without fallback', async () => {
    let savedPayload: any = null;
    const mockClient = {
      configuration: () => Promise.resolve({ enabled: true, presets: [] }),
      configure: (payload: any) => {
        savedPayload = payload;
        return Promise.resolve({ enabled: true, presets: payload.presets, settings: payload.settings });
      },
    } as any;

    const unconfiguredPreset: OutputLayerPreset = {
      id: 'empty-test',
      label: '空模型预设',
      instruction: '简洁输出',
      modelId: undefined,
      maxOutputTokens: undefined,
      contextWindow: 32768,
    };

    await outputLayerStore.savePreset(unconfiguredPreset, { client: mockClient });
    const saved = savedPayload.presets.find((p: any) => p.id === 'empty-test');
    expect(saved).toBeDefined();
    expect(saved.modelId).toBeUndefined();
    expect(saved.maxOutputTokens).toBeUndefined();
    expect(saved.label).toBe('空模型预设');
    // Ensure no fallback backfilled 2048 or default
    expect(saved.modelId).not.toBe('default');
    expect(saved.maxOutputTokens).not.toBe(2048);
  });

  it('preserves explicit model and positive maxOutputTokens when configured', async () => {
    let savedPayload: any = null;
    const mockClient = {
      configuration: () => Promise.resolve({ enabled: true, presets: [] }),
      configure: (payload: any) => {
        savedPayload = payload;
        return Promise.resolve({ enabled: true, presets: payload.presets, settings: payload.settings });
      },
    } as any;

    const explicitPreset: OutputLayerPreset = {
      id: 'explicit-test',
      label: '指定模型',
      instruction: '翻译',
      modelId: 'openai/gpt-4o-mini',
      maxOutputTokens: 4096,
      contextWindow: 32768,
    };

    await outputLayerStore.savePreset(explicitPreset, { client: mockClient });
    const saved = savedPayload.presets.find((p: any) => p.id === 'explicit-test');
    expect(saved).toBeDefined();
    expect(saved.modelId).toBe('openai/gpt-4o-mini');
    expect(saved.maxOutputTokens).toBe(4096);
  });
});

describe('outputLayerStore space namespacing', () => {
  const LEGACY_KEY = 'kiki.output-layer.sessions.v1';
  const DEFAULT_STATE = { activePresetId: null, viewMode: 'processed' };

  /**
   * Boot a fresh store the way the desktop entry does: configure the space
   * first, then load the module that reads the keys at construction.
   */
  async function bootInSpace(homeId: string | null): Promise<typeof import('./outputLayerStore')> {
    vi.resetModules();
    const storage = await import('../../lib/spaceStorage');
    storage.configureSpaceStorage(homeId === null ? null : { homeId, isPrimary: homeId === 'main' });
    return import('./outputLayerStore');
  }

  function writeLegacy(value: unknown): void {
    localStorage.setItem(LEGACY_KEY, typeof value === 'string' ? value : JSON.stringify(value));
  }

  function namespacedKey(homeId: string): string {
    return `kiki.space.${homeId}.${LEGACY_KEY}`;
  }

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('recovers a subspace record that only exists under the pre-space key', async () => {
    const legacy = { 'work:server-a:session-1': { activePresetId: 'translate', viewMode: 'original' } };
    writeLegacy(legacy);

    const { outputLayerStore: store } = await bootInSpace('work');

    expect(store.getSessionState('work:server-a:session-1')).toEqual(legacy['work:server-a:session-1']);
    // The migration reads; the original bytes stay exactly as they were.
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY)!)).toEqual(legacy);
    expect(localStorage.getItem(namespacedKey('work'))).toBeNull();
  });

  it('keeps a recovered record once the space saves its own state', async () => {
    writeLegacy({ 'work:server-a:session-1': { activePresetId: 'translate', viewMode: 'original' } });
    const { outputLayerStore: store } = await bootInSpace('work');

    store.setViewMode('work:server-a:session-2', 'original');

    expect(JSON.parse(localStorage.getItem(namespacedKey('work'))!)).toEqual({
      'work:server-a:session-1': { activePresetId: 'translate', viewMode: 'original' },
      'work:server-a:session-2': { activePresetId: null, viewMode: 'original' },
    });
  });

  it('leaves the main space on the plain key it has always used', async () => {
    const plain = { 'main:server-a:session-1': { activePresetId: 'translate', viewMode: 'processed' } };
    writeLegacy(plain);

    const { outputLayerStore: store } = await bootInSpace(null);

    expect(store.getSessionState('main:server-a:session-1')).toEqual(plain['main:server-a:session-1']);
    expect(localStorage.getItem(namespacedKey('main'))).toBeNull();
  });

  it('keeps two homes and two servers apart even for the same session id', async () => {
    writeLegacy({
      'work:server-a:session-1': { activePresetId: 'translate', viewMode: 'processed' },
      'work:server-b:session-1': { activePresetId: 'plain', viewMode: 'processed' },
    });

    const work = (await bootInSpace('work')).outputLayerStore;
    expect(work.getSessionState('work:server-a:session-1').activePresetId).toBe('translate');
    expect(work.getSessionState('work:server-b:session-1').activePresetId).toBe('plain');

    const studio = (await bootInSpace('studio')).outputLayerStore;
    expect(studio.getSessionState('studio:server-a:session-1')).toEqual(DEFAULT_STATE);
    expect(studio.getSessionState('studio:server-b:session-1')).toEqual(DEFAULT_STATE);

    studio.setViewMode('studio:server-a:session-1', 'original');
    expect(JSON.parse(localStorage.getItem(namespacedKey('studio'))!)).toEqual({
      'studio:server-a:session-1': { activePresetId: null, viewMode: 'original' },
    });
  });

  it('never overwrites a value the space already saved', async () => {
    const legacy = { 'work:server-a:session-1': { activePresetId: 'translate', viewMode: 'original' } };
    writeLegacy(legacy);
    const stored = { 'work:server-a:session-1': { activePresetId: 'plain', viewMode: 'processed' } };
    localStorage.setItem(namespacedKey('work'), JSON.stringify(stored));

    const first = (await bootInSpace('work')).outputLayerStore;
    expect(first.getSessionState('work:server-a:session-1')).toEqual(stored['work:server-a:session-1']);
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY)!)).toEqual(legacy);

    // A second boot reads the same answer; the migration is idempotent.
    const second = (await bootInSpace('work')).outputLayerStore;
    expect(second.getSessionState('work:server-a:session-1')).toEqual(stored['work:server-a:session-1']);
  });

  it('restores a remote connection record only for the context that asks for it', async () => {
    const remote = 'remote:conn-1:server-x:session-9';
    const legacy = {
      [remote]: { activePresetId: 'translate', viewMode: 'original' },
      'remote:conn-2:server-x:session-9': { activePresetId: 'plain', viewMode: 'original' },
    };
    writeLegacy(legacy);

    const work = (await bootInSpace('work')).outputLayerStore;
    // A remote id carries no home, so it is not part of the boot merge; the
    // exact live context still reads its own record.
    expect(work.getSessionState(remote)).toEqual(legacy[remote]);
    expect(work.getSessionState('remote:conn-2:server-y:session-9')).toEqual(DEFAULT_STATE);

    work.setViewMode('work:server-a:session-1', 'original');
    const persisted = JSON.parse(localStorage.getItem(namespacedKey('work'))!);
    expect(persisted).toEqual({
      'work:server-a:session-1': { activePresetId: null, viewMode: 'original' },
    });
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY)!)).toEqual(legacy);
  });

  it('reuses the boot migration without rereading storage or exposing another home', async () => {
    const remote = 'remote:conn-1:server-x:session-9';
    writeLegacy({
      [remote]: { activePresetId: 'translate', viewMode: 'original' },
      'studio:server-a:session-1': { activePresetId: 'plain', viewMode: 'original' },
    });
    const work = (await bootInSpace('work')).outputLayerStore;
    const read = vi.spyOn(Storage.prototype, 'getItem');
    try {
      for (let index = 0; index < 100; index++) {
        expect(work.getSessionState(remote)).toEqual({ activePresetId: 'translate', viewMode: 'original' });
        expect(work.getSessionState('studio:server-a:session-1')).toEqual(DEFAULT_STATE);
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('survives unreadable bytes on either side', async () => {
    writeLegacy('{not json');
    const empty = (await bootInSpace('work')).outputLayerStore;
    expect(empty.getSessionState('work:server-a:session-1')).toEqual(DEFAULT_STATE);

    writeLegacy({ 'work:server-a:session-1': { activePresetId: 'translate', viewMode: 'original' } });
    localStorage.setItem(namespacedKey('work'), '[];');
    const recovered = (await bootInSpace('work')).outputLayerStore;
    expect(recovered.getSessionState('work:server-a:session-1')).toEqual({ activePresetId: 'translate', viewMode: 'original' });
  });
});
