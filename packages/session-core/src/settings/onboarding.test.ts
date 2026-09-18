// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  isOnboardingCompleted,
  markOnboardingCompleted,
  readOnboardingState,
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
