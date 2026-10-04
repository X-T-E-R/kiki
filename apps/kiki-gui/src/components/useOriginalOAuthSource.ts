/**
 * Choosing where a connection's sign-in comes from.
 *
 * Kiki can hold a credential of its own, or point at the sign-in the original
 * vendor's own app already has on this machine. The second is a *reuse*, not a
 * copy: Kiki renews it near expiry and adapts whatever the machine keeps it in
 * (a file, the system keyring, an encrypted store). Nothing here runs the other
 * app, and nothing here reads its token — the server reports what it found.
 *
 * "This machine" is the machine Kiki's server runs on, which is not always the
 * machine you are looking at. So the directory is a real input: the default is
 * probed, and pointing at a different one is an ordinary thing to do when the
 * server is elsewhere.
 *
 * The order is fixed and is the whole point of this module: **probe, then
 * connect.** A probe says which account is on the other side; the connect
 * carries that account's id back, so a credential that was replaced in between
 * is refused instead of being quietly adopted. Changing the directory or the
 * account therefore invalidates what was probed, and a stale result is never
 * offered as the thing to connect to.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { OriginalOAuthProbe, OriginalOAuthRequest } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import type { Feedback } from './controls';

/** The two methods whose original sign-in on the machine can be reused. */
export type OriginalProvider = OriginalOAuthRequest['provider'];

/** Why a probe cannot become a connection, in the terms a person can act on. */
export type OriginalSourceBlock =
  | 'noAccount'
  | 'unsupported'
  | 'unreadable'
  | 'signedOut'
  | 'accountChanged'
  | 'refreshFailed';

export interface OriginalSourceController {
  /** The directory currently being probed; empty means the default. */
  readonly homeDir: string;
  /** Set a different server directory to probe. Empty returns to the default. */
  readonly setHomeDir: (value: string) => void;
  /** True while the first probe for this method is still out. */
  readonly probing: boolean;
  /** The last probe that matches what is on screen, or null. */
  readonly probe: OriginalOAuthProbe | null;
  /**
   * Why this probe cannot be connected, or null when it can. A missing account,
   * an unsupported provider and a stale one are different problems with
   * different fixes, so they are told apart — but only the actionable ones.
   */
  readonly blocked: OriginalSourceBlock | null;
  /** Read the machine's own sign-in. Safe to repeat; changes nothing. */
  readonly probeOriginal: () => Promise<void>;
  /** Attach the connection to the account the probe just reported. */
  readonly connectOriginal: () => Promise<void>;
  /**
   * Let go of the machine's sign-in. This drops Kiki's reference and the models
   * it provisioned, and nothing else: the vendor's own sign-in is still there
   * and that app is untouched. Present only while the connection is actually
   * attached to it, so it can never be offered for a Kiki-held credential.
   */
  readonly detachLocalOriginal: (() => Promise<void>) | undefined;
  /** True while the connect call is out. */
  readonly connecting: boolean;
  /** The outcome of the last connect attempt, for the row to read back. */
  readonly feedback: Feedback;
}

/**
 * Why a state is not a usable credential, in terms a person can act on.
 * `ready` and `refresh_required` are both usable — the second just means Kiki
 * renews it first, which is the normal course for a credential this old.
 *
 * The state is read before `can_connect`, because that flag alone would flatten
 * "the account on the machine changed" and "Kiki cannot read the file" into one
 * sentence — and those two need opposite responses. The flag is kept as a floor
 * so a state this module has not heard of is still treated as a refusal.
 *
 * Takes the three facts rather than a probe, because a connection that is
 * already attached has the same state without a fresh check to read it from.
 */
export function originalStateBlock(
  state: OriginalOAuthProbe['state'],
  accountKnown: boolean,
  canConnect: boolean,
): OriginalSourceBlock | null {
  if (state === 'account_changed') return 'accountChanged';
  if (state === 'refresh_failed') return 'refreshFailed';
  if (state === 'unsupported') return 'unsupported';
  if (state === 'unreadable') return 'unreadable';
  if (state === 'signed_out') return 'signedOut';
  if (!canConnect) return accountKnown ? 'unreadable' : 'noAccount';
  // `ready` and `refresh_required`: usable, and deliberately not phrased as a
  // problem.
  return null;
}

export function originalSourceBlock(probe: OriginalOAuthProbe | null): OriginalSourceBlock | null {
  if (probe === null) return null;
  return originalStateBlock(probe.state, probe.account.state === 'known', probe.can_connect);
}

/** The account a connect may attach to, or null when there is none to attach. */
export function originalAccountId(probe: OriginalOAuthProbe | null): string | null {
  if (probe === null || probe.account.state !== 'known') return null;
  return probe.account.id;
}

export function useOriginalOAuthSource(
  methodId: OriginalProvider,
  attached: boolean,
  onChanged?: () => Promise<void> | void,
  attachedHomeDir?: string,
): OriginalSourceController {
  const { client, scopeId } = useConnection();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  // A directory edit belongs to this client's connection, not the next server
  // or method. Recovery starts in the directory the connection actually uses.
  const scope = useMemo(() => ({ client, scopeId, methodId, attachedHomeDir }), [client, scopeId, methodId, attachedHomeDir]);
  const [home, setHome] = useState<{ scope: typeof scope; value: string } | null>(null);
  const homeDir = home?.scope === scope ? home.value : (attachedHomeDir ?? '');
  const setHomeDir = useCallback((value: string) => { setHome({ scope, value }); }, [scope]);
  // Request identity includes the client scope even when two servers receive
  // exactly the same provider and directory. Returning to an old directory is
  // a new question too; it must not resurrect a previous answer.
  const request: OriginalOAuthRequest = useMemo(
    () => (homeDir.trim() === '' ? { provider: scope.methodId } : { provider: scope.methodId, home_dir: homeDir.trim() }),
    [homeDir, scope],
  );
  const [probingRequest, setProbingRequest] = useState<OriginalOAuthRequest | null>(null);
  const [connectingRequest, setConnectingRequest] = useState<OriginalOAuthRequest | null>(null);
  const [result, setResult] = useState<{ probe: OriginalOAuthProbe; asked: OriginalOAuthRequest } | null>(null);
  const [feedback, setFeedback] = useState<{ asked: OriginalOAuthRequest; value: Feedback } | null>(null);
  const latest = useRef(0);
  const currentRequest = useRef<OriginalOAuthRequest | null>(null);
  useLayoutEffect(() => {
    currentRequest.current = request;
    return () => {
      currentRequest.current = null;
      ++latest.current;
    };
  }, [request]);
  const probe = result?.asked === request ? result.probe : null;

  const refresh = useCallback(async () => {
    if (currentRequest.current !== request) return;
    await queryClient.invalidateQueries({ queryKey: ['oauth-methods'] });
    if (currentRequest.current === request) await onChanged?.();
  }, [onChanged, queryClient, request]);

  const probeOriginal = useCallback(async () => {
    if (currentRequest.current !== request) return;
    setProbingRequest(request);
    setFeedback(null);
    const ask = ++latest.current;
    try {
      const found = await client.probeOriginalOAuth(request);
      if (ask !== latest.current || currentRequest.current !== request) return;
      setResult({ probe: found, asked: request });
    } catch (error) {
      if (ask !== latest.current || currentRequest.current !== request) return;
      setResult(null);
      setFeedback({ asked: request, value: { tone: 'error', text: errorText(locale, error) } });
    } finally {
      if (ask === latest.current && currentRequest.current === request) setProbingRequest(null);
    }
  }, [client, locale, request]);

  const connectOriginal = useCallback(async () => {
    if (currentRequest.current !== request || probe === null || originalSourceBlock(probe) !== null) return;
    const accountId = originalAccountId(probe);
    if (accountId === null) return;
    setConnectingRequest(request);
    setProbingRequest(null);
    setFeedback(null);
    ++latest.current;
    try {
      const connected = await client.connectOriginalOAuth({ ...request, expected_account_id: accountId });
      if (currentRequest.current !== request) return;
      setResult({ probe: connected, asked: request });
      await refresh();
    } catch (error) {
      if (currentRequest.current !== request) return;
      setResult(null);
      setFeedback({ asked: request, value: { tone: 'error', text: errorText(locale, error) } });
    } finally {
      if (currentRequest.current === request) setConnectingRequest(null);
    }
  }, [client, locale, probe, refresh, request]);

  // Logout drops Kiki's reference, never the original app's credential.
  const detachLocalOriginal = useMemo<(() => Promise<void>) | undefined>(
    () => (attached
      ? async () => {
        if (currentRequest.current !== request) return;
        ++latest.current;
        setProbingRequest(null);
        setFeedback(null);
        try {
          await client.logoutOAuth({ provider: methodId });
          if (currentRequest.current !== request) return;
          setResult(null);
          await refresh();
        } catch (error) {
          if (currentRequest.current !== request) return;
          setFeedback({ asked: request, value: { tone: 'error', text: errorText(locale, error) } });
        }
      }
      : undefined),
    [attached, client, methodId, locale, refresh, request],
  );

  return {
    homeDir,
    setHomeDir,
    probing: probingRequest === request,
    probe,
    blocked: originalSourceBlock(probe),
    probeOriginal,
    connectOriginal,
    detachLocalOriginal,
    connecting: connectingRequest === request,
    feedback: feedback?.asked === request ? feedback.value : null,
  };
}
