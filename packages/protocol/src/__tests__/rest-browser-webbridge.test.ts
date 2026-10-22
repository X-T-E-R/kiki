import { describe, expect, it } from 'vitest';

import { browserConnectionInputSchema, browserConnectionSchema } from '../rest/browser';
import { browserPresetIdSchema } from '../rest/browser-setup';

describe('webbridge command browser connection', () => {
  it('accepts the command type without an endpoint and still accepts CDP addresses', () => {
    expect(browserConnectionInputSchema.parse({ type: 'webbridge-command', name: 'Kimi browser extension' })).toEqual({
      type: 'webbridge-command', name: 'Kimi browser extension', enabled: true,
    });
    expect(browserConnectionInputSchema.safeParse({ type: 'webbridge-command', name: 'Kimi', endpoint: { action: 'set', value: 'http://127.0.0.1:10086/command' } }).success).toBe(false);
    expect(browserConnectionInputSchema.safeParse({ type: 'webbridge-command', name: 'Kimi', driverPath: 'C:/driver.exe' }).success).toBe(false);
    for (const value of ['http://127.0.0.1:10086', 'http://127.0.0.1:10086/command', 'http://127.0.0.1:10086/json/version', 'http://127.0.0.1:9222/command']) {
      expect(browserConnectionInputSchema.safeParse({ type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value } }).success).toBe(true);
    }
    expect(browserConnectionInputSchema.safeParse({ type: 'agent-browser-cdp', name: 'CDP', endpoint: { action: 'set', value: 'file:///private' } }).success).toBe(false);
    expect(browserConnectionSchema.parse({ id: 'webbridge-command', name: 'Kimi browser extension', enabled: true, type: 'webbridge-command' }).type).toBe('webbridge-command');
    expect(browserConnectionSchema.parse({ id: 'kimi-webbridge', name: 'edge-kimi', enabled: true, type: 'agent-browser-cdp', endpointConfigured: true }).type).toBe('agent-browser-cdp');
    expect(browserPresetIdSchema.options).toEqual(['kimi-webbridge', 'independent-browser', 'codex-browser', 'ego-lite']);
  });
});
