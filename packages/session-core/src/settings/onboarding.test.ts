// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  isOnboardingCompleted,
  markOnboardingCompleted,
  readOnboardingState,
  rememberOnboardingReplyPreference,
} from './onboarding';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number { return this.#items.size; }
  clear(): void { this.#items.clear(); }
  getItem(key: string): string | null { return this.#items.get(key) ?? null; }
  key(index: number): string | null { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string): void { this.#items.delete(key); }
  setItem(key: string, value: string): void { this.#items.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
});

function ls(): Storage {
  return globalThis.localStorage as Storage;
}

describe('onboarding completion flag', () => {
  it('starts incomplete when nothing is stored', () => {
    expect(readOnboardingState().completedAt).toBeUndefined();
    expect(isOnboardingCompleted()).toBe(false);
  });

  it('marks completion with a timestamp that survives a re-read', () => {
    const state = markOnboardingCompleted();
    expect(state.completedAt).toBeTypeOf('string');
    expect(isOnboardingCompleted()).toBe(true);
    expect(readOnboardingState().completedAt).toBe(state.completedAt);
    expect(ls().getItem('kiki.onboarding')).toContain('completedAt');
  });

  it('preserves the reply memory identity when setup is closed and reopened', () => {
    rememberOnboardingReplyPreference('https://example.test', 'm_reply');
    expect(isOnboardingCompleted()).toBe(false);
    markOnboardingCompleted();
    expect(readOnboardingState().replyPreference).toEqual({ connectionUrl: 'https://example.test', memoryId: 'm_reply' });
    rememberOnboardingReplyPreference('https://other.example.test', 'm_other');
    expect(isOnboardingCompleted()).toBe(true);
    expect(readOnboardingState().replyPreference).toEqual({ connectionUrl: 'https://other.example.test', memoryId: 'm_other' });
  });

  it('does not trust a malformed reply memory pointer', () => {
    ls().setItem('kiki.onboarding', JSON.stringify({ replyPreference: { connectionUrl: 'https://example.test', memoryId: 42 } }));
    expect(readOnboardingState().replyPreference).toBeUndefined();
  });

  it('treats corrupt or shapeless stored values as incomplete', () => {
    ls().setItem('kiki.onboarding', 'not json');
    expect(isOnboardingCompleted()).toBe(false);
    ls().setItem('kiki.onboarding', JSON.stringify(['completedAt']));
    expect(isOnboardingCompleted()).toBe(false);
    ls().setItem('kiki.onboarding', JSON.stringify({ completedAt: '' }));
    expect(isOnboardingCompleted()).toBe(false);
    ls().setItem('kiki.onboarding', JSON.stringify({ completedAt: 42 }));
    expect(isOnboardingCompleted()).toBe(false);
  });
});
