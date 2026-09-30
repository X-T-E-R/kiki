import { describe, expect, it } from 'vitest';

import { antigravityVersionValid, secondsLeft } from './AntigravitySetup';

describe('antigravityVersionValid', () => {
  it('accepts 1.x releases only', () => {
    expect(antigravityVersionValid('1.2.1')).toBe(true);
    expect(antigravityVersionValid(' 1.10.0 ')).toBe(true);
    expect(antigravityVersionValid('1.107')).toBe(false);
    expect(antigravityVersionValid('2.0.0')).toBe(false);
    expect(antigravityVersionValid('latest')).toBe(false);
  });
});

describe('secondsLeft', () => {
  it('counts down and stops at zero', () => {
    expect(secondsLeft({ startedAt: 0, expires_in_secs: 300 }, 0)).toBe(300);
    expect(secondsLeft({ startedAt: 0, expires_in_secs: 300 }, 299_500)).toBe(1);
    expect(secondsLeft({ startedAt: 0, expires_in_secs: 300 }, 400_000)).toBe(0);
  });
});
