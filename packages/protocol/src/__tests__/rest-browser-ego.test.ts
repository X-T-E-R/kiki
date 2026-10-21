import { describe, expect, it } from 'vitest';

import { browserConnectionInputSchema, browserConnectionSchema } from '../rest/browser';
import { browserPresetIdSchema, browserSetupConnectInputSchema, browserSetupStatusSchema } from '../rest/browser-setup';

describe('ego-lite browser connection', () => {
  it('keeps the older connection types and accepts ego-lite without an endpoint', () => {
    expect(browserConnectionInputSchema.parse({ type: 'agent-browser-profile', name: 'Profile', enabled: true, headed: true })).toMatchObject({ type: 'agent-browser-profile' });
    expect(browserConnectionInputSchema.parse({ type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value: 'http://127.0.0.1:9222' } })).toMatchObject({ type: 'agent-browser-cdp' });
    expect(browserConnectionInputSchema.parse({ type: 'codex-extension', name: 'Codex', runtimeRoot: 'C:/bridge.exe', browserId: 'pipe' })).toMatchObject({ type: 'codex-extension' });
    const ego = browserConnectionInputSchema.parse({ type: 'ego-lite', name: 'Ego Lite', cliPath: 'C:/Ego/ego-browser.exe', profileId: 'p', serverName: 'desk' });
    expect(ego).toEqual({ type: 'ego-lite', name: 'Ego Lite', enabled: true, cliPath: 'C:/Ego/ego-browser.exe', profileId: 'p', serverName: 'desk' });
    expect(browserConnectionInputSchema.safeParse({ type: 'ego-lite', name: 'Ego Lite', endpoint: 'http://127.0.0.1:1' }).success).toBe(false);
    expect(browserConnectionSchema.parse({ id: 'ego-lite', name: 'Ego Lite', enabled: true, type: 'ego-lite', cliPath: 'C:/Ego/ego-browser.exe' }).type).toBe('ego-lite');
    expect(browserPresetIdSchema.parse('ego-lite')).toBe('ego-lite');
    expect(browserPresetIdSchema.options).toEqual(['kimi-webbridge', 'independent-browser', 'codex-browser', 'ego-lite']);
  });

  it('carries an Ego Lite CLI choice on setup status and connect input', () => {
    const status = browserSetupStatusSchema.parse({
      preset: 'ego-lite', displayName: 'Ego Lite', controlSurface: 'external-app',
      state: 'needs_user_action', supported: true, executionHost: 'fixture', steps: [],
      actions: [{ id: 'connect' }, { id: 'open_instructions', url: 'https://lite.ego.app/download?auto=1', target: 'documentation' }],
      reason: 'ego_choose_cli',
      cliPaths: ['C:/Ego/0.6.0.16/ego-browser.exe', 'C:/Ego/0.6.0.15/ego-browser.exe'],
      sourceUrl: 'https://lite.ego.app/download?auto=1',
    });
    expect(status.cliPaths).toEqual(['C:/Ego/0.6.0.16/ego-browser.exe', 'C:/Ego/0.6.0.15/ego-browser.exe']);
    expect(browserSetupConnectInputSchema.parse({ cliPath: 'C:/Ego/0.6.0.15/ego-browser.exe' })).toEqual({ cliPath: 'C:/Ego/0.6.0.15/ego-browser.exe' });
    expect(browserSetupConnectInputSchema.safeParse({ cliPath: '' }).success).toBe(false);
    expect(browserSetupStatusSchema.safeParse({
      ...status, candidates: [{ browserId: 'C:/Ego/ego-browser.exe' }],
    }).success).toBe(false);
  });
});
