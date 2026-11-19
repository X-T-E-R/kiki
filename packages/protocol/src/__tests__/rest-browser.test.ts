import { describe, expect, it } from 'vitest';

import {
  browserCatalogResponseSchema,
  browserConnectionInputSchema,
  browserConnectionSchema,
  browserIdSchema,
} from '../rest/browser';
import {
  browserPresetIdSchema,
  browserSetupConnectInputSchema,
  browserSetupStatusSchema,
  codexBridgeBrowserIdSchema,
} from '../rest/browser-setup';

const hyphenId = 'codex-browser-use-11111111-2222-4333-8444-555555555555';
const slashId = 'codex-browser-use\\11111111-2222-4333-8444-555555555555';

const codexSetupStatus = {
  preset: 'codex-browser' as const,
  displayName: 'Codex / ChatGPT browser extension',
  controlSurface: 'browser-connection' as const,
  state: 'needs_user_action' as const,
  supported: true,
  executionHost: 'test',
  steps: [{ id: 'detect', state: 'user_action' as const, reason: 'choose_connection' }],
  actions: [{ id: 'choose_connection' as const }],
  sourceUrl: 'https://github.com/DeliciousBuding/codex-browser-bridge',
};

describe('browser REST schemas', () => {
  it.each([
    [
      'agent-browser-profile',
      { type: 'agent-browser-profile', name: 'Profile', enabled: true, headed: true },
      { type: 'agent-browser-profile', name: 'Profile', enabled: true, headed: true },
    ],
    [
      'agent-browser-cdp',
      { type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value: 'http://127.0.0.1:9222' } },
      { type: 'agent-browser-cdp', name: 'CDP', enabled: true },
    ],
    [
      'codex-extension',
      { type: 'codex-extension', name: 'Codex', runtimeRoot: 'C:/bridge.exe', browserId: 'pipe' },
      { type: 'codex-extension', name: 'Codex', enabled: true },
    ],
    [
      'ego-lite without endpoint',
      { type: 'ego-lite', name: 'Ego Lite', cliPath: 'C:/Ego/ego-browser.exe', profileId: 'p', serverName: 'desk' },
      { type: 'ego-lite', name: 'Ego Lite', enabled: true, cliPath: 'C:/Ego/ego-browser.exe', profileId: 'p', serverName: 'desk' },
    ],
    [
      'kimi-webbridge',
      { type: 'kimi-webbridge', name: 'edge-kimi', enabled: true },
      { type: 'kimi-webbridge', name: 'edge-kimi', enabled: true },
    ],
    [
      'webbridge-command without endpoint',
      { type: 'webbridge-command', name: 'Kimi browser extension' },
      { type: 'webbridge-command', name: 'Kimi browser extension', enabled: true },
    ],
  ] as const)('accepts connection input for %s', (_label, input, expected) => {
    expect(browserConnectionInputSchema.parse(input)).toMatchObject(expected);
  });

  it.each([
    'http://127.0.0.1:10086',
    'http://127.0.0.1:10086/command',
    'http://127.0.0.1:10086/json/version',
    'http://127.0.0.1:9222/command',
  ])('accepts CDP endpoint URL %s', (value) => {
    expect(
      browserConnectionInputSchema.safeParse({ type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value } }).success,
    ).toBe(true);
  });

  it.each([
    ['ego-lite with endpoint', { type: 'ego-lite', name: 'Ego Lite', endpoint: 'http://127.0.0.1:1' }],
    ['kimi-webbridge with endpoint', { type: 'kimi-webbridge', name: 'edge-kimi', endpoint: { action: 'keep' } }],
    ['webbridge-command with endpoint', { type: 'webbridge-command', name: 'Kimi', endpoint: { action: 'set', value: 'http://127.0.0.1:10086/command' } }],
    ['webbridge-command with driverPath', { type: 'webbridge-command', name: 'Kimi', driverPath: 'C:/driver.exe' }],
    ['CDP file:// endpoint', { type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value: 'file:///private' } }],
  ] as const)('rejects invalid connection input (%s)', (_label, input) => {
    expect(browserConnectionInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { id: 'ego-lite', name: 'Ego Lite', enabled: true, type: 'ego-lite', cliPath: 'C:/Ego/ego-browser.exe' },
    { id: 'kimi-webbridge', name: 'edge-kimi', enabled: true, type: 'kimi-webbridge' },
    { id: 'kimi-webbridge', name: 'Existing CDP', enabled: true, type: 'agent-browser-cdp', endpointDisplay: 'http://127.0.0.1', endpointConfigured: true },
    { id: 'webbridge-command', name: 'Kimi browser extension', enabled: true, type: 'webbridge-command' },
  ] as const)('parses stored connection shape ($type)', (connection) => {
    expect(browserConnectionSchema.parse(connection).type).toBe(connection.type);
  });

  it.each([
    'extension-command-session',
    'main-frame-only',
    'official-extension-tab-ids',
    'opaque-context-through-window',
  ] as const)('projects catalog contextIsolation %s', (contextIsolation) => {
    const parsed = browserCatalogResponseSchema.parse({
      browser: 'webbridge-command',
      status: { browser: 'webbridge-command', state: 'idle', executionHost: 'fixture', generation: 0 },
      backendToolCount: 0,
      contextIsolation,
      capabilities: [],
    });
    expect(parsed.contextIsolation).toBe(contextIsolation);
  });
});

describe('browser setup contracts', () => {
  it('exposes expected preset options and validates Ego Lite CLI choice', () => {
    expect(browserPresetIdSchema.options).toEqual(['kimi-webbridge', 'independent-browser', 'codex-browser', 'ego-lite']);
    const egoStatus = {
      preset: 'ego-lite',
      displayName: 'Ego Lite',
      controlSurface: 'external-app',
      state: 'needs_user_action',
      supported: true,
      executionHost: 'fixture',
      steps: [],
      actions: [{ id: 'connect' }, { id: 'open_instructions', url: 'https://lite.ego.app/download?auto=1', target: 'documentation' }],
      reason: 'ego_choose_cli',
      cliPaths: ['C:/Ego/0.6.0.16/ego-browser.exe', 'C:/Ego/0.6.0.15/ego-browser.exe'],
      sourceUrl: 'https://lite.ego.app/download?auto=1',
    };
    expect(browserSetupStatusSchema.parse(egoStatus).cliPaths).toEqual(egoStatus.cliPaths);
    expect(browserSetupConnectInputSchema.parse({ cliPath: 'C:/Ego/0.6.0.15/ego-browser.exe' })).toEqual({
      cliPath: 'C:/Ego/0.6.0.15/ego-browser.exe',
    });
    expect(browserSetupConnectInputSchema.safeParse({ cliPath: '' }).success).toBe(false);
    expect(browserSetupStatusSchema.safeParse({ ...egoStatus, candidates: [{ browserId: 'C:/Ego/ego-browser.exe' }] }).success).toBe(false);
  });

  it('keeps connectionId as the Kiki id and carries both pipe forms on browserId', () => {
    expect(browserIdSchema.safeParse('codex-browser').success).toBe(true);
    expect(browserIdSchema.safeParse(hyphenId).success).toBe(true);
    expect(browserIdSchema.safeParse(slashId).success).toBe(false);
    expect(codexBridgeBrowserIdSchema.parse(hyphenId)).toBe(hyphenId);
    expect(codexBridgeBrowserIdSchema.parse(slashId)).toBe(slashId);

    expect(browserSetupConnectInputSchema.parse({})).toEqual({});
    expect(browserSetupConnectInputSchema.parse({ connectionId: 'codex-browser', browserId: slashId, setDefault: true })).toEqual({
      connectionId: 'codex-browser',
      browserId: slashId,
      setDefault: true,
    });
    expect(browserSetupConnectInputSchema.safeParse({ connectionId: slashId }).success).toBe(false);
    expect(browserSetupConnectInputSchema.safeParse({ browserId: 'first-pipe' }).success).toBe(false);
  });

  it('projects candidates for Codex and still accepts a status that omits them', () => {
    expect(browserSetupStatusSchema.parse({ ...codexSetupStatus, candidates: [{ browserId: hyphenId }, { browserId: slashId }] }).candidates)
      .toEqual([{ browserId: hyphenId }, { browserId: slashId }]);
    expect(browserSetupStatusSchema.parse(codexSetupStatus).candidates).toBeUndefined();
    expect(browserSetupStatusSchema.safeParse({ ...codexSetupStatus, browserId: slashId }).success).toBe(true);
    expect(browserSetupStatusSchema.safeParse({ ...codexSetupStatus, candidates: [{ browserId: 'first-pipe' }] }).success).toBe(false);
    expect(browserSetupStatusSchema.safeParse({ ...codexSetupStatus, connectionId: slashId }).success).toBe(false);
  });
});
