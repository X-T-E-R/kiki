import { describe, expect, it } from 'vitest';

import { antigravityVersionValid, reduceInstallProgress, secondsLeft, type InstallProgressEvent } from './AntigravitySetup';

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

describe('reduceInstallProgress', () => {
  const tag = { installId: 'i1', version: '1.2.1' } as const;
  const run = (events: readonly InstallProgressEvent[], version: string | null = '1.2.1') =>
    events.reduce<ReturnType<typeof reduceInstallProgress>>((state, event) => reduceInstallProgress(state, event, version), null);

  it('follows download bytes, then unpack and activate, and clears on done', () => {
    expect(run([{ ...tag, stage: 'download', receivedBytes: 0, totalBytes: 100 }, { ...tag, stage: 'download', receivedBytes: 40, totalBytes: 100 }]))
      .toEqual({ installId: 'i1', stage: 'download', receivedBytes: 40, totalBytes: 100 });
    expect(run([{ ...tag, stage: 'download', receivedBytes: 100, totalBytes: 100 }, { ...tag, stage: 'extract' }]))
      .toMatchObject({ stage: 'extract', receivedBytes: 100, totalBytes: 100 });
    expect(run([{ ...tag, stage: 'extract' }, { ...tag, stage: 'activate' }])).toMatchObject({ stage: 'activate' });
    expect(run([{ ...tag, stage: 'activate' }, { ...tag, stage: 'done' }])).toBeNull();
    expect(run([{ ...tag, stage: 'download', receivedBytes: 5 }, { ...tag, stage: 'failed', error: 'x', timedOut: true }])).toBeNull();
  });

  it('ignores another version and anything while no install is running', () => {
    expect(run([{ ...tag, version: '1.3.0', stage: 'download', receivedBytes: 1 }])).toBeNull();
    expect(run([{ ...tag, stage: 'download', receivedBytes: 1 }], null)).toBeNull();
  });

  it('keeps the current bar when a stale install ends', () => {
    expect(run([{ ...tag, stage: 'download', receivedBytes: 7 }, { installId: 'old', version: '1.2.1', stage: 'done' }]))
      .toMatchObject({ installId: 'i1', receivedBytes: 7 });
  });
});
