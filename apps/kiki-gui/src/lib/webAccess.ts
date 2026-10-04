/**
 * Web access, GUI side: the link this machine hands out, and the browser side
 * that redeems one.
 *
 * Two directions, deliberately separate:
 *
 *   The owner (this window) manages the entry point with the local-owner
 *   connection it already has: status, enable, disable, issue a link, revoke a
 *   browser. Nothing here invents a second credential — a web link is a
 *   property of the same Kiki, not a new account.
 *
 *   A browser arriving with `#access=<one-time code>` redeems that code against
 *   its own origin and receives an HttpOnly cookie. The code is read at the
 *   earliest possible moment and the fragment is cleared immediately, so it is
 *   never left in the address bar, in history, or in a referrer. There is no
 *   long-lived secret in JavaScript: the redeemed session lives in a cookie the
 *   page cannot read, and `current()` reports whether it is still good.
 *
 * The redemption path never carries the code anywhere but the current origin.
 * A `#access=` code arriving alongside `?server=` is ignored outright: a link
 * that could retarget the Web UI at another host is not an entry link.
 */

import { useQuery } from '@tanstack/react-query';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { WebAccessEnableInput, WebAccessLink, WebAccessSession, WebAccessStatus } from '@kiki/protocol';

import type { KikiClient } from './client';

/**
 * The control surface, named here rather than imported: `@kiki/klient/http`
 * re-exports `HttpRestFacade` (whose `webAccess` member is typed) but not the
 * facade type on its own, and that barrel belongs to the core slice. This is
 * the same shape the transport already provides — no second definition of the
 * contract is being made, only a local handle on it.
 */
export type WebAccessFacade = NonNullable<KikiClient['klient']['rest']>['webAccess'];

/** The fragment key a generated entry link carries. */
export const ACCESS_FRAGMENT_KEY = 'access';

/** The two ways an entry can be left open. */
export type Mode = 'temporary' | 'persistent';

const ACCESS_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export const webAccessKeys = {
  all: ['web-access'] as const,
  status: () => [...webAccessKeys.all, 'status'] as const,
  session: () => [...webAccessKeys.all, 'session'] as const,
};

/**
 * The web-access control surface. Only the local/control client may own this;
 * a remote space has its own server and its own entry point.
 */
export function webAccessApi(client: KikiClient): WebAccessFacade {
  const rest = client.klient.rest;
  if (rest === undefined) throw new Error('Web access needs an HTTP connection to the server.');
  return rest.webAccess;
}

// ---------------------------------------------------------------------------
// The owner's view.
// ---------------------------------------------------------------------------

/**
 * The entry point as the server really has it. `enabled` is what is in effect;
 * a saved-but-not-listening state is reported by the server as not enabled, and
 * this reads the echo of every write rather than assuming its own.
 */
export function useWebAccessStatus(client: KikiClient | null) {
  return useQuery({
    queryKey: webAccessKeys.status(),
    queryFn: async () => {
      if (client === null) throw new Error('The local control connection is not ready.');
      return webAccessApi(client).status();
    },
    enabled: client !== null,
    refetchInterval: 6_000,
    staleTime: 3_000,
  });
}

// ---------------------------------------------------------------------------
// The browser's view.
// ---------------------------------------------------------------------------

/**
 * This browser's own web session, if it holds one. Polled because a browser
 * session can end without this page doing anything: the owner turns the entry
 * point off, the temporary window closes, or the service restarts.
 */
export function useWebAccessSession(client: KikiClient | null) {
  return useQuery({
    queryKey: webAccessKeys.session(),
    queryFn: async () => {
      if (client === null) throw new Error('The browser connection is not ready.');
      return webAccessApi(client).current();
    },
    enabled: client !== null,
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Reading and clearing the one-time code.
// ---------------------------------------------------------------------------

export type AccessCodeRead =
  /** A code was present, has been taken out of the URL, and is ready to redeem. */
  | { readonly kind: 'code'; readonly code: string }
  /**
   * A code arrived next to a `?server=` / `?url=` target. Honoring it would
   * let one link point this page at a different server; it is dropped, and the
   * fragment is cleared either way.
   */
  | { readonly kind: 'rejected' }
  /** Nothing to redeem. */
  | { readonly kind: 'none' };

/**
 * Take the one-time code out of the URL fragment.
 *
 * The fragment is cleared by the caller *before* any network call, and the
 * code is returned to memory only — it is never written to storage, never put
 * back in the address bar, and never sent anywhere but this origin.
 */
export function readAccessCode(hash: string): string | null {
  if (!hash.startsWith('#')) return null;
  const raw = hash.slice(1);
  for (const part of raw.split('&')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator);
    if (name !== ACCESS_FRAGMENT_KEY) continue;
    let value = part.slice(separator + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // A malformed escape is still a string; the shape check rejects it.
    }
    return ACCESS_CODE_PATTERN.test(value) ? value : null;
  }
  return null;
}

/** The URL this page should show once the code has been taken out of it. */
export function scrubAccessFragment(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  // `location.hash` carries a leading '#', but a fragment handed to this
  // function may not; both forms are scrubbed so no caller can leave a code
  // behind by passing the raw value.
  const prefixed = location.hash.startsWith('#');
  const parts = (prefixed ? location.hash.slice(1) : location.hash).split('&');
  const kept = parts.filter((part) => !part.startsWith(`${ACCESS_FRAGMENT_KEY}=`));
  const hash = kept.length === parts.length
    ? location.hash
    : kept.length === 0 || (kept.length === 1 && kept[0] === '')
      ? ''
      : `#${kept.join('&')}`;
  return `${location.pathname}${location.search}${hash}`;
}

export function hasAccessFragment(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): boolean {
  const raw = location.hash.startsWith('#') ? location.hash : (location.hash === '' ? '' : `#${location.hash}`);
  return readAccessFragmentName(raw) !== null;
}

function readAccessFragmentName(hash: string): string | null {
  if (hash === '' || hash === '#') return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  return body.split('&').some((part) => part.startsWith(`${ACCESS_FRAGMENT_KEY}=`))
    ? ACCESS_FRAGMENT_KEY
    : null;
}

export type AccessCodeOutcome =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'none' };

/**
 * Read and immediately clear the one-time code.
 *
 * Order matters and is the whole point of this function: the fragment is
 * removed from the address bar by `replaceState` first, and only then is the
 * code handed out. A crash or a hang between the two leaves a code that is no
 * longer in the URL.
 *
 * To be exact about what that does and does not do: it removes the code from
 * this page. It does not invalidate it. The code is spent only when the server
 * exchanges it, and a code that is never exchanged is spent when the server
 * expires it. So the property this ordering buys is narrow and worth naming
 * honestly — the secret is out of the address bar, the referrer, and the
 * history entry, so a later read of the URL cannot replay it. Whether it can
 * still be redeemed is entirely the server's answer, and this function does not
 * claim otherwise.
 */
export function takeAccessCode(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): AccessCodeOutcome {
  const params = new URLSearchParams(location.search);
  const hasForeignTarget = params.has('server') || params.has('url');
  if (!hasAccessFragment(location)) return { kind: 'none' };
  const code = readAccessCode(location.hash);
  const scrubbed = scrubAccessFragment(location);
  try {
    history.replaceState(history.state ?? null, '', scrubbed);
  } catch {
    // A history failure must not block sign-in; the code is still spent either
    // way and the redemption is a one-time exchange.
  }
  if (hasForeignTarget) return { kind: 'rejected' };
  return code === null ? { kind: 'none' } : { kind: 'code', code };
}

/**
 * Ask the server whether this browser already holds a web session.
 *
 * The one-time code is spent on the first load, so a refresh or a later visit
 * has nothing to redeem and must be recognized by the cookie the exchange left
 * behind. The answer is the server's, asked with no credential of our own; a
 * `false` here is a normal outcome, not an error, and it is what lets a browser
 * that never had a session fall through to the ordinary connect path.
 */
export async function claimWebCookie(onClaimed: (claimed: boolean) => void): Promise<void> {
  if (typeof window === 'undefined') return onClaimed(false);
  try {
    const response = await fetch('/api/web-access/session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return onClaimed(false);
    const payload = (await response.json()) as { data?: { authenticated?: unknown } };
    onClaimed(payload.data?.authenticated === true);
    return;
  } catch {
    // No answer is not a claim. The connect screen is the honest fallback.
    onClaimed(false);
  }
}

/**
 * Redeem a one-time code for this browser's session.
 *
 * Same origin only. The response cookie is HttpOnly, so nothing learned here
 * can be replayed from JavaScript, and the call is skipped past auth because
 * the browser has nothing to authenticate with yet.
 */
export async function redeemAccessCode(
  client: KikiClient,
  code: string,
  label?: string,
): Promise<WebAccessSession> {
  return webAccessApi(client).exchange(label === undefined ? { code } : { code, label });
}

// ---------------------------------------------------------------------------
// The bootstrap, carried in memory from the address bar to the app.
// ---------------------------------------------------------------------------

/**
 * What happened between opening a link and rendering the app.
 *
 * This is module memory on purpose. The one-time code is read at the earliest
 * possible moment, redeemed, and then dropped: it is never stored, never
 * re-read from the URL, and never written to `localStorage`, so a refresh, a
 * second tab, or a later visit cannot replay it. What survives is the fact
 * that this browser is now signed in — a fact the server can be asked about at
 * any time, and the only fact the app needs to decide how to connect.
 */
export type WebAccessBootstrap =
  /** No link was opened; behave exactly as before. */
  | { readonly kind: 'none' }
  /** A code was redeemed and this browser now holds a session cookie. */
  | { readonly kind: 'signed-in' }
  /** A link was opened but the code could not be redeemed. */
  | { readonly kind: 'failed'; readonly reason: string };

let bootstrap: WebAccessBootstrap = { kind: 'none' };

export function webAccessBootstrap(): WebAccessBootstrap {
  return bootstrap;
}

/**
 * Test seam and single writer for the bootstrap result.
 *
 * `resetWebAccessBootstrap` exists so a suite can start from a browser that has
 * never seen a link; production code only ever calls `setWebAccessBootstrap`.
 */
export function setWebAccessBootstrap(next: WebAccessBootstrap): void {
  bootstrap = next;
}

export function resetWebAccessBootstrap(): void {
  bootstrap = { kind: 'none' };
}

/**
 * Why a link did not put this browser into the Kiki, as far as this page can
 * tell. The server's own reason is deliberately not passed through: it can name
 * internal conditions, and all a person can act on is "get a new link".
 */
export type WebEntryProblem = 'refused' | 'retargeted';

export function webEntryProblemFor(reason: string): WebEntryProblem {
  return reason === 'retargeted' ? 'retargeted' : 'refused';
}

// ---------------------------------------------------------------------------
// What the entry point really looks like from here.
// ---------------------------------------------------------------------------

/** `192.168.1.20:58627` — an address a person can type on another machine. */
export function webAccessAddress(status: WebAccessStatus): string | null {
  if (status.host === null) return null;
  return status.port === null ? status.host : `${status.host}:${status.port}`;
}

/**
 * The link to hand over, from the server's own answer. A temporary entry point
 * is a full address; a persistent one carries no secret, so the base URL is
 * enough and a device that has visited before keeps working.
 */
export function entryUrl(status: WebAccessStatus): string | null {
  if (!status.enabled || status.url === null) return null;
  return status.url;
}

/** A one-time link as issued, which carries the code in its fragment. */
export function issuedLinkText(link: WebAccessLink): string {
  return link.url;
}

export type WebAccessFailure =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'raw'; readonly text: string };

// ---------------------------------------------------------------------------
// Where the entry can be reached, before it is opened.
// ---------------------------------------------------------------------------

/**
 * The address options, as typed. These are the fields of the enable contract —
 * nothing here invents a network model of its own. A blank host or port means
 * "let the server decide", and the server's own answer (in the status echo) is
 * what the card then shows, so the address a person copies is always the one
 * that is actually listening rather than the one they typed.
 */
export interface WebAccessAddressDraft {
  readonly host: string;
  readonly port: string;
  readonly publicUrl: string;
  readonly insecureNoTls: boolean;
}

export const emptyAddressDraft: WebAccessAddressDraft = {
  host: '', port: '', publicUrl: '', insecureNoTls: false,
};

/** The draft a currently-open entry implies, so reopening the fold starts true. */
export function addressDraftFromStatus(status: WebAccessStatus): WebAccessAddressDraft {
  return {
    host: status.host ?? '',
    port: status.port === null ? '' : String(status.port),
    publicUrl: '',
    insecureNoTls: status.insecure,
  };
}

const HOST_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === 'localhost' || value === '::1' || value === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Check the address the same way the listener does, so the refusal arrives
 * while typing instead of as a failed write.
 *
 * The listener's rule is not a policy of this UI: a non-loopback bind is
 * refused unless the traffic is encrypted, either by an https `publicUrl` in
 * front of it or by the person explicitly accepting plain HTTP. Mirroring it
 * here is what makes the `insecure-no-tls` box appear exactly when it is
 * needed, instead of after a round trip.
 */
export function addressIssue(draft: WebAccessAddressDraft): I18nKey | null {
  const host = draft.host.trim();
  if (host !== '' && !HOST_PATTERN.test(host)) return 'st.web.address.hostInvalid';

  const port = draft.port.trim();
  if (port !== '') {
    if (!/^\d{1,5}$/.test(port)) return 'st.web.address.portInvalid';
    const value = Number(port);
    if (value < 1 || value > 65535) return 'st.web.address.portInvalid';
  }

  const publicUrl = draft.publicUrl.trim();
  if (publicUrl !== '') {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      return 'st.web.address.publicUrlInvalid';
    }
    // The listener accepts a bare origin only.
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '' ||
        (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') {
      return 'st.web.address.publicUrlInvalid';
    }
  }

  if (host !== '' && !isLoopbackHost(host)) {
    const encrypted = publicUrl !== '' && publicUrl.toLowerCase().startsWith('https://');
    if (!encrypted && !draft.insecureNoTls) return 'st.web.address.needsTls';
  }
  if (publicUrl !== '' && publicUrl.toLowerCase().startsWith('http://') && !isLoopbackHost(new URL(publicUrl).hostname) &&
      !draft.insecureNoTls) {
    return 'st.web.address.needsTls';
  }
  return null;
}

/** The enable input for a draft, with blank fields left to the server. */
export function enableInputFor(mode: Mode, draft: WebAccessAddressDraft): WebAccessEnableInput {
  const host = draft.host.trim();
  const port = draft.port.trim();
  const publicUrl = draft.publicUrl.trim();
  return {
    mode,
    ...(host === '' ? {} : { host }),
    ...(port === '' ? {} : { port: Number(port) }),
    ...(publicUrl === '' ? {} : { publicUrl }),
    ...(draft.insecureNoTls ? { insecureNoTls: true } : {}),
  };
}

/** Whether this draft asks for a bind other devices could reach. */
export function draftReachesOtherDevices(draft: WebAccessAddressDraft): boolean {
  const host = draft.host.trim();
  return host !== '' && !isLoopbackHost(host);
}

/**
 * Why an action did not happen, in the person's terms. The server answers with
 * a short code; anything unrecognized passes through as the raw text rather
 * than being flattened into a generic failure.
 */
export function webAccessFailureText(message: string): string | null {
  const needles = [
    'web_access_disabled',
    'web_access_already_enabled',
    'tls_required',
    'insecure_not_allowed',
    'public_url_required',
    'port_in_use',
    'local_owner_required',
  ];
  return needles.some((needle) => message.includes(needle)) ? message : null;
}
