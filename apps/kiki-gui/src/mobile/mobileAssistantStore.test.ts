// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  assistantScopeTarget,
  clearMobileAssistant,
  MOBILE_ASSISTANT_STORAGE_KEY,
  readMobileAssistant,
  writeMobileAssistant,
} from './mobileAssistantStore';

describe('mobileAssistantStore', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('keeps one binding per space and tracks the most recent one', () => {
    writeMobileAssistant({ spaceKey: 'local', personaId: 'kiki', sessionId: 's-1' });
    writeMobileAssistant({ spaceKey: 'remote:gpu', personaId: 'nia', sessionId: 's-2' });

    expect(readMobileAssistant('local')).toEqual({ spaceKey: 'local', personaId: 'kiki', sessionId: 's-1' });
    expect(readMobileAssistant('remote:gpu')?.sessionId).toBe('s-2');
    expect(readMobileAssistant()).toEqual({ spaceKey: 'remote:gpu', personaId: 'nia', sessionId: 's-2' });

    clearMobileAssistant('remote:gpu');
    expect(readMobileAssistant('remote:gpu')).toBeUndefined();
    expect(readMobileAssistant()).toBeUndefined();
    expect(readMobileAssistant('local')?.personaId).toBe('kiki');
  });

  it('ignores malformed or foreign-version payloads', () => {
    localStorage.setItem(MOBILE_ASSISTANT_STORAGE_KEY, '{"version":2,"bySpace":{"local":{"personaId":"x","sessionId":"y"}}}');
    expect(readMobileAssistant('local')).toBeUndefined();
    localStorage.setItem(MOBILE_ASSISTANT_STORAGE_KEY, 'not json');
    expect(readMobileAssistant()).toBeUndefined();
  });

  it('moves a concrete scope to the computer the assistant started on', () => {
    expect(assistantScopeTarget('main', 'remote:abc')).toBe('remote:abc');
    expect(assistantScopeTarget('remote:abc', 'remote:abc')).toBeUndefined();
    expect(assistantScopeTarget(undefined, 'remote:abc')).toBeUndefined();
  });
});
