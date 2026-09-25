import { describe, expect, it } from 'vitest';

import { activityPollInterval } from './ActivityPanel';

describe('ActivityPanel busy-session polling', () => {
  it('retains the 5-second cadence for one or two sessions and backs off as load grows', () => {
    expect(activityPollInterval(1)).toBe(5_000);
    expect(activityPollInterval(2)).toBe(5_000);
    expect(activityPollInterval(3)).toBe(10_000);
    expect(activityPollInterval(5)).toBe(10_000);
    expect(activityPollInterval(6)).toBe(15_000);
    expect(activityPollInterval(20)).toBe(15_000);
  });
});
