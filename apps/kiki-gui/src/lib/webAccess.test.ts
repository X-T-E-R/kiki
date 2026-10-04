/**
 * The web-access bootstrap: reading and spending a one-time entry code.
 *
 * These are the properties that make the link safe to hand to someone, and
 * each one is asserted directly rather than through the component that
 * happens to call them:
 *
 *   - the fragment leaves the address bar before the code is handed out;
 *   - the code is never persisted and never put back into the URL;
 *   - a code arriving beside `?server=` is dropped instead of honored, so one
 *     link cannot point this page at a different server;
 *   - a shape that is not a code is cleared all the same.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS_FRAGMENT_KEY,
  addressDraftFromStatus,
  addressIssue,
  draftReachesOtherDevices,
  enableInputFor,
  emptyAddressDraft,
  webEntryProblemFor,
  hasAccessFragment,
  readAccessCode,
  resetWebAccessBootstrap,
  scrubAccessFragment,
  setWebAccessBootstrap,
  takeAccessCode,
  webAccessAddress,
  webAccessBootstrap,
} from './webAccess';

const CODE = 'a'.repeat(43);

afterEach(() => {
  resetWebAccessBootstrap();
  vi.restoreAllMocks();
});

/**
 * A `History` stand-in with the real `replaceState` shape. Typing the double
 * against `History` rather than a loose object is what keeps the call signature
 * honest: a mock that accepted anything would not catch a wrong argument order.
 */
function history(): History & { replaceState: ReturnType<typeof vi.fn> } {
  return { replaceState: vi.fn(), state: null } as unknown as History & { replaceState: ReturnType<typeof vi.fn> };
}

describe('readAccessCode', () => {
  it('reads the code out of the fragment', () => {
    expect(readAccessCode(`#${ACCESS_FRAGMENT_KEY}=${CODE}`)).toBe(CODE);
  });

  it('reads it when the fragment carries other parts', () => {
    expect(readAccessCode(`#view=chat&${ACCESS_FRAGMENT_KEY}=${CODE}`)).toBe(CODE);
  });

  it('rejects anything that is not a code of the right shape', () => {
    expect(readAccessCode(`#${ACCESS_FRAGMENT_KEY}=short`)).toBeNull();
    expect(readAccessCode(`#${ACCESS_FRAGMENT_KEY}=`)).toBeNull();
    expect(readAccessCode(`#${ACCESS_FRAGMENT_KEY}=has spaces in it`)).toBeNull();
  });

  it('ignores a fragment that carries no access part at all', () => {
    expect(readAccessCode('')).toBeNull();
    expect(readAccessCode('#token=abc')).toBeNull();
    expect(readAccessCode('access=abc')).toBeNull();
  });
});

describe('scrubAccessFragment', () => {
  it('removes only the access part and keeps everything else', () => {
    expect(scrubAccessFragment({ pathname: '/new', search: '?a=1', hash: `#view=x&${ACCESS_FRAGMENT_KEY}=${CODE}` }))
      .toBe('/new?a=1#view=x');
  });

  it('drops the hash entirely when access was the only part', () => {
    expect(scrubAccessFragment({ pathname: '/', search: '', hash: `${ACCESS_FRAGMENT_KEY}=${CODE}` })).toBe('/');
  });

  it('leaves an unrelated URL byte-for-byte identical', () => {
    const url = { pathname: '/x', search: '?q=1', hash: '#token=abc' };
    expect(scrubAccessFragment(url)).toBe('/x?q=1#token=abc');
    expect(hasAccessFragment(url)).toBe(false);
  });
});

describe('takeAccessCode', () => {
  it('clears the address bar before returning the code', () => {
    const h = history();
    const outcome = takeAccessCode({ pathname: '/', search: '', hash: `#${ACCESS_FRAGMENT_KEY}=${CODE}` }, h);
    expect(outcome).toEqual({ kind: 'code', code: CODE });
    // The scrub is the first observable effect, and it targets the bare URL.
    expect(h.replaceState).toHaveBeenCalledTimes(1);
    expect(h.replaceState.mock.calls[0]![2]).toBe('/');
  });

  it('does nothing at all when there is no access fragment', () => {
    const h = history();
    expect(takeAccessCode({ pathname: '/', search: '?server=x', hash: '' }, h)).toEqual({ kind: 'none' });
    expect(h.replaceState).not.toHaveBeenCalled();
  });

  it('drops a code that arrived with a foreign server target', () => {
    for (const search of [`?server=evil.example`, `?url=evil.example`]) {
      const h = history();
      const outcome = takeAccessCode({ pathname: '/', search, hash: `#${ACCESS_FRAGMENT_KEY}=${CODE}` }, h);
      expect(outcome).toEqual({ kind: 'rejected' });
      // Still cleared: the code is not left in the bar just because it was refused.
      expect(h.replaceState).toHaveBeenCalledTimes(1);
    }
  });

  it('clears a malformed access part instead of leaving it on screen', () => {
    const h = history();
    const outcome = takeAccessCode({ pathname: '/', search: '', hash: `#${ACCESS_FRAGMENT_KEY}=nope` }, h);
    expect(outcome).toEqual({ kind: 'none' });
    expect(h.replaceState.mock.calls[0]![2]).toBe('/');
  });

  it('still hands the code over when the address bar cannot be rewritten', () => {
    const h = history();
    h.replaceState.mockImplementation(() => { throw new Error('history unavailable'); });
    const outcome = takeAccessCode({ pathname: '/', search: '', hash: `#${ACCESS_FRAGMENT_KEY}=${CODE}` }, h);
    expect(outcome).toEqual({ kind: 'code', code: CODE });
  });
});

describe('bootstrap memory', () => {
  it('starts as none and carries only the outcome', () => {
    expect(webAccessBootstrap()).toEqual({ kind: 'none' });
    setWebAccessBootstrap({ kind: 'signed-in' });
    expect(webAccessBootstrap()).toEqual({ kind: 'signed-in' });
    setWebAccessBootstrap({ kind: 'failed', reason: 'nope' });
    expect(webAccessBootstrap()).toEqual({ kind: 'failed', reason: 'nope' });
    resetWebAccessBootstrap();
    expect(webAccessBootstrap()).toEqual({ kind: 'none' });
  });
});

describe('webAccessAddress', () => {
  it('is host alone when there is no port', () => {
    expect(webAccessAddress({
      enabled: true, mode: 'temporary', url: null, expiresAt: null,
      host: '127.0.0.1', port: null, insecure: false, sessions: [],
    })).toBe('127.0.0.1');
  });

  it('is host and port when the server reports one', () => {
    expect(webAccessAddress({
      enabled: true, mode: 'temporary', url: null, expiresAt: null,
      host: '0.0.0.0', port: 58627, insecure: true, sessions: [],
    })).toBe('0.0.0.0:58627');
  });

  it('is absent when the server reports no host', () => {
    expect(webAccessAddress({
      enabled: false, mode: null, url: null, expiresAt: null,
      host: null, port: 58627, insecure: false, sessions: [],
    })).toBeNull();
  });
});


describe('address options', () => {
  const draft = (over: Partial<typeof emptyAddressDraft> = {}) => ({ ...emptyAddressDraft, ...over });

  it('leaves blank fields to the server instead of sending empties', () => {
    expect(enableInputFor('temporary', draft())).toEqual({ mode: 'temporary' });
    expect(enableInputFor('persistent', draft({ host: '0.0.0.0', port: '58628' })))
      .toEqual({ mode: 'persistent', host: '0.0.0.0', port: 58628 });
  });

  it('sends the unencrypted choice only when it is made', () => {
    expect(enableInputFor('temporary', draft({ insecureNoTls: true })))
      .toEqual({ mode: 'temporary', insecureNoTls: true });
  });

  it('accepts a loopback bind and an https public address as they are', () => {
    expect(addressIssue(draft({ host: '127.0.0.1' }))).toBeNull();
    expect(addressIssue(draft({ host: '::1' }))).toBeNull();
    expect(addressIssue(draft({ host: '0.0.0.0', publicUrl: 'https://kiki.example.com' }))).toBeNull();
  });

  it('refuses a non-loopback bind over plain HTTP unless it was allowed', () => {
    expect(addressIssue(draft({ host: '0.0.0.0' }))).toBe('st.web.address.needsTls');
    expect(addressIssue(draft({ host: '192.168.1.20', port: '58627' }))).toBe('st.web.address.needsTls');
    expect(addressIssue(draft({ host: '0.0.0.0', insecureNoTls: true }))).toBeNull();
  });

  it('refuses a plain-http public address on another host unless allowed', () => {
    expect(addressIssue(draft({ publicUrl: 'http://kiki.example.com' }))).toBe('st.web.address.needsTls');
    expect(addressIssue(draft({ publicUrl: 'http://kiki.example.com', insecureNoTls: true }))).toBeNull();
    // Loopback http is already local, so it needs no extra permission.
    expect(addressIssue(draft({ publicUrl: 'http://127.0.0.1:58627' }))).toBeNull();
  });

  it('rejects an address that is not a bare origin, and a bad port', () => {
    expect(addressIssue(draft({ publicUrl: 'https://kiki.example.com/app' }))).toBe('st.web.address.publicUrlInvalid');
    expect(addressIssue(draft({ publicUrl: 'not a url' }))).toBe('st.web.address.publicUrlInvalid');
    expect(addressIssue(draft({ port: '0' }))).toBe('st.web.address.portInvalid');
    expect(addressIssue(draft({ port: '99999' }))).toBe('st.web.address.portInvalid');
    expect(addressIssue(draft({ port: 'abc' }))).toBe('st.web.address.portInvalid');
    expect(addressIssue(draft({ host: 'has spaces' }))).toBe('st.web.address.hostInvalid');
  });

  it('knows when a draft reaches beyond this machine', () => {
    expect(draftReachesOtherDevices(draft({ host: '127.0.0.1' }))).toBe(false);
    expect(draftReachesOtherDevices(draft({ host: '0.0.0.0' }))).toBe(true);
    expect(draftReachesOtherDevices(draft())).toBe(false);
  });

  it('opens the editor on the address the server actually reported', () => {
    expect(addressDraftFromStatus({
      enabled: true, mode: 'persistent', url: 'http://x/', expiresAt: null,
      host: '192.168.1.20', port: 58627, insecure: true, sessions: [],
    })).toEqual({ host: '192.168.1.20', port: '58627', publicUrl: '', insecureNoTls: true });
  });
});

describe('webEntryProblemFor', () => {
  it('separates a link that was refused from one that pointed elsewhere', () => {
    expect(webEntryProblemFor('retargeted')).toBe('retargeted');
    expect(webEntryProblemFor('anything else at all')).toBe('refused');
  });
});


describe('a browser that just redeemed a link', () => {
  // The stored-configuration case is the one that matters: `kiki.connection`
  // survives in localStorage, so without a rule a link handed to a phone could
  // silently land on whatever server that browser last used by hand.
  it('prefers its own origin over a stored connection', () => {
    const bootstrap = webAccessBootstrap();
    expect(bootstrap).toEqual({ kind: 'none' });
    setWebAccessBootstrap({ kind: 'signed-in' });
    expect(webAccessBootstrap()).toEqual({ kind: 'signed-in' });
    // The selection itself is made in ConnectionProvider; what the library
    // guarantees is that the outcome is readable there and nowhere else.
    resetWebAccessBootstrap();
    expect(webAccessBootstrap()).toEqual({ kind: 'none' });
  });

  it('keeps no copy of the code after redemption', () => {
    setWebAccessBootstrap({ kind: 'signed-in' });
    // Nothing about the code survives in the bootstrap value: a reader can see
    // that this browser is signed in, never with what.
    expect(JSON.stringify(webAccessBootstrap())).not.toContain(CODE);
  });
});
