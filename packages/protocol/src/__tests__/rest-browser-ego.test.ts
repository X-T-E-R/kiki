import { describe, expect, it } from 'vitest';

import { browserConnectionInputSchema, browserConnectionSchema } from '../rest/browser';
import { browserPresetIdSchema } from '../rest/browser-setup';

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
});
