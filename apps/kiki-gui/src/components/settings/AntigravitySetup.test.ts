import { describe, expect, it } from 'vitest';

import {
  antigravityVersionValid,
  formatAntigravityModelLabel,
  isAntigravityPasteValid,
  isAntigravityProgramReady,
  loginOutcomeKey,
  loginStatusDisplay,
  reduceInstallProgress,
  resolveLoginFlowKind,
  secondsLeft,
  type InstallProgressEvent,
} from './AntigravitySetup';

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

describe('loginOutcomeKey', () => {
  it('translates by message_code and falls back to retryable for older servers', () => {
    expect(loginOutcomeKey({ retryable: true, message_code: 'callback_mismatch' })).toBe('st.antigravity.pasteRetry');
    expect(loginOutcomeKey({ retryable: false, message_code: 'signin_failed' })).toBe('st.antigravity.signInRejected');
    expect(loginOutcomeKey({ retryable: true })).toBe('st.antigravity.pasteRetry');
    expect(loginOutcomeKey({ retryable: false })).toBe('st.antigravity.flowEnded');
  });
});

describe('loginStatusDisplay', () => {
  it('preserves tri-state login including unknown without collapsing to logged_out', () => {
    expect(loginStatusDisplay('unknown', true)).toEqual({
      key: 'st.engines.login.unknown',
      className: 'text-ink-soft',
    });
    expect(loginStatusDisplay('logged_out', true)).toEqual({
      key: 'st.engines.login.logged_out',
      className: 'text-amber-ink',
    });
    expect(loginStatusDisplay('logged_in', true)).toEqual({
      key: 'st.engines.login.logged_in',
      className: '',
    });
  });

  it('shows waiting state when engine binary is not ready regardless of login', () => {
    expect(loginStatusDisplay('unknown', false)).toEqual({
      key: 'st.engines.stepWaiting',
      className: 'text-ink-faint',
    });
    expect(loginStatusDisplay('logged_out', false)).toEqual({
      key: 'st.engines.stepWaiting',
      className: 'text-ink-faint',
    });
  });
});

describe('Antigravity 1.5+ code_paste & model helpers', () => {
  it('resolves code_paste vs loopback_url flow kind cleanly', () => {
    expect(resolveLoginFlowKind({ flow_kind: 'code_paste', redirect_uri: 'https://antigravity.google/oauth-callback' })).toBe('code_paste');
    expect(resolveLoginFlowKind({ flow_kind: 'loopback_url', redirect_uri: 'http://127.0.0.1:9123/oauth' })).toBe('loopback_url');
    expect(resolveLoginFlowKind({ redirect_uri: 'https://antigravity.google/oauth-callback' })).toBe('code_paste');
    expect(resolveLoginFlowKind({ redirect_uri: 'http://127.0.0.1:9123/oauth' })).toBe('loopback_url');
  });

  it('accepts raw authorization codes in code_paste mode and requires http(s) URL in loopback_url mode', () => {
    expect(isAntigravityPasteValid('4/0A-sample-auth-code', 'code_paste')).toBe(true);
    expect(isAntigravityPasteValid('https://antigravity.google/oauth-callback?code=abc', 'code_paste')).toBe(true);
    expect(isAntigravityPasteValid('  ', 'code_paste')).toBe(false);
    expect(isAntigravityPasteValid('4/0A-sample-auth-code', 'loopback_url')).toBe(false);
    expect(isAntigravityPasteValid('http://localhost:9123/oauth2callback?code=abc', 'loopback_url')).toBe(true);
  });

  it('formats entitled model labels preferring label over raw id', () => {
    expect(formatAntigravityModelLabel({ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' })).toBe('Gemini 3.1 Pro');
    expect(formatAntigravityModelLabel({ id: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
  });

  it('treats PATH-only / external CLI installs as ready for sign-in even without a managed active_version', () => {
    expect(isAntigravityProgramReady(undefined, false)).toBe(false);
    expect(isAntigravityProgramReady(undefined, true)).toBe(true);
    expect(isAntigravityProgramReady('external', false)).toBe(true);
    expect(isAntigravityProgramReady('1.5.11', false)).toBe(true);
  });
});
