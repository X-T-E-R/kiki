import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRestartRequirement,
  markRestartRequired,
  parseAdvancedServerConfig,
  parseExperimentalFlags,
  providerDraftFromCatalog,
  readDesktopPrefs,
  readRestartRequirement,
  readSettings,
  replaceProvider,
  validateDesktopConfigDraft,
  validateProviderDraft,
  validateServerDefaults,
  writeDesktopPrefs,
  type ProviderDraft,
} from './settings';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number { return this.#items.size; }
  clear(): void { this.#items.clear(); }
  getItem(key: string): string | null { return this.#items.get(key) ?? null; }
  key(index: number): string | null { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string): void { this.#items.delete(key); }
  setItem(key: string, value: string): void { this.#items.set(key, value); }
}

const providerDraft = (patch: Partial<ProviderDraft> = {}): ProviderDraft => ({
  id: 'example',
  type: 'openai',
  baseUrl: 'https://api.example.test/v1',
  defaultModel: 'chat',
  apiKey: '',
  clearApiKey: false,
  models: [
    {
      model: 'chat',
      maxContextSize: 128000,
      displayName: 'Example Chat',
      capabilities: ['reasoning'],
      supportEfforts: ['low', 'high'],
    },
  ],
  ...patch,
});

describe('settings persistence and validation', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
    vi.restoreAllMocks();
  });

  it('defaults absent, partial, and malformed storage to safe local values', () => {
    expect(readSettings().closeToTray).toBe(true);
    expect(readDesktopPrefs().closeToTray).toBe(true);

    localStorage.setItem('kiki.settings', JSON.stringify({ sendShortcut: 'invalid', defaultPermissionMode: 'root' }));
    localStorage.setItem('kiki.desktopPrefs', JSON.stringify({ notifications: false }));
    expect(readSettings().sendShortcut).toBe('enter');
    expect(readSettings().defaultPermissionMode).toBe('manual');
    expect(readDesktopPrefs()).toEqual({ notifications: false, closeToTray: true });

    localStorage.setItem('kiki.desktopPrefs', '{not-json');
    expect(readDesktopPrefs().closeToTray).toBe(true);
  });

  it('preserves an explicitly persisted quit choice', () => {
    writeDesktopPrefs({ closeToTray: false });
    expect(readDesktopPrefs().closeToTray).toBe(false);
  });

  it('persists restart-required fields until cleared after a verified restart', () => {
    expect(readRestartRequirement().required).toBe(false);
    markRestartRequired(['subagent']);
    const pending = markRestartRequired(['agents', 'subagent']);
    expect(pending.required).toBe(true);
    expect(pending.fields).toEqual(['subagent', 'agents']);
    expect(readRestartRequirement().changedAt).toBeTypeOf('string');
    clearRestartRequirement();
    expect(readRestartRequirement()).toEqual({ required: false, changedAt: undefined, fields: [] });
  });

  it('rejects invalid server, desktop, provider, and experiment values before writes', () => {
    expect(validateServerDefaults('root')?.key).toBe('val.permissionMode');
    expect(validateServerDefaults('auto')).toBeNull();
    expect(validateDesktopConfigDraft({
      subagentDefaultModel: ' example/chat',
      subagentDefaultEffort: 'high',
      subagentTimeoutMs: 60_000,
      defaultSubagentModel: '',
      defaultSubagentReasoningEffort: '',
      modelCatalogRefreshIntervalMs: 0,
    })?.key).toBe('val.spacesSubagentModel');
    expect(validateDesktopConfigDraft({
      subagentDefaultModel: 'example/chat',
      subagentDefaultEffort: 'high',
      subagentTimeoutMs: 86_400_001,
      defaultSubagentModel: '',
      defaultSubagentReasoningEffort: '',
      modelCatalogRefreshIntervalMs: 0,
    })?.key).toBe('val.timeoutMax');
    expect(validateProviderDraft(providerDraft({ baseUrl: 'file:///secret' }))?.key).toBe('val.baseUrlHttp');
    expect(validateProviderDraft(providerDraft({ apiKey: 'bad\nkey' }))?.key).toBe('val.apiKeyLineBreaks');
    expect(() => parseExperimentalFlags('{"flag":"yes"}')).toThrow('true or false');
    expect(parseExperimentalFlags('{"search_worker":true}')).toEqual({ search_worker: true });
    expect(() => parseAdvancedServerConfig('{"hooks":{}}')).toThrow('JSON array');
    expect(() => parseAdvancedServerConfig('{"unknown":true}')).toThrow('Unsupported');
    expect(parseAdvancedServerConfig('{"hooks":[],"background":{"max":2}}')).toEqual({
      permission: undefined,
      hooks: [],
      services: undefined,
      loop_control: undefined,
      background: { max: 2 },
    });
  });

  it('builds an editable provider draft without ever reading an existing secret', () => {
    const draft = providerDraftFromCatalog(
      {
        id: 'example',
        type: 'openai',
        base_url: 'https://api.example.test/v1',
        default_model: 'example/chat',
        has_api_key: true,
        status: 'connected',
        models: ['example/chat'],
      },
      [{
        provider: 'example',
        model: 'example/chat',
        display_name: 'Example Chat',
        max_context_size: 128000,
        capabilities: ['reasoning'],
        support_efforts: ['high'],
      }],
    );
    expect(draft?.apiKey).toBe('');
    expect(draft?.defaultModel).toBe('chat');
    expect(draft?.models[0]?.model).toBe('chat');
  });

  it('uses the provider PUT wire and omits a blank write-once secret', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.method).toBe('PUT');
      expect(body['api_key']).toBeUndefined();
      expect(body['models']).toEqual([
        expect.objectContaining({ model: 'chat', max_context_size: 128000 }),
      ]);
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          provider: {
            id: 'example',
            type: 'openai',
            has_api_key: true,
            status: 'connected',
            models: ['example/chat'],
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const saved = await replaceProvider(
      { url: 'http://127.0.0.1:8080', token: 'token' },
      'example',
      providerDraft(),
    );
    expect(saved.id).toBe('example');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends an explicit empty API key only when the user chooses clear', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body['api_key']).toBe('');
      return new Response(JSON.stringify({
        code: 0,
        msg: 'success',
        data: { provider: { id: 'example', type: 'openai', has_api_key: false, status: 'unconfigured' } },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await replaceProvider(
      { url: 'http://127.0.0.1:8080', token: 'token' },
      'example',
      providerDraft({ clearApiKey: true }),
    );
  });
});
